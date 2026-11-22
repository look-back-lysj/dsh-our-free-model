/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The classification
 * order below is what decides which shape a model is shown; see
 * LICENSE.
 */

/**
 * Decide which filter, if any, should compact a blob.
 *
 * ## Why detection exists at all
 *
 * The alternative is to ask the caller which tool produced the output, and there
 * is no such field in any of the three wire protocols. The request carries text
 * and nothing about its provenance, so the only way to compact it is to recognise
 * it.
 *
 * ## The cost of a wrong guess
 *
 * A filter applied to the wrong blob does not fail loudly — it rewrites the text
 * into a shape that never happened, and the model reads a fiction. So the order
 * below is deliberate: strong structural signals first (a diff header, a commit
 * line), weak statistical ones last (enough non-empty lines), and `null` — leave it
 * alone — is always preferred over a guess.
 *
 * ## Two-phase detection
 *
 * Phase one is cheap and decisive: a handful of anchored regexes over the first
 * {@link DETECT_WINDOW} bytes. Phase two only runs if phase one found nothing, and
 * it samples the blob to score it against several weak hypotheses at once. Keeping
 * them separate means the common case (a diff, a status, a log) costs four regexes
 * rather than a full scan.
 *
 * @module src/token-saver/compact/autodetect
 */

import { DETECT_WINDOW, READ_NUMBERED_MIN_HIT_RATIO, SMART_TRUNCATE_MIN_LINES } from './constants.js'
import { gitDiff } from './filters/gitDiff.js'
import { gitStatus } from './filters/gitStatus.js'
import { gitLog } from './filters/gitLog.js'
import { buildOutput } from './filters/buildOutput.js'
import { grep } from './filters/grep.js'
import { find } from './filters/find.js'
import { dedupLog } from './filters/dedupLog.js'
import { ls } from './filters/ls.js'
import { tree } from './filters/tree.js'
import { smartTruncate } from './filters/smartTruncate.js'
import { readNumbered, READ_NUMBERED_LINE_RE } from './filters/readNumbered.js'
import { searchList, SEARCH_LIST_HEADER_RE } from './filters/searchList.js'
import { isGrepHit, splitGrepHit, parseGrepOutput } from './hitLine.js'

/** Anchored signals that identify a blob from its opening bytes alone. */
const OPENING_SIGNALS = [
  [/^[*|/\\ ]*commit [0-9a-f]{7,40}$/m, gitLog],
  [/^(?:diff --git |@@ )/m, gitDiff],
  [/^(?:On branch |nothing to commit|Changes (?:not |to be )|Untracked files:)/m, gitStatus],
  [/^(?:npm (?:warn|error|ERR!)|yarn (?:warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|added \d+ package|\[ERROR\]|BUILD (?:SUCCESS|FAILED)|\s*Finished\s+|Successfully (?:installed|built)|ERROR:)/im, buildOutput],
]

/** A `ls -l` permissions string at the start of a row. */
const LISTING_ROW = /^[-dlbcps][rwx-]{9}/

/** A porcelain status row that is not an indented continuation. */
const PORCELAIN_ROW = /^(?!  )[ MADRCU?!][ MADRCU?!] \S/

/** A row that looks like a path rather than prose. */
const PATH_ROW = /^[A-Za-z]:[\\/]/

/** Rows sampled in phase two when scoring weak hypotheses. */
const PHASE_TWO_SAMPLE = 5

/**
 * What phase two measured about a blob.
 *
 * `nonEmpty` is the denominator for the ratio tests; `paths` counts rows that look
 * like bare paths, which is what separates a `find` listing from prose that happens
 * to have several lines.
 */
function profileBlob(head) {
  const lines = head.split('\n')
  let nonEmpty = 0
  let porcelain = 0
  let paths = 0
  let listings = 0
  let numbered = 0
  let sampled = 0

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    // Numbering is only measured over the first 100 rows: a numbered dump is
    // numbered throughout, so a longer sample buys nothing.
    if (index < 100 && line.length > 0) {
      sampled += 1
      if (READ_NUMBERED_LINE_RE.test(line)) numbered += 1
    }
    if (LISTING_ROW.test(line)) listings += 1
    if (trimmed === '') continue
    nonEmpty += 1
    if (PORCELAIN_ROW.test(line)) porcelain += 1
    if (PATH_ROW.test(trimmed) || (!trimmed.includes(':') && (trimmed.startsWith('.') || trimmed.includes('/')))) {
      paths += 1
    }
  }
  return { nonEmpty, porcelain, paths, listings, numbered, sampled }
}

/**
 * Score the first few non-empty rows as search hits.
 *
 * Two separate questions: does any row carry a numeric line field (which makes it
 * hit-shaped at all), and does any row carry a path (which makes it a search result
 * rather than a numbered dump). A blob can be the first without being the second,
 * and that case must not be routed to the grep filter.
 */
function sampleHits(text) {
  let sampled = 0
  let numericLine = false
  let hasPath = false
  for (let offset = 0; offset < text.length && sampled < PHASE_TWO_SAMPLE;) {
    const newline = text.indexOf('\n', offset)
    const end = newline < 0 ? text.length : newline
    const line = text.slice(offset, end)
    if (line.trim()) {
      sampled += 1
      const hit = splitGrepHit(line)
      if (hit !== null && /^\d+$/.test(hit.line)) numericLine = true
      if (isGrepHit(line)) hasPath = true
    }
    offset = end + 1
  }
  return { numericLine, hasPath }
}

/** How many lines the blob has, counted only as far as the truncation threshold. */
function reachesTruncationThreshold(text) {
  let count = 1
  let position = -1
  while (count < SMART_TRUNCATE_MIN_LINES) {
    position = text.indexOf('\n', position + 1)
    if (position < 0) return false
    count += 1
  }
  return true
}

/**
 * The filter for this blob, or `null` to leave it untouched.
 *
 * `null` is the answer for anything ambiguous. That is the safe direction: an
 * uncompacted blob costs tokens, while a wrongly compacted one costs correctness.
 */
export function autoDetectFilter(text) {
  const head = text.slice(0, DETECT_WINDOW)

  // Phase one: a decisive opening signal ends the search.
  for (const [pattern, filter] of OPENING_SIGNALS) {
    if (pattern.test(head)) return filter
  }

  // Phase two: score the weak hypotheses.
  const { nonEmpty, porcelain, paths, listings, numbered, sampled } = profileBlob(head)
  if (nonEmpty >= 3 && porcelain / nonEmpty >= 0.6) return gitStatus

  const { numericLine, hasPath } = sampleHits(text)
  if (numericLine) {
    // Hit-shaped but no path anywhere means it is not a search result. Checking
    // the whole blob parses is what keeps a numbered dump out of this branch.
    return hasPath && parseGrepOutput(text) !== null ? grep : null
  }
  if (nonEmpty >= 3 && paths === nonEmpty) return find
  if (/[├└]──|│  /.test(head)) return tree
  if (/^total \d+$/m.test(head) || listings >= 3) return ls
  if (SEARCH_LIST_HEADER_RE.test(head)) return searchList
  if (sampled >= 5 && numbered / sampled >= READ_NUMBERED_MIN_HIT_RATIO && head.split('\n').length >= SMART_TRUNCATE_MIN_LINES) {
    return readNumbered
  }
  if (nonEmpty >= 5) return dedupLog
  if (reachesTruncationThreshold(text)) return smartTruncate
  return null
}
