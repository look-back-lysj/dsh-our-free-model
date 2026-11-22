/**
 * Shared adapter machinery: message normalisation, SSE consumption, and the wire formats
 * the account channels speak.
 *
 * ## Why this is one module rather than a base class
 *
 * The channels differ in their auth, their model tables and their error vocabulary, but
 * they agree on the parts that are easy to get subtly wrong: how a tool call and its
 * result are paired across turns, how a reasoning delta is separated from answer text,
 * how a truncated stream is recognised, and how usage is attributed. Duplicating that per
 * channel is how the same defect ends up fixed in four places and missed in the fifth.
 *
 * So the shared parts live here and each channel supplies only its own decisions.
 *
 * ## The invariants this module enforces
 *
 * - A tool result is paired with its call by id; an orphan result is dropped rather than
 *   sent, because providers reject unpaired results and the error names the wrong cause.
 * - A stream that ends without a finish signal is reported as truncated, never as a
 *   successful empty answer. An empty success is indistinguishable from a real refusal
 *   and the user has no way to tell.
 * - Usage is only reported when the provider reported it. A missing usage frame is not
 *   zero tokens; claiming zero corrupts every aggregate downstream.
 * - The caller's abort signal reaches the socket read, not just the fetch.
 *
 * @module src/accounts/core/wire
 */

import { AccountError, ACCOUNT_ERROR_CODES } from './errors.js'

/** Chunk kinds the adapters emit. */
export const CHUNK = Object.freeze({
  TEXT: 'text-delta',
  REASONING: 'reasoning-delta',
  TOOL_CALL: 'tool-call',
  TOOL_DELTA: 'tool-call-delta',
  USAGE: 'usage',
})

/**
 * Split a stored message list into roles the wire accepts, keeping tool pairing intact.
 *
 * Rules, all of which a provider will reject if broken:
 * - an assistant tool call keeps its id so the matching result can reference it;
 * - a tool result whose call is not present in the outgoing window is dropped — sending
 *   it produces "unknown tool_call_id", which reads like a protocol bug rather than a
 *   history-trimming artifact;
 * - a system message is hoisted out of the sequence when the wire carries it separately.
 *
 * @param {Array<Record<string, any>>} messages
 * @returns {{ system: string[], turns: Array<Record<string, any>>, droppedResults: number }}
 */
export function normalizeMessages(messages) {
  const system = []
  const turns = []
  let droppedResults = 0
  /** @type {Set<string>} */
  const liveCallIds = new Set()

  for (const message of messages ?? []) {
    if (message === null || typeof message !== 'object') continue
    if (message.role === 'system') {
      const text = flattenText(message.content)
      if (text.length > 0) system.push(text)
      continue
    }
    if (message.role === 'tool') {
      const id = message.toolCallId ?? message.tool_call_id
      if (typeof id !== 'string' || !liveCallIds.has(id)) {
        droppedResults += 1
        continue
      }
      turns.push({ ...message, toolCallId: id })
      continue
    }
    if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        if (typeof call?.id === 'string') liveCallIds.add(call.id)
      }
    }
    turns.push(message)
  }
  return { system, turns, droppedResults }
}

/**
 * Flatten a content value to plain text.
 *
 * Handles the three shapes that reach an adapter: a bare string, an array of typed parts,
 * and an object with a `text` field.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function flattenText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        if (part?.type === 'text' && typeof part.text === 'string') return part.text
        return ''
      })
      .join('')
  }
  if (content !== null && typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

/**
 * Collect image attachments referenced by a message list.
 *
 * Returns the ids in encounter order with a stable index, so a caller can inline them and
 * refer to each by the same id the message used.
 *
 * @param {Array<Record<string, any>>} messages
 * @returns {Map<string, { index: number }>}
 */
export function collectImageRefs(messages) {
  const refs = new Map()
  const visit = content => {
    if (!Array.isArray(content)) return
    for (const part of content) {
      if (part?.type !== 'image') continue
      const id = part.attachment?.attachmentId
      if (typeof id === 'string' && !refs.has(id)) refs.set(id, { index: refs.size })
    }
  }
  for (const message of messages ?? []) {
    visit(message?.content)
    if (Array.isArray(message?.toolResults)) {
      for (const result of message.toolResults) visit(result?.content)
    }
  }
  return refs
}

/**
 * Does this request reference any image at all?
 *
 * @param {Array<Record<string, any>>} messages
 * @returns {boolean}
 */
export function hasImages(messages) {
  return collectImageRefs(messages).size > 0
}

/**
 * Split a reasoning block out of content that may interleave reasoning and answer text.
 *
 * Providers disagree about whether reasoning arrives in a separate field or inline as a
 * tagged block. Both shapes must map onto the two chunk kinds without losing text, so an
 * unterminated tag is treated as "still reasoning" rather than dropped.
 *
 * @param {string} text
 * @param {{ inReasoning: boolean }} state - carried across chunks of one stream
 * @returns {Array<{ kind: string, text: string }>}
 */
export function splitReasoning(text, state) {
  const out = []
  let rest = text
  while (rest.length > 0) {
    if (state.inReasoning) {
      const close = rest.indexOf('<｜end▁of▁thinking｜>')
      if (close === -1) {
        if (rest.length > 0) out.push({ kind: CHUNK.REASONING, text: rest })
        rest = ''
        break
      }
      const reasoning = rest.slice(0, close)
      if (reasoning.length > 0) out.push({ kind: CHUNK.REASONING, text: reasoning })
      rest = rest.slice(close + '<｜end▁of▁thinking｜>'.length)
      state.inReasoning = false
      continue
    }
    const open = rest.indexOf(' thinking')
    if (open === -1) {
      if (rest.length > 0) out.push({ kind: CHUNK.TEXT, text: rest })
      rest = ''
      break
    }
    const answer = rest.slice(0, open)
    if (answer.length > 0) out.push({ kind: CHUNK.TEXT, text: answer })
    rest = rest.slice(open + ' thinking'.length)
    state.inReasoning = true
  }
  return out
}

/**
 * Decode an SSE byte stream into `{ event, data }` frames.
 *
 * Handles the three things that break naive parsers: a frame split across chunk
 * boundaries, CRLF versus LF line endings, and a final frame with no trailing blank line.
 * Comment lines (`:`) are skipped, since providers use them as keep-alives.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {{ signal?: AbortSignal, idleTimeoutMs?: number }} [options]
 * @returns {AsyncGenerator<{ event: string, data: string }>}
 */
export async function* readSse(body, { signal, idleTimeoutMs = 120_000 } = {}) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      signal?.throwIfAborted?.()
      const step = await readWithIdleTimeout(reader, idleTimeoutMs, signal)
      if (step.done === true) {
        // A stream can end mid-frame; the residual is still a real frame for providers
        // that omit the trailing blank line.
        const tail = parseFrame(buffer)
        if (tail !== undefined) yield tail
        return
      }
      buffer += decoder.decode(step.value, { stream: true })
      let boundary
      while ((boundary = findBoundary(buffer)) !== undefined) {
        const raw = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        const frame = parseFrame(raw)
        if (frame !== undefined) yield frame
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* already closed */ }
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

/**
 * Find the first frame boundary, tolerating both line-ending conventions.
 *
 * @param {string} buffer
 * @returns {undefined | { index: number, length: number }}
 */
function findBoundary(buffer) {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return undefined
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 }
  return { index: lf, length: 2 }
}

/**
 * Parse one raw frame into an event name and its joined data lines.
 *
 * @param {string} raw
 * @returns {undefined | { event: string, data: string }}
 */
function parseFrame(raw) {
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
  if (data.length === 0 && event === '') return undefined
  return { event, data: data.join('\n') }
}

/**
 * Read from a stream reader, giving up if nothing arrives within the idle window.
 *
 * The idle timeout is separate from any overall deadline: a provider that is thinking for
 * a long time is not stalled, while one that has sent nothing for two minutes is. Without
 * this split, a legitimate long reasoning turn gets killed as a timeout.
 *
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {number} idleMs
 * @param {AbortSignal} [signal]
 * @returns {Promise<ReadableStreamReadResult<Uint8Array>>}
 */
export function readWithIdleTimeout(reader, idleMs, signal) {
  return new Promise((resolve, reject) => {
    // Check before subscribing: an abort that already happened will never fire the listener,
    // so without this the call would sit for the whole idle window on a cancelled turn.
    if (signal?.aborted === true) {
      reject(signal.reason ?? new AccountError('aborted', ACCOUNT_ERROR_CODES.ABORTED))
      return
    }
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, new AccountError(
      `upstream sent nothing for ${idleMs}ms`,
      ACCOUNT_ERROR_CODES.TRANSPORT,
    )), idleMs)
    const onAbort = () => finish(reject, signal?.reason ?? new AccountError('aborted', ACCOUNT_ERROR_CODES.ABORTED))
    signal?.addEventListener('abort', onAbort, { once: true })
    reader.read().then(
      step => finish(resolve, step),
      error => finish(reject, error),
    )
  })
}

/**
 * Attribute usage from a provider payload, keeping "reported" distinct from "zero".
 *
 * Cached and reasoning tokens are reported separately when the provider supplies them,
 * because folding them into the input total makes cost reporting wrong in a way nobody
 * can reconstruct later.
 *
 * @param {Record<string, any> | undefined} raw
 * @returns {undefined | { inputTokens: number, outputTokens: number, totalTokens?: number, cacheReadTokens?: number, reasoningTokens?: number }}
 */
export function readUsage(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return undefined
  const prompt = finiteNumber(raw.prompt_tokens ?? raw.input_tokens)
  const completion = finiteNumber(raw.completion_tokens ?? raw.output_tokens)
  if (prompt === undefined && completion === undefined) return undefined
  const cached = finiteNumber(raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens)
  const reasoning = finiteNumber(raw.completion_tokens_details?.reasoning_tokens ?? raw.reasoning_tokens)
  const out = {
    inputTokens: prompt === undefined ? 0 : Math.max(0, prompt - (cached ?? 0)),
    outputTokens: completion === undefined ? 0 : completion,
  }
  const total = finiteNumber(raw.total_tokens)
  if (total !== undefined) out.totalTokens = total
  if (cached !== undefined) out.cacheReadTokens = cached
  if (reasoning !== undefined) out.reasoningTokens = reasoning
  return out
}

/** @param {unknown} value @returns {number | undefined} */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Map a provider finish reason onto the harness vocabulary.
 *
 * @param {unknown} reason
 * @param {boolean} sawToolCall
 * @returns {'stop' | 'max-tokens' | 'tool-calls' | 'refusal'}
 */
export function mapFinishReason(reason, sawToolCall) {
  if (sawToolCall) return 'tool-calls'
  if (typeof reason !== 'string') return 'stop'
  const lower = reason.toLowerCase()
  if (lower === 'length' || lower === 'max_tokens' || lower === 'max-tokens') return 'max-tokens'
  if (lower === 'tool_calls' || lower === 'tool_use' || lower === 'function_call') return 'tool-calls'
  if (lower === 'content_filter' || lower === 'refusal') return 'refusal'
  return 'stop'
}

/**
 * Decide the verdict for a stream that has ended.
 *
 * A stream with neither a finish reason nor a terminator was cut off. Reporting that as a
 * normal stop would hand the caller a truncated answer that looks complete — the worst
 * possible outcome, because nothing downstream can detect it.
 *
 * @param {{ finishReason?: string, terminated: boolean, sawContent: boolean, sawToolCall: boolean }} state
 * @returns {{ finishReason: string, truncated: boolean, empty: boolean }}
 */
export function settleStream(state) {
  const empty = !state.sawContent && !state.sawToolCall
  if (state.finishReason !== undefined) {
    return { finishReason: state.finishReason, truncated: false, empty }
  }
  if (!state.terminated) {
    // No terminator and no finish reason: the connection dropped mid-answer.
    return { finishReason: state.sawToolCall ? 'tool-calls' : 'max-tokens', truncated: true, empty }
  }
  return { finishReason: state.sawToolCall ? 'tool-calls' : 'stop', truncated: false, empty }
}

/**
 * Build the OpenAI-chat request body for a channel.
 *
 * Field inclusion is conditional because several providers reject unknown fields outright.
 * `stream` is forced on: every channel here streams, and a non-streaming request would
 * need a separate parse path for no benefit.
 *
 * @param {object} spec
 * @param {string} spec.model
 * @param {Array<Record<string, any>>} spec.messages - already normalised turns
 * @param {string[]} [spec.system]
 * @param {Array<Record<string, any>>} [spec.tools]
 * @param {number} [spec.maxTokens]
 * @param {number} [spec.temperature]
 * @param {string[]} [spec.stop]
 * @param {string} [spec.reasoningEffort]
 * @param {Record<string, unknown>} [spec.extra] - provider-specific top-level fields
 * @returns {Record<string, unknown>}
 */
export function buildChatBody({ model, messages, system, tools, maxTokens, temperature, stop, reasoningEffort, extra }) {
  const body = { model, messages: [] }
  for (const text of system ?? []) body.messages.push({ role: 'system', content: text })
  for (const turn of messages) body.messages.push(toChatMessage(turn))
  body.stream = true
  if (tools !== undefined && tools.length > 0) body.tools = tools
  if (maxTokens !== undefined) body.max_tokens = maxTokens
  if (temperature !== undefined) body.temperature = temperature
  if (stop !== undefined && stop.length > 0) body.stop = stop
  if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort
  if (extra !== undefined) Object.assign(body, extra)
  return body
}

/**
 * Convert one normalised turn to the OpenAI chat shape.
 *
 * @param {Record<string, any>} turn
 * @returns {Record<string, unknown>}
 */
export function toChatMessage(turn) {
  if (turn.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: turn.toolCallId,
      content: flattenText(turn.content),
    }
  }
  if (turn.role === 'assistant') {
    const out = { role: 'assistant', content: flattenText(turn.content) }
    if (Array.isArray(turn.toolCalls) && turn.toolCalls.length > 0) {
      out.tool_calls = turn.toolCalls.map(call => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
        },
      }))
    }
    return out
  }
  return { role: turn.role, content: toChatContent(turn.content) }
}

/**
 * Convert user content to the OpenAI part list, or a bare string when text-only.
 *
 * @param {unknown} content
 * @param {(attachmentId: string) => string | undefined} [resolveImageUrl]
 * @returns {string | Array<Record<string, unknown>>}
 */
export function toChatContent(content, resolveImageUrl) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return flattenText(content)
  const parts = []
  let sawImage = false
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text })
      continue
    }
    if (part?.type === 'image') {
      const id = part.attachment?.attachmentId
      const url = typeof id === 'string' ? resolveImageUrl?.(id) : undefined
      if (url !== undefined) {
        parts.push({ type: 'image_url', image_url: { url } })
        sawImage = true
      }
      continue
    }
  }
  if (!sawImage) {
    // A text-only part list collapses to a string: some providers reject the array form
    // when no image is present.
    return parts.filter(part => part.type === 'text').map(part => part.text).join('')
  }
  return parts
}

/**
 * Convert tools to the OpenAI function shape.
 *
 * @param {Array<Record<string, any>>} tools
 * @returns {Array<Record<string, unknown>>}
 */
export function toChatTools(tools) {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.inputSchema ?? tool.parameters ?? { type: 'object', properties: {} },
    },
  }))
}

/**
 * Convert tools to the Anthropic flat shape.
 *
 * Anthropic wants `input_schema` at the top level rather than nested under `function`, and
 * a `cache_control` breakpoint on the last tool is what makes prompt caching apply to the
 * tool block.
 *
 * @param {Array<Record<string, any>>} tools
 * @param {{ cacheLast?: boolean }} [options]
 * @returns {Array<Record<string, unknown>>}
 */
export function toAnthropicTools(tools, { cacheLast = false } = {}) {
  return tools.map((tool, index) => {
    const out = {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      input_schema: tool.inputSchema ?? tool.parameters ?? { type: 'object', properties: {} },
    }
    if (cacheLast && index === tools.length - 1) out.cache_control = { type: 'ephemeral' }
    return out
  })
}

/**
 * Convert turns to Anthropic messages, where tool results are user-role blocks.
 *
 * The role change is the part that is easy to get wrong: a tool result is not its own
 * role on this wire, it is a `tool_result` block inside a user turn. Sending it as a `tool`
 * role produces a schema error that does not mention the real problem.
 *
 * @param {Array<Record<string, any>>} turns
 * @param {{ resolveImage?: (attachmentId: string) => { mediaType: string, data: string } | undefined }} [options]
 * @returns {Array<Record<string, unknown>>}
 */
export function toAnthropicMessages(turns, { resolveImage } = {}) {
  const out = []
  for (const turn of turns) {
    if (turn.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: turn.toolCallId,
        content: flattenText(turn.content),
      }
      if (turn.isError === true) block.is_error = true
      out.push({ role: 'user', content: [block] })
      continue
    }
    if (turn.role === 'assistant') {
      const content = []
      const text = flattenText(turn.content)
      if (text.length > 0) content.push({ type: 'text', text })
      for (const call of turn.toolCalls ?? []) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: typeof call.arguments === 'string' ? safeParse(call.arguments) : call.arguments ?? {},
        })
      }
      out.push({ role: 'assistant', content: content.length === 0 ? [{ type: 'text', text: '' }] : content })
      continue
    }
    out.push({ role: 'user', content: toAnthropicContent(turn.content, resolveImage) })
  }
  return out
}

/**
 * @param {unknown} content
 * @param {(attachmentId: string) => { mediaType: string, data: string } | undefined} [resolveImage]
 */
function toAnthropicContent(content, resolveImage) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) {
    const text = flattenText(content)
    return text.length === 0 ? [] : [{ type: 'text', text }]
  }
  const parts = []
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text })
      continue
    }
    if (part?.type === 'image') {
      const id = part.attachment?.attachmentId
      const inline = typeof id === 'string' ? resolveImage?.(id) : undefined
      if (inline !== undefined) {
        // Bare base64, no data: prefix — the Anthropic media block is not a URL.
        parts.push({ type: 'image', source: { type: 'base64', media_type: inline.mediaType, data: inline.data } })
      }
      continue
    }
  }
  return parts
}

/** @param {string} text @returns {Record<string, unknown>} */
function safeParse(text) {
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

export { ACCOUNT_ERROR_CODES }
