/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0); the filter ids and
 * the command aliases below are its naming, kept so a saved report stays readable.
 * See LICENSE.
 */

/**
 * Looking filters up by name.
 *
 * The ids are a visible contract — the savings report prints `via git-diff`, and a
 * user who searches this repository for that string must find it — so the map is
 * built from the filters' own `filterName` property rather than from a second,
 * hand-maintained list that could drift out of step with them.
 *
 * The aliases exist because two of these filters also answer to the name of the
 * tool that usually produces the input. `rg` is ripgrep, whose output the `grep`
 * filter parses; `fd` is fd-find, whose output the `find` filter parses. Neither
 * needs a separate implementation.
 *
 * @module src/token-saver/compact/registry
 */

import { gitDiff } from './filters/gitDiff.js'
import { gitStatus } from './filters/gitStatus.js'
import { gitLog } from './filters/gitLog.js'
import { grep } from './filters/grep.js'
import { find } from './filters/find.js'
import { dedupLog } from './filters/dedupLog.js'
import { ls } from './filters/ls.js'
import { tree } from './filters/tree.js'
import { smartTruncate } from './filters/smartTruncate.js'
import { readNumbered } from './filters/readNumbered.js'
import { searchList } from './filters/searchList.js'

const ALL = [
  gitDiff, gitStatus, gitLog, grep, find, dedupLog, ls, tree,
  smartTruncate, readNumbered, searchList,
]

const byName = Object.fromEntries(ALL.map(filter => [filter.filterName, filter]))

/** Tool names that produce output an existing filter already understands. */
const ALIASES = { rg: grep, fd: find }

/**
 * The filter registered under `name`, or `null`.
 *
 * Returning `null` rather than throwing is deliberate: callers treat an unknown
 * name as "nothing to do", which is the same outcome as a filter that found no
 * match.
 */
export function resolveFilter(name) {
  return ALIASES[name] ?? byName[name] ?? null
}

/** Every registered filter, keyed by id. */
export function allFilters() {
  return byName
}
