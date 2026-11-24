/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */

/**
 * Compact a build log: keep every diagnostic, count the repetitive progress rows.
 *
 * ## What must never be dropped
 *
 * An error, and its continuation lines. A Rust or TypeScript diagnostic spans
 * several rows (`error[E0308]:`, then `--> src/a.rs:12`, then the source line, then
 * a note), and the first row alone is useless — it names the kind of problem but
 * not where. So once a diagnostic starts, its continuation rows are captured
 * verbatim until a row stops looking like part of it.
 *
 * Errors are never capped. A build log with 200 errors is a log where the model
 * needs to know there are 200; hiding the tail would suggest the build is nearly
 * clean.
 *
 * ## What is counted instead
 *
 * Progress rows — `Compiling foo`, `Downloading bar`, deprecation warnings, the
 * `Finished` / `added N packages` footer. These repeat once per unit of work and
 * carry no information a count does not. They are summarised, with samples kept so
 * the model can see the shape.
 *
 * ## Ordering
 *
 * Deprecations first, then progress counts, then errors, then warnings, then
 * summaries. Errors are the reason anyone reads a failed build, so they come before
 * the softer material even though they were parsed last.
 *
 * @module src/token-saver/compact/filters/build-output
 */

/** Footer and summary rows: the build's own conclusion, kept verbatim. */
const SUMMARY_ROW = /^(?:(?:added|removed|changed|audited|installed)\s+\d+\s+package|Finished\s+|BUILD SUCCESS|\d+\s+(?:vulnerabilities|packages?|warnings?|errors?)|Successfully (?:installed|built)|To address .* issues|Run `npm (?:audit|fund)`)|packages are looking for funding/i

/** A hard failure row, in any of the toolchains this lane sees. */
const ERROR_ROW = /^(?:npm (?:ERR!|error)|yarn error|\[ERROR\]|BUILD FAILED)/i

/** A deprecation notice. */
const DEPRECATION_ROW = /^npm warn deprecated/i

/** A soft warning row. */
const WARNING_ROW = /^(?:npm warn|yarn warn|\[WARNING\])/i

/** A compiler-style error that opens a multi-row diagnostic. */
const DIAGNOSTIC_START = /^error(?:\[|:)/i

/** A compiler-style warning that opens a multi-row diagnostic. */
const WARNING_DIAGNOSTIC_START = /^warning(?:\[|:)/i

/** A continuation row of an open diagnostic: an arrow, a gutter or a marker line. */
const DIAGNOSTIC_CONTINUATION = /^\s*(?:-->|\||\d+\s*\||=)/

/** A unit of compilation. */
const COMPILING_ROW = /^Compiling\s+\S+/i

/** A unit of download. */
const DOWNLOAD_ROW = /^(?:Downloading\s+\S+|Fetching\s+)/i

/** Samples kept per category. */
const DEPRECATION_SAMPLES = 3
const WARNING_SAMPLES = 5

export function buildOutput(input) {
  const errors = []
  const warnings = []
  const deprecated = []
  const summaries = []
  let warningCount = 0
  let deprecationCount = 0
  let compiled = 0
  let downloaded = 0
  let inDiagnostic = false

  let offset = 0
  for (;;) {
    const newline = input.indexOf('\n', offset)
    const end = newline < 0 ? input.length : newline
    const row = input.slice(offset, end)
    const text = row.trim()

    if (inDiagnostic && text !== '' && DIAGNOSTIC_CONTINUATION.test(row)) {
      // Part of the diagnostic that opened above: keep it with its parent.
      errors.push(row)
    } else {
      inDiagnostic = false
      if (ERROR_ROW.test(text)) {
        errors.push(row)
      } else if (DEPRECATION_ROW.test(text)) {
        deprecationCount += 1
        if (deprecated.length < DEPRECATION_SAMPLES) deprecated.push(row)
      } else if (WARNING_ROW.test(text)) {
        warningCount += 1
        if (warnings.length < WARNING_SAMPLES) warnings.push(row)
      } else if (DIAGNOSTIC_START.test(text) || text.startsWith('error -->')) {
        errors.push(row)
        inDiagnostic = true
      } else if (WARNING_DIAGNOSTIC_START.test(text) || text.startsWith('warning -->')) {
        warningCount += 1
        if (warnings.length < WARNING_SAMPLES) warnings.push(row)
        inDiagnostic = true
      } else if (COMPILING_ROW.test(text)) {
        compiled += 1
      } else if (DOWNLOAD_ROW.test(text)) {
        downloaded += 1
      } else if (SUMMARY_ROW.test(text)) {
        summaries.push(row)
      }
    }

    if (newline < 0) break
    offset = newline + 1
  }

  const head = deprecated.slice()
  if (deprecationCount > DEPRECATION_SAMPLES) {
    head.push(`... +${deprecationCount - DEPRECATION_SAMPLES} more deprecated packages`)
  }
  if (compiled > 0) head.push(`Compiled ${compiled} packages`)
  if (downloaded > 0) head.push(`Downloaded ${downloaded} packages`)

  // Accumulate rather than spreading the arrays into a call: a log with thousands
  // of errors would otherwise exceed the argument limit.
  let result = head.join('\n')
  const append = row => { result += `${result ? '\n' : ''}${row}` }
  for (const row of errors) append(row)
  for (const row of warnings) append(row)
  if (warningCount > WARNING_SAMPLES) append(`... +${warningCount - WARNING_SAMPLES} more warnings`)
  for (const row of summaries) append(row)
  return result || input
}

buildOutput.filterName = 'build-output'
