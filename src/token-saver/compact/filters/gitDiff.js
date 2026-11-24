/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */

/**
 * Compact a unified diff: keep every hunk header and every change, bounded.
 *
 * ## What a model needs from a diff
 *
 * Which files changed, how much, and what the change actually says. It does not
 * need the context lines a diff repeats for every hunk, and it cannot read a 40 KB
 * patch anyway — past a few hundred lines the detail is lost in the middle
 * regardless.
 *
 * So this keeps the file boundary, the hunk header, every added and removed line
 * (up to a per-hunk ceiling) and a short run of context. What it drops, it counts:
 * `... (3 lines truncated)` tells the model the hunk continues, while an
 * unexplained gap reads as the whole hunk.
 *
 * ## Why a truncated diff says so explicitly
 *
 * A diff cut short without a marker is dangerous: the model sees a
 * complete-looking patch that is missing changes, and may conclude the code is
 * already correct. The trailing sentence names the cause and tells the caller how
 * to get the rest, so reaching a wrong conclusion is not the easy path.
 *
 * @module src/token-saver/compact/filters/git-diff
 */

import { GIT_DIFF_HUNK_MAX_LINES } from '../constants.js'

const FILE_BOUNDARY = 'diff --git'
const HUNK_BOUNDARY = '@@'
const TRUNCATION_NOTE = '[diff truncated by OFM; disable tool-output compression and request the diff again]'

/** Where the path starts in a `diff --git a/x b/x` header. */
const PATH_MARKER = ' b/'

/**
 * Walk the diff once, accumulating output.
 *
 * `shown` resets at each boundary, so the ceiling applies per hunk rather than to
 * the whole patch — a patch with many small hunks should show all of them.
 */
export function gitDiff(input, maxLines = 500) {
  const output = []
  let file = ''
  let added = 0
  let removed = 0
  let shown = 0
  let omitted = 0
  let inHunk = false
  let truncated = false

  const flushOmitted = () => {
    if (omitted === 0) return
    output.push(`  ... (${omitted} lines truncated)`)
    truncated = true
    omitted = 0
  }

  const flushCounts = () => {
    if (file && (added > 0 || removed > 0)) output.push(`  +${added} -${removed}`)
  }

  let offset = 0
  for (;;) {
    const newline = input.indexOf('\n', offset)
    const end = newline < 0 ? input.length : newline
    const row = input.slice(offset, end)

    if (row.startsWith(FILE_BOUNDARY) || row.startsWith(HUNK_BOUNDARY)) {
      flushOmitted()
      shown = 0
      inHunk = row.startsWith(HUNK_BOUNDARY)
      if (inHunk) {
        output.push(`  ${row}`)
      } else {
        flushCounts()
        const marker = row.indexOf(PATH_MARKER)
        file = marker < 0 ? 'unknown' : row.slice(marker + PATH_MARKER.length)
        output.push(`\n${file}`)
        added = 0
        removed = 0
      }
    } else if (inHunk) {
      // `+++` / `---` are file headers that appear inside a hunk, not changes.
      const isAddition = row[0] === '+' && !row.startsWith('+++')
      const isDeletion = row[0] === '-' && !row.startsWith('---')
      if (isAddition) added += 1
      if (isDeletion) removed += 1
      if (isAddition || isDeletion) {
        if (shown < GIT_DIFF_HUNK_MAX_LINES) {
          output.push(`  ${row}`)
          shown += 1
        } else {
          omitted += 1
        }
      } else if (shown > 0 && shown < GIT_DIFF_HUNK_MAX_LINES && row[0] !== '\\') {
        // Context is kept only while there is room, and only after the first
        // change, so a hunk's leading context does not eat the budget. A `\` row
        // is the "no newline at end of file" marker and carries no code.
        output.push(`  ${row}`)
        shown += 1
      }
    }

    if (output.length >= maxLines) {
      output.push('\n... (more changes truncated)')
      truncated = true
      break
    }
    if (newline < 0) break
    offset = newline + 1
  }

  flushOmitted()
  flushCounts()
  if (truncated) output.push(TRUNCATION_NOTE)
  return output.join('\n')
}

gitDiff.filterName = 'git-diff'
