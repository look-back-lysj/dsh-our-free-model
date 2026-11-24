/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */

/**
 * Compact search output: group hits by file, cap the samples, keep exact counts.
 *
 * ## The shape of the answer
 *
 * `grep -rn` prints one line per hit. The redundancy is structural rather than
 * textual: the same path repeats for every match in that file, and a search that
 * hits one file forty times is forty near-identical prefixes.
 *
 * So the output is grouped by file, with the first few line numbers and their
 * content kept as samples and the rest counted. A model can tell which files
 * matched, how many times, and what the matches looked like — which is what it
 * needs to decide where to look next.
 *
 * ## All-or-nothing parsing
 *
 * If any row does not parse, the input is returned unchanged. A partially-parsed
 * search result would silently omit the rows that failed, and a search result
 * with holes is worse than an uncompacted one: the model cannot tell the
 * difference between "no match" and "dropped by the filter".
 *
 * @module src/token-saver/compact/filters/grep
 */

import { GREP_PER_FILE_MAX } from '../constants.js'
import { splitGrepHit } from '../hitLine.js'

/** One or more digits. */
const LINE_NUMBER = /^\d+$/

export function grep(input) {
  const groups = new Map()
  let total = 0

  let offset = 0
  for (;;) {
    const newline = input.indexOf('\n', offset)
    const end = newline < 0 ? input.length : newline
    const row = input.slice(offset, end)
    if (row.trim()) {
      const hit = splitGrepHit(row)
      // Bail out entirely rather than emit a summary with missing rows.
      if (!hit || !hit.file.trim() || !LINE_NUMBER.test(hit.line)) return input
      total += 1
      let group = groups.get(hit.file)
      if (group === undefined) {
        group = { count: 0, samples: [] }
        groups.set(hit.file, group)
      }
      group.count += 1
      if (group.samples.length < GREP_PER_FILE_MAX) {
        // The trailing newline is part of the sample so the join below needs no
        // separator logic; the four-width pad keeps line numbers aligned.
        group.samples.push(`  ${hit.line.padStart(4)}: ${hit.content.trim()}\n`)
      }
    }
    if (newline < 0) break
    offset = newline + 1
  }

  if (total === 0) return input

  const output = [`${total} matches in ${groups.size}F:\n\n`]
  // Sorted so the same search always produces the same bytes: filesystem order is
  // not stable across runs, and an unstable output defeats prompt caching.
  for (const file of [...groups.keys()].sort()) {
    const { count, samples } = groups.get(file)
    output.push(`[file] ${file} (${count}):\n`, ...samples)
    if (count > samples.length) output.push(`  +${count - samples.length}\n`)
    output.push('\n')
  }
  return output.join('')
}

grep.filterName = 'grep'
