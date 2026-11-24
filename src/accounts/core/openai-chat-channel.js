/**
 * A reusable adapter for channels that speak OpenAI chat completions.
 *
 * ## Why a factory rather than five near-copies
 *
 * Four of the account channels send an OpenAI-chat body and read an OpenAI SSE stream.
 * They differ in four things only: where they POST, what headers they add, how they
 * classify a failure, and what their catalog says. Everything else — pairing tool calls,
 * separating reasoning, detecting truncation, attributing usage, honouring abort — is
 * identical, and identical logic copied five times is logic that gets fixed in four
 * places and missed in the fifth.
 *
 * So the shared flow lives here, and each channel passes in its own decisions. A channel
 * that needs a genuinely different shape (Anthropic messages, Gemini contents, or a
 * proprietary envelope) gets its own module instead of bending this one.
 *
 * ## What the factory guarantees for every channel built on it
 *
 * - A transport failure is never classified as an account problem, so a network fault
 *   cannot look like a rotation.
 * - A 401/403 gets at most one credential refresh before the failure is reported, so an
 *   always-401 provider cannot become a refresh loop.
 * - A failure that rotates records a cooldown only when the channel says the kind means
 *   "this model is limited", so transient faults do not park usable capacity.
 * - An in-band error is only retried while nothing has been delivered.
 * - A stream without a finish signal is reported as truncated.
 *
 * @module src/accounts/core/openai-chat-channel
 */

import { AccountError, ACCOUNT_ERROR_CODES } from './errors.js'
import {
  CHUNK,
  buildChatBody,
  collectImageRefs,
  mapFinishReason,
  normalizeMessages,
  readSse,
  readUsage,
  settleStream,
  toChatContent,
  toChatTools,
} from './wire.js'

const DEFAULT_FIRST_TOKEN_MS = 120_000
const DEFAULT_CHUNK_MS = 120_000

/**
 * Build an adapter for an OpenAI-chat channel.
 *
 * @param {object} spec
 * @param {string} spec.provider
 * @param {string} spec.chatUrl - absolute URL to POST
 * @param {(input: { credential: Record<string, any>, model: string }) => Record<string, string>} spec.headers
 * @param {(status: number, body: string) => string} spec.classifyHttp
 * @param {(message: string) => string} spec.classifyInBand
 * @param {(kind: string) => boolean} spec.shouldRotate
 * @param {(kind: string) => boolean} [spec.recordsCooldown]
 * @param {(status: number, body: string, kind: string) => string} spec.errorCode - maps a classification to a harness code
 * @param {number} [spec.maxAttempts]
 * @param {number} [spec.cooldownMs]
 * @param {(status: number) => boolean} [spec.refreshableStatus] - default 401/403
 * @param {(kind: string, status: number) => boolean} [spec.isAuthKind]
 * @param {object} spec.deps - fetch, credentials, credentialRef, accountPool, now, warn, sleep
 * @returns {object}
 */
export function createOpenAiChatChannel(spec) {
  const {
    provider,
    chatUrl,
    headers,
    classifyHttp,
    classifyInBand,
    shouldRotate,
    recordsCooldown = () => false,
    errorCode,
    maxAttempts = 3,
    cooldownMs = 3_600_000,
    refreshableStatus = status => status === 401 || status === 403,
    deps,
  } = spec
  const {
    fetch: fetchImpl,
    credentials,
    credentialRef,
    accountPool,
    now = () => Date.now(),
    warn = () => {},
  } = deps

  /**
   * Resolve a credential for this request.
   *
   * With a pool, an empty pool is reported as exhausted rather than falling through to a
   * default credential: falling through would send the request on an account the user has
   * already spent, and the resulting error would name the wrong cause.
   *
   * @param {string} model
   * @param {string} defaultRef
   */
  async function resolve(model, defaultRef) {
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
    const stored = await credentials.resolve(credentialRef(defaultRef))
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
   * Run one streaming turn.
   *
   * @param {object} input
   * @returns {AsyncGenerator<Record<string, any>>}
   */
  async function* stream(input) {
    const { model, signal } = input
    const defaultRef = spec.defaultCredentialRef
    const normalized = normalizeMessages(input.messages)
    const imageRefs = collectImageRefs(input.messages)
    const resolveImageUrl = input.resolveImageUrl
    const tools = input.tools === undefined ? undefined : toChatTools(input.tools)

    // Rebuild user turns with the channel's own image projection when it has one.
    const turns = normalized.turns.map(turn => (
      turn.role === 'user' && imageRefs.size > 0 && resolveImageUrl !== undefined
        ? { ...turn, content: toChatContent(turn.content, resolveImageUrl) }
        : turn
    ))

    let refreshed = false
    let lastKind = 'none'
    let lastStatus = 0

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      signal?.throwIfAborted?.()
      const resolved = await resolve(model, defaultRef)

      const body = buildChatBody({
        model,
        messages: turns,
        system: normalized.system,
        tools,
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        stop: input.stop,
        reasoningEffort: input.reasoningEffort,
        extra: input.extra,
      })

      let response
      try {
        response = await fetchImpl(chatUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...headers({ credential: resolved.credential, model }),
          },
          body: JSON.stringify(body),
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
        if (refreshableStatus(response.status) && !refreshed && spec.refresh !== undefined) {
          refreshed = true
          try {
            await spec.refresh({ accountId: resolved.entry?.id, deps })
            attempt -= 1
            continue
          } catch (error) {
            throw new AccountError(`${provider}: authentication failed and the refresh did not help`, ACCOUNT_ERROR_CODES.AUTH, { status: response.status, cause: error })
          }
        }
        lastKind = classifyHttp(response.status, text)
        lastStatus = response.status
        if (recordsCooldown(lastKind) && resolved.entry !== undefined && accountPool !== undefined) {
          await accountPool.updateModelRateLimit(resolved.entry.id, model, now() + cooldownMs)
        }
        if (accountPool !== undefined && resolved.entry !== undefined && shouldRotate(lastKind)) continue
        throw new AccountError(
          `${provider}: ${text.trim().slice(0, 400) || `HTTP ${response.status}`} (${response.status}/${lastKind})`,
          errorCode(response.status, text, lastKind),
          { status: response.status },
        )
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        // A JSON body on a streaming endpoint is an error or a queue notice.
        const text = await response.text().catch(() => '')
        const kind = classifyInBand(text)
        if (recordsCooldown(kind) && resolved.entry !== undefined && accountPool !== undefined) {
          await accountPool.updateModelRateLimit(resolved.entry.id, model, now() + cooldownMs)
        }
        if (accountPool !== undefined && resolved.entry !== undefined && shouldRotate(kind)) continue
        throw new AccountError(
          `${provider}: ${text.trim().slice(0, 400)} (200/${kind})`,
          errorCode(200, text, kind),
          { status: 200 },
        )
      }

      yield* consume(response, {
        signal,
        firstTokenMs: input.firstTokenMs ?? DEFAULT_FIRST_TOKEN_MS,
        chunkMs: input.chunkMs ?? DEFAULT_CHUNK_MS,
        canRotateInBand: accountPool !== undefined && resolved.entry !== undefined,
        entry: resolved.entry,
        model,
        classifyInBand,
        shouldRotate,
        recordsCooldown,
        errorCode,
      })
      return
    }

    if (lastKind === 'hard-credit' || lastKind === 'soft-rate' || lastKind === 'quota-exceeded') {
      throw new AccountError(`${provider}: every account is limited for ${model}`, ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED, { status: lastStatus })
    }
    throw new AccountError(`${provider}: no account could serve this request (last: ${lastKind})`, ACCOUNT_ERROR_CODES.AUTH, { status: lastStatus })
  }

  /**
   * Consume one successful SSE response.
   *
   * Delivery is tracked here because only the stream can observe it, and the retry rule
   * depends on it: once a chunk has been yielded, a failure must be surfaced rather than
   * retried.
   */
  async function* consume(response, context) {
    const { signal } = context
    /** @type {Map<number, { id?: string, name?: string, args: string }>} */
    const toolCalls = new Map()
    let finishReason
    let terminated = false
    let sawContent = false
    let sawToolCall = false
    let firstChunk = true
    let usageEmitted = false
    let delivered = false

    for await (const frame of readSse(response.body, {
      signal,
      idleTimeoutMs: firstChunk ? context.firstTokenMs : context.chunkMs,
    })) {
      firstChunk = false
      if (frame.data === '[DONE]') {
        terminated = true
        break
      }
      let payload
      try {
        payload = JSON.parse(frame.data)
      } catch {
        continue
      }

      if (payload?.error !== undefined) {
        const message = typeof payload.error?.message === 'string' ? payload.error.message : JSON.stringify(payload.error)
        const kind = context.classifyInBand(message)
        // In-band errors rotate only while nothing has reached the caller. After that the
        // answer would be duplicated, so the failure stands.
        if (!delivered && context.canRotateInBand && context.shouldRotate(kind)) {
          if (context.recordsCooldown(kind) && context.entry !== undefined) {
            // Surfaced as a queue error so the wrapper can rotate without losing the cause.
            throw new AccountError(`${provider}: in-band error (${kind})`, ACCOUNT_ERROR_CODES.QUEUE, { status: 200 })
          }
          throw new AccountError(`${provider}: in-band error (${kind})`, ACCOUNT_ERROR_CODES.QUEUE, { status: 200 })
        }
        throw new AccountError(`${provider}: ${message}`, context.errorCode(200, message, kind), { status: 200 })
      }

      const choice = payload?.choices?.[0]
      if (choice === undefined) {
        const usage = readUsage(payload?.usage)
        if (usage !== undefined && !usageEmitted) {
          usageEmitted = true
          delivered = true
          yield { type: CHUNK.USAGE, ...usage }
        }
        continue
      }

      const piece = choice.delta ?? {}
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
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason
      const usage = readUsage(payload.usage)
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
      finishReason: finishReason === undefined ? undefined : mapFinishReason(finishReason, sawToolCall),
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

  return { provider, stream, warn }
}
