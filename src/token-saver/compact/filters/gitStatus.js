/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */

/**
 * Compact `git status`, in both of its dialects.
 *
 * ## Two dialects, one parser
 *
 * Porcelain output is two status columns plus a path, one line per file. Long-form
 * output is prose with `modified:   path` sections. The wire gives no hint which
 * one a tool used, so both are parsed here.
 *
 * This matters more than it looks: a porcelain-only parser silently reports
 * "clean" for long-form input, and a model reading "clean" concludes there is
 * nothing to commit while edits sit unstaged. A false "clean" is the worst answer
 * a status summary can give.
 *
 * ## What is kept
 *
 * The branch, an exact count per category, and enough path samples to recognise
 * one's own work — not a hundred lines of per-file ceremony. Counts stay exact
 * when the sample list is capped, because "12 modified" is the useful fact and
 * the twelve names are not.
 *
 * @module src/token-saver/compact/filters/git-status
 */

import { STATUS_MAX_FILES, STATUS_MAX_UNTRACKED } from '../constants.js'

/** Porcelain row: two status columns, a space, then the path. */
const PORCELAIN_ROW = /^[ MADRCU?!][ MADRCU?!] /

/** Long-form row: `modified:   path` and its siblings. */
const LONG_FORM_ROW = /^\s*(modified|new file|deleted|renamed|both modified):\s+(.+)$/

/** Index column letters that mean "staged". `U` is unmerged and handled apart. */
const STAGED_LETTERS = 'MADRC'

/** The three categories, in output order. */
const STAGED = 0
const MODIFIED = 1
const UNTRACKED = 2

const SECTIONS = [
  { label: '+ Staged', limit: STATUS_MAX_FILES },
  { label: '~ Modified', limit: STATUS_MAX_FILES },
  { label: '? Untracked', limit: STATUS_MAX_UNTRACKED },
]

export function gitStatus(input) {
  // No newline and no content: an empty status, which is a fact worth stating.
  if (!input.includes('\n') && !input.trim()) return 'Clean working tree'

  const counts = [0, 0, 0]
  const samples = [[], [], []]
  let branch = ''
  let conflicts = 0

  let offset = 0
  for (;;) {
    const newline = input.indexOf('\n', offset)
    const end = newline < 0 ? input.length : newline
    const row = input.slice(offset, end)

    const heading = /^On branch (\S+)/.exec(row)
    if (heading) {
      branch = heading[1]
    } else if (row.startsWith('##')) {
      // Porcelain branch header, e.g. `## main...origin/main`.
      branch = row.slice(2).trimStart()
    } else if (PORCELAIN_ROW.test(row)) {
      const path = row.slice(3)
      if (row.startsWith('??')) {
        counts[UNTRACKED] += 1
        if (samples[UNTRACKED].length < SECTIONS[UNTRACKED].limit) samples[UNTRACKED].push(path)
      } else {
        // Column 1 is the index, column 2 the worktree; a file can be in both.
        if (STAGED_LETTERS.includes(row[0])) {
          counts[STAGED] += 1
          if (samples[STAGED].length < SECTIONS[STAGED].limit) samples[STAGED].push(path)
        } else if (row[0] === 'U') {
          conflicts += 1
        }
        if (row[1] === 'M' || row[1] === 'D') {
          counts[MODIFIED] += 1
          if (samples[MODIFIED].length < SECTIONS[MODIFIED].limit) samples[MODIFIED].push(path)
        }
      }
    } else {
      const detail = LONG_FORM_ROW.exec(row)
      if (detail) {
        const path = detail[2].trim()
        if (detail[1] === 'both modified') {
          conflicts += 1
        } else if (detail[1] === 'modified' || detail[1] === 'deleted') {
          counts[MODIFIED] += 1
          if (samples[MODIFIED].length < SECTIONS[MODIFIED].limit) samples[MODIFIED].push(path)
        } else {
          counts[STAGED] += 1
          if (samples[STAGED].length < SECTIONS[STAGED].limit) samples[STAGED].push(path)
        }
      }
    }

    if (newline < 0) break
    offset = newline + 1
  }

  const output = branch ? [`* ${branch}`] : []
  for (const index of [STAGED, MODIFIED, UNTRACKED]) {
    const count = counts[index]
    if (count === 0) continue
    output.push(`${SECTIONS[index].label}: ${count} files`)
    for (const path of samples[index]) output.push(`   ${path}`)
    if (count > samples[index].length) output.push(`   ... +${count - samples[index].length} more`)
  }
  if (conflicts > 0) output.push(`conflicts: ${conflicts} files`)
  // An empty status is a fact the model must be told explicitly: silence reads as
  // "the command failed", and the model then runs status again.
  if (conflicts === 0 && counts.every(count => count === 0)) output.push('clean — nothing to commit')
  return output.join('\n')
}

gitStatus.filterName = 'git-status'
