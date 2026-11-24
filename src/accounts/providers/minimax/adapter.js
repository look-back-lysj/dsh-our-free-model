/**
 * MiniMax channel: the adapter over the Anthropic Messages wire.
 *
 * ## The defect this rewrite fixes
 *
 * The original consumer declared an abort signal and never read it: the reader loop called
 * `reader.read()` bare, with no idle timeout and no abort check. A caller that cancelled
 * during streaming was ignored until the upstream closed the socket on its own, so a
 * cancelled turn kept an upstream connection open and kept consuming the account's budget.
 *
 * Here the abort signal reaches `readSse`, which threads it into `readWithIdleTimeout`, so a
 * cancelled turn ends promptly and the reader is cancelled in a `finally`.
 *
 * ## Why the stream is not the shared chat consumer
 *
 * This is the Anthropic event shape: `message_start` carries the usage floor,
 * `content_block_delta` carries text and tool input, and `message_delta` carries the stop
 * reason. The shared consumer reads `choices[0].delta`, which does not exist here.
 *
 * @module src/accounts/providers/minimax/adapter
 */

import { AccountError, ACCOUNT_ERROR_CODES } from '../../core/errors.js'
import {
  CHUNK,
  collectImageRefs,
  flattenText,
  normalizeMessages,
  readSse,
  settleStream,
  toAnthropicMessages,
  toAnthropicTools,
} from '../../core/wire.js'
import {
  classifyHttp,
  DEFAULT_CREDENTIAL_REF,
  FALLBACK_MODELS,
  HOSTS,
  mapErrorCode,
  mapStopReason,
  PATHS,
  PROVIDER_ID,
  refuseReason,
  thinkingField,
} from './product.js'

const DEFAULT_FIRST_TOKEN_MS = 120_000
const DEFAULT_CHUNK_MS = 120_000

/**
 * Create the adapter.
 *
 * @param {object} deps
 * @param {typeof fetch} deps.fetch
 * @param {{ resolve: Function, set: Function }} deps.credentials
 * @param {(ref: string) => string} deps.credentialRef
 * @param {object} [deps.accountPool]
 * @param {(attachment: unknown) => Promise<{ data: Uint8Array, mediaType: string } | undefined>} [deps.readImage]
 * @param {() => number} [deps.now]
 * @param {(message: string) => void} [deps.warn]
 * @returns {object}
 */
export function createMinimaxAdapter(deps) {
  const {
    fetch: fetchImpl,
    credentials,
    credentialRef,
    accountPool,
    readImage,
    now = () => Date.now(),
    warn = () => {},
  } = deps

  /**
   * Resolve a credential, refreshing once when it looks expired.
   *
   * @param {string} model
   */
  async function resolve(model) {
    if (accountPool !== undefined) {
      const available = await accountPool.getAvailableAccount(PROVIDER_ID, model)
      if (available !== null && available !== undefined) {
        return { entry: available.entry, credential: available.credential }
      }
    }
    const stored = await credentials.resolve(credentialRef(DEFAULT_CREDENTIAL_REF))
    if (stored === undefined) {
      throw new AccountError(`${PROVIDER_ID}: no usable credential; log in from the channel panel first`, ACCOUNT_ERROR_CODES.MISSING_CREDENTIAL)
    }
    try {
      return { entry: undefined, credential: JSON.parse(stored.value) }
    } catch (error) {
      throw new AccountError(`${PROVIDER_ID}: the stored credential is not valid JSON`, ACCOUNT_ERROR_CODES.MISSING_CREDENTIAL, { cause: error })
    }
  }

  /**
   * Refresh a credential with its refresh-token grant.
   *
   * Unlike the channels that can only probe, this provider has a real refresh endpoint, so
   * this genuinely renews rather than merely checking.
   *
   * @param {{ accountId?: string }} spec
   */
  async function refresh({ accountId }) {
    const ref = accountId === undefined
      ? credentialRef(DEFAULT_CREDENTIAL_REF)
      : credentialRef(String(accountId).toUpperCase().replace(/-/g, '_'))
    const stored = await credentials.resolve(ref)
    if (stored === undefined) throw new AccountError(`${PROVIDER_ID}: no credential to refresh`, ACCOUNT_ERROR_CODES.AUTH)
    const parsed = JSON.parse(stored.value)
    if (typeof parsed.refresh_token !== 'string' || parsed.refresh_token.length === 0) {
      throw new AccountError(`${PROVIDER_ID}: the credential carries no refresh token`, ACCOUNT_ERROR_CODES.AUTH)
    }
    const response = await fetchImpl(`${HOSTS.account}${PATHS.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: parsed.refresh_token,
        client_id: typeof parsed.client_id === 'string' ? parsed.client_id : '',
      }).toString(),
    })
    if (!response.ok) {
      throw new AccountError(`${PROVIDER_ID}: refresh failed (${response.status})`, ACCOUNT_ERROR_CODES.AUTH, { status: response.status })
    }
    const body = await response.json().catch(() => ({}))
    if (typeof body?.access_token !== 'string') {
      throw new AccountError(`${PROVIDER_ID}: refresh returned no access token`, ACCOUNT_ERROR_CODES.AUTH)
    }
    await credentials.set(ref, JSON.stringify({
      ...parsed,
      access_token: body.access_token,
      ...(typeof body.refresh_token === 'string' ? { refresh_token: body.refresh_token } : {}),
      ...(typeof body.expires_in === 'number' ? { expires_at: new Date(now() + body.expires_in * 1000).toISOString() } : {}),
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
    const entry = FALLBACK_MODELS.find(row => row.id === model)
    const imageRefs = collectImageRefs(input.messages)

    // Refuse before sending: a stripped image would look like a successful turn in which the
    // model simply ignored the picture.
    const reason = refuseReason(entry, imageRefs.size > 0, readImage !== undefined)
    if (reason !== undefined) {
      throw new AccountError(`${PROVIDER_ID}: ${reason}`, 'UNSUPPORTED_CONTENT')
    }

    /** @type {Map<string, { mediaType: string, data: string }>} */
    const inlined = new Map()
    if (imageRefs.size > 0) {
      for (const id of imageRefs.keys()) {
        const bytes = await readImage({ attachmentId: id })
        if (bytes === undefined) {
          throw new AccountError(
            `${PROVIDER_ID}: image ${id} could not be inlined; refusing to send a request without it`,
            'UNSUPPORTED_CONTENT',
          )
        }
        // Bare base64, no data: prefix — the Anthropic media block is not a URL.
        inlined.set(id, {
          mediaType: bytes.mediaType,
          data: Buffer.from(bytes.data).toString('base64'),
        })
      }
    }

    const normalized = normalizeMessages(input.messages)
    const body = {
      model,
      stream: true,
      messages: toAnthropicMessages(normalized.turns, { resolveImage: id => inlined.get(id) }),
      ...(normalized.system.length > 0 ? { system: normalized.system.join('\n\n') } : {}),
      ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      ...(input.stop === undefined ? {} : { stop_sequences: input.stop }),
      ...(input.tools === undefined ? {} : { tools: toAnthropicTools(input.tools) }),
    }
    const thinking = thinkingField(entry, input.reasoningEffort)
    if (thinking !== undefined) body.thinking = thinking
    if (input.reasoningEffort !== undefined && entry?.effortOptions?.includes(input.reasoningEffort)) {
      body.output_config = { effort: input.reasoningEffort }
    }

    const resolved = await resolve(model)
    let response
    try {
      response = await fetchImpl(`${HOSTS.api}${PATHS.infer}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${resolved.credential.access_token ?? ''}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (signal?.aborted === true) {
        throw new AccountError(`${PROVIDER_ID}: request aborted`, ACCOUNT_ERROR_CODES.ABORTED, { cause: error })
      }
      throw new AccountError(`${PROVIDER_ID}: transport failure: ${error?.message ?? error}`, ACCOUNT_ERROR_CODES.TRANSPORT, { cause: error })
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const kind = classifyHttp(response.status)
      throw new AccountError(
        `${PROVIDER_ID}: ${text.trim().slice(0, 400) || `HTTP ${response.status}`} (${response.status}/${kind})`,
        mapErrorCode(response.status, kind),
        { status: response.status },
      )
    }

    yield* consume(response, {
      signal,
      firstTokenMs: input.firstTokenMs ?? DEFAULT_FIRST_TOKEN_MS,
      chunkMs: input.chunkMs ?? DEFAULT_CHUNK_MS,
    })
  }

  /**
   * Consume the Anthropic event stream.
   *
   * Abort is threaded through `readSse`, which is the fix for the original defect: the
   * reader observes the signal and an idle window, so a cancelled turn stops promptly.
   */
  async function* consume(response, context) {
    const { signal } = context
    /** @type {Map<number, { id?: string, name?: string, args: string }>} */
    const blocks = new Map()
    let stopReason
    let sawContent = false
    let sawToolUse = false
    let firstFrame = true
    let usage = {}
    let usageEmitted = false
    let terminated = false

    for await (const frame of readSse(response.body, {
      signal,
      idleTimeoutMs: firstFrame ? context.firstTokenMs : context.chunkMs,
    })) {
      firstFrame = false
      let payload
      try {
        payload = JSON.parse(frame.data)
      } catch {
        continue
      }

      if (payload?.type === 'error') {
        const message = typeof payload.error?.message === 'string' ? payload.error.message : 'upstream error'
        throw new AccountError(`${PROVIDER_ID}: ${message}`, ACCOUNT_ERROR_CODES.SERVER, { status: 200 })
      }

      if (payload?.type === 'message_start') {
        const startUsage = payload.message?.usage
        if (startUsage !== undefined) usage = { ...usage, ...startUsage }
        continue
      }

      if (payload?.type === 'content_block_start') {
        const block = payload.content_block
        if (block?.type === 'tool_use') {
          blocks.set(payload.index, { id: block.id, name: block.name, args: '' })
          sawToolUse = true
        }
        continue
      }

      if (payload?.type === 'content_block_delta') {
        const piece = payload.delta
        if (piece?.type === 'text_delta' && typeof piece.text === 'string' && piece.text.length > 0) {
          sawContent = true
          yield { type: CHUNK.TEXT, text: piece.text }
        } else if (piece?.type === 'thinking_delta' && typeof piece.thinking === 'string' && piece.thinking.length > 0) {
          sawContent = true
          yield { type: CHUNK.REASONING, text: piece.thinking }
        } else if (piece?.type === 'input_json_delta' && typeof piece.partial_json === 'string') {
          const current = blocks.get(payload.index)
          if (current !== undefined) {
            current.args += piece.partial_json
            yield { type: CHUNK.TOOL_DELTA, index: payload.index, argumentsDelta: piece.partial_json }
          }
        }
        continue
      }

      if (payload?.type === 'message_delta') {
        if (typeof payload.delta?.stop_reason === 'string') stopReason = payload.delta.stop_reason
        if (payload.usage !== undefined) usage = { ...usage, ...payload.usage }
        continue
      }

      if (payload?.type === 'message_stop') {
        terminated = true
        break
      }
    }

    for (const [, block] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (block.name === undefined) continue
      yield {
        type: CHUNK.TOOL_CALL,
        id: block.id ?? `call_${block.name}_${block.args.length}`,
        name: block.name,
        arguments: block.args,
      }
    }

    // Usage is emitted once at the end: the start event carries only a floor and the delta
    // completes it, so emitting early would report a partial count as final.
    if (!usageEmitted && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
      usageEmitted = true
      const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
      const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
      yield {
        type: CHUNK.USAGE,
        inputTokens: input,
        outputTokens: output,
        ...(typeof usage.cache_read_input_tokens === 'number' ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
      }
    }

    const settled = settleStream({
      finishReason: stopReason === undefined ? undefined : mapStopReason(stopReason, sawToolUse),
      terminated,
      sawContent,
      sawToolUse,
    })
    yield {
      type: 'finish',
      finishReason: settled.finishReason,
      truncated: settled.truncated,
      ...(settled.empty ? { empty: true } : {}),
    }
  }

  /**
   * List models from the remote catalog, falling back to the static table.
   *
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function listModels({ signal } = {}) {
    let token
    try {
      if (accountPool !== undefined) {
        const available = await accountPool.getAvailableAccount(PROVIDER_ID, '')
        token = available?.credential?.access_token
      }
      if (token === undefined) {
        const stored = await credentials.resolve(credentialRef(DEFAULT_CREDENTIAL_REF))
        token = stored === undefined ? undefined : JSON.parse(stored.value).access_token
      }
    } catch {
      token = undefined
    }
    if (token === undefined) return FALLBACK_MODELS.map(row => ({ ...row }))
    try {
      const response = await fetchImpl(`${HOSTS.api}${PATHS.models}?region=cn&buildEnv=prod`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal,
      })
      if (!response.ok) return FALLBACK_MODELS.map(row => ({ ...row }))
      const body = await response.json()
      const rows = body?.data ?? body?.models ?? body
      if (!Array.isArray(rows) || rows.length === 0) return FALLBACK_MODELS.map(row => ({ ...row }))
      return rows.map(row => {
        const id = typeof row?.id === 'string' ? row.id : row?.model
        if (typeof id !== 'string' || id.length === 0) return undefined
        const curated = FALLBACK_MODELS.find(model => model.id === id)
        const modalities = Array.isArray(row?.capabilities?.input_modalities) ? row.capabilities.input_modalities : undefined
        return {
          id,
          name: typeof row.display_name === 'string' ? row.display_name : (curated?.name ?? id),
          contextWindow: typeof row.limit?.context === 'number' ? row.limit.context : (curated?.contextWindow ?? 1_000_000),
          maxTokens: typeof row.limit?.output === 'number' ? row.limit.output : curated?.maxTokens,
          supportsImage: modalities === undefined
            ? curated?.supportsImage === true
            : modalities.includes('image'),
          ...(curated?.thinkingMode === undefined ? {} : { thinkingMode: curated.thinkingMode }),
          ...(curated?.effortOptions === undefined ? {} : { effortOptions: curated.effortOptions, defaultEffort: curated.defaultEffort }),
        }
      }).filter(row => row !== undefined)
    } catch (error) {
      warn(`[${PROVIDER_ID}] model listing failed, using the static table: ${String(error)}`)
      return FALLBACK_MODELS.map(row => ({ ...row }))
    }
  }

  return { provider: PROVIDER_ID, stream, listModels, refresh }
}

export { flattenText }
