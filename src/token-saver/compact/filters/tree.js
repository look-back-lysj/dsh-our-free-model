/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */

/**
 * Compact a `tree` listing: keep the glyph structure, bound the row count.
 *
 * ## What is kept
 *
 * Every row that carries a name, up to the ceiling. The box-drawing glyphs are
 * what makes a tree readable, so they are preserved verbatim — re-indenting would
 * destroy the structure the glyphs encode.
 *
 * The trailing `N directories, M files` summary is dropped: it restates what the
 * rows already show, and a model that has the rows does not need the count.
 *
 * ## Why the retained rows are trimmed to the last content row
 *
 * A tree ends with a blank line. Without trimming, a truncated listing could end
 * on that blank row and the `... +N more` marker would attach to nothing visible.
 * Trimming to the last row that actually carries content keeps the marker adjacent
 * to the rows it summarises.
 *
 * @module src/token-saver/compact/filters/tree
 */

import { TREE_MAX_LINES } from '../constants.js'

export function tree(input) {
  const retained = []
  let seen = 0
  let lastContentIndex = 0

  let offset = 0
  for (;;) {
    const newline = input.indexOf('\n', offset)
    const end = newline < 0 ? input.length : newline
    const row = input.slice(offset, end)
    const hasContent = row.trim() !== ''
    // The summary line contains both words; every other row is structure or a
    // name. Skipping it is what makes the row count describe the tree rather than
    // the tree plus its footer.
    const isSummary = row.includes('director') && row.includes('file')
    if (!isSummary && (seen > 0 || hasContent)) {
      seen += 1
      if (hasContent) lastContentIndex = seen
      if (retained.length < TREE_MAX_LINES) retained.push(row)
    }
    if (newline < 0) break
    offset = newline + 1
  }

  retained.length = Math.min(retained.length, lastContentIndex)
  if (lastContentIndex > TREE_MAX_LINES) {
    retained.push(`... +${lastContentIndex - TREE_MAX_LINES} more lines`)
  }
  return retained.join('\n')
}

tree.filterName = 'tree'
