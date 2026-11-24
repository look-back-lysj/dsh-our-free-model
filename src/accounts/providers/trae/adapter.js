/**
 * TRAE channel: the adapter over the proprietary SOLO wire.
 *
 * ## Why this does not use the shared OpenAI-chat flow
 *
 * The shared flow reads `choices[0].delta` and finishes on `[DONE]`. This provider emits
 * named events (`done`, `token_usage`, `error`) with its own payload shapes, so the consumer
 * is its own. The pieces that *are* shared — message normalisation, truncation verdicts,
 * usage attribution, abort threading — are imported rather than reimplemented.
 *
 * ## The rotation rule that is specific to this channel
 *
 * An in-band error before any content is a rotatable condition; the same error after content
 * is not, because the caller has already read part of an answer. The code for that decision
 * lives in the consumer, where delivery is observable.
 *
 * @module src/accounts/providers/trae/adapter
 */

import { AccountError, ACCOUNT_ERROR_CODES } from '../../core/errors.js'
import {
  CHUNK,
  collectImageRefs,
  normalizeMessages,
  readSse,
  readUsage,
  settleStream,
  toChatContent,
  toChatTools,
} from '../../core/wire.js'
import {
  classifyHttp,
  classifyInBandFrame,
  COOLDOWN_FALLBACK_MS,
  DEFAULT_CHANNELS,
  DEFAULT_CREDENTIAL_REF,
  DEFAULT_FUNCTION,
  deriveCheckinDeviceId,
  FALLBACK_MODELS,
  HOSTS,
  MAX_ATTEMPTS,
  MAX_COMPLETION_TOKENS,
  mapErrorCode,
  parseBatchModels,
  PATHS,
  PROVIDER_ID,
  recordsCooldown,
  shouldRotate,
  toSoloBody,
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
 * @param {readonly string[]} [deps.channels]
 * @param {() => number} [deps.now]
 * @param {(message: string) => void} [deps.warn]
 * @returns {object}
 */
export function createTraeAdapter(deps) {
  const {
    fetch: fetchImpl,
    credentials,
    credentialRef,
    accountPool,
    channels = DEFAULT_CHANNELS,
    now = () => Date.now(),
    warn = () => {},
  } = deps

  /**
   * Resolve a credential and the account it belongs to.
   *
   * @param {string} model
   */
  async function resolve(model) {
    if (accountPool !== undefined) {
      const available = await accountPool.getAvailableAccount(PROVIDER_ID, model)
      if (available !== null && available !== undefined) {
        return { entry: available.entry, credential: available.credential }
      }
      throw new AccountError(
        `${PROVIDER_ID}: no usable account for ${model} (every account is disabled, cooling down, or out of credit)`,
        ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED,
      )
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
   * Refresh a credential by re-exchanging the stored token.
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
    const token = parsed.refresh_token ?? parsed.access_token
    if (typeof token !== 'string' || token.length === 0) {
      throw new AccountError(`${PROVIDER_ID}: the credential carries no token to exchange`, ACCOUNT_ERROR_CODES.AUTH)
    }
    const host = typeof parsed.api_host === 'string' ? parsed.api_host : HOSTS.oauth
    const response = await fetchImpl(`${host}${PATHS.exchange}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (!response.ok) {
      throw new AccountError(`${PROVIDER_ID}: token exchange failed (${response.status})`, ACCOUNT_ERROR_CODES.AUTH, { status: response.status })
    }
    const body = await response.json().catch(() => ({}))
    const next = body?.data ?? body
    const access = next?.access_token ?? next?.token
    if (typeof access !== 'string' || access.length === 0) {
      throw new AccountError(`${PROVIDER_ID}: token exchange returned no token`, ACCOUNT_ERROR_CODES.AUTH)
    }
    await credentials.set(ref, JSON.stringify({
      ...parsed,
      access_token: access,
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
    const normalized = normalizeMessages(input.messages)
    const imageRefs = collectImageRefs(input.messages)
    const tools = input.tools === undefined ? undefined : toChatTools(input.tools)
    const turns = normalized.turns.map(turn => (
      turn.role === 'user' && imageRefs.size > 0 && input.resolveImageUrl !== undefined
        ? { ...turn, content: toChatContent(turn.content, input.resolveImageUrl) }
        : turn
    ))

    // The routing channel is a per-model fact; the static table is the only local source.
    const route = FALLBACK_MODELS.find(row => row.id === model)
    const functionName = route?.function ?? DEFAULT_FUNCTION

    let refreshed = false
    let lastKind = 'none'
    let lastStatus = 0

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted?.()
      const resolved = await resolve(model)

      const chatBody = {
        model,
        messages: [
          ...normalized.system.map(text => ({ role: 'system', content: text })),
          ...turns.map(turn => toSoloMessage(turn)),
        ],
        stream: true,
        ...(tools === undefined ? {} : { tools }),
        ...(input.maxTokens === undefined ? {} : { max_tokens: Math.min(input.maxTokens, MAX_COMPLETION_TOKENS) }),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.stop === undefined ? {} : { stop: input.stop }),
        ...(input.reasoningEffort === undefined ? {} : { reasoning_effort: input.reasoningEffort }),
      }

      const solo = toSoloBody(chatBody, { model, functionName })

      let response
      try {
        response = await fetchImpl(`${HOSTS.agent}${PATHS.chat}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${resolved.credential.access_token ?? ''}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify(solo),
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
        if ((response.status === 401 || response.status === 403) && !refreshed) {
          refreshed = true
          try {
            await refresh({ accountId: resolved.entry?.id })
            attempt -= 1
            continue
          } catch (error) {
            throw new AccountError(`${PROVIDER_ID}: authentication failed and the refresh did not help`, ACCOUNT_ERROR_CODES.AUTH, { status: response.status, cause: error })
          }
        }
        lastKind = classifyHttp(response.status, text)
        lastStatus = response.status
        if (recordsCooldown(lastKind) && resolved.entry !== undefined && accountPool !== undefined) {
          await accountPool.updateModelRateLimit(resolved.entry.id, model, now() + COOLDOWN_FALLBACK_MS)
        }
        if (accountPool !== undefined && resolved.entry !== undefined && shouldRotate(lastKind)) continue
        throw new AccountError(
          `${PROVIDER_ID}: ${text.trim().slice(0, 400) || `HTTP ${response.status}`} (${response.status}/${lastKind})`,
          mapErrorCode(response.status, text, lastKind),
          { status: response.status },
        )
      }

      yield* consume(response, {
        signal,
        firstTokenMs: input.firstTokenMs ?? DEFAULT_FIRST_TOKEN_MS,
        chunkMs: input.chunkMs ?? DEFAULT_CHUNK_MS,
        canRotateInBand: accountPool !== undefined && resolved.entry !== undefined,
        entry: resolved.entry,
        model,
        accountPool,
      })
      return
    }

    if (lastKind === 'quota-exceeded' || lastKind === 'hard-plan' || lastKind === 'soft-rate') {
      throw new AccountError(`${PROVIDER_ID}: every account is limited for ${model}`, ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED, { status: lastStatus })
    }
    throw new AccountError(`${PROVIDER_ID}: no account could serve this request (last: ${lastKind})`, ACCOUNT_ERROR_CODES.AUTH, { status: lastStatus })
  }

  /** Consume one successful stream. */
  async function* consume(response, context) {
    const { signal } = context
    /** @type {Map<number, { id?: string, name?: string, args: string }>} */
    const toolCalls = new Map()
    let finishReason
    let terminated = false
    let sawContent = false
    let sawToolCall = false
    let firstFrame = true
    let usageEmitted = false
    let delivered = false

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

      if (frame.event === 'error' || payload?.error !== undefined) {
        const verdict = classifyInBandFrame({
          code: payload?.code ?? payload?.error?.code,
          message: payload?.message ?? payload?.error?.message,
        })
        if (verdict === undefined) continue
        if (!delivered && context.canRotateInBand && verdict.rotatable) {
          throw new AccountError(`${PROVIDER_ID}: in-band error (${verdict.kind})`, ACCOUNT_ERROR_CODES.QUEUE, { status: 200 })
        }
        throw new AccountError(`${PROVIDER_ID}: ${payload?.message ?? 'in-band error'}`, mapErrorCode(200, '', verdict.kind), { status: 200 })
      }

      if (frame.event === 'done') {
        if (typeof payload?.finish_reason === 'string') finishReason = payload.finish_reason
        terminated = true
        break
      }

      if (frame.event === 'token_usage') {
        const usage = readUsage(payload?.usage ?? payload)
        if (usage !== undefined && !usageEmitted) {
          usageEmitted = true
          yield { type: CHUNK.USAGE, ...usage }
        }
        continue
      }

      const choice = payload?.choices?.[0]
      const piece = choice?.delta ?? payload?.delta
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
      const usage = readUsage(payload?.usage)
      if (usage !== undefined && !usageEmitted) {
        usageEmitted = true
        yield { type: CHUNK.USAGE, ...usage }
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

    const settled = settleStream({
      finishReason: finishReason === undefined ? undefined : finishReason,
      terminated,
      sawContent,
      sawToolCall,
    })
    yield {
      type: 'finish',
      finishReason: settled.finishReason,
      truncated: settled.truncated,
      ...(settled.empty ? { empty: true } : {}),
    }
  }

  /**
   * List models from the batch listing, falling back to the static table.
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
      const response = await fetchImpl(`${HOSTS.agent}${PATHS.batchModels}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ functions: [...channels] }),
        signal,
      })
      if (!response.ok) return FALLBACK_MODELS.map(row => ({ ...row }))
      const parsed = parseBatchModels(await response.json(), { channels })
      return parsed.length === 0 ? FALLBACK_MODELS.map(row => ({ ...row })) : parsed
    } catch (error) {
      warn(`[${PROVIDER_ID}] model listing failed, using the static table: ${String(error)}`)
      return FALLBACK_MODELS.map(row => ({ ...row }))
    }
  }

  /**
   * The check-in device id for an account at a given generation.
   *
   * @param {Record<string, any>} credential
   * @param {number} generation
   * @returns {string}
   */
  function checkinDeviceId(credential, generation) {
    const base = typeof credential?.device_id === 'string' ? credential.device_id : ''
    return deriveCheckinDeviceId(base, generation)
  }

  return { provider: PROVIDER_ID, stream, listModels, refresh, checkinDeviceId }
}

/** @param {unknown} content */
function flatten(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join('')
  }
  return ''
}

/**
 * Convert one normalised turn into the intermediate chat shape the SOLO transform expects.
 *
 * Kept as a named function rather than an inline expression: the tool-call branch nests three
 * levels deep, and inlining it made the parser reject the surrounding object literal.
 *
 * @param {Record<string, any>} turn
 * @returns {Record<string, unknown>}
 */
function toSoloMessage(turn) {
  if (turn.role === 'tool') {
    return { role: 'tool', tool_call_id: turn.toolCallId, content: flatten(turn.content) }
  }
  if (turn.role !== 'assistant') {
    return { role: turn.role, content: turn.content }
  }
  /** @type {Record<string, unknown>} */
  const message = { role: 'assistant', content: flatten(turn.content) }
  const calls = Array.isArray(turn.toolCalls) ? turn.toolCalls : []
  if (calls.length === 0) return message
  message.tool_calls = calls.map(call => ({
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
    },
  }))
  return message
}
