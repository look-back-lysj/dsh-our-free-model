/*!
 * Vendored from 9router (https://github.com/decolua/9router, MIT,
 * Copyright (c) 2024-2026 decolua and contributors), upstream file ".probe2.mjs".
 *
 * This is a byte-for-byte copy with the upstream base URL changed to the endpoint
 * this plugin probes. It is kept as evidence for the findings in README.md, not as
 * shipped code, and it imports 9router's own modules, so it does not run outside a
 * 9router checkout.
 *
 * MIT licence text: LICENSE, section "9router".
 */
import { generateSessionId, generateRequestId } from "./open-sse/executors/opencode.js";
import { applyFingerprintTools } from "./open-sse/utils/opencodeFingerprint.js";

const session = generateSessionId();
const B = "https://opencode.ai";
const HEADERS = {
  "Content-Type": "application/json",
  "Authorization": "Bearer public",
  "User-Agent": "opencode/1.18.31",
  "x-opencode-client": "desktop",
  "x-opencode-session": session,
  "x-opencode-project": "global",
  "Accept": "text/event-stream",
};

const TEXT_RE = /"text":"((?:[^"\\]|\\.)*)"/g;
const CONTENT_RE = /"content":"((?:[^"\\]|\\.)*)"/g;

function grab(txt, re) {
  const out = [];
  for (const m of txt.matchAll(re)) out.push(m[1]);
  return out.join("");
}

async function chat(model) {
  const body = {
    model,
    messages: [{ role: "user", content: "Reply with exactly: PROBE-OK" }],
    stream: true,
  };
  applyFingerprintTools(body, false);
  const t0 = Date.now();
  const res = await fetch(`${B}/inference/v1/chat/completions`, {
    method: "POST",
    headers: { ...HEADERS, "x-opencode-request": generateRequestId() },
    body: JSON.stringify(body),
    redirect: "error",
  });
  const txt = await res.text();
  const dt = Date.now() - t0;
  const c = grab(txt, CONTENT_RE);
  console.log(`[chat ${res.status}] ${dt}ms ${model} :: ${c.slice(0, 120) || txt.slice(0, 280).replace(/\s+/g, " ")}`);
}

async function responses(model) {
  const body = {
    model,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Reply with exactly: PROBE-OK" }] }],
    stream: true,
    store: false,
  };
  applyFingerprintTools(body, true);
  const t0 = Date.now();
  const res = await fetch(`${B}/inference/v1/responses`, {
    method: "POST",
    headers: { ...HEADERS, "x-opencode-request": generateRequestId() },
    body: JSON.stringify(body),
    redirect: "error",
  });
  const txt = await res.text();
  const dt = Date.now() - t0;
  const c = grab(txt, TEXT_RE);
  console.log(`[resp ${res.status}] ${dt}ms ${model} :: ${c.slice(0, 120) || txt.slice(0, 320).replace(/\s+/g, " ")}`);
}

await chat("deepseek-v4-flash-free");
await chat("union-alpha");
await responses("muse-spark-1.3-contributor-free");
await responses("muse-spark-1.2-contributor-free");
await chat("muse-spark-1.3-contributor-free");
