import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./paths.mjs";
import { writePrivateJson } from "./file-security.mjs";

// Explicit temporary diagnostic consent. Never captures normal traffic,
// authentication headers, credential stores or unrelated threads. Captured
// tool arguments are private task content. No automatic history replay.
export function recordRelayFailureCapture(error, threadId, { stateDir = STATE_DIR, now = Date.now() } = {}) {
  if (error?.code !== "ERR_NAMESPACE_RELAY_COMMITTED_STREAM" || !error.relayFrame || !threadId) return false;
  try {
    const file = path.join(stateDir, "relay-failure-capture.json");
    if (!existsSync(file) || statSync(file).size > 2048) return false;
    const consent = JSON.parse(readFileSync(file, "utf8"));
    if (consent.threadId !== threadId || consent.model !== error.relayFrame.model ||
        !Number.isFinite(consent.expiresAt) || consent.expiresAt <= now || consent.expiresAt > now + 24 * 60 * 60 * 1000) return false;
    for (let index = 1; index <= 3; index++) {
      const target = path.join(stateDir, `relay-failure-capture-${index}.json`);
      if (existsSync(target)) continue;
      const { prefix, ...metadata } = error.relayFrame;
      writePrivateJson(target, { at: new Date(now).toISOString(), threadId, boundary: "namespace-relay-input",
        ...metadata, capturedBytes: prefix.length, truncated: prefix.length !== metadata.byteLength,
        frameBase64: prefix.toString("base64") });
      return true;
    }
  } catch { /* Diagnostics must never replace the original provider failure. */ }
  return false;
}
