// src/o2a/version.js
var V2_CLIENT_VERSION = "2.2.3";
var CLIENT_UA = `opencode/latest/${V2_CLIENT_VERSION}/cli`;
var V2_COMPLETION_LIMIT = 32e3;
var ANONYMOUS_CREDENTIAL = "public";

// src/o2a/identity.js
import { createHash, randomBytes } from "node:crypto";
var CANONICAL_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
var DESCENDING_TIME_RE = /^[0-9a-f]{9}f[c-f][0-9a-f]$/;
var BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
var SESSION_TIMESTAMP_WINDOW_MS = 30 * 24 * 60 * 60 * 1e3;
var SESSION_PHASE_MS = 2n ** 36n;
var FIELD_BITS = 48n;
var FIELD_MASK = (1n << FIELD_BITS) - 1n;
var COUNTER_ONE = 1n;
var PAYLOAD_OFFSET = 6;
var PAYLOAD_BYTES = 10;
var PAYLOAD_CHARS = 14;
var MS_PER_DAY = 864e5;
var processSalt = randomBytes(16);
function isOfficialSessionID(value) {
  if (typeof value !== "string") return false;
  if (!CANONICAL_SESSION_RE.test(value)) return false;
  return DESCENDING_TIME_RE.test(value.slice(4, 16));
}
function sessionPhaseMs(id) {
  if (!isOfficialSessionID(id)) return null;
  const stored = BigInt(`0x${id.slice(4, 16)}`);
  return Number(FIELD_MASK - stored >> 12n);
}
function currentTimePhaseMs(now = Date.now()) {
  return now % Number(SESSION_PHASE_MS);
}
function phaseAgeMs(phase, now = Date.now()) {
  const period = Number(SESSION_PHASE_MS);
  return ((currentTimePhaseMs(now) - phase) % period + period) % period;
}
function encodePhaseField(now = Date.now(), hash) {
  const offset = hash[0] * 16777216 + hash[1] * 65536 + hash[2] * 256 + hash[3];
  const midnight = Math.floor(now / MS_PER_DAY) * MS_PER_DAY;
  const stamp = midnight - offset % SESSION_TIMESTAMP_WINDOW_MS;
  const field = (BigInt(stamp) << 12n | COUNTER_ONE) & FIELD_MASK;
  return (FIELD_MASK - field).toString(16).padStart(12, "0");
}
function encodeFixedBase62(bytes, width) {
  let value = 0n;
  for (const byte of bytes) value = value << 8n | BigInt(byte);
  let text = "";
  for (let remaining = width; remaining > 0; remaining -= 1) {
    text = BASE62_ALPHABET[Number(value % 62n)] + text;
    value /= 62n;
  }
  return text;
}
function mintSessionIdentifier(signal, now = Date.now()) {
  if (isOfficialSessionID(signal)) return signal;
  const digest = createHash("sha256").update("ses").update("\0").update(processSalt).update("\0").update(String(signal)).digest();
  const phase = encodePhaseField(now, digest);
  const payload = encodeFixedBase62(digest.subarray(PAYLOAD_OFFSET, PAYLOAD_OFFSET + PAYLOAD_BYTES), PAYLOAD_CHARS);
  return `ses_${phase}${payload}`;
}
function randomID(prefix, size) {
  return prefix + "_" + randomBytes(size).toString("hex");
}
function randomProjectID() {
  return randomBytes(20).toString("hex");
}

// src/o2a/tool-renames.js
import { createHash as createHash2 } from "node:crypto";
var CLIENT_TOOL_PREFIX = "mcp_";
var LEGACY_CLIENT_TOOL_PREFIXES = Object.freeze(["clint_"]);
var CLIENT_TOOL_DIGEST_LENGTH = 12;
var TOOL_WIRE_NAME_LIMIT = 64;
var DIGEST_HEX = "0123456789abcdef";
var COUNTER_SUFFIX = /^_\d+$/;
function isWireToolName(name) {
  if (typeof name !== "string" || name === "") return false;
  for (const namespace of [CLIENT_TOOL_PREFIX, ...LEGACY_CLIENT_TOOL_PREFIXES]) {
    if (!name.startsWith(namespace)) continue;
    const body = name.slice(namespace.length);
    const split = body.lastIndexOf("_");
    const digest = split > 0 && COUNTER_SUFFIX.test(body.slice(split)) ? body.slice(0, split) : body;
    if (digest.length !== CLIENT_TOOL_DIGEST_LENGTH) continue;
    let allHex = true;
    for (const char of digest) if (!DIGEST_HEX.includes(char)) {
      allHex = false;
      break;
    }
    if (allHex) return true;
  }
  return false;
}
function foldToolName(name) {
  return String(name ?? "").toLowerCase().replace(/[_.\- \t\r\n]/g, "");
}
function clientToolWireName(name, taken) {
  const issued = taken instanceof Set ? taken : /* @__PURE__ */ new Set();
  const digest = createHash2("sha256").update(String(name)).digest("hex").slice(0, CLIENT_TOOL_DIGEST_LENGTH);
  const base = CLIENT_TOOL_PREFIX + digest;
  if (!issued.has(base)) {
    issued.add(base);
    return base;
  }
  for (let counter = 2; ; counter += 1) {
    const suffix = `_${counter}`;
    const candidate = base.slice(0, TOOL_WIRE_NAME_LIMIT - suffix.length) + suffix;
    if (issued.has(candidate)) continue;
    issued.add(candidate);
    return candidate;
  }
}
var OFFICIAL_TOOL_ALIASES = Object.freeze({
  edit: ["edit"],
  glob: ["glob"],
  grep: ["grep"],
  question: ["question", "askuserquestion"],
  read: ["read", "view"],
  shell: ["shell", "bash"],
  skill: ["skill"],
  subagent: ["subagent", "agent", "task"],
  webfetch: ["webfetch", "fetch"],
  websearch: ["websearch"],
  write: ["write"],
  patch: ["patch", "applypatch"]
});
var OFFICIAL_BY_SPELLING = new Map(
  Object.entries(OFFICIAL_TOOL_ALIASES).flatMap(([canonical, spellings]) => spellings.map((spelling) => [foldToolName(spelling), canonical]))
);
function officialForClientName(name) {
  if (typeof name !== "string" || name === "") return null;
  return OFFICIAL_BY_SPELLING.get(foldToolName(name)) ?? null;
}
var ToolRenameMap = class extends Map {
  #byClient = /* @__PURE__ */ new Map();
  #byLower = /* @__PURE__ */ new Map();
  #byFolded = /* @__PURE__ */ new Map();
  /**
   * Record that `client`'s tool goes out as `wire`.
   *
   * No-ops when the mapping is trivial or already known, so shaping twice is
   * idempotent.
   */
  add(client, wire) {
    if (!client || !wire || client === wire) return;
    if (this.#byClient.has(client) || this.has(wire)) return;
    this.set(wire, client);
    this.#byClient.set(client, wire);
    for (const [index, key] of [[this.#byLower, String(client).toLowerCase()], [this.#byFolded, foldToolName(client)]]) {
      if (!key) continue;
      const existing = index.get(key);
      index.set(key, existing === void 0 || existing === client ? client : "");
    }
  }
  /** The handle issued for a caller tool, if any. */
  wireOf(client) {
    return this.#byClient.get(client);
  }
  /** Does any issued handle start with `prefix`? */
  hasPrefix(prefix) {
    if (!prefix) return false;
    for (const wire of this.keys()) if (wire.startsWith(prefix)) return true;
    return false;
  }
  /** Does any issued handle extend `prefix` beyond itself? */
  hasLongerPrefix(prefix) {
    if (!prefix) return false;
    for (const wire of this.keys()) if (wire.length > prefix.length && wire.startsWith(prefix)) return true;
    return false;
  }
  /**
   * Map a name arriving from the model back to the caller's tool name.
   *
   * Three attempts, in decreasing confidence:
   *
   * 1. An exact handle in this request's map.
   * 2. A handle minted by an earlier build: strip the namespace and look the
   *    remainder up as a caller name. This is what keeps a conversation saved
   *    under `clint_` working after an upgrade.
   * 3. Case-insensitive, then separator-insensitive lookup of whatever remains —
   *    including a name that was never renamed at all, which must survive intact
   *    so a genuine MCP tool is not mangled.
   *
   * Returns the input unchanged when nothing matches. That is the honest
   * outcome: the digest is one-way, so an unknown handle cannot be reversed, and
   * inventing a name would be worse than passing it through.
   */
  resolve(wire) {
    if (!wire) return wire;
    const exact = this.get(wire);
    if (exact !== void 0) return exact;
    if (!isWireToolName(wire)) {
      const drifted = this.#byLower.get(wire.toLowerCase());
      if (drifted !== void 0) return drifted || wire;
      return this.#byFolded.get(foldToolName(wire)) || wire;
    }
    const namespace = [CLIENT_TOOL_PREFIX, ...LEGACY_CLIENT_TOOL_PREFIXES].find((candidate) => wire.startsWith(candidate) && wire.length > candidate.length);
    const bare = namespace === void 0 ? wire : wire.slice(namespace.length);
    if (this.#byClient.has(bare)) return bare;
    const lower = this.#byLower.get(bare.toLowerCase());
    if (lower !== void 0 && lower !== "") return lower;
    return this.#byFolded.get(foldToolName(bare)) || wire;
  }
};

// src/o2a/asset-source.js
/*!
 * The two assets below are verbatim copies of the OpenCode client's system
 * prompt and tool contracts (sst/opencode, MIT, tag v2.2.3). Their licence
 * text ships in LICENSE. Do not edit them by hand: the free
 * tier fingerprints these bytes.
 */
var OFFICIAL_PROMPT_V2 = "You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.\n\n# Harness\n- Responses are rendered as GitHub-flavored Markdown.\n- `<system-reminder>` blocks are harness instructions, not user-authored content. Read and follow them.\n- Prefer parallelizing independent tool calls.\n${OPENCODE_TOOL_GUIDANCE}\n\n# Communication\n- Use clear file paths when referring to files.\n- Keep responses clear and concise, and avoid unnecessary technical jargon.\n\n# Working in codebases\n- Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.\n- Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.\n";
var OFFICIAL_TOOLS_V2 = '{\n  "read": {\n    "description": "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "path": {\n          "type": "string",\n          "description": "File or directory to read"\n        },\n        "offset": {\n          "type": "integer",\n          "minimum": 0,\n          "description": "The line or directory entry to start reading from (1-based)"\n        },\n        "limit": {\n          "type": "integer",\n          "minimum": 0,\n          "description": "The maximum number of lines or directory entries to read (defaults to and capped at 2000)"\n        }\n      },\n      "required": [\n        "path"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "shell": {\n    "description": "Execute a shell command and return its output. Commands run on ${OS} using ${shell}. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "command": {\n          "type": "string",\n          "description": "Shell command string to execute"\n        },\n        "workdir": {\n          "type": "string",\n          "description": "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead."\n        },\n        "timeout": {\n          "type": "integer",\n          "minimum": 0,\n          "description": "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default."\n        },\n        "background": {\n          "type": "boolean",\n          "description": "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use \'&\' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion."\n        }\n      },\n      "required": [\n        "command"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "edit": {\n    "description": "Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\\\n; the file\'s existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\\\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "path": {\n          "type": "string",\n          "description": "File to edit"\n        },\n        "oldString": {\n          "type": "string",\n          "description": "Exact text to find and replace"\n        },\n        "newString": {\n          "type": "string",\n          "description": "Text to replace oldString with (must differ from oldString)"\n        },\n        "replaceAll": {\n          "type": "boolean",\n          "description": "Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false."\n        }\n      },\n      "required": [\n        "path",\n        "oldString",\n        "newString"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "glob": {\n    "description": "Search file paths using a glob pattern (examples: \\"**/*.ts\\", \\"src/**/*.tsx\\").",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "pattern": {\n          "type": "string",\n          "description": "Glob pattern to match files against"\n        },\n        "path": {\n          "type": "string",\n          "description": "Directory to search. Defaults to the current working directory."\n        },\n        "hidden": {\n          "type": "boolean",\n          "description": "Include hidden files and directories (default: false)."\n        },\n        "limit": {\n          "type": "integer",\n          "exclusiveMinimum": 0,\n          "description": "Maximum number of matching files to return (default: 100)"\n        }\n      },\n      "required": [\n        "pattern"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "grep": {\n    "description": "Search file contents using ripgrep\'s regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "pattern": {\n          "type": "string",\n          "minLength": 1,\n          "description": "Regular expression or literal text to match in file contents."\n        },\n        "path": {\n          "type": "string",\n          "description": "File or directory to search. Defaults to the current working directory."\n        },\n        "include": {\n          "type": "string",\n          "description": "Glob pattern to filter files (for example, \\"*.js\\" or \\"*.{ts,tsx}\\")"\n        },\n        "literal": {\n          "type": "boolean",\n          "description": "Treat `pattern` as exact text instead of a regular expression (default: false)."\n        },\n        "caseSensitive": {\n          "type": "boolean",\n          "description": "Use case-sensitive matching (default: true)."\n        },\n        "limit": {\n          "type": "integer",\n          "exclusiveMinimum": 0,\n          "description": "Maximum number of matching lines to return (default: 100)"\n        }\n      },\n      "required": [\n        "pattern"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "write": {\n    "description": "Writes a file to the local filesystem, overwriting if one exists.\\n\\nMissing parent directories are created automatically.\\n\\nUse this tool to create new files or overwrite existing files. For partial changes, use the edit tool instead.",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "path": {\n          "type": "string",\n          "description": "Path to the file to write to"\n        },\n        "content": {\n          "type": "string",\n          "description": "Content to write to the file"\n        }\n      },\n      "required": [\n        "path",\n        "content"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "patch": {\n    "description": "Use the `patch` tool to edit files. Your patch language is a stripped\u2011down, file\u2011oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high\u2011level envelope:\\n\\n*** Begin Patch\\n[ one or more file sections ]\\n*** End Patch\\n\\nWithin that envelope, you get a sequence of file operations.\\nYou MUST include a header to specify the action you are taking.\\nEach operation starts with one of three headers:\\n\\n*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).\\n*** Delete File: <path> - remove an existing file. Nothing follows.\\n*** Update File: <path> - patch an existing file in place (optionally with a rename).\\n\\nExample patch:\\n\\n```\\n*** Begin Patch\\n*** Add File: hello.txt\\n+Hello world\\n*** Update File: src/app.py\\n*** Move to: src/main.py\\n@@ def greet():\\n-print(\\"Hi\\")\\n+print(\\"Hello, world!\\")\\n*** Delete File: obsolete.txt\\n*** End Patch\\n```\\n\\nIt is important to remember:\\n\\n- You must include a header with your intended action (Add/Delete/Update)\\n- You must prefix new lines with `+` even when creating a new file\\n",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "patchText": {\n          "type": "string",\n          "description": "The full patch text describing add, update, and delete operations"\n        }\n      },\n      "required": [\n        "patchText"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "webfetch": {\n    "description": "Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.\\n\\nUse a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "url": {\n          "type": "string",\n          "description": "The HTTP or HTTPS URL to fetch content from"\n        },\n        "format": {\n          "enum": [\n            "text",\n            "markdown",\n            "html"\n          ],\n          "description": "The format to return the content in. Defaults to markdown."\n        },\n        "timeout": {\n          "type": "number",\n          "exclusiveMinimum": 0,\n          "maximum": 120,\n          "description": "Optional timeout in seconds (maximum: 120)"\n        }\n      },\n      "required": [\n        "url",\n        "format"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "websearch": {\n    "description": "Search the web using the user\'s selected search integration. Use this for current information beyond knowledge cutoff.\\n\\nThe current year is 2026. Use this year when searching for recent information or current events.",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "query": {\n          "type": "string",\n          "description": "Websearch query"\n        }\n      },\n      "required": [\n        "query"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "question": {\n    "description": "Use this tool when you need to ask the user questions during execution. This allows you to:\\n1. Gather user preferences or requirements\\n2. Clarify ambiguous instructions\\n3. Get decisions on implementation choices as you work\\n4. Offer choices to the user about what direction to take.\\n\\nUsage notes:\\n- A \\"Type your own answer\\" option is added automatically; don\'t include a separate option for free form answers\\n- Set `multiple: true` to allow selecting more than one option\\n- If you recommend a specific option, make that the first option in the list and add \\"(Recommended)\\" at the end of the label",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "questions": {\n          "type": "array",\n          "items": {\n            "type": "object",\n            "properties": {\n              "question": {\n                "type": "string"\n              },\n              "header": {\n                "type": "string"\n              },\n              "options": {\n                "type": "array",\n                "items": {\n                  "type": "object",\n                  "properties": {\n                    "label": {\n                      "type": "string"\n                    },\n                    "description": {\n                      "type": "string"\n                    }\n                  },\n                  "required": [\n                    "label",\n                    "description"\n                  ],\n                  "additionalProperties": false\n                }\n              },\n              "multiple": {\n                "type": "boolean"\n              }\n            },\n            "required": [\n              "question",\n              "header",\n              "options"\n            ],\n            "additionalProperties": false\n          },\n          "minItems": 1,\n          "description": "Questions to ask"\n        }\n      },\n      "required": [\n        "questions"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "skill": {\n    "description": "Load a specialized skill\'s instructions and resources into the current conversation when the task at hand matches its description.\\n\\nThe skill ID must match an available skill or a skill explicitly referenced by the user.",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "id": {\n          "type": "string",\n          "description": "The ID of an available skill or a skill explicitly referenced by the user"\n        }\n      },\n      "required": [\n        "id"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "subagent": {\n    "description": "Spawns an agent in a child session to work on the specified task.\\nThe output includes a sessionID you can pass back later to continue that specific conversation with the subagent.\\nNew child sessions start with fresh context, so include all relevant context and instructions when you don\'t pass a sessionID.\\nForeground (default) runs the subagent to completion and returns its final response.\\nBackground mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.\\nUse background only for independent work that can run while you continue elsewhere.",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "agent": {\n          "type": "string",\n          "description": "The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead."\n        },\n        "description": {\n          "type": "string",\n          "description": "A short 3-5 word label for the task, displayed to the user"\n        },\n        "prompt": {\n          "type": "string",\n          "description": "The task for the subagent to perform"\n        },\n        "model": {\n          "type": "string",\n          "description": "NEVER set this unless the user explicitly asks for a particular model or variant. It must be a chat model; image and decision models can\'t run subagents. The value is written as \\"providerID/modelID\\", or \\"providerID/modelID#variant\\" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first."\n        },\n        "sessionID": {\n          "type": "string",\n          "description": "Send a follow-up to an existing subagent, running or finished. Omit to start a new one."\n        },\n        "background": {\n          "type": "boolean",\n          "description": "Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress."\n        }\n      },\n      "required": [\n        "agent",\n        "description",\n        "prompt"\n      ],\n      "additionalProperties": false\n    }\n  },\n  "todowrite": {\n    "description": "Create and update a todo list for the current session. The user sees it as your working plan.\\n\\nUse it proactively when a task has 3 or more distinct steps, or when the user gives several tasks or asks for a todo list. Skip it for a single simple task or a purely conversational request. When in doubt, use it.\\n\\n- Send the full list on every call; it replaces the previous one.\\n- Mark items `in_progress` when you start them and `completed` as soon as they\'re actually done.\\n- Only call it when the list changes.\\n",\n    "parameters": {\n      "type": "object",\n      "properties": {\n        "todos": {\n          "type": "array",\n          "items": {\n            "type": "object",\n            "properties": {\n              "content": {\n                "type": "string",\n                "description": "Brief description of the task"\n              },\n              "status": {\n                "enum": [\n                  "pending",\n                  "in_progress",\n                  "completed",\n                  "cancelled"\n                ],\n                "description": "Current status of the task: pending, in_progress, completed, cancelled"\n              }\n            },\n            "required": [\n              "content",\n              "status"\n            ],\n            "additionalProperties": false\n          },\n          "description": "The updated todo list"\n        }\n      },\n      "required": [\n        "todos"\n      ],\n      "additionalProperties": false\n    }\n  }\n}\n';
function officialPromptText() {
  return OFFICIAL_PROMPT_V2;
}
function officialToolsText() {
  return OFFICIAL_TOOLS_V2;
}

// src/o2a/official-tools.js
var V2_OFFICIAL_TOOL_ORDER = Object.freeze([
  "edit",
  "glob",
  "grep",
  "patch",
  "question",
  "read",
  "shell",
  "skill",
  "subagent",
  "todowrite",
  "webfetch",
  "websearch",
  "write"
]);
var definitions;
function officialToolDefinition(name) {
  definitions ??= new Map(Object.entries(JSON.parse(officialToolsText())));
  return definitions.get(name);
}
var SHELL_OS = { win32: "Windows", darwin: "macOS", linux: "Linux" };
var SHELL_NAME = { win32: "powershell", darwin: "bash", linux: "bash" };
function v2ShellDescription(base, platform = process.platform) {
  return base.replace(/\$\{OS\}/g, SHELL_OS[platform] ?? platform).replace(/\$\{shell\}/g, SHELL_NAME[platform] ?? "bash");
}
function officialTool(shape, name) {
  const definition = officialToolDefinition(name);
  let description = definition?.description ?? `Agent tool ${name}`;
  const parameters = definition?.parameters == null ? { type: "object", properties: {} } : structuredClone(definition.parameters);
  if (name === "shell") description = v2ShellDescription(description);
  if (shape === "claude") return { name, description, input_schema: parameters };
  const fn = { name, description, parameters };
  return shape === "flat" ? { type: "function", ...fn } : { type: "function", function: { ...fn, strict: false } };
}
function officialToolset(shape) {
  return V2_OFFICIAL_TOOL_ORDER.map((name) => officialTool(shape, name));
}
function renamableToolName(shape, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  if (shape !== "chat") {
    const type = typeof entry.type === "string" ? entry.type : "";
    if (shape === "flat" && !["", "function", "custom"].includes(type)) return null;
    if (shape === "claude" && !["", "custom"].includes(type)) return null;
  }
  const name = shape === "chat" ? entry.function?.name : entry.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

// src/o2a/official-prompt.js
var OFFICIAL_PROMPT_MARKER = "You are an AI agent running in OpenCode, a coding agent harness.";
var OFFICIAL_SKILLS = "Use only skills explicitly provided by the host; do not assume built-in skills are available.";
var cachedDirectory;
var TOOL_GUIDANCE = [
  ["shell", [
    "- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.",
    "- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse."
  ]],
  ["write", [
    "- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes."
  ]],
  ["edit", [
    "- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence."
  ]]
];
function officialPrompt(toolNames) {
  const base = officialPromptText();
  if (base === "") return "";
  const declared = toolNames instanceof Set ? toolNames : Array.isArray(toolNames) ? new Set(toolNames) : null;
  const lines = [];
  for (const [family, guidance] of TOOL_GUIDANCE) {
    if (declared === null || declared.size === 0 || declared.has(family)) lines.push(...guidance);
  }
  return base.replace("${OPENCODE_TOOL_GUIDANCE}", lines.join("\n"));
}
function officialEnvironment(model, directory) {
  if (directory === void 0) {
    if (cachedDirectory === void 0) {
      try {
        cachedDirectory = process.cwd().trim() || "/workspace";
      } catch {
        cachedDirectory = "/workspace";
      }
    }
    directory = cachedDirectory;
  }
  const id = String(model ?? "").replace(/^opencode\//, "").trim() || "unknown";
  const now = /* @__PURE__ */ new Date();
  const date = now.toUTCString().slice(0, 16).replace(",", "");
  return `Model: ${id}
<env>
  Working directory: ${directory}
  Workspace root folder: ${directory}
  Platform: ${process.platform}
  Today's date: ${date}
</env>`;
}
function officialSystemPrompt(model, directory, toolNames) {
  const base = officialPrompt(toolNames);
  return base === "" ? "" : `${base}${officialEnvironment(model, directory)}
${OFFICIAL_SKILLS}`;
}
function textFragments(value) {
  const result = [], pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") {
      if (item.trim()) result.push(item);
    } else if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index--) pending.push(item[index]);
    } else if (item && typeof item === "object") {
      if (typeof item.text === "string") pending.push(item.text);
      else if (item.content !== void 0) pending.push(item.content);
    }
  }
  return result;
}
function carriesOpenCodePrompt(value) {
  return textFragments(value).some((text) => text.includes(OFFICIAL_PROMPT_MARKER));
}
function injectOfficialPrompt(payload, shape, { workDir, model, toolNames } = {}) {
  if (!payload || typeof payload !== "object" || !["chat", "flat", "claude"].includes(shape)) return false;
  const prompt = officialSystemPrompt(model ?? payload.model, workDir, toolNames);
  if (!prompt) return false;
  const prepend = (value, blocks) => {
    if (blocks && Array.isArray(value)) return [{ type: "text", text: prompt }, ...value];
    return typeof value === "string" && value.trim() ? `${prompt}

${value}` : prompt;
  };
  if (shape !== "chat") {
    const key = shape === "flat" ? "instructions" : "system";
    if (carriesOpenCodePrompt(payload[key])) return false;
    payload[key] = prepend(payload[key], shape === "claude");
    return true;
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  let anchor = -1;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== "system" && message?.role !== "developer") continue;
    if (carriesOpenCodePrompt(message.content)) return false;
    if (anchor < 0) anchor = index;
  }
  if (anchor < 0) payload.messages = [{ role: "system", content: prompt }, ...messages];
  else messages[anchor] = { ...messages[anchor], content: prepend(messages[anchor].content, true) };
  return true;
}

// src/o2a/gateway-body.js
function ensureChatUsage(payload, shape) {
  if (shape !== "chat" || payload.stream !== true) return false;
  const options = payload.stream_options;
  const object = options !== null && typeof options === "object" && !Array.isArray(options);
  if (object && options.include_usage === true) return false;
  payload.stream_options = object ? { ...options, include_usage: true } : { include_usage: true };
  return true;
}
function ensureV2CompletionLimit(payload, shape) {
  if (shape !== "chat" || payload.max_tokens !== void 0 || payload.max_completion_tokens !== void 0) return false;
  payload.max_completion_tokens = V2_COMPLETION_LIMIT;
  return true;
}

// src/o2a/headers.js
import { createHash as createHash3, randomBytes as randomBytes2 } from "node:crypto";
function projectID(project) {
  if (project === "global" || /^[0-9a-f]{40}$/.test(String(project))) return project;
  return createHash3("sha256").update(`opencode-project\0${project}`).digest("hex").slice(0, 40);
}
function stableProjectID(session) {
  return projectID(String(session ?? ""));
}
function traceHeaders() {
  const entropy = randomBytes2(32).toString("hex");
  const trace = entropy.slice(0, 32), span = entropy.slice(32, 48), parent = entropy.slice(48);
  return { traceparent: `00-${trace}-${span}-01`, b3: `${trace}-${span}-1-${parent}` };
}
function gatewayHeaders({ session, childSession, project, accept, anthropic, userAgent } = {}) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${ANONYMOUS_CREDENTIAL}`,
    "user-agent": userAgent ?? CLIENT_UA,
    "x-opencode-client": "cli",
    "x-opencode-session-id": childSession ?? session,
    "x-opencode-project": project === null || project === void 0 ? stableProjectID(session) : projectID(project),
    ...traceHeaders()
  };
  for (const key of ["x-session-affinity", "x-session-id", "x-opencode-session"]) headers[key] = session;
  if (accept !== null) headers.accept = accept ?? "*/*";
  if (anthropic) headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
  return headers;
}

// src/o2a/toolshape.js
var SHAPED = /* @__PURE__ */ new Set(["chat", "flat", "claude"]);
function deLiteralize(text) {
  return typeof text === "string" ? text.replaceAll(" ", "\xA0") : text;
}
function carriesOfficialDefinition(shape, entry, name) {
  const wrapper = shape === "chat" ? entry?.function : entry;
  if (wrapper === null || wrapper === void 0 || typeof wrapper !== "object") return false;
  const rendered = officialTool(shape, name);
  const target = shape === "chat" ? rendered.function : rendered;
  if (!target) return false;
  const schema = shape === "claude" ? wrapper.input_schema : wrapper.parameters;
  const targetSchema = shape === "claude" ? target.input_schema : target.parameters;
  return wrapper.description === target.description && JSON.stringify(schema) === JSON.stringify(targetSchema);
}
function withWireName(shape, entry, name) {
  if (shape === "chat") return { ...entry, function: { ...entry.function, name } };
  return { ...entry, name };
}
function withDeLiteralizedDescription(shape, entry) {
  if (shape === "chat") {
    const fn = entry.function;
    if (!fn || typeof fn !== "object") return entry;
    const description2 = deLiteralize(fn.description);
    return description2 === fn.description ? entry : { ...entry, function: { ...fn, description: description2 } };
  }
  const description = deLiteralize(entry.description);
  return description === entry.description ? entry : { ...entry, description };
}
function declarationsFromLegacyFunctions(entries, shape, renames, taken) {
  const converted = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (typeof entry.name !== "string" || entry.name === "") continue;
    let wire = renames.wireOf(entry.name);
    if (wire === void 0) {
      wire = clientToolWireName(entry.name, taken);
      renames.add(entry.name, wire);
    }
    const declaration = {
      name: wire,
      description: typeof entry.description === "string" ? entry.description : void 0,
      parameters: entry.parameters ?? { type: "object", properties: {} }
    };
    if (entry.strict !== void 0) declaration.strict = entry.strict;
    converted.push(shape === "chat" ? { type: "function", function: declaration } : { type: "function", ...declaration });
  }
  return converted;
}
function assignWireName(name, state, { shape, entry } = {}) {
  const canonical = officialForClientName(name);
  if (canonical !== null && !state.officials.has(canonical) && officialToolDefinition(canonical) !== void 0 && carriesOfficialDefinition(shape, entry, canonical)) {
    state.officials.add(canonical);
    state.renames.add(name, canonical);
    return canonical;
  }
  const existing = state.renames.wireOf(name);
  if (existing !== void 0) return existing;
  const minted = clientToolWireName(name, state.taken);
  state.renames.add(name, minted);
  return minted;
}
function remapToolReferences(payload, shape, renames) {
  if (renames.size === 0) return;
  const named = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    if (typeof value.name !== "string") return value;
    const wire = renames.wireOf(value.name);
    return wire === void 0 || wire === value.name ? value : { ...value, name: wire };
  };
  const nested = (value) => {
    if (!value || typeof value !== "object") return value;
    const fn = named(value.function);
    return fn === value.function ? value : { ...value, function: fn };
  };
  const mapped = (owner, key, convert) => {
    if (!Array.isArray(owner[key])) return owner;
    const original = owner[key];
    let replacement;
    for (let index = 0; index < original.length; index += 1) {
      const converted = convert(original[index]);
      if (converted === original[index]) continue;
      replacement ??= original.slice();
      replacement[index] = converted;
    }
    return replacement === void 0 ? owner : { ...owner, [key]: replacement };
  };
  const choice = payload.tool_choice;
  if (choice && typeof choice === "object" && !Array.isArray(choice)) {
    if (shape === "chat") {
      payload.tool_choice = choice.function && typeof choice.function === "object" ? nested(choice) : named(choice);
    } else {
      const rewritten = named(choice);
      payload.tool_choice = shape === "flat" ? mapped(rewritten, "allowed_tools", named) : rewritten;
    }
  }
  if (shape === "chat") {
    if (payload.function_call && typeof payload.function_call === "object") {
      payload.function_call = named(payload.function_call);
    }
    if (!Array.isArray(payload.messages)) return;
    for (let index = 0; index < payload.messages.length; index += 1) {
      const message = payload.messages[index];
      if (!message || typeof message !== "object") continue;
      const fn = named(message.function_call);
      const next = fn === message.function_call ? message : { ...message, function_call: fn };
      payload.messages[index] = mapped(next, "tool_calls", nested);
    }
    return;
  }
  if (shape === "flat") {
    if (!Array.isArray(payload.input)) return;
    for (let index = 0; index < payload.input.length; index += 1) {
      const item = payload.input[index];
      if (item?.type === "function_call" || item?.type === "custom_tool_call") payload.input[index] = named(item);
    }
    return;
  }
  if (!Array.isArray(payload.messages)) return;
  for (let index = 0; index < payload.messages.length; index += 1) {
    const message = payload.messages[index];
    if (!message || typeof message !== "object") continue;
    payload.messages[index] = mapped(message, "content", (block) => block?.type === "tool_use" ? named(block) : block);
  }
}
function carriesContent(message) {
  for (const key of ["content", "reasoning_content", "reasoning"]) {
    const value = message[key];
    if (value === null || value === void 0) continue;
    if (typeof value === "string" || Array.isArray(value)) {
      if (value.length > 0) return true;
      continue;
    }
    if (typeof value !== "object") return true;
    if (Object.keys(value).length > 0) return true;
  }
  return false;
}
function servedName(known) {
  return (name) => {
    if (typeof name !== "string" || name === "") return null;
    if (known.has(name)) return name;
    const canonical = officialForClientName(name);
    return canonical !== null && known.has(canonical) ? canonical : null;
  };
}
function rewriteFlatRecord(row, ctx) {
  if (row?.type === "function_call") {
    const name = ctx.served(row.name);
    if (name === null) {
      if (typeof row.call_id === "string" && row.call_id !== "") ctx.droppedCalls.add(row.call_id);
      return { row, drop: true };
    }
    return { row: name === row.name ? row : { ...row, name }, drop: false };
  }
  if (row?.type === "function_call_output" && ctx.droppedCalls.has(row.call_id)) {
    return { row, drop: true };
  }
  return { row, drop: false };
}
function rewriteChatRecord(original, ctx) {
  let row = original;
  let emptied = false;
  if (Array.isArray(row.tool_calls)) {
    const kept = [];
    let touched = row.tool_calls.length === 0;
    for (const call of row.tool_calls) {
      const name = ctx.served(call?.function?.name);
      if (name === null) {
        if (typeof call?.id === "string" && call.id !== "") ctx.droppedCalls.add(call.id);
        touched = true;
        continue;
      }
      if (name === call.function.name) {
        kept.push(call);
        continue;
      }
      kept.push({ ...call, function: { ...call.function, name } });
      touched = true;
    }
    if (touched) {
      emptied = kept.length === 0 && row.tool_calls.length > 0 && row.function_call === void 0;
      row = { ...row };
      if (kept.length > 0) row.tool_calls = kept;
      else delete row.tool_calls;
    }
  }
  if (row.function_call && typeof row.function_call === "object") {
    const name = ctx.served(row.function_call.name);
    if (name === null) {
      if (typeof row.function_call.name === "string") ctx.droppedFunctions.add(row.function_call.name);
      row = { ...row };
      delete row.function_call;
    } else if (name !== row.function_call.name) {
      row = { ...row, function_call: { ...row.function_call, name } };
    }
  }
  const drop = row.role === "tool" && ctx.droppedCalls.has(row.tool_call_id) || row.role === "function" && ctx.droppedFunctions.has(row.name) || emptied && !carriesContent(row);
  return { row, drop };
}
function rewriteClaudeRecord(original, ctx) {
  if (!Array.isArray(original?.content)) return { row: original, drop: false };
  const blocks = [];
  let touched = false;
  for (const block of original.content) {
    if (block?.type === "tool_use") {
      const name = ctx.served(block.name);
      if (name === null) {
        if (typeof block.id === "string" && block.id !== "") ctx.droppedCalls.add(block.id);
        touched = true;
        continue;
      }
      if (name === block.name) {
        blocks.push(block);
        continue;
      }
      blocks.push({ ...block, name });
      touched = true;
      continue;
    }
    if (block?.type === "tool_result" && ctx.droppedCalls.has(block.tool_use_id)) {
      touched = true;
      continue;
    }
    blocks.push(block);
  }
  if (!touched) return { row: original, drop: false };
  return { row: { ...original, content: blocks }, drop: blocks.length === 0 };
}
function dropUnservedHistory(payload, shape, known) {
  const field = shape === "flat" ? "input" : "messages";
  const records = payload[field];
  if (!Array.isArray(records)) return;
  const ctx = { served: servedName(known), droppedCalls: /* @__PURE__ */ new Set(), droppedFunctions: /* @__PURE__ */ new Set() };
  const rewrite = shape === "flat" ? rewriteFlatRecord : shape === "chat" ? rewriteChatRecord : rewriteClaudeRecord;
  let write = 0;
  let changed = false;
  for (const original of records) {
    const { row, drop } = rewrite(original, ctx);
    if (drop || row !== original) changed = true;
    if (!drop) records[write++] = row;
  }
  records.length = write;
  if (changed && shape === "claude") payload[field] = records.filter((row) => row !== null);
}
function dropDanglingToolChoice(payload, shape, known) {
  const choice = payload?.tool_choice;
  if (choice === null || typeof choice !== "object") return;
  const name = shape === "chat" && choice.function && typeof choice.function === "object" ? choice.function.name : choice.name;
  if (typeof name === "string" && name !== "" && !known.has(name)) delete payload.tool_choice;
}
function shapeToolSurface(payload, shape, { keep } = {}) {
  const renames = new ToolRenameMap();
  const injected = [];
  const known = /* @__PURE__ */ new Set();
  if (!SHAPED.has(shape)) return { renames, injected, known };
  const preserved = keep instanceof Set ? keep : /* @__PURE__ */ new Set();
  const state = { renames, officials: new Set(preserved), taken: /* @__PURE__ */ new Set() };
  const entries = Array.isArray(payload.tools) ? payload.tools.slice() : [];
  if (shape !== "claude" && Array.isArray(payload.functions)) {
    entries.push(...declarationsFromLegacyFunctions(payload.functions, shape, renames, state.taken));
    delete payload.functions;
  }
  let declared = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const name = renamableToolName(shape, entry);
    if (name === null) continue;
    declared += 1;
    const officialName = V2_OFFICIAL_TOOL_ORDER.includes(name);
    if (preserved.has(name) || isWireToolName(name) || officialName && !state.officials.has(name) && carriesOfficialDefinition(shape, entry, name)) {
      state.officials.add(name);
      continue;
    }
    const wire = assignWireName(name, state, { shape, entry });
    const renamed = wire === name ? entry : withWireName(shape, entry, wire);
    entries[index] = V2_OFFICIAL_TOOL_ORDER.includes(wire) && carriesOfficialDefinition(shape, entry, wire) ? renamed : withDeLiteralizedDescription(shape, renamed);
  }
  for (const name of V2_OFFICIAL_TOOL_ORDER) {
    if (state.officials.has(name)) continue;
    entries.push(officialTool(shape, name));
    state.officials.add(name);
    injected.push(name);
  }
  for (const name of state.officials) known.add(name);
  for (const name of renames.keys()) known.add(name);
  const unique = [];
  const seenWire = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    const wire = renamableToolName(shape, entry);
    if (wire !== null) {
      if (seenWire.has(wire)) continue;
      seenWire.add(wire);
    }
    unique.push(entry);
  }
  payload.tools = unique;
  remapToolReferences(payload, shape, renames);
  if (declared > 0) dropUnservedHistory(payload, shape, known);
  dropDanglingToolChoice(payload, shape, known);
  return { renames, injected, known };
}
export {
  ANONYMOUS_CREDENTIAL,
  BASE62_ALPHABET,
  CANONICAL_SESSION_RE,
  CLIENT_TOOL_DIGEST_LENGTH,
  CLIENT_TOOL_PREFIX,
  CLIENT_UA,
  DESCENDING_TIME_RE,
  LEGACY_CLIENT_TOOL_PREFIXES,
  OFFICIAL_PROMPT_MARKER,
  OFFICIAL_SKILLS,
  OFFICIAL_TOOL_ALIASES,
  SESSION_PHASE_MS,
  SESSION_TIMESTAMP_WINDOW_MS,
  TOOL_WIRE_NAME_LIMIT,
  ToolRenameMap,
  V2_CLIENT_VERSION,
  V2_COMPLETION_LIMIT,
  V2_OFFICIAL_TOOL_ORDER,
  carriesOpenCodePrompt,
  clientToolWireName,
  currentTimePhaseMs,
  encodeFixedBase62,
  encodePhaseField,
  ensureChatUsage,
  ensureV2CompletionLimit,
  foldToolName,
  gatewayHeaders,
  injectOfficialPrompt,
  isOfficialSessionID,
  isWireToolName,
  mintSessionIdentifier,
  officialEnvironment,
  officialForClientName,
  officialPrompt,
  officialSystemPrompt,
  officialTool,
  officialToolDefinition,
  officialToolset,
  phaseAgeMs,
  projectID,
  randomID,
  randomProjectID,
  renamableToolName,
  sessionPhaseMs,
  shapeToolSurface,
  stableProjectID,
  textFragments,
  traceHeaders,
  v2ShellDescription
};
