/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */

/**
 * Keep the first and last N lines of an over-long blob, and say how many went.
 *
 * ## Why head and tail, not head only
 *
 * A build log's conclusion is at the end; a source dump's context is at the start.
 * Keeping only one end forces the model to ask again. Keeping both costs the same
 * number of bytes and answers both questions.
 *
 * ## Why no array is built
 *
 * The input can be megabytes. Splitting it into lines would allocate a copy of the
 * whole thing just to read the first 120 and the last 60, which is the opposite of
 * what a token saver should do. So the input is scanned with `indexOf` twice: once
 * forward to find where the head ends, once backward from the end to find where the
 * tail begins. Both are index arithmetic on the original string; no intermediate
 * array exists.
 *
 * `suffix` lets a caller distinguish its output from a generic window — the
 * read-numbered filter says `(file continues)` where the generic one says nothing.
 *
 * @module src/token-saver/compact/filters/smart-truncate
 */

import { SMART_TRUNCATE_HEAD, SMART_TRUNCATE_TAIL, SMART_TRUNCATE_MIN_LINES } from '../constants.js'

/**
 * The head/tail window itself.
 *
 * `count` starts at 1 because a string with no newline still has one line. That
 * matters for the short-circuit below: a single-line blob must not be windowed.
 */
export function truncateWindow(input, suffix) {
  let count = 1
  let headEnd = input.length
  let position = input.indexOf('\n')
  while (position !== -1) {
    if (count === SMART_TRUNCATE_HEAD) headEnd = position
    count += 1
    position = input.indexOf('\n', position + 1)
  }
  if (count < SMART_TRUNCATE_MIN_LINES) return input

  let tailStart = input.length
  for (let line = 0; line < SMART_TRUNCATE_TAIL; line += 1) {
    tailStart = input.lastIndexOf('\n', tailStart - 1)
  }
  const removed = count - SMART_TRUNCATE_HEAD - SMART_TRUNCATE_TAIL
  return `${input.slice(0, headEnd)}\n... +${removed} lines truncated${suffix}\n${input.slice(tailStart + 1)}`
}

export function smartTruncate(input) {
  return truncateWindow(input, '')
}

smartTruncate.filterName = 'smart-truncate'
