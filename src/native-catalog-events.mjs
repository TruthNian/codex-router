import { createHash } from "node:crypto";
import { existsSync, watch as watchDirectory } from "node:fs";
import path from "node:path";

import { CODEX_AUTH_PATH, nativeAccountCatalogHeaders } from "./codex-native-session.mjs";
import { codexBinaryFingerprint, findCodexBinary } from "./codex-binary.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";

// Compare identities only in memory. Neither account IDs nor credentials are
// written to a cache, returned in an event, or logged. A rotating bearer is not
// an account identity, and a missing/unreadable session is not proof of logout.
export async function nativeCatalogAccountIdentity({
  headersProvider = nativeAccountCatalogHeaders,
  discoveryOff = discoveryDisabled,
} = {}) {
  if (discoveryOff()) return undefined;
  try {
    const headers = await headersProvider();
    const account = headers?.["chatgpt-account-id"];
    if (typeof account !== "string" || !account || account.length > 4096) return undefined;
    return createHash("sha256").update(account).digest("hex");
  } catch {
    return undefined;
  }
}

export function nativeCatalogBinaryRoots({
  platform = process.platform,
  environment = process.env,
} = {}) {
  if (platform === "win32") {
    return environment.LOCALAPPDATA
      ? [path.join(environment.LOCALAPPDATA, "OpenAI", "Codex", "bin")]
      : [];
  }
  return platform === "darwin"
    ? ["/Applications/Codex.app/Contents/Resources", "/Applications/ChatGPT.app/Contents/Resources"]
    : ["/opt/codex-desktop/resources"];
}

function nearestExistingDirectory(directory, exists) {
  let candidate = directory;
  while (!exists(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
  // Do not turn a missing application installation into a whole-volume watch.
  return path.dirname(candidate) === candidate ? undefined : candidate;
}

/**
 * Observe account identity and installed binary changes. Parent-directory
 * watches survive atomic file replacement; a Windows recursive bin-root watch
 * also notices a newly installed version-hashed runtime. Models caches,
 * generated catalogs and staged route selections are deliberately not watched:
 * our own publication must not start a refresh loop or bypass reconciliation.
 */
export function subscribeNativeCatalogEvents(listener, {
  authPath = CODEX_AUTH_PATH,
  readAccountIdentity = nativeCatalogAccountIdentity,
  readBinaryIdentity = codexBinaryFingerprint,
  resolveBinary = findCodexBinary,
  binaryRoots = nativeCatalogBinaryRoots(),
  platform = process.platform,
  discoveryOff = discoveryDisabled,
  watch = watchDirectory,
  exists = existsSync,
  schedule = setTimeout,
  cancel = clearTimeout,
  debounceMs = 500,
} = {}) {
  if (discoveryOff()) return () => {};
  let stopped = false;
  let timer;
  let checking = false;
  let checkAgain = false;
  let account;
  let binary;
  let initialized = false;
  const watchers = new Map();

  const queueCheck = () => {
    if (stopped || discoveryOff()) return;
    if (checking) { checkAgain = true; return; }
    if (timer !== undefined) cancel(timer);
    timer = schedule(() => {
      timer = undefined;
      void check();
    }, debounceMs);
    timer.unref?.();
  };

  function rearm() {
    if (stopped || discoveryOff()) return;
    const targets = [{ target: path.resolve(authPath), directory: false }];
    try {
      const resolved = resolveBinary();
      if (resolved) targets.push({ target: path.resolve(resolved), directory: false });
    } catch { /* A temporarily missing runtime preserves the previous identity. */ }
    targets.push(...binaryRoots.map((target) => ({ target: path.resolve(target), directory: true })));
    const desired = new Map();
    for (const { target, directory } of targets) {
      const requested = directory ? target : path.dirname(target);
      const parent = nearestExistingDirectory(requested, exists);
      if (!parent) continue;
      const recursive = directory && parent === requested && ["win32", "darwin"].includes(platform);
      const key = `${parent}\0${recursive}`;
      const names = desired.get(key)?.names || new Set();
      // An absent directory is watched through its first missing ancestor.
      const relative = path.relative(parent, target);
      names.add(directory && parent === requested ? "*" : relative.split(path.sep)[0]);
      desired.set(key, { parent, recursive, names });
    }
    for (const [key, record] of watchers) {
      if (!desired.has(key)) { record.handle.close(); watchers.delete(key); }
    }
    for (const [key, spec] of desired) {
      const existing = watchers.get(key);
      if (existing) { existing.names = spec.names; continue; }
      try {
        const record = { ...spec, handle: undefined };
        record.handle = watch(spec.parent, { persistent: false, recursive: spec.recursive }, (_event, filename) => {
          const name = filename === null || filename === undefined ? undefined : String(filename).split(/[\\/]/)[0];
          if (!name || record.names.has("*") || record.names.has(name)) queueCheck();
        });
        record.handle.on?.("error", () => {
          record.handle.close();
          if (watchers.get(key) === record) watchers.delete(key);
          queueCheck();
        });
        watchers.set(key, record);
      } catch {
        // Filesystem notifications are an optimization. The daily bounded
        // fallback remains responsible when the OS cannot create a watch.
      }
    }
  }

  async function check() {
    if (stopped || discoveryOff()) return;
    if (checking) { checkAgain = true; return; }
    checking = true;
    try {
      if (!initialized) {
        try { binary = readBinaryIdentity(); } catch { /* Unknown is not replacement. */ }
      }
      let nextAccount;
      try { nextAccount = await readAccountIdentity(); } catch { /* Unknown is not logout. */ }
      if (stopped || discoveryOff()) return;
      let nextBinary;
      try { nextBinary = readBinaryIdentity(); } catch { /* Unknown is not replacement. */ }
      if (initialized || checkAgain) {
        if (nextAccount !== undefined && nextAccount !== account) {
          listener({ source: "account", forceAccountRefresh: true, accountChanged: true });
        }
        if (nextBinary !== undefined && nextBinary !== binary) {
          listener({ source: "binary", forceAccountRefresh: true });
        }
      }
      if (nextAccount !== undefined) account = nextAccount;
      if (nextBinary !== undefined) binary = nextBinary;
      initialized = true;
      rearm();
    } catch {
      // A transient identity read cannot withdraw the previous safe catalog.
      initialized = true;
      rearm();
    } finally {
      checking = false;
      if (checkAgain && !stopped) { checkAgain = false; queueCheck(); }
    }
  }

  rearm();
  void check();
  return () => {
    stopped = true;
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    checkAgain = false;
    for (const { handle } of watchers.values()) handle.close();
    watchers.clear();
  };
}
