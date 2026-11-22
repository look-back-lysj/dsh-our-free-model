/**
 * ZCode channel: the adapter, with the on-demand captcha policy and a two-clock timeout.
 *
 * ## Two clocks, not one
 *
 * A long reasoning turn legitimately sends nothing for minutes. A stalled connection also
 * sends nothing. A single overall deadline cannot tell them apart, so it either kills
 * legitimate turns or waits forever on a dead socket. This adapter keeps a wall-clock request
 * deadline *and* a per-read idle window; the idle window is what distinguishes thinking from
 * silence.
 *
 * ## Captcha per attempt, not per turn
 *
 * A captcha parameter is single-use. Reusing one across retries produces a rejection that
 * looks like the captcha was wrong rather than already spent, so every attempt that needs one
 * mints a fresh one.
 *
 * @module src/accounts/providers/zcode/adapter
 */

import { AccountError, ACCOUNT_ERROR_CODES } from '../../core/errors.js'
import {
  CHUNK,
  collectImageRefs,
  normalizeMessages,
  readSse,
  readWithIdleTimeout,
  settleStream,
  toAnthropicMessages,
  toAnthropicTools,
} from '../../core/wire.js'
import {
  buildSystemBlocks,
  CaptchaRequirements,
  classifyHttp,
  DEFAULT_CREDENTIAL_REF,
  FALLBACK_MODELS,
  FAST_EMPTY_MS,
  HOSTS,
  isCaptchaRejected,
  isConcurrencyLimited,
  isQuotaExhausted,
  mapErrorCode,
  mapStopReason,
  PATHS,
  PROVIDER_ID,
  recordsCooldown,
  shouldRotate,
  sortLevels,
  TUNING,
} from './product.js'

/**
 * Create the adapter.
 *
 * @param {object} deps
 * @param {typeof fetch} deps.fetch
 * @param {{ resolve: Function, set: Function }} deps.credentials
 * @param {(ref: string) => string} deps.credentialRef
 * @param {object} [deps.accountPool]
 * @param {(spec: { accountId?: string, model: string }) => Promise<Record<string, string> | undefined>} [deps.mintCaptcha]
 * @param {() => number} [deps.now]
 * @param {(message: string) => void} [deps.warn]
 * @returns {object}
 */
export function createZcodeAdapter(deps) {
  const {
    fetch: fetchImpl,
    credentials,
    credentialRef,
    accountPool,
    mintCaptcha,
    now = () => Date.now(),
    warn = () => {},
  } = deps

  const captcha = new CaptchaRequirements({ now })

  /**
   * Resolve a credential.
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
   * Refresh by re-minting through the OAuth CLI flow.
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
    if (typeof parsed.zcode_jwt !== 'string' || parsed.zcode_jwt.length === 0) {
      throw new AccountError(`${PROVIDER_ID}: the credential carries no token to re-mint`, ACCOUNT_ERROR_CODES.AUTH)
    }
    const response = await fetchImpl(`${HOSTS.origin}${PATHS.oauthInit}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: parsed.zcode_jwt }),
    })
    if (!response.ok) {
      throw new AccountError(`${PROVIDER_ID}: token re-mint failed (${response.status})`, ACCOUNT_ERROR_CODES.AUTH, { status: response.status })
    }
    const body = await response.json().catch(() => ({}))
    const next = body?.data ?? body
    if (typeof next?.zcode_jwt !== 'string' && typeof next?.access_token !== 'string') {
      throw new AccountError(`${PROVIDER_ID}: re-mint returned no token`, ACCOUNT_ERROR_CODES.AUTH)
    }
    await credentials.set(ref, JSON.stringify({
      ...parsed,
      ...(typeof next.zcode_jwt === 'string' ? { zcode_jwt: next.zcode_jwt } : {}),
      ...(typeof next.access_token === 'string' ? { access_token: next.access_token } : {}),
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
    const normalized = normalizeMessages(input.messages)
    const imageRefs = collectImageRefs(input.messages)
    if (imageRefs.size > 0 && entry?.supportsImage !== true) {
      throw new AccountError(`${PROVIDER_ID}: model "${model}" does not accept image input`, 'UNSUPPORTED_CONTENT')
    }

    const resolved = await resolve(model)
    const accountId = resolved.entry?.id ?? 'default'
    const deadline = now() + (input.requestTimeoutMs ?? TUNING.requestTimeoutMs)

    let concurrencyAttempt = 0
    let captchaAttempt = 0
    let quotaRound = 0
    let probeRejected = false

    for (;;) {
      if (now() >= deadline) {
        throw new AccountError(`${PROVIDER_ID}: request deadline exceeded`, ACCOUNT_ERROR_CODES.TRANSPORT)
      }
      signal?.throwIfAborted?.()

      // Mint only when this account and model are known to need one, or this attempt was
      // already rejected. A captcha parameter is single-use, so each attempt mints fresh.
      const needsCaptcha = captcha.required(accountId, model) || probeRejected
      let captchaHeaders
      if (needsCaptcha) {
        if (mintCaptcha === undefined) {
          throw new AccountError(`${PROVIDER_ID}: this account needs a captcha but no minting bridge is wired`, ACCOUNT_ERROR_CODES.RATE_LIMIT)
        }
        captchaHeaders = await mintCaptcha({ accountId: resolved.entry?.id, model })
      }

      const body = {
        model,
        max_tokens: input.maxTokens ?? 8192,
        stream: true,
        messages: toAnthropicMessages(normalized.turns),
        ...(normalized.system.length > 0 ? { system: buildSystemBlocks(normalized.system) } : {}),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.stop === undefined ? {} : { stop_sequences: input.stop }),
        ...(input.tools === undefined
          ? {}
          : { tools: toAnthropicTools(input.tools, { cacheLast: TUNING.toolCacheBreakpoint }) }),
        ...(input.reasoningEffort === undefined ? {} : { output_config: { effort: input.reasoningEffort } }),
      }

      let response
      try {
        response = await fetchImpl(`${HOSTS.origin}${PATHS.startPlanInfer}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${resolved.credential.zcode_jwt ?? resolved.credential.access_token ?? ''}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'anthropic-version': '2023-06-01',
            ...(captchaHeaders ?? {}),
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

      const startedAt = now()
      if (!response.ok) {
        const text = await response.text().catch(() => '')

        if (isCaptchaRejected(text)) {
          // Record the requirement and retry with a fresh captcha, bounded.
          captcha.markRequired(accountId, model)
          probeRejected = true
          captchaAttempt += 1
          if (captchaAttempt > TUNING.concurrencyRetryMax) {
            throw new AccountError(`${PROVIDER_ID}: captcha rejected repeatedly`, ACCOUNT_ERROR_CODES.RATE_LIMIT, { status: response.status })
          }
          continue
        }

        if (isConcurrencyLimited(text)) {
          concurrencyAttempt += 1
          if (concurrencyAttempt > TUNING.concurrencyRetryMax) {
            throw new AccountError(`${PROVIDER_ID}: still concurrency-limited after retries`, ACCOUNT_ERROR_CODES.RATE_LIMIT, { status: response.status })
          }
          await new Promise(resolveWait => setTimeout(resolveWait, TUNING.concurrencyRetryBaseMs * concurrencyAttempt))
          continue
        }

        const kind = classifyHttp(response.status, text)
        if (kind === 'quota-exceeded') {
          if (accountPool !== undefined && resolved.entry !== undefined) {
            await accountPool.updateModelRateLimit(resolved.entry.id, model, now() + 86_400_000)
          }
          quotaRound += 1
          if (accountPool !== undefined && quotaRound <= TUNING.quotaSwitchMax) {
            const next = await accountPool.getAvailableAccount(PROVIDER_ID, model, new Set([resolved.entry?.id]))
            if (next !== null && next !== undefined) {
              yield* stream({ ...input, __accountOverride: next })
              return
            }
          }
          throw new AccountError(`${PROVIDER_ID}: allowance exhausted for ${model}`, ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED, { status: response.status })
        }

        throw new AccountError(
          `${PROVIDER_ID}: ${text.trim().slice(0, 400) || `HTTP ${response.status}`} (${response.status}/${kind})`,
          mapErrorCode(response.status, text, kind),
          { status: response.status },
        )
      }

      // A fast empty response is a distinct failure: it is not a slow model producing nothing,
      // it is a request that never really started.
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        const text = await response.text().catch(() => '')
        if (now() - startedAt < FAST_EMPTY_MS && text.trim().length === 0) {
          throw new AccountError(`${PROVIDER_ID}: the provider answered empty`, ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED, { status: response.status })
        }
        throw new AccountError(`${PROVIDER_ID}: unexpected response body`, ACCOUNT_ERROR_CODES.SERVER, { status: response.status })
      }

      try {
        yield* consume(response, {
          signal,
          idleTimeoutMs: input.streamIdleTimeoutMs ?? TUNING.streamIdleTimeoutMs,
          accountId,
          model,
          deadline,
        })
      } catch (error) {
        // A raw AbortError from the reader is normalised so callers branch on one vocabulary.
        if (signal?.aborted === true) {
          throw new AccountError(`${PROVIDER_ID}: request aborted`, ACCOUNT_ERROR_CODES.ABORTED, { cause: error })
        }
        throw error
      }
      return
    }
  }

  /** Consume the Anthropic-shaped stream. */
  async function* consume(response, context) {
    const { signal } = context
    /** @type {Map<number, { id?: string, name?: string, args: string }>} */
    const blocks = new Map()
    let stopReason
    let sawContent = false
    let sawToolUse = false
    let usage = {}
    let usageEmitted = false
    let terminated = false
    let succeededWithoutCaptcha = false

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        if (now() >= context.deadline) {
          throw new AccountError(`${PROVIDER_ID}: request deadline exceeded mid-stream`, ACCOUNT_ERROR_CODES.TRANSPORT)
        }
        const step = await readWithIdleTimeout(reader, context.idleTimeoutMs, signal)
        if (step.done === true) {
          // A residual frame without a trailing blank line is still a frame.
          if (buffer.trim().length > 0) {
            for (const chunk of handleFrame(buffer, context)) yield chunk
          }
          break
        }
        buffer += decoder.decode(step.value, { stream: true })
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          // `handleFrame` returns a list of chunks for one frame: a single delta frame can
          // produce none, and a terminal frame produces a finish chunk. Yielding the list
          // itself would hand the caller an array instead of a chunk.
          for (const chunk of handleFrame(raw, context)) {
            if (chunk.type === 'finish') {
              terminated = true
              yield chunk
              return
            }
            yield chunk
          }
        }
      }
    } finally {
      try { await reader.cancel() } catch { /* already closed */ }
      try { reader.releaseLock() } catch { /* already released */ }
    }

    function handleFrame(raw, ctx) {
      const lines = raw.split(/\r?\n/)
      let event = ''
      const data = []
      for (const line of lines) {
        if (line.length === 0 || line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
      }
      if (data.length === 0) return []
      let payload
      try {
        payload = JSON.parse(data.join('\n'))
      } catch {
        return []
      }

      if (event === 'error' || payload?.type === 'error') {
        const kind = payload?.error?.type === 'overloaded_error' ? 'soft-rate' : 'server'
        throw new AccountError(`${PROVIDER_ID}: ${payload?.error?.message ?? 'stream error'}`, mapErrorCode(200, '', kind), { status: 200 })
      }

      if (payload?.type === 'message_start') {
        if (payload.message?.usage !== undefined) usage = { ...usage, ...payload.message.usage }
        return []
      }
      if (payload?.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
        blocks.set(payload.index, { id: payload.content_block.id, name: payload.content_block.name, args: '' })
        sawToolUse = true
        return []
      }
      if (payload?.type === 'content_block_delta') {
        const piece = payload.delta
        if (piece?.type === 'text_delta' && typeof piece.text === 'string' && piece.text.length > 0) {
          sawContent = true
          succeededWithoutCaptcha = true
          return [{ type: CHUNK.TEXT, text: piece.text }]
        }
        if (piece?.type === 'thinking_delta' && typeof piece.thinking === 'string' && piece.thinking.length > 0) {
          sawContent = true
          return [{ type: CHUNK.REASONING, text: piece.thinking }]
        }
        if (piece?.type === 'input_json_delta' && typeof piece.partial_json === 'string') {
          const current = blocks.get(payload.index)
          if (current !== undefined) {
            current.args += piece.partial_json
            return [{ type: CHUNK.TOOL_DELTA, index: payload.index, argumentsDelta: piece.partial_json }]
          }
        }
        return []
      }
      if (payload?.type === 'message_delta') {
        if (typeof payload.delta?.stop_reason === 'string') stopReason = payload.delta.stop_reason
        if (payload.usage !== undefined) usage = { ...usage, ...payload.usage }
        return []
      }
      if (payload?.type === 'message_stop') {
        // Success without a captcha means the requirement is gone; clear it so the next turn
        // does not mint one speculatively.
        if (succeededWithoutCaptcha) captcha.clear(ctx.accountId, ctx.model)
        return []
      }
      // Every branch returns a list so the caller can iterate unconditionally; an unknown
      // frame type contributes nothing.
      return []
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

    if (!usageEmitted && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
      usageEmitted = true
      const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
      const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
      yield {
        type: CHUNK.USAGE,
        inputTokens: input,
        outputTokens: output,
        ...(input > 0 && output > 0 ? { totalTokens: input + output } : {}),
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
        token = available?.credential?.zcode_jwt ?? available?.credential?.access_token
      }
      if (token === undefined) {
        const stored = await credentials.resolve(credentialRef(DEFAULT_CREDENTIAL_REF))
        token = stored === undefined ? undefined : (JSON.parse(stored.value).zcode_jwt ?? JSON.parse(stored.value).access_token)
      }
    } catch {
      token = undefined
    }
    if (token === undefined) return FALLBACK_MODELS.map(row => ({ ...row }))
    try {
      const response = await fetchImpl(`${HOSTS.origin}/api/v1/client/configs`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal,
      })
      if (!response.ok) return FALLBACK_MODELS.map(row => ({ ...row }))
      const body = await response.json()
      const rows = body?.data?.models ?? body?.models
      if (!Array.isArray(rows) || rows.length === 0) return FALLBACK_MODELS.map(row => ({ ...row }))
      return rows.map(row => {
        const id = typeof row?.id === 'string' ? row.id : row?.name
        if (typeof id !== 'string' || id.length === 0) return undefined
        const curated = FALLBACK_MODELS.find(model => model.id === id)
        return {
          id,
          name: typeof row.display_name === 'string' ? row.display_name : (curated?.name ?? id),
          contextWindow: typeof row.limit?.context === 'number' ? row.limit.context : (curated?.contextWindow ?? 200_000),
          maxTokens: typeof row.limit?.output === 'number' ? row.limit.output : (curated?.maxTokens ?? 32_768),
          supportsImage: Array.isArray(row.modalities?.input)
            ? row.modalities.input.includes('image')
            : curated?.supportsImage === true,
          ...(Array.isArray(row.reasoning_levels) && row.reasoning_levels.length > 0
            ? { reasoningLevels: sortLevels(row.reasoning_levels), defaultReasoningLevel: row.default_reasoning_level ?? 'max' }
            : curated === undefined ? {} : { reasoningLevels: [...curated.reasoningLevels], defaultReasoningLevel: curated.defaultReasoningLevel }),
        }
      }).filter(row => row !== undefined)
    } catch (error) {
      warn(`[${PROVIDER_ID}] model listing failed, using the static table: ${String(error)}`)
      return FALLBACK_MODELS.map(row => ({ ...row }))
    }
  }

  return {
    provider: PROVIDER_ID,
    stream,
    listModels,
    refresh,
    /** Exposed for the panel and for tests: the live captcha requirement state. */
    captchaRequirements: () => captcha.size(),
    tuning: TUNING,
  }
}
