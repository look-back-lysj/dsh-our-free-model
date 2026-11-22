/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */

/**
 * Compact a path listing: group by directory, keep filenames, count the rest.
 *
 * ## Why grouping is the compaction
 *
 * `find` prints full paths, one per line. Every path in a directory repeats that
 * directory, so a listing of 200 files across 6 directories is mostly the same six
 * prefixes. Grouping by directory removes that repetition and leaves the part a
 * model actually reads: which names exist where.
 *
 * The directory line carries the exact count, so a capped sample list never hides
 * how many files are really there.
 *
 * ## Backslashes are normalised in the header only
 *
 * A Windows listing uses `\`; the output shows `/`. That is display, not data: the
 * filenames are untouched, and a model reasoning about paths handles both. Keeping
 * the original separator would make the same directory appear as two groups when a
 * listing mixed both.
 *
 * @module src/token-saver/compact/filters/find
 */

import { FIND_PER_DIR_MAX, FIND_TOTAL_DIR_MAX } from '../constants.js'

export function find(input) {
  const groups = new Map()
  let total = 0

  let start = 0
  for (;;) {
    const newline = input.indexOf('\n', start)
    const end = newline < 0 ? input.length : newline
    const path = input.slice(start, end)
    if (path.trim()) {
      total += 1
      const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
      // A path with no separator is a bare filename in the current directory.
      const directory = separator < 0 ? '.' : path.slice(0, separator) || '/'
      let group = groups.get(directory)
      if (group === undefined) {
        group = { count: 0, names: [] }
        groups.set(directory, group)
      }
      group.count += 1
      if (group.names.length < FIND_PER_DIR_MAX) group.names.push(path.slice(separator + 1))
    }
    if (newline < 0) break
    start = newline + 1
  }

  if (total === 0) return input

  const directories = [...groups.keys()].sort()
  const output = [`${total} files in ${directories.length} dirs:\n\n`]
  for (const directory of directories.slice(0, FIND_TOTAL_DIR_MAX)) {
    const { count, names } = groups.get(directory)
    output.push(`${directory.replace(/\\/g, '/')}/  (${count})\n`)
    for (const name of names) output.push(`  ${name}\n`)
    if (count > names.length) output.push(`  +${count - names.length}\n`)
  }
  if (directories.length > FIND_TOTAL_DIR_MAX) {
    output.push(`\n+${directories.length - FIND_TOTAL_DIR_MAX} more dirs\n`)
  }
  return output.join('')
}

find.filterName = 'find'
