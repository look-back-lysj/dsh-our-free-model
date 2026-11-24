/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */

/**
 * Collapse runs of identical log lines, keeping the count.
 *
 * ## Only *consecutive* runs collapse
 *
 * This is the whole design constraint. A log where `retrying...` appears at lines
 * 3, 40 and 900 is telling the model something different from one where it appears
 * nine hundred times in a row. Deduplicating across the whole file would erase that
 * distinction and make a pathological loop look like a quiet log.
 *
 * So a run collapses only while the line repeats without interruption, and the
 * count is emitted when the run ends. A blank line ends a run.
 *
 * ## Blank lines are kept once per run
 *
 * Blank lines separate sections in a log, which is real structure. Repeating them
 * is not, so a run of blanks collapses to one.
 *
 * @module src/token-saver/compact/filters/dedup-log
 */

import { DEDUP_LINE_MAX } from '../constants.js'

export function dedupLog(input) {
  const output = []
  let previous
  let duplicates = 0
  let previousWasBlank = false

  let offset = 0
  for (;;) {
    const newline = input.indexOf('\n', offset)
    const end = newline < 0 ? input.length : newline
    const row = input.slice(offset, end)
    const blank = row.trim() === ''

    if (!blank && row === previous) {
      // Same line, uninterrupted: count it and emit nothing.
      duplicates += 1
    } else {
      if (blank && !previousWasBlank) output.push(row)
      if (duplicates > 0) output.push(`  ... (${duplicates} duplicate lines)`)
      duplicates = 0
      previous = blank ? undefined : row
      if (!blank) {
        output.push(row)
        if (output.length >= DEDUP_LINE_MAX) {
          output.push(`... (truncated at ${DEDUP_LINE_MAX} lines)`)
          return output.join('\n')
        }
      }
    }

    previousWasBlank = blank
    if (newline < 0) break
    offset = newline + 1
  }

  if (duplicates > 0) output.push(`  ... (${duplicates} duplicate lines)`)
  return output.join('\n')
}

dedupLog.filterName = 'dedup-log'
