/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */

/**
 * The same head/tail window, for dumps whose lines carry a line-number prefix.
 *
 * The only difference from {@link module:src/token-saver/compact/filters/smart-truncate}
 * is the suffix: a file dump that was cut should say the file continues, so the
 * model knows it is looking at an excerpt rather than a short file. That one word
 * is why this exists as its own filter instead of a parameter.
 *
 * @module src/token-saver/compact/filters/read-numbered
 */

import { truncateWindow } from './smartTruncate.js'

/**
 * A `cat -n` / `nl` style prefix: optional space, digits, a pipe.
 *
 * Exported because the detector uses it to decide whether a blob is a numbered
 * dump, and the two must agree — a blob the detector recognises must be one this
 * filter can window.
 */
export const READ_NUMBERED_LINE_RE = /^\s*\d+\|/

export function readNumbered(input) {
  return truncateWindow(input, ' (file continues)')
}

readNumbered.filterName = 'read-numbered'
