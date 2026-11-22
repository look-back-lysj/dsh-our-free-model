// src/token-saver/compact/constants.js
/*!
 * The output markers and byte budgets in this module are a compatibility surface:
 * a model has been trained to read these exact shapes, so changing one changes
 * what the model understands, not merely how the text looks. Adapted from the
 * RTK command filters (rtk-ai/rtk, Apache-2.0); see LICENSE.
 */
var RAW_CAP = 10 * 1024 * 1024;
var MIN_COMPRESS_SIZE = 500;
var DETECT_WINDOW = 1024;
var GIT_DIFF_HUNK_MAX_LINES = 100;
var GIT_LOG_MAX_LINES = 200;
var DEDUP_LINE_MAX = 2e3;
var GREP_PER_FILE_MAX = 10;
var FIND_PER_DIR_MAX = 10;
var FIND_TOTAL_DIR_MAX = 20;
var STATUS_MAX_FILES = 10;
var STATUS_MAX_UNTRACKED = 10;
var LS_EXT_SUMMARY_TOP = 5;
var LS_NOISE_DIRS = [
  // Dependency trees
  "node_modules",
  ".venv",
  "venv",
  "env",
  ".eggs",
  "*.egg-info",
  // Build output and caches
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
  ".turbo",
  ".vercel",
  ".nyc_output",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  // VCS metadata
  ".git",
  // Editor and IDE state
  ".idea",
  ".vscode",
  ".vs",
  // OS cruft
  ".DS_Store",
  "Thumbs.db"
];
var TREE_MAX_LINES = 200;
var SEARCH_LIST_PER_DIR_MAX = 10;
var SEARCH_LIST_TOTAL_DIR_MAX = 20;
var SMART_TRUNCATE_HEAD = 120;
var SMART_TRUNCATE_TAIL = 60;
var SMART_TRUNCATE_MIN_LINES = 250;
var READ_NUMBERED_MIN_HIT_RATIO = 0.7;

// src/token-saver/compact/filters/gitDiff.js
/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */
var FILE_BOUNDARY = "diff --git";
var HUNK_BOUNDARY = "@@";
var TRUNCATION_NOTE = "[diff truncated by OFM; disable tool-output compression and request the diff again]";
var PATH_MARKER = " b/";
function gitDiff(input, maxLines = 500) {
  const output = [];
  let file = "";
  let added = 0;
  let removed = 0;
  let shown = 0;
  let omitted = 0;
  let inHunk = false;
  let truncated = false;
  const flushOmitted = () => {
    if (omitted === 0) return;
    output.push(`  ... (${omitted} lines truncated)`);
    truncated = true;
    omitted = 0;
  };
  const flushCounts = () => {
    if (file && (added > 0 || removed > 0)) output.push(`  +${added} -${removed}`);
  };
  let offset = 0;
  for (; ; ) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const row = input.slice(offset, end);
    if (row.startsWith(FILE_BOUNDARY) || row.startsWith(HUNK_BOUNDARY)) {
      flushOmitted();
      shown = 0;
      inHunk = row.startsWith(HUNK_BOUNDARY);
      if (inHunk) {
        output.push(`  ${row}`);
      } else {
        flushCounts();
        const marker = row.indexOf(PATH_MARKER);
        file = marker < 0 ? "unknown" : row.slice(marker + PATH_MARKER.length);
        output.push(`
${file}`);
        added = 0;
        removed = 0;
      }
    } else if (inHunk) {
      const isAddition = row[0] === "+" && !row.startsWith("+++");
      const isDeletion = row[0] === "-" && !row.startsWith("---");
      if (isAddition) added += 1;
      if (isDeletion) removed += 1;
      if (isAddition || isDeletion) {
        if (shown < GIT_DIFF_HUNK_MAX_LINES) {
          output.push(`  ${row}`);
          shown += 1;
        } else {
          omitted += 1;
        }
      } else if (shown > 0 && shown < GIT_DIFF_HUNK_MAX_LINES && row[0] !== "\\") {
        output.push(`  ${row}`);
        shown += 1;
      }
    }
    if (output.length >= maxLines) {
      output.push("\n... (more changes truncated)");
      truncated = true;
      break;
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  flushOmitted();
  flushCounts();
  if (truncated) output.push(TRUNCATION_NOTE);
  return output.join("\n");
}
gitDiff.filterName = "git-diff";

// src/token-saver/compact/filters/gitStatus.js
/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */
var PORCELAIN_ROW = /^[ MADRCU?!][ MADRCU?!] /;
var LONG_FORM_ROW = /^\s*(modified|new file|deleted|renamed|both modified):\s+(.+)$/;
var STAGED_LETTERS = "MADRC";
var STAGED = 0;
var MODIFIED = 1;
var UNTRACKED = 2;
var SECTIONS = [
  { label: "+ Staged", limit: STATUS_MAX_FILES },
  { label: "~ Modified", limit: STATUS_MAX_FILES },
  { label: "? Untracked", limit: STATUS_MAX_UNTRACKED }
];
function gitStatus(input) {
  if (!input.includes("\n") && !input.trim()) return "Clean working tree";
  const counts = [0, 0, 0];
  const samples = [[], [], []];
  let branch = "";
  let conflicts = 0;
  let offset = 0;
  for (; ; ) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const row = input.slice(offset, end);
    const heading = /^On branch (\S+)/.exec(row);
    if (heading) {
      branch = heading[1];
    } else if (row.startsWith("##")) {
      branch = row.slice(2).trimStart();
    } else if (PORCELAIN_ROW.test(row)) {
      const path = row.slice(3);
      if (row.startsWith("??")) {
        counts[UNTRACKED] += 1;
        if (samples[UNTRACKED].length < SECTIONS[UNTRACKED].limit) samples[UNTRACKED].push(path);
      } else {
        if (STAGED_LETTERS.includes(row[0])) {
          counts[STAGED] += 1;
          if (samples[STAGED].length < SECTIONS[STAGED].limit) samples[STAGED].push(path);
        } else if (row[0] === "U") {
          conflicts += 1;
        }
        if (row[1] === "M" || row[1] === "D") {
          counts[MODIFIED] += 1;
          if (samples[MODIFIED].length < SECTIONS[MODIFIED].limit) samples[MODIFIED].push(path);
        }
      }
    } else {
      const detail = LONG_FORM_ROW.exec(row);
      if (detail) {
        const path = detail[2].trim();
        if (detail[1] === "both modified") {
          conflicts += 1;
        } else if (detail[1] === "modified" || detail[1] === "deleted") {
          counts[MODIFIED] += 1;
          if (samples[MODIFIED].length < SECTIONS[MODIFIED].limit) samples[MODIFIED].push(path);
        } else {
          counts[STAGED] += 1;
          if (samples[STAGED].length < SECTIONS[STAGED].limit) samples[STAGED].push(path);
        }
      }
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  const output = branch ? [`* ${branch}`] : [];
  for (const index of [STAGED, MODIFIED, UNTRACKED]) {
    const count = counts[index];
    if (count === 0) continue;
    output.push(`${SECTIONS[index].label}: ${count} files`);
    for (const path of samples[index]) output.push(`   ${path}`);
    if (count > samples[index].length) output.push(`   ... +${count - samples[index].length} more`);
  }
  if (conflicts > 0) output.push(`conflicts: ${conflicts} files`);
  if (conflicts === 0 && counts.every((count) => count === 0)) output.push("clean \u2014 nothing to commit");
  return output.join("\n");
}
gitStatus.filterName = "git-status";

// src/token-saver/compact/filters/gitLog.js
/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */
var COMMIT_LINE = /^(?:commit [0-9a-f]{7,40}$|[*|/\\ ]+commit [0-9a-f]{7,40})/i;
var HEADER_LINE = /^[*|/\\ ]*(?:Author|Date):/i;
var INDENTED_LINE = /^[*|/\\ ]*    \S/;
var DIFFSTAT_LINE = /^\d+ file\w* changed/;
var GRAPH_ONLY = /^[*|/\\ ]+$/;
var GRAPH_SUBJECT = /^[*|/\\ ]+([0-9a-f]{7,40}\s+.+)/i;
function gitLog(text, maxLines = GIT_LOG_MAX_LINES) {
  if (!text) return "";
  const input = String(text);
  const output = [];
  let inCommit = false;
  let subjectSeen = false;
  let skipped = 0;
  let offset = 0;
  for (; ; ) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const row = input.slice(offset, end).trimEnd();
    const trimmed = row.trim();
    let selected;
    if (COMMIT_LINE.test(trimmed)) {
      inCommit = true;
      subjectSeen = false;
      selected = row;
    } else if (inCommit) {
      if (HEADER_LINE.test(trimmed)) {
        selected = trimmed;
      } else if (trimmed) {
        if (!subjectSeen && INDENTED_LINE.test(row)) {
          selected = `  Subject: ${trimmed}`;
          subjectSeen = true;
        } else if (DIFFSTAT_LINE.test(trimmed)) {
          selected = `  ${trimmed}`;
        } else if (trimmed.startsWith("diff --git ")) {
          selected = "  ... diff body omitted";
        }
      }
    } else {
      const graph = GRAPH_SUBJECT.exec(trimmed);
      if (graph) selected = graph[1];
      else if (!GRAPH_ONLY.test(trimmed) || !/[*|/\\]/.test(trimmed)) selected = trimmed;
    }
    if (selected !== void 0) {
      if (output.length < maxLines) output.push(selected);
      else skipped += 1;
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  if (skipped > 0) output.push(`... (${skipped} more lines)`);
  const result2 = output.join("\n");
  return result2 && result2.length <= input.length ? result2 : input;
}
gitLog.filterName = "git-log";

// src/token-saver/compact/filters/buildOutput.js
/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */
var SUMMARY_ROW = /^(?:(?:added|removed|changed|audited|installed)\s+\d+\s+package|Finished\s+|BUILD SUCCESS|\d+\s+(?:vulnerabilities|packages?|warnings?|errors?)|Successfully (?:installed|built)|To address .* issues|Run `npm (?:audit|fund)`)|packages are looking for funding/i;
var ERROR_ROW = /^(?:npm (?:ERR!|error)|yarn error|\[ERROR\]|BUILD FAILED)/i;
var DEPRECATION_ROW = /^npm warn deprecated/i;
var WARNING_ROW = /^(?:npm warn|yarn warn|\[WARNING\])/i;
var DIAGNOSTIC_START = /^error(?:\[|:)/i;
var WARNING_DIAGNOSTIC_START = /^warning(?:\[|:)/i;
var DIAGNOSTIC_CONTINUATION = /^\s*(?:-->|\||\d+\s*\||=)/;
var COMPILING_ROW = /^Compiling\s+\S+/i;
var DOWNLOAD_ROW = /^(?:Downloading\s+\S+|Fetching\s+)/i;
var DEPRECATION_SAMPLES = 3;
var WARNING_SAMPLES = 5;
function buildOutput(input) {
  const errors = [];
  const warnings = [];
  const deprecated = [];
  const summaries = [];
  let warningCount = 0;
  let deprecationCount = 0;
  let compiled = 0;
  let downloaded = 0;
  let inDiagnostic = false;
  let offset = 0;
  for (; ; ) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const row = input.slice(offset, end);
    const text = row.trim();
    if (inDiagnostic && text !== "" && DIAGNOSTIC_CONTINUATION.test(row)) {
      errors.push(row);
    } else {
      inDiagnostic = false;
      if (ERROR_ROW.test(text)) {
        errors.push(row);
      } else if (DEPRECATION_ROW.test(text)) {
        deprecationCount += 1;
        if (deprecated.length < DEPRECATION_SAMPLES) deprecated.push(row);
      } else if (WARNING_ROW.test(text)) {
        warningCount += 1;
        if (warnings.length < WARNING_SAMPLES) warnings.push(row);
      } else if (DIAGNOSTIC_START.test(text) || text.startsWith("error -->")) {
        errors.push(row);
        inDiagnostic = true;
      } else if (WARNING_DIAGNOSTIC_START.test(text) || text.startsWith("warning -->")) {
        warningCount += 1;
        if (warnings.length < WARNING_SAMPLES) warnings.push(row);
        inDiagnostic = true;
      } else if (COMPILING_ROW.test(text)) {
        compiled += 1;
      } else if (DOWNLOAD_ROW.test(text)) {
        downloaded += 1;
      } else if (SUMMARY_ROW.test(text)) {
        summaries.push(row);
      }
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  const head = deprecated.slice();
  if (deprecationCount > DEPRECATION_SAMPLES) {
    head.push(`... +${deprecationCount - DEPRECATION_SAMPLES} more deprecated packages`);
  }
  if (compiled > 0) head.push(`Compiled ${compiled} packages`);
  if (downloaded > 0) head.push(`Downloaded ${downloaded} packages`);
  let result2 = head.join("\n");
  const append = (row) => {
    result2 += `${result2 ? "\n" : ""}${row}`;
  };
  for (const row of errors) append(row);
  for (const row of warnings) append(row);
  if (warningCount > WARNING_SAMPLES) append(`... +${warningCount - WARNING_SAMPLES} more warnings`);
  for (const row of summaries) append(row);
  return result2 || input;
}
buildOutput.filterName = "build-output";

// src/token-saver/compact/hitLine.js
/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0); the parsing rules
 * here are shaped by what those filters accept. See LICENSE.
 */
var DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;
var LINE_NUMBER = /^\d+$/;
function splitGrepHit(row) {
  const skip = DRIVE_PREFIX.test(row) ? 2 : 0;
  const fileEnd = row.indexOf(":", skip);
  if (fileEnd < 0) return null;
  const lineEnd = row.indexOf(":", fileEnd + 1);
  if (lineEnd < 0) return null;
  return {
    file: row.substring(0, fileEnd),
    line: row.substring(fileEnd + 1, lineEnd),
    content: row.substring(lineEnd + 1)
  };
}
function isGrepHit(row) {
  const hit = splitGrepHit(row);
  if (hit === null) return false;
  if (!LINE_NUMBER.test(hit.line)) return false;
  return /[\\/.]/.test(hit.file) && !/\s/.test(hit.file);
}
function parseGrepOutput(text) {
  const hits = [];
  let offset = 0;
  for (; ; ) {
    const newline = text.indexOf("\n", offset);
    const end = newline < 0 ? text.length : newline;
    const row = text.slice(offset, end);
    if (row.trim()) {
      const hit = splitGrepHit(row);
      if (hit === null || !hit.file.trim() || !LINE_NUMBER.test(hit.line)) return null;
      hits.push(hit);
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  return hits.length > 0 ? hits : null;
}

// src/token-saver/compact/filters/grep.js
/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */
var LINE_NUMBER2 = /^\d+$/;
function grep(input) {
  const groups = /* @__PURE__ */ new Map();
  let total = 0;
  let offset = 0;
  for (; ; ) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const row = input.slice(offset, end);
    if (row.trim()) {
      const hit = splitGrepHit(row);
      if (!hit || !hit.file.trim() || !LINE_NUMBER2.test(hit.line)) return input;
      total += 1;
      let group = groups.get(hit.file);
      if (group === void 0) {
        group = { count: 0, samples: [] };
        groups.set(hit.file, group);
      }
      group.count += 1;
      if (group.samples.length < GREP_PER_FILE_MAX) {
        group.samples.push(`  ${hit.line.padStart(4)}: ${hit.content.trim()}
`);
      }
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  if (total === 0) return input;
  const output = [`${total} matches in ${groups.size}F:

`];
  for (const file of [...groups.keys()].sort()) {
    const { count, samples } = groups.get(file);
    output.push(`[file] ${file} (${count}):
`, ...samples);
    if (count > samples.length) output.push(`  +${count - samples.length}
`);
    output.push("\n");
  }
  return output.join("");
}
grep.filterName = "grep";

// src/token-saver/compact/filters/find.js
/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */
function find(input) {
  const groups = /* @__PURE__ */ new Map();
  let total = 0;
  let start = 0;
  for (; ; ) {
    const newline = input.indexOf("\n", start);
    const end = newline < 0 ? input.length : newline;
    const path = input.slice(start, end);
    if (path.trim()) {
      total += 1;
      const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      const directory = separator < 0 ? "." : path.slice(0, separator) || "/";
      let group = groups.get(directory);
      if (group === void 0) {
        group = { count: 0, names: [] };
        groups.set(directory, group);
      }
      group.count += 1;
      if (group.names.length < FIND_PER_DIR_MAX) group.names.push(path.slice(separator + 1));
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  if (total === 0) return input;
  const directories = [...groups.keys()].sort();
  const output = [`${total} files in ${directories.length} dirs:

`];
  for (const directory of directories.slice(0, FIND_TOTAL_DIR_MAX)) {
    const { count, names } = groups.get(directory);
    output.push(`${directory.replace(/\\/g, "/")}/  (${count})
`);
    for (const name of names) output.push(`  ${name}
`);
    if (count > names.length) output.push(`  +${count - names.length}
`);
  }
  if (directories.length > FIND_TOTAL_DIR_MAX) {
    output.push(`
+${directories.length - FIND_TOTAL_DIR_MAX} more dirs
`);
  }
  return output.join("");
}
find.filterName = "find";

// src/token-saver/compact/filters/dedupLog.js
/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */
function dedupLog(input) {
  const output = [];
  let previous;
  let duplicates = 0;
  let previousWasBlank = false;
  let offset = 0;
  for (; ; ) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const row = input.slice(offset, end);
    const blank = row.trim() === "";
    if (!blank && row === previous) {
      duplicates += 1;
    } else {
      if (blank && !previousWasBlank) output.push(row);
      if (duplicates > 0) output.push(`  ... (${duplicates} duplicate lines)`);
      duplicates = 0;
      previous = blank ? void 0 : row;
      if (!blank) {
        output.push(row);
        if (output.length >= DEDUP_LINE_MAX) {
          output.push(`... (truncated at ${DEDUP_LINE_MAX} lines)`);
          return output.join("\n");
        }
      }
    }
    previousWasBlank = blank;
    if (newline < 0) break;
    offset = newline + 1;
  }
  if (duplicates > 0) output.push(`  ... (${duplicates} duplicate lines)`);
  return output.join("\n");
}
dedupLog.filterName = "dedup-log";

// src/token-saver/compact/filters/ls.js
/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */
var NOISE = new Set(LS_NOISE_DIRS);
var DATE_COLUMN = /\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(?:\d{4}|\d{2}:\d{2})\s+/;
function humanSize(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}
function ls(input) {
  let directoryRows = "";
  let fileRows = "";
  let directoryCount = 0;
  let fileCount = 0;
  const extensions = /* @__PURE__ */ new Map();
  let offset = 0;
  for (; ; ) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const row = input.slice(offset, end);
    const date = row.startsWith("total ") ? null : DATE_COLUMN.exec(row);
    if (date !== null) {
      const name = row.slice(date.index + date[0].length);
      const columns = row.slice(0, date.index).trim().split(/\s+/);
      if (columns.length >= 4 && name !== "." && name !== ".." && !NOISE.has(name)) {
        const type = columns[0][0];
        if (type === "d") {
          directoryRows += `${name}/
`;
          directoryCount += 1;
        } else if (type === "-" || type === "l") {
          let bytes = 0;
          for (let index = columns.length - 1; index >= 0; index -= 1) {
            const number = Number(columns[index]);
            if (Number.isInteger(number) && String(number) === columns[index]) {
              bytes = number;
              break;
            }
          }
          fileRows += `${name}  ${humanSize(bytes)}
`;
          fileCount += 1;
          const dot = name.lastIndexOf(".");
          const extension = dot > 0 ? name.slice(dot) : "no ext";
          extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
        }
      }
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  if (directoryCount === 0 && fileCount === 0) return input;
  let summary = `
Summary: ${fileCount} files, ${directoryCount} dirs`;
  if (extensions.size > 0) {
    const ranked = [...extensions].sort((left, right) => right[1] - left[1]);
    const labels = ranked.slice(0, LS_EXT_SUMMARY_TOP).map(([extension, count]) => `${count} ${extension}`);
    if (ranked.length > LS_EXT_SUMMARY_TOP) labels.push(`+${ranked.length - LS_EXT_SUMMARY_TOP} more`);
    summary += ` (${labels.join(", ")})`;
  }
  return directoryRows + fileRows + summary;
}
ls.filterName = "ls";

// src/token-saver/compact/filters/tree.js
/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */
function tree(input) {
  const retained = [];
  let seen = 0;
  let lastContentIndex = 0;
  let offset = 0;
  for (; ; ) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const row = input.slice(offset, end);
    const hasContent = row.trim() !== "";
    const isSummary = row.includes("director") && row.includes("file");
    if (!isSummary && (seen > 0 || hasContent)) {
      seen += 1;
      if (hasContent) lastContentIndex = seen;
      if (retained.length < TREE_MAX_LINES) retained.push(row);
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  retained.length = Math.min(retained.length, lastContentIndex);
  if (lastContentIndex > TREE_MAX_LINES) {
    retained.push(`... +${lastContentIndex - TREE_MAX_LINES} more lines`);
  }
  return retained.join("\n");
}
tree.filterName = "tree";

// src/token-saver/compact/filters/smartTruncate.js
/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */
function truncateWindow(input, suffix) {
  let count = 1;
  let headEnd = input.length;
  let position = input.indexOf("\n");
  while (position !== -1) {
    if (count === SMART_TRUNCATE_HEAD) headEnd = position;
    count += 1;
    position = input.indexOf("\n", position + 1);
  }
  if (count < SMART_TRUNCATE_MIN_LINES) return input;
  let tailStart = input.length;
  for (let line = 0; line < SMART_TRUNCATE_TAIL; line += 1) {
    tailStart = input.lastIndexOf("\n", tailStart - 1);
  }
  const removed = count - SMART_TRUNCATE_HEAD - SMART_TRUNCATE_TAIL;
  return `${input.slice(0, headEnd)}
... +${removed} lines truncated${suffix}
${input.slice(tailStart + 1)}`;
}
function smartTruncate(input) {
  return truncateWindow(input, "");
}
smartTruncate.filterName = "smart-truncate";

// src/token-saver/compact/filters/readNumbered.js
/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */
var READ_NUMBERED_LINE_RE = /^\s*\d+\|/;
function readNumbered(input) {
  return truncateWindow(input, " (file continues)");
}
readNumbered.filterName = "read-numbered";

// src/token-saver/compact/filters/searchList.js
/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */
var SEARCH_LIST_HEADER_RE = /^Result of search in '[^']*' \(total (\d+) files?\):/;
function searchList(input) {
  const headerEnd = input.indexOf("\n");
  if (headerEnd < 0) return input;
  const groups = /* @__PURE__ */ new Map();
  let total = 0;
  let offset = headerEnd + 1;
  for (; ; ) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const row = input.slice(offset, end).trim();
    if (row.startsWith("- ")) {
      const path = row.slice(2);
      const slash = path.lastIndexOf("/");
      const directory = slash < 0 ? "." : path.slice(0, slash) || "/";
      let group = groups.get(directory);
      if (group === void 0) {
        group = { count: 0, names: [] };
        groups.set(directory, group);
      }
      total += 1;
      group.count += 1;
      if (group.names.length < SEARCH_LIST_PER_DIR_MAX) group.names.push(path.slice(slash + 1));
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  if (total === 0) return input;
  const output = [input.slice(0, headerEnd), `${total} files in ${groups.size} dirs:`, ""];
  for (const directory of [...groups.keys()].sort().slice(0, SEARCH_LIST_TOTAL_DIR_MAX)) {
    const { count, names } = groups.get(directory);
    output.push(`${directory}/ (${count}):`);
    for (const name of names) output.push(`  ${name}`);
    if (count > names.length) output.push(`  +${count - names.length}`);
    output.push("");
  }
  if (groups.size > SEARCH_LIST_TOTAL_DIR_MAX) {
    output.push(`+${groups.size - SEARCH_LIST_TOTAL_DIR_MAX} more dirs`);
  }
  return output.join("\n").replace(/\n+$/, "");
}
searchList.filterName = "search-list";

// src/token-saver/compact/autodetect.js
/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The classification
 * order below is what decides which shape a model is shown; see
 * LICENSE.
 */
var OPENING_SIGNALS = [
  [/^[*|/\\ ]*commit [0-9a-f]{7,40}$/m, gitLog],
  [/^(?:diff --git |@@ )/m, gitDiff],
  [/^(?:On branch |nothing to commit|Changes (?:not |to be )|Untracked files:)/m, gitStatus],
  [/^(?:npm (?:warn|error|ERR!)|yarn (?:warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|added \d+ package|\[ERROR\]|BUILD (?:SUCCESS|FAILED)|\s*Finished\s+|Successfully (?:installed|built)|ERROR:)/im, buildOutput]
];
var LISTING_ROW = /^[-dlbcps][rwx-]{9}/;
var PORCELAIN_ROW2 = /^(?!  )[ MADRCU?!][ MADRCU?!] \S/;
var PATH_ROW = /^[A-Za-z]:[\\/]/;
var PHASE_TWO_SAMPLE = 5;
function profileBlob(head) {
  const lines = head.split("\n");
  let nonEmpty = 0;
  let porcelain = 0;
  let paths = 0;
  let listings = 0;
  let numbered = 0;
  let sampled = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (index < 100 && line.length > 0) {
      sampled += 1;
      if (READ_NUMBERED_LINE_RE.test(line)) numbered += 1;
    }
    if (LISTING_ROW.test(line)) listings += 1;
    if (trimmed === "") continue;
    nonEmpty += 1;
    if (PORCELAIN_ROW2.test(line)) porcelain += 1;
    if (PATH_ROW.test(trimmed) || !trimmed.includes(":") && (trimmed.startsWith(".") || trimmed.includes("/"))) {
      paths += 1;
    }
  }
  return { nonEmpty, porcelain, paths, listings, numbered, sampled };
}
function sampleHits(text) {
  let sampled = 0;
  let numericLine = false;
  let hasPath = false;
  for (let offset = 0; offset < text.length && sampled < PHASE_TWO_SAMPLE; ) {
    const newline = text.indexOf("\n", offset);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(offset, end);
    if (line.trim()) {
      sampled += 1;
      const hit = splitGrepHit(line);
      if (hit !== null && /^\d+$/.test(hit.line)) numericLine = true;
      if (isGrepHit(line)) hasPath = true;
    }
    offset = end + 1;
  }
  return { numericLine, hasPath };
}
function reachesTruncationThreshold(text) {
  let count = 1;
  let position = -1;
  while (count < SMART_TRUNCATE_MIN_LINES) {
    position = text.indexOf("\n", position + 1);
    if (position < 0) return false;
    count += 1;
  }
  return true;
}
function autoDetectFilter(text) {
  const head = text.slice(0, DETECT_WINDOW);
  for (const [pattern, filter] of OPENING_SIGNALS) {
    if (pattern.test(head)) return filter;
  }
  const { nonEmpty, porcelain, paths, listings, numbered, sampled } = profileBlob(head);
  if (nonEmpty >= 3 && porcelain / nonEmpty >= 0.6) return gitStatus;
  const { numericLine, hasPath } = sampleHits(text);
  if (numericLine) {
    return hasPath && parseGrepOutput(text) !== null ? grep : null;
  }
  if (nonEmpty >= 3 && paths === nonEmpty) return find;
  if (/[├└]──|│  /.test(head)) return tree;
  if (/^total \d+$/m.test(head) || listings >= 3) return ls;
  if (SEARCH_LIST_HEADER_RE.test(head)) return searchList;
  if (sampled >= 5 && numbered / sampled >= READ_NUMBERED_MIN_HIT_RATIO && head.split("\n").length >= SMART_TRUNCATE_MIN_LINES) {
    return readNumbered;
  }
  if (nonEmpty >= 5) return dedupLog;
  if (reachesTruncationThreshold(text)) return smartTruncate;
  return null;
}

// src/token-saver/compact/applyFilter.js
/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0); the fail-open
 * contract below is why these filters are safe to run on live traffic.
 * See LICENSE.
 */
function safeApply(filter, text) {
  if (typeof filter !== "function") return text;
  try {
    const result2 = filter(text);
    return typeof result2 === "string" ? result2 : text;
  } catch (error) {
    const name = filter.filterName || filter.name || "anonymous";
    console.warn(`[rtk] warning: filter '${name}' panicked \u2014 passing through raw output: ${error?.message || error}`);
    return text;
  }
}

// src/token-saver/compact/index.js
/*!
 * Adapted from the RTK command filters (rtk-ai/rtk, Apache-2.0). The emitted
 * markers are a wire format a model has been trained to read; see
 * LICENSE.
 */
function compressText(text, stats, shape) {
  const before = text.length;
  stats.bytesBefore += before;
  let result2 = text;
  if (before >= MIN_COMPRESS_SIZE && before <= RAW_CAP) {
    const filter = autoDetectFilter(text);
    if (filter !== null) {
      const candidate = safeApply(filter, text);
      if (candidate.length > 0 && candidate.length < before) {
        result2 = candidate;
        stats.hits.push({ shape, filter: filter.filterName || filter.name, saved: before - candidate.length });
      }
    }
  }
  stats.bytesAfter += result2.length;
  return result2;
}
function compactField(owner, key, partType, stringShape, arrayShape, stats) {
  const content = owner[key];
  if (typeof content === "string") {
    owner[key] = compressText(content, stats, stringShape);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!part) continue;
    if (partType !== null && part.type !== partType) continue;
    if (typeof part.text === "string") part.text = compressText(part.text, stats, arrayShape);
  }
}
function walk(items, mode, stats) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item) continue;
    if ((mode === "auto" || mode === "responses") && item.type === "function_call_output") {
      compactField(item, "output", "input_text", "openai-responses-string", "openai-responses-array", stats);
      continue;
    }
    if ((mode === "auto" || mode === "chat") && item.role === "tool") {
      compactField(item, "content", "text", "openai-tool", "openai-tool-array", stats);
      continue;
    }
    if ((mode === "auto" || mode === "messages") && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (block?.type === "tool_result" && block.is_error !== true) {
          compactField(block, "content", "text", "claude-string", "claude-array", stats);
        }
      }
    }
  }
}
function compressRequest(payload, wire, options = true) {
  const enabled = options !== false && (options === null || typeof options !== "object" || options.enabled !== false);
  const stats = { enabled, bytesBefore: 0, bytesAfter: 0, saved: 0, hits: [] };
  if (enabled && payload !== null && typeof payload === "object") {
    try {
      if (wire === "chat" || wire === "messages") walk(payload.messages, wire, stats);
      else if (wire === "responses") walk(payload.input, wire, stats);
    } catch (error) {
      console.warn("[rtk] compressRequest error:", error?.message ?? error);
      stats.bytesAfter = stats.bytesBefore - stats.hits.reduce((sum, hit) => sum + hit.saved, 0);
    }
  }
  stats.saved = stats.bytesBefore - stats.bytesAfter;
  return { payload, stats };
}

// src/token-saver/prompts.js
var CAVEMAN_LEVELS = ["off", "lite", "full", "ultra", "wenyan-lite", "wenyan", "wenyan-ultra"];
var PONYTAIL_LEVELS = ["off", "lite", "full", "ultra"];
var answerBoundary = "Keep code, identifiers, paths, commands, error text and URLs unchanged. Use complete, clear language for security guidance, irreversible decisions and ordered procedures; clarity takes priority over brevity. Do not invent abbreviations. Follow the user's language except when a classical Chinese level is selected. Do not announce this style or add decorative emoji. Apply the selected level throughout the conversation while respecting explicit user instructions.";
var answerLevels = new Map([
  ["lite", "Use short grammatical sentences. Remove filler while retaining the explanation needed to act."],
  ["full", "Prefer compact phrases and direct conclusions. Keep technical detail and necessary reasoning."],
  ["ultra", "Give the smallest unambiguous answer that satisfies the request. Omit repetition, never required facts."],
  ["wenyan-lite", "Use readable Chinese with a light classical register and short sentences."],
  ["wenyan", "Use concise classical Chinese for prose; keep technical material precise and readily understandable."],
  ["wenyan-ultra", "Use very brief classical Chinese prose. Expand whenever compression would make an action ambiguous."]
].map(([level, text]) => [level, `${text} ${answerBoundary}`]));
var codeBoundary = "Implement only the requested behavior. Reuse existing project code, standard libraries and installed dependencies before adding code. Keep responsibility in the relevant module. Avoid speculative abstractions, options and future scaffolding. Preserve validation at trust boundaries, data-loss prevention, security, accessibility and explicit requirements. Verify meaningful behavior with a focused runnable check; trivial changes need no artificial test. Explain material limitations without claiming unperformed verification. Continue this discipline across turns.";
var codeLevels = new Map([
  ["lite", "Make the requested change with minimal additions; mention a simpler alternative only when useful."],
  ["full", "Choose the smallest maintainable implementation and keep the diff focused on the requested capability."],
  ["ultra", "Actively remove unnecessary work and duplication before adding code; preserve every required behavior."]
].map(([level, text]) => [level, `${text} ${codeBoundary}`]));
function cavemanPrompt(level) {
  return answerLevels.get(level) ?? null;
}
function ponytailPrompt(level) {
  return codeLevels.get(level) ?? null;
}
function activePrompts({ caveman, ponytail } = {}) {
  const result2 = [];
  for (const [id, level, lookup] of [["caveman", caveman, cavemanPrompt], ["ponytail", ponytail, ponytailPrompt]]) {
    const text = lookup(level);
    if (text !== null) result2.push({ id, level, text });
  }
  return result2;
}

// src/token-saver/inject.js
var INJECT_MARKER = "<!-- ofm-token-saver -->";
var MARKER_END = "<!-- /ofm-token-saver -->";
var SEP = "\n\n";
var result = (payload, injected, reason) => ({ payload, injected, reason });
function injectSystem(payload, wire, text) {
  try {
    if (payload === null || typeof payload !== "object") return result(payload, false, "shape-not-recognised");
    if (typeof text !== "string" || text === "") return result(payload, false, "no-text");
    const segment = `${INJECT_MARKER}${SEP}${text}${SEP}${MARKER_END}`;
    if (wire === "chat") return injectChat(payload, segment);
    if (wire === "messages") return injectMessages(payload, segment);
    if (wire === "responses") return injectResponses(payload, segment);
    return result(payload, false, "shape-not-recognised");
  } catch {
    return result(payload, false, "inject-failed");
  }
}
var isSystem = (message) => message !== null && typeof message === "object" && (message.role === "system" || message.role === "developer");
var isResponsesSystem = (item) => isSystem(item) && item.type === "message";
function contentHasSegment(content, segment) {
  if (typeof content === "string") return content.includes(segment);
  if (Array.isArray(content)) {
    return content.some((block) => block !== null && typeof block === "object" && typeof block.text === "string" && block.text.includes(segment));
  }
  return false;
}
function injectChat(payload, segment) {
  if (!Array.isArray(payload.messages)) return result(payload, false, "shape-not-recognised");
  let target;
  for (const message of payload.messages) {
    if (!isSystem(message)) continue;
    if (contentHasSegment(message.content, segment)) return result(payload, false, "already-injected");
    target ??= message;
  }
  if (!target) payload.messages.unshift({ role: "system", content: segment });
  else if (Array.isArray(target.content)) target.content.push({ type: "text", text: segment });
  else target.content = typeof target.content === "string" && target.content ? `${target.content}${SEP}${segment}` : segment;
  return result(payload, true, "injected");
}
function injectMessages(payload, segment) {
  if (!Array.isArray(payload.messages)) return result(payload, false, "shape-not-recognised");
  const system = payload.system;
  if (contentHasSegment(system, segment)) return result(payload, false, "already-injected");
  if (Array.isArray(system)) {
    let position = system.length;
    for (let i = system.length - 1; i >= 0; i--) {
      if (system[i]?.cache_control) {
        position = i;
        break;
      }
    }
    system.splice(position, 0, { type: "text", text: segment });
  } else if (system == null || typeof system === "string") {
    payload.system = system ? `${system}${SEP}${segment}` : segment;
  } else return result(payload, false, "shape-not-recognised");
  return result(payload, true, "injected");
}
function injectResponses(payload, segment) {
  if (typeof payload.instructions === "string") {
    if (payload.instructions.includes(segment)) return result(payload, false, "already-injected");
    payload.instructions = payload.instructions ? `${payload.instructions}${SEP}${segment}` : segment;
    return result(payload, true, "injected");
  }
  if (!Array.isArray(payload.input)) return result(payload, false, "shape-not-recognised");
  let target;
  for (const item of payload.input) {
    if (!isResponsesSystem(item)) continue;
    if (contentHasSegment(item.content, segment)) return result(payload, false, "already-injected");
    target ??= item;
  }
  const block = { type: "input_text", text: segment };
  if (!target) payload.input.unshift({ type: "message", role: "system", content: [block] });
  else if (Array.isArray(target.content)) target.content.push(block);
  else if (typeof target.content === "string") target.content = target.content ? `${target.content}${SEP}${segment}` : segment;
  else target.content = [block];
  return result(payload, true, "injected");
}

// src/token-saver/index.js
var PROMPT_FAMILIES = ["caveman", "ponytail"];
function saverConfig(settings) {
  const section = settings?.tokenSaver ?? {};
  const prompts = section.prompts ?? {};
  return {
    enabled: section.enabled !== false,
    rtk: section.rtk !== false,
    caveman: PROMPT_FAMILIES.includes("caveman") ? String(prompts.caveman ?? "off") : "off",
    ponytail: String(prompts.ponytail ?? "off")
    /** Per-request header/query opt-out is handled by the caller; this is the
     *  stored preference only. */
  };
}
function applyTokenSavers(payload, wire, config) {
  const report = { prompt: null, rtk: null, saved: 0, bytesBefore: 0, bytesAfter: 0, notes: [] };
  if (config?.enabled === false || payload === null || typeof payload !== "object") return report;
  if (config.caveman !== "off" || config.ponytail !== "off") {
    try {
      const prompts = activePrompts({ caveman: config.caveman, ponytail: config.ponytail });
      if (prompts.length > 0) {
        const text = prompts.map((entry) => entry.text).join("\n\n");
        const result2 = injectSystem(payload, wire, text);
        report.prompt = { injected: result2.injected === true, reason: result2.reason ?? "", families: prompts.map((entry) => `${entry.id}:${entry.level}`) };
        if (result2.injected !== true && result2.reason !== void 0) report.notes.push(`prompt:${result2.reason}`);
      }
    } catch (error) {
      report.notes.push(`prompt-failed:${error?.message ?? error}`);
    }
  }
  if (config.rtk !== false) {
    try {
      const result2 = compressRequest(payload, wire, true);
      report.rtk = result2.stats;
      report.saved = Number(result2.stats?.saved) || 0;
      report.bytesBefore = Number(result2.stats?.bytesBefore) || 0;
      report.bytesAfter = Number(result2.stats?.bytesAfter) || 0;
    } catch (error) {
      report.notes.push(`rtk-failed:${error?.message ?? error}`);
    }
  }
  return report;
}
function emptySavings() {
  return { bytesBefore: 0, bytesAfter: 0, saved: 0, blocks: 0, calls: 0, promptCalls: 0 };
}
function addSavings(total, report) {
  const base = total ?? emptySavings();
  const blocks = Array.isArray(report?.rtk?.hits) ? report.rtk.hits.length : 0;
  return {
    bytesBefore: base.bytesBefore + (Number(report?.bytesBefore) || 0),
    bytesAfter: base.bytesAfter + (Number(report?.bytesAfter) || 0),
    saved: base.saved + (Number(report?.saved) || 0),
    blocks: base.blocks + blocks,
    calls: base.calls + 1,
    promptCalls: base.promptCalls + (report?.prompt?.injected === true ? 1 : 0)
  };
}
function savingsPercent(total) {
  const before = Number(total?.bytesBefore) || 0;
  const saved = Number(total?.saved) || 0;
  if (before <= 0) return 0;
  return Math.round(saved / before * 100);
}
function describeSavingsTotal(total) {
  const safe = total ?? emptySavings();
  const percent = savingsPercent(safe);
  if (safe.calls === 0) return "token saver: no requests measured yet";
  return `token saver: ${formatBytes(safe.saved)} saved over ${safe.calls} request(s) (${percent}%), ${safe.blocks} block(s) compacted`;
}
function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
export {
  CAVEMAN_LEVELS,
  PONYTAIL_LEVELS,
  PROMPT_FAMILIES,
  activePrompts,
  addSavings,
  applyTokenSavers,
  cavemanPrompt,
  describeSavingsTotal,
  emptySavings,
  formatBytes,
  ponytailPrompt,
  saverConfig,
  savingsPercent
};
