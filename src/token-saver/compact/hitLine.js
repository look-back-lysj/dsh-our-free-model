/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0); the parsing rules
 * here are shaped by what those filters accept. See LICENSE.
 */

/**
 * Reading `path:line:text` rows from search output.
 *
 * ## The ambiguity this has to resolve
 *
 * A search hit is three fields separated by colons. That is only unambiguous when
 * the path cannot itself contain a colon — which stops being true on Windows,
 * where `C:\src\a.js:12:foo` has four colons. Splitting from the left would read
 * `C` as the file and `\src\a.js` as the line number.
 *
 * So the first delimiter is skipped when the row starts with a drive letter. That
 * is the only case where a colon can legally appear before the first separator,
 * which makes the rule narrow enough not to need heuristics.
 *
 * @module src/token-saver/compact/hit-line
 */

/** `X:` or `X:/` or `X:\` — a Windows drive prefix, not a field separator. */
const DRIVE_PREFIX = /^[A-Za-z]:[\\/]/

/** One or more digits, and nothing else. */
const LINE_NUMBER = /^\d+$/

/**
 * Split one row into `{ file, line, content }`, or `null` if it is not shaped
 * like a hit at all.
 *
 * `line` is returned as text, not a number: callers validate it with
 * {@link LINE_NUMBER} and the filters re-pad it, so converting and converting
 * back would only lose the original width.
 */
export function splitGrepHit(row) {
  const skip = DRIVE_PREFIX.test(row) ? 2 : 0
  const fileEnd = row.indexOf(':', skip)
  if (fileEnd < 0) return null
  const lineEnd = row.indexOf(':', fileEnd + 1)
  if (lineEnd < 0) return null
  return {
    file: row.substring(0, fileEnd),
    line: row.substring(fileEnd + 1, lineEnd),
    content: row.substring(lineEnd + 1),
  }
}

/**
 * Does this row look like a real hit?
 *
 * Stricter than {@link splitGrepHit}, deliberately: the detector uses this to
 * decide whether a blob is search output at all, and a false positive routes a
 * non-search blob to a filter that would mangle it. A real hit has a numeric line
 * and a path — something carrying a separator or a dot, with no whitespace,
 * because a path containing a space would have been quoted and the quoting is not
 * preserved in this format.
 */
export function isGrepHit(row) {
  const hit = splitGrepHit(row)
  if (hit === null) return false
  if (!LINE_NUMBER.test(hit.line)) return false
  return /[\\/.]/.test(hit.file) && !/\s/.test(hit.file)
}

/**
 * Parse a whole blob as search output, or return `null` if any row breaks the
 * shape.
 *
 * All-or-nothing on purpose. A partially-parsed blob means the filter would
 * silently drop the rows it could not read, and a search result with holes in it
 * is worse than an uncompacted one.
 */
export function parseGrepOutput(text) {
  const hits = []
  let offset = 0
  for (;;) {
    const newline = text.indexOf('\n', offset)
    const end = newline < 0 ? text.length : newline
    const row = text.slice(offset, end)
    if (row.trim()) {
      const hit = splitGrepHit(row)
      if (hit === null || !hit.file.trim() || !LINE_NUMBER.test(hit.line)) return null
      hits.push(hit)
    }
    if (newline < 0) break
    offset = newline + 1
  }
  return hits.length > 0 ? hits : null
}
