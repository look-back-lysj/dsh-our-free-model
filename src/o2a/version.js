/** Wire contract constants for the free lane. See SYNC.md for the replacement status.
 * @module src/o2a/version.js
 */

/**
 * The released client whose wire contract this lane follows.
 *
 * This is the one version string that reaches the network: it forms
 * {@link CLIENT_UA}, and the two verbatim assets in `assets/` are generated from
 * the matching `sst/opencode` tag (see `docs/opencode-assets.md`). It is
 * deliberately not the version of any other project.
 */
export const V2_CLIENT_VERSION = '2.2.3'
export const CLIENT_UA = `opencode/latest/${V2_CLIENT_VERSION}/cli`
export const V2_COMPLETION_LIMIT = 32000
export const ANONYMOUS_CREDENTIAL = 'public'
