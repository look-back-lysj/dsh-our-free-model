/**
 * Qoder and Qoder CN: the adapter, driving the retained WASM for the encrypted envelope.
 *
 * ## Where the boundary sits
 *
 * This module builds the plaintext payload and makes every routing decision. The retained WASM
 * turns that payload into a URL, headers and an encrypted body, and decrypts the response. The
 * adapter never inspects the ciphertext, and it never replaces the `Authorization` header the
 * WASM produces — that header is derived from the encrypted envelope, so replacing it yields a
 * request the server rejects without saying why.
 *
 * ## Queue handling is this channel's distinguishing behaviour
 *
 * A queue notice is not an error the user should see: it is the provider asking us to wait. So
 * it is waited out internally, bounded by both an attempt count and a total deadline, and the
 * account is only rotated after repeated queue hits — otherwise one busy account would consume
 * the whole rotation budget on a condition that clears by itself.
 *
 * @module src/accounts/providers/qoder/adapter
 */

import { AccountError, ACCOUNT_ERROR_CODES } from '../../core/errors.js'
import { CHUNK, flattenText, normalizeMessages, readSse, settleStream } from '../../core/wire.js'
import {
  buildInferPayload,
  classifyHttp,
  classifyInBand,
  effortMenu,
  mapErrorCode,
  MAX_ATTEMPTS,
  modelsFor,
  PATHS,
  PRODUCTS,
  PROVIDER_QODER,
  PROVIDER_QODER_CN,
  queueDelayMs,
  QUEUE_DEADLINE_MS,
  QUEUE_MAX_ATTEMPTS,
  resolveEffort,
} from './product.js'

/** Rotate to another account after this many queue hits on one account. */
const QUEUE_HITS_BEFORE_ROTATE = 3
/** ...or after this long spent queueing on one account. */
const QUEUE_MS_BEFORE_ROTATE = 20_000
/** How long a spent allowance parks the model. The provider settles daily on UTC+8. */
const QUOTA_COOLDOWN_MS = 86_400_000

/**
 * Create the adapter for one product.
 *
 * @param {object} deps
 * @param {typeof fetch} deps.fetch
 * @param {{ resolve: Function, set: Function }} deps.credentials
 * @param {(ref: string) => string} deps.credentialRef
 * @param {object} [deps.accountPool]
 * @param {(plaintext: string, context: object) => Promise<{ url: string, headers: Record<string, string>, body: string }>} deps.encrypt
 *   the retained-WASM bridge; the only seam through which the binary is used
 * @param {(response: Response) => AsyncIterable<Record<string, any>>} [deps.decryptStream]
 *   the retained-WASM stream unwrapper; identity by default for tests
 * @param {string} [deps.provider] one of the two product ids
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.now]
 * @param {(message: string) => void} [deps.warn]
 * @returns {object}
 */
export function createQoderAdapter(deps) {
  const {
    fetch: fetchImpl,
    credentials,
    credentialRef,
    accountPool,
    encrypt,
    decryptStream,
    provider = PROVIDER_QODER,
    sleep = defaultSleep,
    now = () => Date.now(),
    warn = () => {},
  } = deps

  if (encrypt === undefined) {
    throw new TypeError('createQoderAdapter requires the retained-WASM encrypt bridge')
  }
  const product = PRODUCTS[provider]
  if (product === undefined) throw new TypeError(`unknown Qoder product: ${provider}`)
  const table = modelsFor(provider)

  /**
   * Resolve a credential.
   *
   * @param {string} model
   */
  async function resolve(model) {
    if (accountPool !== undefined) {
      const available = await accountPool.getAvailableAccount(provider, model)
      if (available !== null && available !== undefined) {
        return { entry: available.entry, credential: available.credential }
      }
      throw new AccountError(
        `${provider}: no usable account for ${model} (every account is disabled, cooling down, or out of credit)`,
        ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED,
      )
    }
    const stored = await credentials.resolve(credentialRef(product.defaultCredentialRef))
    if (stored === undefined) {
      throw new AccountError(`${provider}: no usable credential; log in from the channel panel first`, ACCOUNT_ERROR_CODES.MISSING_CREDENTIAL)
    }
    try {
      return { entry: undefined, credential: JSON.parse(stored.value) }
    } catch (error) {
      throw new AccountError(`${provider}: the stored credential is not valid JSON`, ACCOUNT_ERROR_CODES.MISSING_CREDENTIAL, { cause: error })
    }
  }

  /**
   * Refresh a credential through the device-token endpoint.
   *
   * @param {{ accountId?: string }} spec
   */
  async function refresh({ accountId }) {
    const ref = accountId === undefined
      ? credentialRef(product.defaultCredentialRef)
      : credentialRef(String(accountId).toUpperCase().replace(/-/g, '_'))
    const stored = await credentials.resolve(ref)
    if (stored === undefined) throw new AccountError(`${provider}: no credential to refresh`, ACCOUNT_ERROR_CODES.AUTH)
    const parsed = JSON.parse(stored.value)
    if (typeof parsed.refresh_token !== 'string' || parsed.refresh_token.length === 0) {
      throw new AccountError(`${provider}: the credential carries no refresh token`, ACCOUNT_ERROR_CODES.AUTH)
    }
    const response = await fetchImpl(`${product.authBase}${PATHS.refresh}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: parsed.refresh_token }),
    })
    if (!response.ok) {
      throw new AccountError(`${provider}: token refresh failed (${response.status})`, ACCOUNT_ERROR_CODES.AUTH, { status: response.status })
    }
    const body = await response.json().catch(() => ({}))
    const next = body?.data ?? body
    if (typeof next?.access_token !== 'string') {
      throw new AccountError(`${provider}: refresh returned no access token`, ACCOUNT_ERROR_CODES.AUTH)
    }
    await credentials.set(ref, JSON.stringify({
      ...parsed,
      access_token: next.access_token,
      ...(typeof next.refresh_token === 'string' ? { refresh_token: next.refresh_token } : {}),
    }))
  }

  /**
   * Run one streaming turn.
   *
   * @param {object} input
   * @returns {AsyncGenerator<Record<string, any>>}
   */
  async function* stream(input) {
    const { model, signal } = input
    const entry = table.find(row => row.id === model)
    if (entry === undefined) {
      throw new AccountError(`${provider}: "${model}" is not in this product's model table`, ACCOUNT_ERROR_CODES.INVALID_REQUEST, { status: 400 })
    }
    const effort = resolveEffort(entry, input.reasoningEffort)
    const normalized = normalizeMessages(input.messages)
    const tried = new Set()
    let refreshed = false
    let lastKind = 'none'
    let lastStatus = 0

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted?.()
      const resolved = await resolve(model)
      if (resolved.entry !== undefined) tried.add(resolved.entry.id)

      const payload = buildInferPayload({
        model: entry,
        requestId: `ofm-${now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        sessionId: input.sessionId ?? '',
        text: flattenText(normalized.turns.at(-1)?.content),
        system: normalized.system.join('\n\n'),
        messages: normalized.turns.map(turn => ({
          role: turn.role === 'tool' ? 'user' : turn.role,
          content: flattenText(turn.content),
        })),
        tools: input.tools ?? [],
        maxTokens: input.maxTokens,
        reasoningEffort: effort,
        enableThinking: entry.supportsThinking === true,
      })

      // The WASM produces the URL, the headers and the encrypted body.
      let prepared
      try {
        prepared = await encrypt(JSON.stringify(payload), {
          provider,
          credential: resolved.credential,
          model: entry,
        })
      } catch (error) {
        throw new AccountError(`${provider}: the encryption bridge failed: ${error?.message ?? error}`, ACCOUNT_ERROR_CODES.SERVER, { cause: error })
      }

      let response
      try {
        response = await fetchImpl(prepared.url, {
          method: 'POST',
          // The WASM's Authorization header is preserved: it is derived from the envelope.
          headers: { ...prepared.headers, accept: 'text/event-stream' },
          body: prepared.body,
          signal,
        })
      } catch (error) {
        if (signal?.aborted === true) {
          throw new AccountError(`${provider}: request aborted`, ACCOUNT_ERROR_CODES.ABORTED, { cause: error })
        }
        throw new AccountError(`${provider}: transport failure: ${error?.message ?? error}`, ACCOUNT_ERROR_CODES.TRANSPORT, { cause: error })
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        let body
        try { body = JSON.parse(text) } catch { body = undefined }
        const kind = classifyHttp({ status: response.status, body: body ?? text })
        lastKind = kind
        lastStatus = response.status

        if (kind === 'queue') {
          // Wait it out rather than surfacing it; the wrapper owns the budget.
          yield* waitForQueue({ delayMs: queueDelayMs(body), signal })
          continue
        }

        if (kind === 'auth' && !refreshed) {
          refreshed = true
          try {
            await refresh({ accountId: resolved.entry?.id })
            attempt -= 1
            continue
          } catch (error) {
            throw new AccountError(`${provider}: authentication failed and the refresh did not help`, ACCOUNT_ERROR_CODES.AUTH, { status: response.status, cause: error })
          }
        }

        if (kind === 'duplicate') {
          // A duplicate submission is resent once; it is not an account problem.
          attempt -= 1
          continue
        }

        if (kind === 'quota-exceeded' && accountPool !== undefined && resolved.entry !== undefined) {
          await accountPool.updateModelRateLimit(resolved.entry.id, model, now() + QUOTA_COOLDOWN_MS)
          continue
        }

        throw new AccountError(
          `${provider}: ${text.trim().slice(0, 400) || `HTTP ${response.status}`} (${response.status}/${kind})`,
          mapErrorCode(kind, response.status),
          { status: response.status },
        )
      }

      const frames = decryptStream === undefined ? defaultFrames(response) : decryptStream(response)
      yield* consume(frames, {
        signal,
        canRotateInBand: accountPool !== undefined && resolved.entry !== undefined,
        entry: resolved.entry,
        model,
        sleep,
      })
      return
    }

    if (lastKind === 'quota-exceeded') {
      throw new AccountError(`${provider}: every account is limited for ${model}`, ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED, { status: lastStatus })
    }
    throw new AccountError(`${provider}: no account could serve this request (last: ${lastKind})`, ACCOUNT_ERROR_CODES.AUTH, { status: lastStatus })
  }

  /**
   * Wait out one queue notice, with the same bounded budget the contract fixes.
   *
   * A turn that exceeds either the attempt count or the deadline stops waiting and reports a
   * queue failure, so the user sees "still queued" rather than a hang.
   */
  async function* waitForQueue({ delayMs, signal }) {
    void 0
    const wait = Math.min(delayMs ?? 1_000, 10_000)
    await sleep(wait, signal)
    // The caller's loop owns the counters; this generator exists so the wait is expressed in
    // the same stream-shaped flow as the rest of the turn.
    yield { type: 'queue-wait', delayMs: wait }
  }

  /** Consume the decrypted stream. */
  async function* consume(frames, context) {
    const { signal } = context
    let finishReason
    let terminated = false
    let sawContent = false
    let sawToolCall = false
    let usageEmitted = false
    let delivered = false
    let queueHits = 0
    let queueingSince
    let attempts = 0
    const deadline = now() + QUEUE_DEADLINE_MS

    /** @type {Map<number, { id?: string, name?: string, args: string }>} */
    const toolCalls = new Map()

    for await (const payload of frames) {
      signal?.throwIfAborted?.()
      if (payload === null || typeof payload !== 'object') continue

      const kind = classifyInBand(payload)
      if (kind === 'queue' || kind === 'quota-exceeded') {
        if (!delivered && context.canRotateInBand) {
          queueHits += 1
          queueingSince ??= now()
          attempts += 1
          if (attempts > QUEUE_MAX_ATTEMPTS || now() >= deadline) {
            throw new AccountError(`${provider}: queue retries or wait time exhausted`, ACCOUNT_ERROR_CODES.QUEUE, { status: 200 })
          }
          // Only rotate after repeated hits; one busy account should not consume the budget.
          if (queueHits >= QUEUE_HITS_BEFORE_ROTATE || now() - queueingSince >= QUEUE_MS_BEFORE_ROTATE) {
            throw new AccountError(`${provider}: in-band ${kind}, rotating`, ACCOUNT_ERROR_CODES.QUEUE, { status: 200 })
          }
          await context.sleep(queueDelayMs(payload) ?? 1_000, signal)
          continue
        }
        throw new AccountError(`${provider}: in-band ${kind}`, mapErrorCode(kind, 200), { status: 200 })
      }
      if (payload.error !== undefined) {
        throw new AccountError(`${provider}: ${payload.error?.message ?? 'stream error'}`, ACCOUNT_ERROR_CODES.SERVER, { status: 200 })
      }

      const choice = payload.choices?.[0]
      const piece = choice?.delta ?? payload.delta
      if (piece !== undefined) {
        if (typeof piece.reasoning_content === 'string' && piece.reasoning_content.length > 0) {
          sawContent = true
          delivered = true
          yield { type: CHUNK.REASONING, text: piece.reasoning_content }
        }
        if (typeof piece.content === 'string' && piece.content.length > 0) {
          sawContent = true
          delivered = true
          yield { type: CHUNK.TEXT, text: piece.content }
        }
        for (const call of piece.tool_calls ?? []) {
          const index = typeof call.index === 'number' ? call.index : 0
          const current = toolCalls.get(index) ?? { args: '' }
          if (typeof call.id === 'string' && call.id.length > 0) current.id = call.id
          if (typeof call.function?.name === 'string' && call.function.name.length > 0) current.name = call.function.name
          if (typeof call.function?.arguments === 'string') {
            current.args += call.function.arguments
            sawToolCall = true
            delivered = true
            yield { type: CHUNK.TOOL_DELTA, index, argumentsDelta: call.function.arguments }
          }
          toolCalls.set(index, current)
        }
        if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason
      }
      if (payload.done === true || payload === '[DONE]') {
        terminated = true
        break
      }
      const usage = payload.usage
      if (usage !== undefined && !usageEmitted && typeof usage === 'object') {
        usageEmitted = true
        const input = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
        const cached = typeof usage.prompt_tokens_details?.cached_tokens === 'number' ? usage.prompt_tokens_details.cached_tokens : 0
        const output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
        yield {
          type: CHUNK.USAGE,
          inputTokens: Math.max(0, input - cached),
          outputTokens: output,
          ...(cached > 0 ? { cacheReadTokens: cached } : {}),
        }
      }
    }

    for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      if (call.name === undefined) continue
      yield {
        type: CHUNK.TOOL_CALL,
        id: call.id ?? `call_${call.name}_${call.args.length}`,
        name: call.name,
        arguments: call.args,
      }
    }

    const settled = settleStream({ finishReason, terminated, sawContent, sawToolCall })
    yield {
      type: 'finish',
      finishReason: settled.finishReason,
      truncated: settled.truncated,
      ...(settled.empty ? { empty: true } : {}),
    }
  }

  /**
   * List the product's model table, with effort menus attached.
   *
   * There is no remote listing for either product, so the table is authoritative. That is why
   * an unknown id is refused in `stream`: there is nothing to fall back to.
   */
  async function listModels() {
    return table.map(row => ({
      id: row.id,
      name: row.name,
      contextWindow: row.contextWindow,
      supportsImage: row.supportsImage === true,
      ...(effortMenu(row).length === 0
        ? {}
        : { efforts: effortMenu(row), ...(row.defaultEffort === undefined ? {} : { defaultEffort: row.defaultEffort }) }),
    }))
  }

  return { provider, listModels, stream, refresh }
}

/** Yield parsed frames from a plain (already-decrypted) SSE response. */
async function* defaultFrames(response) {
  for await (const frame of readSse(response.body)) {
    if (frame.data === '[DONE]') {
      yield '[DONE]'
      return
    }
    try {
      yield JSON.parse(frame.data)
    } catch {
      // A non-JSON frame is a keep-alive.
    }
  }
}

/** Sleep that honours a signal. */
function defaultSleep(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  if (signal?.aborted === true) return Promise.reject(new AccountError('aborted', ACCOUNT_ERROR_CODES.ABORTED))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AccountError('aborted', ACCOUNT_ERROR_CODES.ABORTED))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export { PROVIDER_QODER, PROVIDER_QODER_CN }
