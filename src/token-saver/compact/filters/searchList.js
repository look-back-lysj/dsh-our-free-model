/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */

/**
 * Compact a glob result: keep the header, group paths by directory.
 *
 * ## The input shape
 *
 * One header line naming the pattern and the total, then `- path` rows. The header
 * is kept verbatim because it states which pattern produced these results — a fact
 * the model needs and cannot reconstruct from the paths.
 *
 * The rows are grouped by directory for the same reason as the `find` filter: a
 * path list repeats its directory once per file, and the directory is the part the
 * model can act on.
 *
 * ## Trailing newlines are stripped
 *
 * The output is built with blank lines between groups for readability, which leaves
 * one at the end. Stripping it keeps the byte count honest and makes the output
 * compare equal across the two code paths that can produce it.
 *
 * @module src/token-saver/compact/filters/search-list
 */

import { SEARCH_LIST_PER_DIR_MAX, SEARCH_LIST_TOTAL_DIR_MAX } from '../constants.js'

/**
 * The header line.
 *
 * Exported because the detector matches it to decide a blob is a glob result, and
 * the two must agree on what that header looks like.
 */
export const SEARCH_LIST_HEADER_RE = /^Result of search in '[^']*' \(total (\d+) files?\):/

export function searchList(input) {
  const headerEnd = input.indexOf('\n')
  // A single-line blob is a header with no rows; nothing to group.
  if (headerEnd < 0) return input

  const groups = new Map()
  let total = 0

  let offset = headerEnd + 1
  for (;;) {
    const newline = input.indexOf('\n', offset)
    const end = newline < 0 ? input.length : newline
    const row = input.slice(offset, end).trim()
    if (row.startsWith('- ')) {
      const path = row.slice(2)
      const slash = path.lastIndexOf('/')
      const directory = slash < 0 ? '.' : path.slice(0, slash) || '/'
      let group = groups.get(directory)
      if (group === undefined) {
        group = { count: 0, names: [] }
        groups.set(directory, group)
      }
      total += 1
      group.count += 1
      if (group.names.length < SEARCH_LIST_PER_DIR_MAX) group.names.push(path.slice(slash + 1))
    }
    if (newline < 0) break
    offset = newline + 1
  }

  if (total === 0) return input

  const output = [input.slice(0, headerEnd), `${total} files in ${groups.size} dirs:`, '']
  for (const directory of [...groups.keys()].sort().slice(0, SEARCH_LIST_TOTAL_DIR_MAX)) {
    const { count, names } = groups.get(directory)
    output.push(`${directory}/ (${count}):`)
    for (const name of names) output.push(`  ${name}`)
    if (count > names.length) output.push(`  +${count - names.length}`)
    output.push('')
  }
  if (groups.size > SEARCH_LIST_TOTAL_DIR_MAX) {
    output.push(`+${groups.size - SEARCH_LIST_TOTAL_DIR_MAX} more dirs`)
  }
  return output.join('\n').replace(/\n+$/, '')
}

searchList.filterName = 'search-list'
