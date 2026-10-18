import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { subscribeNativeCatalogEvents } from "../src/native-catalog-events.mjs";

const results = [];
for (const mode of ["raw-immediate", "canonical-immediate", "raw-settled"]) {
  for (let round = 1; round <= 5; round += 1) {
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
      results.push({ mode, round, observed: event?.accountChanged === true, milliseconds: Date.now() - started, trace });
    } finally {
      clearTimeout(timer); stop();
      assert.equal(path.dirname(allocated), path.resolve(os.tmpdir()));
      assert(path.basename(allocated).startsWith("native-watch-diagnostic-"));
      rmSync(allocated, { recursive: true, force: true });
    }
  }
}
console.log(JSON.stringify({ platform: process.platform, results }, null, 2));
