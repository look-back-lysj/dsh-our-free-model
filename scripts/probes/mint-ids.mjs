/*!
 * Vendored from 9router (https://github.com/decolua/9router, MIT,
 * Copyright (c) 2024-2026 decolua and contributors), upstream file ".probe.mjs".
 *
 * This is a byte-for-byte copy with the upstream base URL changed to the endpoint
 * this plugin probes. It is kept as evidence for the findings in README.md, not as
 * shipped code, and it imports 9router's own modules, so it does not run outside a
 * 9router checkout.
 *
 * MIT licence text: LICENSE, section "9router".
 */
import { generateSessionId, generateRequestId } from "./open-sse/executors/opencode.js";
import { writeFileSync } from "fs";
const s = generateSessionId(), r = generateRequestId();
console.log(s, r);
writeFileSync(".probe-ids.json", JSON.stringify({ session: s, request: r }));
