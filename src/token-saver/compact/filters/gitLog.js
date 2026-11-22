/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */

/**
 * Compact a git log: keep commits, subjects and diffstats; drop commit bodies.
 *
 * ## What survives, and why
 *
 * A model reading a log needs to know which commits exist, what each one said, and
 * how big it was. It does not need the multi-paragraph commit message — that is
 * prose written for a human reviewing history, and it is usually the bulk of the
 * output.
 *
 * Three input dialects are handled, because the same command produces all three:
 *
 * - **plain** — `commit <sha>` then `Author:` / `Date:` then an indented subject;
 * - **graph** — the same, prefixed with `*`, `|`, `/`, `\` by `--graph`;
 * - **full** — with `diff --git` bodies, which are collapsed to one marker line.
 *
 * The subject is the one indented line that follows the headers. Later indented
 * paragraphs are the body and are dropped; the `file changed` diffstat is kept
 * because it is a fact about the commit rather than commentary on it.
 *
 * ## The final guard
 *
 * If the result is longer than the input, the input is returned. That cannot
 * normally happen, but the whole point of this module is to make output smaller,
 * and a filter that occasionally enlarges a blob is worse than no filter.
 *
 * @module src/token-saver/compact/filters/git-log
 */

import { GIT_LOG_MAX_LINES } from '../constants.js'

/** A commit line, with or without graph decoration. */
const COMMIT_LINE = /^(?:commit [0-9a-f]{7,40}$|[*|/\\ ]+commit [0-9a-f]{7,40})/i

/** `Author:` / `Date:` lines, with or without graph decoration. */
const HEADER_LINE = /^[*|/\\ ]*(?:Author|Date):/i

/** An indented line: four spaces after any graph decoration. */
const INDENTED_LINE = /^[*|/\\ ]*    \S/

/** A diffstat row. */
const DIFFSTAT_LINE = /^\d+ file\w* changed/

/** A bare graph row: decoration only, no content. */
const GRAPH_ONLY = /^[*|/\\ ]+$/

/** A graph row carrying `sha subject`. */
const GRAPH_SUBJECT = /^[*|/\\ ]+([0-9a-f]{7,40}\s+.+)/i

export function gitLog(text, maxLines = GIT_LOG_MAX_LINES) {
  if (!text) return ''
  const input = String(text)
  const output = []
  let inCommit = false
  let subjectSeen = false
  let skipped = 0

  let offset = 0
  for (;;) {
    const newline = input.indexOf('\n', offset)
    const end = newline < 0 ? input.length : newline
    const row = input.slice(offset, end).trimEnd()
    const trimmed = row.trim()
    let selected

    if (COMMIT_LINE.test(trimmed)) {
      inCommit = true
      subjectSeen = false
      selected = row
    } else if (inCommit) {
      if (HEADER_LINE.test(trimmed)) {
        selected = trimmed
      } else if (trimmed) {
        if (!subjectSeen && INDENTED_LINE.test(row)) {
          // The first indented line is the subject; later ones are the body.
          selected = `  Subject: ${trimmed}`
          subjectSeen = true
        } else if (DIFFSTAT_LINE.test(trimmed)) {
          selected = `  ${trimmed}`
        } else if (trimmed.startsWith('diff --git ')) {
          selected = '  ... diff body omitted'
        }
      }
    } else {
      // Before the first commit line: either a graph row carrying a subject, or
      // plain text that belongs in the output as-is.
      const graph = GRAPH_SUBJECT.exec(trimmed)
      if (graph) selected = graph[1]
      else if (!GRAPH_ONLY.test(trimmed) || !/[*|/\\]/.test(trimmed)) selected = trimmed
    }

    if (selected !== undefined) {
      if (output.length < maxLines) output.push(selected)
      else skipped += 1
    }
    if (newline < 0) break
    offset = newline + 1
  }

  if (skipped > 0) output.push(`... (${skipped} more lines)`)
  const result = output.join('\n')
  return result && result.length <= input.length ? result : input
}

gitLog.filterName = 'git-log'
