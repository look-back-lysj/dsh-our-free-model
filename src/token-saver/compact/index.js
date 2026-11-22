/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */

/**
 * Compacting tool output inside an outgoing request body.
 *
 * ## The boundary this respects
 *
 * Only *tool output* is touched. System prompts, user turns and assistant text are
 * hand-written context; rewriting them would change what the user asked for. This
 * is why every walker below reaches for a specific field on a specific record type
 * rather than walking strings generically.
 *
 * Error results are never touched either. An error trace is the model's only
 * evidence of what failed; hiding it makes the model retry the same call and the
 * user pays for the loop.
 *
 * ## Why the three wires need separate walkers
 *
 * They put tool output in different places:
 *
 * - **chat** — `messages[]` rows with `role: 'tool'`, content as a string or an
 *   array of `text` parts.
 * - **responses** — `input[]` items of type `function_call_output`, whose `output`
 *   is a string or an array of `input_text` parts.
 * - **messages (Claude)** — `content[]` blocks of type `tool_result`, whose
 *   `content` is a string or an array of `text` parts, and which carry `is_error`.
 *
 * A single walker would have to guess which of those it was looking at. Three
 * explicit ones cannot.
 *
 * ## Fail-open, at every level
 *
 * A filter that throws leaves the blob alone ({@link safeApply}). A walker that
 * throws leaves the payload alone. A request must never fail because the thing
 * meant to make it cheaper broke.
 *
 * @module src/token-saver/compact
 */

import { RAW_CAP, MIN_COMPRESS_SIZE } from './constants.js'
import { autoDetectFilter } from './autodetect.js'
import { safeApply } from './applyFilter.js'

/**
 * Compact one string, updating `stats`.
 *
 * Three conditions must hold before a replacement is used:
 *
 * 1. the blob is between the minimum and the hard cap, so it is neither too small
 *    to be worth the work nor a runaway dump;
 * 2. the detector recognised it;
 * 3. the replacement is non-empty and strictly smaller.
 *
 * The third is not an optimisation. An empty result reads as "the tool printed
 * nothing", which is a different fact from the one the tool reported, and a larger
 * result costs the context it was meant to save.
 */
export function compressText(text, stats, shape) {
  const before = text.length
  stats.bytesBefore += before
  let result = text
  if (before >= MIN_COMPRESS_SIZE && before <= RAW_CAP) {
    const filter = autoDetectFilter(text)
    if (filter !== null) {
      const candidate = safeApply(filter, text)
      if (candidate.length > 0 && candidate.length < before) {
        result = candidate
        stats.hits.push({ shape, filter: filter.filterName || filter.name, saved: before - candidate.length })
      }
    }
  }
  stats.bytesAfter += result.length
  return result
}

/**
 * Compact one field of one record, in place.
 *
 * Handles both shapes a field can take: a bare string, or an array of parts where
 * each part carries its text. `partType` restricts which parts are touched —
 * `null` means every part with text, which is what the Kiro walker needs.
 */
function compactField(owner, key, partType, stringShape, arrayShape, stats) {
  const content = owner[key]
  if (typeof content === 'string') {
    owner[key] = compressText(content, stats, stringShape)
    return
  }
  if (!Array.isArray(content)) return
  for (const part of content) {
    if (!part) continue
    if (partType !== null && part.type !== partType) continue
    if (typeof part.text === 'string') part.text = compressText(part.text, stats, arrayShape)
  }
}

/**
 * Walk a chat / responses / messages body and compact the tool output in it.
 *
 * `mode` narrows which record kinds are considered. `auto` accepts all three, which
 * is what `compressMessages` needs when it does not know the wire.
 */
function walk(items, mode, stats) {
  if (!Array.isArray(items)) return
  for (const item of items) {
    if (!item) continue
    if ((mode === 'auto' || mode === 'responses') && item.type === 'function_call_output') {
      compactField(item, 'output', 'input_text', 'openai-responses-string', 'openai-responses-array', stats)
      continue
    }
    if ((mode === 'auto' || mode === 'chat') && item.role === 'tool') {
      compactField(item, 'content', 'text', 'openai-tool', 'openai-tool-array', stats)
      continue
    }
    if ((mode === 'auto' || mode === 'messages') && Array.isArray(item.content)) {
      for (const block of item.content) {
        // `is_error` must be exactly `true`: an absent field means "not an error".
        if (block?.type === 'tool_result' && block.is_error !== true) {
          compactField(block, 'content', 'text', 'claude-string', 'claude-array', stats)
        }
      }
    }
  }
}

/** Compact one Kiro message's tool results. */
function walkKiro(message, stats) {
  const results = message?.userInputMessage?.userInputMessageContext?.toolResults
  if (!Array.isArray(results)) return
  for (const result of results) {
    // Kiro marks failures with `status: 'error'` rather than a boolean field.
    if (result.status !== 'error' && Array.isArray(result.content)) {
      compactField(result, 'content', null, '', 'kiro-tool-result', stats)
    }
  }
}

/**
 * Compact a body whose wire is not known.
 *
 * Accepts `messages` or `input`, and the Kiro `conversationState` shape. Returns
 * `null` when there is nothing it recognises, so the caller can tell "not a body"
 * from "a body that saved nothing".
 */
export function compressMessages(body, enabled) {
  if (!enabled || !body) return null
  const state = body.conversationState
  const items = Array.isArray(body.messages) ? body.messages : body.input
  if (!state && !Array.isArray(items)) return null
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] }
  try {
    if (state) {
      if (Array.isArray(state.history)) for (const message of state.history) walkKiro(message, stats)
      if (state.currentMessage) walkKiro(state.currentMessage, stats)
    } else {
      walk(items, 'auto', stats)
    }
    return stats
  } catch (error) {
    console.warn('[RTK] compressMessages error:', error.message)
    return null
  }
}

/**
 * Compact a body for a known wire.
 *
 * Returns the same payload reference, mutated, because the caller expects to keep
 * working with it. `options` accepts `false` or `{ enabled: false }` to disable, and
 * anything else (including nothing) to enable.
 *
 * On a walker failure the byte counters are reconstructed from the hits that did
 * land, so the reported saving describes what actually shipped rather than what was
 * attempted.
 */
export function compressRequest(payload, wire, options = true) {
  const enabled = options !== false && (options === null || typeof options !== 'object' || options.enabled !== false)
  const stats = { enabled, bytesBefore: 0, bytesAfter: 0, saved: 0, hits: [] }
  if (enabled && payload !== null && typeof payload === 'object') {
    try {
      if (wire === 'chat' || wire === 'messages') walk(payload.messages, wire, stats)
      else if (wire === 'responses') walk(payload.input, wire, stats)
    } catch (error) {
      console.warn('[rtk] compressRequest error:', error?.message ?? error)
      stats.bytesAfter = stats.bytesBefore - stats.hits.reduce((sum, hit) => sum + hit.saved, 0)
    }
  }
  stats.saved = stats.bytesBefore - stats.bytesAfter
  return { payload, stats }
}

/** One-line summary of what a pass saved, or `null` when nothing happened. */
export function formatRtkLog(stats) {
  if (!stats?.hits?.length) return null
  const filters = [...new Set(stats.hits.map(hit => hit.filter))].join(',')
  const saved = stats.bytesBefore - stats.bytesAfter
  const percentage = stats.bytesBefore > 0 ? (100 * saved / stats.bytesBefore).toFixed(1) : '0'
  return `[RTK] saved ${saved}B / ${stats.bytesBefore}B (${percentage}%) via [${filters}] hits=${stats.hits.length}`
}

/** Bytes in the largest unit that keeps the number short. */
function humanBytes(size) {
  for (const [unit, threshold] of [['MB', 1048576], ['KB', 1024]]) {
    if (size >= threshold) return `${(size / threshold).toFixed(1)} ${unit}`
  }
  return `${size} B`
}

/**
 * The human-facing description of a pass, for the savings panel.
 *
 * Returns `null` when the saver was disabled, and names an empty pass explicitly —
 * "no tool output compacted" is a different fact from "the saver is off", and a
 * panel that showed nothing for both would be lying about one of them.
 */
export function describeSavings(stats) {
  if (!stats || stats.enabled === false) return null
  const before = Number.isFinite(stats.bytesBefore) ? stats.bytesBefore : 0
  const after = Number.isFinite(stats.bytesAfter) ? stats.bytesAfter : 0
  const hits = Array.isArray(stats.hits) ? stats.hits : []
  const prefix = `[token-saver] ${humanBytes(before)} -> ${humanBytes(after)}`
  if (hits.length === 0) return `${prefix} (0%) — no tool output compacted`
  const percent = before > 0 ? Math.round(100 * (before - after) / before) : 0
  return `${prefix} (${percent}%) via ${[...new Set(hits.map(hit => hit.filter))].join(', ')} (${hits.length} blocks)`
}
