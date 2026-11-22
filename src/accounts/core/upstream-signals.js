/**
 * Recognition of "the model is queued" and "the allowance is spent" from upstream
 * bodies, plus the retry-delay parsers they rely on.
 *
 * ## The bug this module exists to prevent
 *
 * Providers express these conditions in three different places: an HTTP status, an
 * in-band SSE error frame under HTTP 200, and a nested JSON string inside a
 * `message` field. Recognising only one of them looks like it works until the day the
 * provider switches channel — which it did. The first fix handled the HTTP 403 shape
 * and silently missed the SSE shape, so every queued request was classified as a
 * server error and retried on the harness's own fast backoff instead of the wait the
 * server had actually asked for.
 *
 * So the parser walks the whole body, breadth-first, through the keys that carry
 * nested payloads (`data`, `result`, `message`, `body`, `error`, `response`), parsing
 * JSON strings as it goes.
 *
 * ## Queue and billing are different conditions and must not be merged
 *
 * A queue hit means "temporarily blocked, wait a few seconds". An exhausted allowance
 * means "nothing will work until tomorrow". Reporting the second as the first produces
 * a retry storm against an account that cannot succeed, and reporting the first as the
 * second tells the user to come back tomorrow for a five-second wait.
 *
 * @module src/accounts/core/upstream-signals
 */

import { ModelQueuedError } from './errors.js'

/** Business codes that mean "queued". */
export const QUEUE_BUSINESS_CODES = Object.freeze(['10605'])

/** Business codes that mean "allowance spent". `112` is the CN variant. */
export const BILLING_BUSINESS_CODES = Object.freeze(['110', '112'])

/** Cap on one queue wait. */
export const QUEUE_MAX_DELAY_MS = 10_000

/** @param {unknown} code @returns {boolean} */
export function isQueueCode(code) {
  if (typeof code === 'number') return QUEUE_BUSINESS_CODES.includes(String(code))
  if (typeof code !== 'string') return false
  return QUEUE_BUSINESS_CODES.includes(code)
}

/** @param {unknown} code @returns {boolean} */
export function isBillingCode(code) {
  if (typeof code === 'number') return BILLING_BUSINESS_CODES.includes(String(code))
  if (typeof code !== 'string') return false
  return BILLING_BUSINESS_CODES.includes(code)
}

/**
 * Billing wording, used when the provider sends no code.
 *
 * Narrow on purpose. `balance` or `quota` as bare words appear in ordinary model prose
 * ("explain how a quota system works"), so only explicit error phrases count.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeBillingText(text) {
  return /billing\s+daily\s+count\s+exceeded|daily\s+count\s+exceeded|billing_error/i.test(text)
}

/**
 * Does this body carry a purchase prompt (`pricingUrl` / `pricing_url`)?
 *
 * That key never appears in a normal response, so its presence is itself the signal —
 * no wording heuristics needed. Matched by key name only: the word "pricing" in prose
 * is common.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasPricingHint(value) {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasPricingHint)
  for (const [key, child] of Object.entries(value)) {
    if (/^pricing[_-]?url$/i.test(key) && typeof child === 'string' && child !== '') return true
    if (typeof child === 'object' && child !== null && hasPricingHint(child)) return true
  }
  return false
}

/**
 * The same signal once the error has been flattened to text.
 *
 * Requires the quoted-key form, because a bare "pricing" is ordinary prose.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasPricingHintText(text) {
  return /"pricing[_-]?url"\s*:/i.test(text)
}

/**
 * Every object reachable from `body` through the nested-payload keys.
 *
 * @param {unknown} body - a string, an already-parsed value, or a nested message
 * @returns {Array<Record<string, unknown>>}
 */
export function payloadNodes(body) {
  let root = body
  if (typeof body === 'string') {
    try { root = JSON.parse(body) } catch { return [] }
  }
  if (root === null || typeof root !== 'object') return []
  const seen = new Set()
  const nodes = []
  const queue = [root]
  while (queue.length > 0) {
    const node = queue.shift()
    if (node === null || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    nodes.push(node)
    for (const key of ['data', 'result', 'message', 'body', 'error', 'response']) {
      const value = node[key]
      if (value !== null && typeof value === 'object') queue.push(value)
      else if (key !== 'response' && typeof value === 'string' && value.length > 0) {
        try { queue.push(JSON.parse(value)) } catch { /* not JSON */ }
      }
    }
  }
  return nodes
}

/** @param {unknown} value @returns {number | undefined} */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Read the queue parameters out of a body, or undefined when it is not a queue body.
 *
 * A queue body is recognised by the business code **or** by the presence of the queue
 * fields themselves. Requiring the code would break the SSE shape, whose inner message
 * has no `code` at all — that is precisely how the first fix failed.
 *
 * `isQueued` is *not* required to be true: an instantaneous queue arrives as
 * `isQueued:false, serviceAvailable:true, waitTime:0, retryAfterSeconds:2`, and treating
 * that as "not queued" throws away the two-second wait the server asked for.
 *
 * @param {unknown} body
 * @returns {undefined | Record<string, unknown>}
 */
export function parseQueueInfo(body) {
  const nodes = payloadNodes(body)
  const info = nodes.find(node => node.isQueued !== undefined || node.serviceAvailable !== undefined)
  if (info === undefined) return undefined
  const codeHit = nodes.some(node => isQueueCode(node.code))
  if (!codeHit && info.isQueued === undefined) return undefined
  /** @type {Record<string, unknown>} */
  const out = {}
  if (typeof info.isQueued === 'boolean') out.isQueued = info.isQueued
  if (typeof info.modelKey === 'string' && info.modelKey.length > 0) out.modelKey = info.modelKey
  if (typeof info.queueType === 'string' && info.queueType.length > 0) out.queueType = info.queueType
  if (typeof info.serviceAvailable === 'boolean') out.serviceAvailable = info.serviceAvailable
  for (const key of ['queueCount', 'retryAfterSeconds', 'waitTime', 'retry_after_ms', 'retryAfterMs']) {
    const value = finite(info[key])
    if (value !== undefined) out[key] = Math.trunc(value)
  }
  return out
}

/**
 * How long to wait for one queue hit, in milliseconds.
 *
 * Priority: `retry_after_ms`, then `retryAfterMs`, then `retryAfterSeconds * 1000`.
 * An invalid value is ignored rather than treated as zero — zero would mean "retry
 * immediately", a busy loop that burns the remaining attempts in a second.
 *
 * @param {Record<string, unknown> | undefined} info
 * @returns {number | undefined}
 */
export function queueDelayMs(info) {
  if (info === undefined) return undefined
  const explicit = finite(info.retry_after_ms) ?? finite(info.retryAfterMs)
  const seconds = finite(info.retryAfterSeconds)
  const raw = explicit ?? (seconds === undefined ? undefined : seconds * 1000)
  if (raw === undefined || raw < 0) return undefined
  return Math.min(Math.trunc(raw), QUEUE_MAX_DELAY_MS)
}

/**
 * Parse a `retry-after` header value into milliseconds.
 *
 * Two details that must not be lost, both of which have caused real bugs:
 *
 * 1. **`0` is a real value** meaning "released immediately". Callers must test with
 *    `=== undefined`; any falsy check turns it into "unknown" and then into an hour of
 *    needless cooldown.
 * 2. **A pure number is seconds and must never reach `Date.parse`.** `Date.parse('900')`
 *    resolves to a moment in 1970, so `at - now` is a large negative number that
 *    `Math.max(0, ...)` flattens to zero — an exhausted account gets reselected at once,
 *    in a tight loop. A negative number is likewise invalid, not a year.
 *
 * @param {string | null | undefined} raw
 * @param {number} [nowMs]
 * @returns {number | undefined} milliseconds; `0` means immediate; `undefined` means the
 *   server said nothing and the caller should fall back
 */
export function parseRetryAfterMs(raw, nowMs = Date.now()) {
  if (raw === undefined || raw === null || raw === '') return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.ceil(seconds * 1000) : undefined
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined
}

/**
 * @param {{ get(name: string): string | null } | null | undefined} headers
 * @param {number} [nowMs]
 */
export function retryAfterMsFromHeaders(headers, nowMs = Date.now()) {
  if (headers === null || headers === undefined) return undefined
  return parseRetryAfterMs(headers.get('retry-after'), nowMs)
}

/**
 * Throw a {@link ModelQueuedError} when the body declares a queue.
 *
 * Cross-channel: only an explicit queue field or a recognised error type counts.
 * Status codes and "busy" wording stay with the individual channel, because they mean
 * different things there.
 *
 * @param {unknown} body
 * @param {{ get(name: string): string | null }} [headers]
 */
export function throwIfQueued(body, headers) {
  const declared = payloadNodes(body).find(node => node.isQueued === true
    || [node.code, node.type].some(value => typeof value === 'string'
      && ['queued', 'model_queued'].includes(value.toLowerCase())))
  if (declared === undefined) return
  const info = parseQueueInfo(body)
    ?? parseQueueInfo({ ...declared, isQueued: true })
    ?? { isQueued: true }
  const delay = queueDelayMs(info) ?? retryAfterMsFromHeaders(headers)
  throw new ModelQueuedError('model queued', {
    queueInfo: info,
    ...(delay === undefined ? {} : { retryAfterMs: Math.min(delay, QUEUE_MAX_DELAY_MS) }),
  })
}

/**
 * Wrap a response so a queue declaration is raised as an error while the body stays
 * readable by the caller's own error handling.
 *
 * For a non-OK response the body is inspected as text. For an OK JSON response the
 * stream is buffered only up to 64 KiB: a queue error is a small JSON object, and
 * buffering an entire completion to look for one would defeat streaming.
 *
 * @param {Response} response
 * @returns {Promise<Response>}
 */
export async function checkQueuedResponse(response) {
  if (!response.ok) {
    const body = await response.clone().text().catch(() => undefined)
    if (body !== undefined) throwIfQueued(body, response.headers)
    return response
  }
  if (response.body === null || !response.headers.get('content-type')?.includes('application/json')) {
    return response
  }
  const decoder = new TextDecoder()
  let prefix = ''
  const reader = response.body.getReader()
  let cancelling
  const cancel = reason => {
    cancelling ??= reader.cancel(reason).finally(() => reader.releaseLock())
    return cancelling
  }
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (cancelling !== undefined) return
        if (done === true) {
          reader.releaseLock()
          controller.close()
          return
        }
        if (prefix !== undefined) {
          prefix += decoder.decode(value, { stream: true })
          const trimmed = prefix.trimStart()
          if (prefix.length > 65_536 || (trimmed.length > 0 && !trimmed.startsWith('{'))) {
            prefix = undefined
          } else {
            let parsed
            try { parsed = JSON.parse(prefix) } catch { /* may span chunks */ }
            if (parsed !== undefined) {
              prefix = undefined
              throwIfQueued(parsed, response.headers)
            }
          }
        }
        controller.enqueue(value)
      } catch (error) {
        await cancel(error).catch(() => {})
        controller.error(error)
      }
    },
    cancel,
  })
  return new Response(body, response)
}
