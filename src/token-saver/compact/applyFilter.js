/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0); the fail-open
 * contract below is why these filters are safe to run on live traffic.
 * See LICENSE.
 */

/**
 * Run one filter, and be unable to make the request worse by doing so.
 *
 * This module sits between the user's turn and the provider, so its worst
 * acceptable outcome is saving nothing — never a broken request. Three ways a
 * filter can fail, all handled the same way:
 *
 * - it is not a function (a detector returned `undefined` where a filter was
 *   expected);
 * - it throws (a regex on a pathological blob, a bad assumption about the input);
 * - it returns something that is not a string (a filter that forgot its return).
 *
 * In every case the original text is returned unchanged, and the failure is
 * logged once so a silent no-op does not look like a filter that simply found
 * nothing to do.
 *
 * @module src/token-saver/compact/apply-filter
 */

/**
 * Apply `filter` to `text`, falling back to `text` on any failure.
 *
 * The log line names the filter rather than the blob: the blob is user content
 * and may be large or sensitive, while the filter name is the actionable part.
 */
export function safeApply(filter, text) {
  if (typeof filter !== 'function') return text
  try {
    const result = filter(text)
    return typeof result === 'string' ? result : text
  } catch (error) {
    const name = filter.filterName || filter.name || 'anonymous'
    console.warn(`[rtk] warning: filter '${name}' panicked — passing through raw output: ${error?.message || error}`)
    return text
  }
}
