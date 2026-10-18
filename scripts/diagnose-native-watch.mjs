import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { subscribeNativeCatalogEvents } from "../src/native-catalog-events.mjs";

const results = [];
const childMode = process.argv[2];
if (!childMode) {
  for (let round = 1; round <= 5; round += 1) {
    for (const mode of ["raw-immediate", "canonical-immediate", "raw-settled"]) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), mode, String(round)], {
        encoding: "utf8", windowsHide: true, timeout: 10_000,
      });
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr);
      results.push(...JSON.parse(child.stdout).results);
    }
  }
} else {
    const mode = childMode;
    assert(["raw-immediate", "canonical-immediate", "raw-settled"].includes(mode));
    const round = Number(process.argv[3]);
    const allocated = mkdtempSync(path.join(os.tmpdir(), "native-watch-diagnostic-"));
    const root = mode === "canonical-immediate" ? realpathSync(allocated) : allocated;
    const authPath = path.join(root, "auth.json");
    writeFileSync(authPath, "synthetic before");
    let identity = "before";
    const started = Date.now();
    const trace = [];
    let complete;
    const observed = new Promise((resolve) => { complete = resolve; });
    const stop = subscribeNativeCatalogEvents((event) => complete(event), {
      authPath, binaryRoots: [], resolveBinary: () => undefined, readBinaryIdentity: () => undefined,
      readAccountIdentity: async () => { trace.push({ at: Date.now() - started, read: identity }); return identity; },
      discoveryOff: () => false, debounceMs: 20,
      watch(directory, flags, callback) {
        trace.push({ at: Date.now() - started, watch: directory, canonical: realpathSync(directory) });
        const handle = watch(directory, flags, (kind, filename) => {
          trace.push({ at: Date.now() - started, kind, filename: filename == null ? null : String(filename) });
          callback(kind, filename);
        });
        handle.on("error", (error) => trace.push({ at: Date.now() - started, error: error.code }));
        return handle;
      },
    });
    let timer;
    try {
      await new Promise((resolve) => setImmediate(resolve));
      if (mode === "raw-settled") await new Promise((resolve) => setTimeout(resolve, 200));
      writeFileSync(`${authPath}.replacement`, "synthetic after");
      identity = "after";
      trace.push({ at: Date.now() - started, replace: true });
      renameSync(`${authPath}.replacement`, authPath);
      const event = await Promise.race([observed, new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), 2000); })]);
      results.push({ mode, round, observed: event?.accountChanged === true,
        nativeCallbacks: trace.filter((entry) => entry.kind).length, milliseconds: Date.now() - started, trace });
    } finally {
      clearTimeout(timer); stop();
      assert.equal(path.dirname(allocated), path.resolve(os.tmpdir()));
      assert(path.basename(allocated).startsWith("native-watch-diagnostic-"));
      rmSync(allocated, { recursive: true, force: true });
    }
}
console.log(JSON.stringify({ platform: process.platform, node: process.version, libuv: process.versions.uv, results }, null, 2));
