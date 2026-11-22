/*!
 * The output markers and byte budgets in this module are a compatibility surface:
 * a model has been trained to read these exact shapes, so changing one changes
 * what the model understands, not merely how the text looks. Adapted from the
 * RTK command filters (rtk-ai/rtk, Apache-2.0); see LICENSE.
 */

/**
 * Every threshold and marker the tool-output compaction shares.
 *
 * ## Why these live in one module
 *
 * The detector decides what a blob is from the same window the filter then
 * compacts. If the two disagreed about a threshold, a blob could be routed to a
 * filter that silently refuses it — the request would carry the original bytes
 * while the savings panel reported a hit that never happened. Keeping every
 * number in one place makes that disagreement impossible to introduce by
 * accident.
 *
 * ## Why the values are not tuning knobs
 *
 * The emitted markers are what a model has already been trained on. `+ Staged:
 * N files` and `... (N lines truncated)` are read as structure, so a different
 * spelling costs comprehension even when the information is identical. Treat
 * these as a wire format.
 *
 * @module src/token-saver/compact/constants
 */

/** Hard ceiling on one blob. Above this it is a runaway dump, not tool output. */
export const RAW_CAP = 10 * 1024 * 1024

/** Below this, compaction costs more attention than it saves. */
export const MIN_COMPRESS_SIZE = 500

/** How much of a blob the detector reads before deciding. */
export const DETECT_WINDOW = 1024

/** Additions kept per diff hunk before the rest is counted instead of shown. */
export const GIT_DIFF_HUNK_MAX_LINES = 100

/** Context lines kept around a change. */
export const GIT_DIFF_CONTEXT_KEEP = 3

/** Commit lines kept from a log before the remainder is counted. */
export const GIT_LOG_MAX_LINES = 200

/** Ceiling on emitted rows for a log with no other structure. */
export const DEDUP_LINE_MAX = 2000

/** Sample hits kept per file in a search result. */
export const GREP_PER_FILE_MAX = 10

/** Sample paths kept per directory in a file listing. */
export const FIND_PER_DIR_MAX = 10

/** Directories listed before the remainder is counted. */
export const FIND_TOTAL_DIR_MAX = 20

/** Sample paths kept per status category. */
export const STATUS_MAX_FILES = 10

/** Sample untracked paths kept. */
export const STATUS_MAX_UNTRACKED = 10

/** Extension buckets named in a listing summary. */
export const LS_EXT_SUMMARY_TOP = 5

/**
 * Directory names a listing never shows.
 *
 * Grouped by what they are rather than listed flat, because the grouping is the
 * useful part: a reader can see at a glance that dependency trees, build output,
 * editor state, VCS metadata and OS cruft are all covered, and can judge whether
 * a new entry belongs. Membership is what matters — this is consumed as a set,
 * so the order of this array carries no meaning.
 *
 * `.env` is deliberately absent: dotfiles are configuration a reader may need,
 * while `env` without the dot is a Python virtualenv and is not.
 */
export const LS_NOISE_DIRS = [
  // Dependency trees
  'node_modules', '.venv', 'venv', 'env', '.eggs', '*.egg-info',
  // Build output and caches
  'dist', 'build', 'target', '.next', '.cache', '.turbo', '.vercel',
  '.nyc_output', 'coverage', '__pycache__', '.pytest_cache', '.mypy_cache', '.tox',
  // VCS metadata
  '.git',
  // Editor and IDE state
  '.idea', '.vscode', '.vs',
  // OS cruft
  '.DS_Store', 'Thumbs.db',
]

/** Tree rows kept before the remainder is counted. */
export const TREE_MAX_LINES = 200

/** Sample paths kept per directory in a glob result. */
export const SEARCH_LIST_PER_DIR_MAX = 10

/** Directories listed before the remainder is counted. */
export const SEARCH_LIST_TOTAL_DIR_MAX = 20

/** Leading lines kept by the head/tail window. */
export const SMART_TRUNCATE_HEAD = 120

/** Trailing lines kept by the head/tail window. */
export const SMART_TRUNCATE_TAIL = 60

/** Below this many lines a blob is not worth windowing. */
export const SMART_TRUNCATE_MIN_LINES = 250

/** Share of sampled lines that must look numbered before a dump is windowed as one. */
export const READ_NUMBERED_MIN_HIT_RATIO = 0.7

/**
 * Filter ids.
 *
 * These reach the savings report, so they are part of the visible contract: a
 * user who sees `via git-diff` and then searches this repository must find it.
 */
export const FILTERS = {
  GIT_DIFF: 'git-diff',
  GIT_STATUS: 'git-status',
  GIT_LOG: 'git-log',
  GREP: 'grep',
  FIND: 'find',
  LS: 'ls',
  TREE: 'tree',
  DEDUP_LOG: 'dedup-log',
  SMART_TRUNCATE: 'smart-truncate',
  READ_NUMBERED: 'read-numbered',
  SEARCH_LIST: 'search-list',
  BUILD_OUTPUT: 'build-output',
}
