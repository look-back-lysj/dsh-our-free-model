/**
 * Gemini channel: the adapter over the contents wire and its two-layer envelope.
 *
 * ## The envelope
 *
 * Every request is `{ model, project, request: { contents, ... }, requestId, userAgent }`, and
 * every streamed frame is `{ response: { candidates, usageMetadata } }` (or the bare inner
 * object). Both layers have to be unwrapped, and the request has to be serialized with keys in
 * alphabetical order at every level.
 *
 * ## The control flow, in the order the contract fixes
 *
 * A signature-looking rejection drops the signatures and retries once, because a signature can
 * go stale and the unsigned request is still valid. A session overflow bumps the session
 * generation once. Then endpoint switching, then a single credential refresh, then rotation.
 * Each of those steps is bounded to one attempt, so a persistently broken account fails with a
 * clear cause instead of looping.
 *
 * @module src/accounts/providers/gemini/adapter
 */

import { AccountError, ACCOUNT_ERROR_CODES } from '../../core/errors.js'
import { CHUNK, collectImageRefs, flattenText, normalizeMessages, readWithIdleTimeout, settleStream } from '../../core/wire.js'
import {
  AUTH_COOLDOWN_MS,
  canonicalModelId,
  classifyFailure,
  DEFAULT_CREDENTIAL_REF,
  deriveSessionId,
  ENDPOINTS,
  FALLBACK_MODELS,
  IDENTITY_HEADERS,
  IDLE_TIMEOUT_MS,
  isContextOverflow,
  isEndpointProblem,
  isQuotaLike,
  isSessionOverflow,
  LOAD_CODE_ASSIST_BODY,
  looksLikeSignatureError,
  mapErrorCode,
  marshalAlphabetical,
  MAX_OUTPUT_TOKENS,
  MAX_ROTATIONS,
  MODEL_ID,
  modelSpec,
  PATHS,
  PROBE_ENDPOINTS,
  PROVIDER_ID,
  RATE_LIMIT_COOLDOWN_MS,
  REQUEST_TIMEOUT_MS,
  readQuota,
  SignatureCache,
} from './product.js'

/**
 * Create the adapter.
 *
 * @param {object} deps
 * @param {typeof fetch} deps.fetch
 * @param {{ resolve: Function, set: Function }} deps.credentials
 * @param {(ref: string) => string} deps.credentialRef
 * @param {object} [deps.accountPool]
 * @param {SignatureCache} [deps.signatureCache]
 * @param {() => number} [deps.now]
 * @param {(message: string) => void} [deps.warn]
 * @returns {object}
 */
export function createGeminiAdapter(deps) {
  const {
    fetch: fetchImpl,
    credentials,
    credentialRef,
    accountPool,
    signatureCache = new SignatureCache(),
    now = () => Date.now(),
    warn = () => {},
  } = deps

  /** Project ids, cached per account for the process lifetime. */
  const projectCache = new Map()
  /** Session generations, keyed by base id. */
  const sessionGenerations = new Map()

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
   * Refresh the OAuth token with its refresh-token grant.
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
    const response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: parsed.refresh_token,
        client_id: process.env.CMDC_PAK_GOOGLE_CLIENT_ID ?? '',
        client_secret: process.env.CMDC_PAK_GOOGLE_CLIENT_SECRET ?? '',
      }).toString(),
    })
    if (!response.ok) {
      throw new AccountError(`${PROVIDER_ID}: token refresh failed (${response.status})`, ACCOUNT_ERROR_CODES.AUTH, { status: response.status })
    }
    const body = await response.json().catch(() => ({}))
    if (typeof body?.access_token !== 'string') {
      throw new AccountError(`${PROVIDER_ID}: refresh returned no access token`, ACCOUNT_ERROR_CODES.AUTH)
    }
    await credentials.set(ref, JSON.stringify({
      ...parsed,
      access_token: body.access_token,
      ...(typeof body.expires_in === 'number' ? { expires_at: new Date(now() + body.expires_in * 1000).toISOString() } : {}),
    }))
    // The project binding can change with the token, so the cached probe is dropped.
    if (accountId !== undefined) projectCache.delete(accountId)
  }

  /**
   * Probe the Cloud Code project for an account.
   *
   * The probe order is sandbox-then-daily, which is the reverse of inference. A failed probe
   * means inference is not sent at all: sending it would fail with an error that blames the
   * model instead of the missing project binding.
   *
   * @param {{ accountId: string, credential: Record<string, any>, signal?: AbortSignal }} spec
   * @returns {Promise<string>}
   */
  async function resolveProject({ accountId, credential, signal }) {
    const cached = projectCache.get(accountId)
    if (cached !== undefined) return cached
    const fromCredential = typeof credential.project === 'string' && credential.project.length > 0 ? credential.project : undefined
    if (fromCredential !== undefined) {
      projectCache.set(accountId, fromCredential)
      return fromCredential
    }
    for (const endpoint of PROBE_ENDPOINTS) {
      try {
        const response = await fetchImpl(`${endpoint}${PATHS.loadCodeAssist}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${credential.access_token ?? ''}`,
            'content-type': 'application/json',
            ...IDENTITY_HEADERS,
          },
          body: LOAD_CODE_ASSIST_BODY,
          signal,
        })
        if (!response.ok) continue
        const body = await response.json().catch(() => ({}))
        const project = body?.cloudaicompanionProject ?? body?.response?.cloudaicompanionProject
        if (typeof project === 'string' && project.length > 0) {
          projectCache.set(accountId, project)
          return project
        }
      } catch (error) {
        if (signal?.aborted === true) throw error
        warn(`[${PROVIDER_ID}] project probe against ${endpoint} failed: ${String(error)}`)
      }
    }
    throw new AccountError(`${PROVIDER_ID}: could not determine the Cloud Code project`, ACCOUNT_ERROR_CODES.AUTH)
  }

  /**
   * Run one streaming turn.
   *
   * @param {object} input
   * @returns {AsyncGenerator<Record<string, any>>}
   */
  async function* stream(input) {
    const { model, signal } = input
    const spec = modelSpec(model, input.reasoningEffort)
    const normalized = normalizeMessages(input.messages)
    const imageRefs = collectImageRefs(input.messages)

    const resolved = await resolve(model)
    const accountId = resolved.entry?.id ?? 'default'
    const project = await resolveProject({ accountId, credential: resolved.credential, signal })

    const baseSessionId = deriveSessionId({
      project,
      lane: 'infer',
      firstUserText: firstUserText(normalized.turns),
    })
    // Mutable: a session-overflow bump has to affect the very next attempt of this turn.
    let generation = sessionGenerations.get(baseSessionId) ?? 0

    let endpointIndex = 0
    let refreshed = false
    let signatureRetried = false
    let sessionBumped = false
    let droppedSignatures = false
    let rotations = 0
    let activeCredential = resolved.credential
    let activeEntry = resolved.entry

    for (;;) {
      signal?.throwIfAborted?.()
      const endpoint = ENDPOINTS[endpointIndex] ?? ENDPOINTS[0]
      const body = marshalAlphabetical({
        model: spec.upstream,
        project,
        request: buildRequest({
          turns: normalized.turns,
          system: normalized.system,
          spec,
          sessionId: baseSessionId,
          sessionGeneration: generation,
          project,
          firstUserText: firstUserText(normalized.turns),
          maxTokens: input.maxTokens ?? MAX_OUTPUT_TOKENS,
          temperature: input.temperature,
          tools: input.tools,
          signatureCache,
          dropSignatures: droppedSignatures,
          imageRefs,
          resolveImage: input.resolveImage,
        }),
        requestId: `ofm-${now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        userAgent: IDENTITY_HEADERS['User-Agent'],
      })

      let response
      try {
        response = await fetchImpl(`${endpoint}${PATHS.stream}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${activeCredential.access_token ?? ''}`,
            'content-type': 'application/json',
            ...IDENTITY_HEADERS,
          },
          body,
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

        // 1. A signature rejection: drop signatures and retry once.
        if (looksLikeSignatureError(text) && !signatureRetried) {
          signatureRetried = true
          droppedSignatures = true
          continue
        }

        // 2. A session overflow: bump the generation once and retry.
        if (isSessionOverflow(text) && !sessionBumped) {
          sessionBumped = true
          generation += 1
          sessionGenerations.set(baseSessionId, generation)
          continue
        }

        // 3. A context overflow is the caller's problem, not the account's.
        if (isContextOverflow(text) && response.status === 400) {
          throw new AccountError(`${PROVIDER_ID}: the conversation exceeds the context window`, 'CONTEXT_WINDOW_EXCEEDED', { status: 400 })
        }

        // 4. An endpoint problem switches endpoint once.
        if (isEndpointProblem(response.status, text) && endpointIndex + 1 < ENDPOINTS.length) {
          endpointIndex += 1
          continue
        }

        // 5. A single credential refresh.
        if (response.status === 401 && !refreshed) {
          refreshed = true
          try {
            await refresh({ accountId: activeEntry?.id })
            activeCredential = JSON.parse((await credentials.resolve(
              activeEntry === undefined
                ? credentialRef(DEFAULT_CREDENTIAL_REF)
                : credentialRef(String(activeEntry.id).toUpperCase().replace(/-/g, '_')),
            ))?.value ?? '{}')
            continue
          } catch (error) {
            throw new AccountError(`${PROVIDER_ID}: authentication failed and the refresh did not help`, ACCOUNT_ERROR_CODES.AUTH, { status: 401, cause: error })
          }
        }

        // 6. Rotation.
        const quotaLike = isQuotaLike(response.status, text)
        if ((quotaLike || response.status === 401 || isEndpointProblem(response.status, text))
          && accountPool !== undefined && activeEntry !== undefined && rotations < MAX_ROTATIONS) {
          rotations += 1
          const cooldown = quotaLike ? RATE_LIMIT_COOLDOWN_MS : AUTH_COOLDOWN_MS
          await accountPool.updateModelRateLimit(activeEntry.id, model, now() + cooldown)
          const next = await accountPool.getAvailableAccount(PROVIDER_ID, model, new Set([activeEntry.id]))
          if (next !== null && next !== undefined) {
            activeEntry = next.entry
            activeCredential = next.credential
            // Per-account state resets with the account.
            endpointIndex = 0
            refreshed = false
            signatureRetried = false
            sessionBumped = false
            droppedSignatures = false
            continue
          }
          throw new AccountError(`${PROVIDER_ID}: every account is limited for ${model}`, ACCOUNT_ERROR_CODES.QUOTA_EXCEEDED, { status: response.status })
        }

        const kind = classifyFailure(response.status, text)
        throw new AccountError(
          `${PROVIDER_ID}: ${text.trim().slice(0, 400) || `HTTP ${response.status}`} (${response.status}/${kind})`,
          mapErrorCode(response.status, text, kind),
          { status: response.status },
        )
      }

      try {
        yield* consume(response, {
          signal,
          idleTimeoutMs: input.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
          deadline: now() + (input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
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

  /** Consume the streamed envelope frames. */
  async function* consume(response, context) {
    const { signal } = context
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sawContent = false
    let sawToolCall = false
    let finishReason
    let bestUsage
    let bestTotal = -1
    let terminated = false

    /**
     * Read one SSE frame's parsed payload.
     *
     * The upstream sends one `data:` line per frame and ignores `[DONE]`, so that marker
     * contributes nothing. Comment lines and `event:` lines carry no payload here.
     */
    function readFrame(raw) {
      const data = []
      for (const line of raw.split(/\r?\n/)) {
        if (line.length === 0 || line.startsWith(':') || line.startsWith('event:')) continue
        if (!line.startsWith('data:')) continue
        data.push(line.slice(5).replace(/^ /, ''))
      }
      if (data.length === 0) return undefined
      const joined = data.join('\n')
      if (joined === '[DONE]') return undefined
      try {
        return JSON.parse(joined)
      } catch {
        return undefined
      }
    }

    /**
     * Turn one parsed frame into the chunks it contributes.
     *
     * Returns a list rather than yielding, because the caller needs to observe a terminal
     * frame and stop reading; a nested generator could not hand that signal back.
     */
    function frameChunks(payload) {
      /** @type {Array<Record<string, any>>} */
      const chunks = []
      // Two-layer envelope: the inner object is either wrapped in `response` or bare.
      const inner = payload?.response ?? payload
      if (inner === null || typeof inner !== 'object') return chunks

      for (const candidate of Array.isArray(inner.candidates) ? inner.candidates : []) {
        for (const part of candidate?.content?.parts ?? []) {
          if (typeof part?.text === 'string' && part.text.length > 0) {
            sawContent = true
            chunks.push({ type: part.thought === true ? CHUNK.REASONING : CHUNK.TEXT, text: part.text })
          }
          if (part?.functionCall !== undefined) {
            sawToolCall = true
            const name = part.functionCall.name
            const args = part.functionCall.args ?? {}
            // The signature is cross-turn state: store it against the exact call so the next
            // turn can replay it.
            if (typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0) {
              signatureCache.store(name, args, part.thoughtSignature)
            }
            chunks.push({
              type: CHUNK.TOOL_CALL,
              id: `call_${name}_${JSON.stringify(args).length}`,
              name,
              arguments: JSON.stringify(args),
            })
          }
        }
        if (typeof candidate?.finishReason === 'string') finishReason = candidate.finishReason
      }

      if (inner.usageMetadata !== undefined) {
        // Keep the frame with the greatest total: the count is cumulative and an early frame
        // would understate it.
        const total = typeof inner.usageMetadata.totalTokenCount === 'number' ? inner.usageMetadata.totalTokenCount : -1
        if (total >= bestTotal) {
          bestTotal = total
          bestUsage = inner.usageMetadata
        }
      }
      return chunks
    }

    try {
      read: for (;;) {
        if (now() >= context.deadline) {
          throw new AccountError(`${PROVIDER_ID}: request deadline exceeded`, ACCOUNT_ERROR_CODES.TRANSPORT)
        }
        const step = await readWithIdleTimeout(reader, context.idleTimeoutMs, signal)
        if (step.done === true) {
          // A residual frame without a trailing blank line is still a frame.
          if (buffer.trim().length > 0) {
            const tail = readFrame(buffer)
            if (tail !== undefined) for (const chunk of frameChunks(tail)) yield chunk
          }
          break
        }
        buffer += decoder.decode(step.value, { stream: true })
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const frame = readFrame(raw)
          if (frame === undefined) continue
          for (const chunk of frameChunks(frame)) yield chunk
          if (finishReason !== undefined) {
            terminated = true
            break read
          }
        }
      }
    } finally {
      try { await reader.cancel() } catch { /* already closed */ }
      try { reader.releaseLock() } catch { /* already released */ }
    }

    if (bestUsage !== undefined) {
      const input = typeof bestUsage.promptTokenCount === 'number' ? bestUsage.promptTokenCount : 0
      const output = typeof bestUsage.candidatesTokenCount === 'number' ? bestUsage.candidatesTokenCount : 0
      yield {
        type: CHUNK.USAGE,
        inputTokens: input,
        outputTokens: output,
        ...(typeof bestUsage.totalTokenCount === 'number' ? { totalTokens: bestUsage.totalTokenCount } : {}),
      }
    }

    const settled = settleStream({
      finishReason: finishReason === undefined ? undefined : mapGeminiFinish(finishReason, sawToolCall),
      terminated: terminated || finishReason !== undefined,
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
   * List the single exposed model.
   *
   * There is no listing endpoint, so this is static. Reporting an empty list when no account is
   * logged in lets the catalog hide the group without claiming a failure.
   */
  async function listModels() {
    if (accountPool !== undefined) {
      try {
        const available = await accountPool.getAvailableAccount(PROVIDER_ID, '')
        if (available === null || available === undefined) return []
      } catch {
        return FALLBACK_MODELS.map(row => ({ ...row }))
      }
    }
    return FALLBACK_MODELS.map(row => ({ ...row }))
  }

  /**
   * Read the quota windows.
   *
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function quota({ signal } = {}) {
    const resolved = await resolve('')
    const accountId = resolved.entry?.id ?? 'default'
    const project = await resolveProject({ accountId, credential: resolved.credential, signal })
    const response = await fetchImpl(`${ENDPOINTS[1]}${PATHS.quota}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${resolved.credential.access_token ?? ''}`,
        'content-type': 'application/json',
        ...IDENTITY_HEADERS,
      },
      body: marshalAlphabetical({ project }),
      signal,
    })
    if (!response.ok) {
      throw new AccountError(`${PROVIDER_ID}: quota query failed (${response.status})`, ACCOUNT_ERROR_CODES.SERVER, { status: response.status })
    }
    return readQuota(await response.json())
  }

  return {
    provider: PROVIDER_ID,
    stream,
    listModels,
    quota,
    refresh,
    signatureCache,
    modelId: MODEL_ID,
  }
}

/**
 * Build the inner `request` object.
 *
 * @param {object} spec
 * @returns {Record<string, unknown>}
 */
function buildRequest(spec) {
  const contents = []
  for (const turn of spec.turns) {
    const role = turn.role === 'assistant' ? 'model' : 'user'
    if (turn.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: turn.toolName ?? 'tool',
            response: { content: flattenText(turn.content) },
          },
        }],
      })
      continue
    }
    const parts = []
    const text = flattenText(turn.content)
    if (text.length > 0) parts.push({ text })
    for (const call of turn.toolCalls ?? []) {
      const args = typeof call.arguments === 'string' ? safeParse(call.arguments) : call.arguments ?? {}
      const part = { functionCall: { name: call.name, args } }
      if (!spec.dropSignatures) {
        const signature = spec.signatureCache.lookup(call.name, args)
          ?? spec.signatureCache.latestForTool(call.name)
        // The signature must be attached to the functionCall part, or the upstream rejects the
        // multi-turn tool conversation.
        if (signature !== undefined) part.thoughtSignature = signature
      }
      parts.push(part)
    }
    if (Array.isArray(turn.content)) {
      for (const piece of turn.content) {
        if (piece?.type !== 'image') continue
        const id = piece.attachment?.attachmentId
        const inline = typeof id === 'string' ? spec.resolveImage?.(id) : undefined
        if (inline !== undefined) {
          parts.push({ inlineData: { mimeType: inline.mediaType, data: inline.data } })
        }
      }
    }
    if (parts.length === 0) parts.push({ text: '' })
    contents.push({ role, parts })
  }

  /** @type {Record<string, unknown>} */
  const request = {
    contents,
    generationConfig: {
      maxOutputTokens: spec.maxTokens,
      thinkingConfig: {
        includeThoughts: true,
        // A tiered request omits the budget so the provider decides.
        ...(spec.spec.tier === 'tiered' ? {} : { thinkingBudget: spec.spec.thinkingBudget }),
      },
      ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }),
    },
    sessionId: spec.sessionGeneration > 0
      ? deriveSessionId({ project: spec.project, lane: 'infer', firstUserText: spec.firstUserText, generation: spec.sessionGeneration })
      : spec.sessionId,
  }
  if (spec.system.length > 0) {
    request.systemInstruction = { parts: [{ text: spec.system.join('\n\n') }] }
  }
  if (Array.isArray(spec.tools) && spec.tools.length > 0) {
    request.tools = [{
      functionDeclarations: spec.tools.map(tool => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: tool.inputSchema ?? tool.parameters ?? { type: 'object', properties: {} },
      })),
    }]
    request.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }
  }
  return request
}

/**
 * Map a Gemini finish reason.
 *
 * @param {string} reason
 * @param {boolean} sawToolCall
 * @returns {string}
 */
function mapGeminiFinish(reason, sawToolCall) {
  if (sawToolCall) return 'tool-calls'
  if (reason === 'MAX_TOKENS') return 'max-tokens'
  return 'stop'
}

/** The first non-empty user text, used to key the session id. */
function firstUserText(turns) {
  for (const turn of turns) {
    if (turn.role !== 'user') continue
    const text = flattenText(turn.content).trim()
    if (text.length > 0) return text
  }
  return ''
}

/** @param {string} text */
function safeParse(text) {
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/** A stable length used to make a synthetic tool-call id. */
function canonicalLength(args) {
  return JSON.stringify(args ?? {}).length
}

export { canonicalModelId }
