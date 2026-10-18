import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { codexBinaryFingerprint } from "../src/codex-binary.mjs";
import { nativeCatalogAccountIdentity, subscribeNativeCatalogEvents } from "../src/native-catalog-events.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "native-catalog-events-"));
  const authPath = path.join(root, "auth.json");
  const binary = path.join(root, "codex.exe");
  writeFileSync(binary, "synthetic runtime");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const watched = [];
  let scheduled;
  const options = {
    authPath,
    resolveBinary: () => binary,
    readBinaryIdentity: () => codexBinaryFingerprint(binary),
    binaryRoots: [],
    discoveryOff: () => false,
    watch(directory, flags, callback) {
      const record = { directory, flags, callback, closed: false };
      watched.push(record);
      return { close() { record.closed = true; }, on() {} };
    },
    schedule(callback) { scheduled = callback; return 1; },
    cancel() { scheduled = undefined; },
  };
  return { root, authPath, binary, watched, options, async flush() {
    const callback = scheduled;
    scheduled = undefined;
    callback?.();
    await settle();
  } };
}

test("native account identity is stable across token rotation and never returns credentials or account IDs", async () => {
  const source = (token) => ({ authorization: `Bearer ${token}`, "chatgpt-account-id": "private-account-identity" });
  const first = await nativeCatalogAccountIdentity({ discoveryOff: () => false, headersProvider: async () => source("first-secret") });
  const rotated = await nativeCatalogAccountIdentity({ discoveryOff: () => false, headersProvider: async () => source("second-secret") });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, rotated);
  assert.doesNotMatch(first, /secret|private-account/);
  assert.equal(await nativeCatalogAccountIdentity({ discoveryOff: () => false, headersProvider: async () => ({ authorization: "Bearer unknown-account" }) }), undefined);
  assert.equal(await nativeCatalogAccountIdentity({ discoveryOff: () => true, headersProvider: () => { throw new Error("credential read"); } }), undefined);
});

test("watch startup catches a changed identity without a filesystem notification and does not poll", async (t) => {
  const f = fixture(t);
  let account = "before";
  let reads = 0;
  const events = [];
  const stop = subscribeNativeCatalogEvents((event) => events.push(event), {
    ...f.options, readAccountIdentity: async () => { reads += 1; return account; },
  });
  t.after(stop);
  await settle();
  account = "after";
  await f.flush();
  assert.deepEqual(events, [{ source: "account", forceAccountRefresh: true, accountChanged: true }]);
  assert.equal(reads, 2);
  await f.flush();
  assert.equal(reads, 2, "the startup check must not become a recurring poll");
});

test("unchanged startup identities do not refresh, and stopping cancels the catch-up", async (t) => {
  const f = fixture(t);
  let reads = 0;
  const events = [];
  const stop = subscribeNativeCatalogEvents((event) => events.push(event), {
    ...f.options, readAccountIdentity: async () => { reads += 1; return "stable"; },
  });
  t.after(stop);
  await settle();
  await f.flush();
  assert.equal(reads, 2);
  assert.deepEqual(events, []);
  await f.flush();
  assert.equal(reads, 2);
  const second = fixture(t);
  const secondStop = subscribeNativeCatalogEvents((event) => events.push(event), {
    ...second.options, readAccountIdentity: async () => { reads += 1; return "stable"; },
  });
  t.after(secondStop);
  await settle();
  const beforeStop = reads;
  secondStop();
  await second.flush();
  assert.equal(reads, beforeStop);
  assert.deepEqual(events, []);
});

test("watch startup also reconciles a binary replaced before notifications begin", async (t) => {
  const f = fixture(t);
  let binary = "before-build";
  const events = [];
  const stop = subscribeNativeCatalogEvents((event) => events.push(event), {
    ...f.options, readAccountIdentity: async () => "stable-account", readBinaryIdentity: () => binary,
  });
  t.after(stop);
  await settle();
  binary = "after-build";
  await f.flush();
  assert.deepEqual(events, [{ source: "binary", forceAccountRefresh: true }]);
  await f.flush();
  assert.equal(events.length, 1);
});

test("account changes refresh once; token rotation and temporarily unavailable auth preserve identity", async (t) => {
  const f = fixture(t);
  let account = "fingerprint-a";
  const events = [];
  const stop = subscribeNativeCatalogEvents((event) => events.push(event), { ...f.options, readAccountIdentity: async () => account });
  t.after(stop);
  await settle();
  const record = f.watched.find((watch) => !watch.closed);
  const notify = () => record.callback("rename", "auth.json");
  notify(); await f.flush();
  account = undefined;
  notify(); await f.flush();
  account = "fingerprint-a";
  notify(); await f.flush();
  assert.deepEqual(events, []);
  account = "fingerprint-b";
  notify(); notify(); await f.flush();
  assert.deepEqual(events, [{ source: "account", forceAccountRefresh: true, accountChanged: true }]);
  assert.doesNotMatch(JSON.stringify(events), /fingerprint/);
  stop();
  account = "fingerprint-c";
  notify(); await f.flush();
  assert.equal(events.length, 1);
});

test("a new Windows hash directory changes the binary identity and rearms its file-parent watch", async (t) => {
  const f = fixture(t);
  const binRoot = path.join(f.root, "bin");
  mkdirSync(path.join(binRoot, "old"), { recursive: true });
  let current = path.join(binRoot, "old", "codex.exe");
  writeFileSync(current, "old");
  const events = [];
  const stop = subscribeNativeCatalogEvents((event) => events.push(event), {
    ...f.options, platform: "win32", binaryRoots: [binRoot],
    resolveBinary: () => current,
    readBinaryIdentity: () => codexBinaryFingerprint(current),
    readAccountIdentity: async () => "stable-account",
  });
  t.after(stop);
  await settle();
  assert.ok(f.watched.some((record) => record.directory === binRoot && record.flags.recursive));
  const oldParent = f.watched.find((record) => record.directory === path.dirname(current));
  mkdirSync(path.join(binRoot, "new"));
  current = path.join(binRoot, "new", "codex.exe");
  writeFileSync(current, "new runtime");
  f.watched.find((record) => record.directory === binRoot).callback("rename", path.join("new", "codex.exe"));
  await f.flush();
  assert.deepEqual(events, [{ source: "binary", forceAccountRefresh: true }]);
  assert.equal(oldParent.closed, true);
  assert.ok(f.watched.some((record) => record.directory === path.dirname(current) && !record.closed));
});

test("missing directories are followed from their parent and publication files cannot trigger refresh loops", async (t) => {
  const f = fixture(t);
  const authDirectory = path.join(f.root, "new-home");
  let reads = 0;
  let account;
  const events = [];
  const stop = subscribeNativeCatalogEvents((event) => events.push(event), {
    ...f.options, authPath: path.join(authDirectory, "auth.json"),
    readAccountIdentity: async () => { reads += 1; return account; },
  });
  t.after(stop);
  await settle();
  const parent = f.watched.find((record) => record.directory === f.root && !record.closed);
  await f.flush();
  const initialReads = reads;
  parent.callback("rename", "models_cache.json");
  parent.callback("rename", "native-models.json");
  parent.callback("rename", "config.toml");
  await f.flush();
  assert.equal(reads, initialReads);
  mkdirSync(authDirectory);
  account = "newly-signed-in";
  parent.callback("rename", "new-home");
  await f.flush();
  assert.deepEqual(events, [{ source: "account", forceAccountRefresh: true, accountChanged: true }]);
  assert.ok(f.watched.some((record) => record.directory === authDirectory && !record.closed));
});

test("disabled discovery creates no watchers and reads no account or runtime", () => {
  const forbidden = () => { throw new Error("account-derived operation"); };
  const stop = subscribeNativeCatalogEvents(forbidden, {
    discoveryOff: () => true, readAccountIdentity: forbidden, readBinaryIdentity: forbidden,
    resolveBinary: forbidden, exists: forbidden, watch: forbidden,
  });
  stop();
});

test("notifications during initial identity lookup are coalesced and cannot hide a concurrent sign-in", async (t) => {
  const f = fixture(t);
  let release;
  let reads = 0;
  const events = [];
  const stop = subscribeNativeCatalogEvents((event) => events.push(event), {
    ...f.options,
    readAccountIdentity() {
      reads += 1;
      return reads === 1 ? new Promise((resolve) => { release = resolve; }) : "new-account";
    },
  });
  t.after(stop);
  const notify = f.watched.find((record) => !record.closed).callback;
  notify("rename", "auth.json");
  notify("change", "auth.json");
  assert.equal(reads, 1);
  release("new-account");
  await settle();
  assert.deepEqual(events, [{ source: "account", forceAccountRefresh: true, accountChanged: true }]);
  await f.flush();
  assert.equal(reads, 2);
  assert.equal(events.length, 1);
});

test("unknown account reads do not block binary updates, and stop suppresses an in-flight identity result", async (t) => {
  const f = fixture(t);
  let identity = "before";
  let release;
  let currentBinary = "before-build";
  const events = [];
  const stop = subscribeNativeCatalogEvents((event) => events.push(event), {
    ...f.options,
    readBinaryIdentity: () => currentBinary,
    readAccountIdentity() {
      if (identity === "error") throw new Error("credential read failed with private content");
      if (identity === "pending") return new Promise((resolve) => { release = resolve; });
      return identity;
    },
  });
  t.after(stop);
  await settle();
  const notify = f.watched.find((record) => !record.closed).callback;
  identity = "error";
  currentBinary = "after-build";
  notify("change", "codex.exe");
  await f.flush();
  assert.deepEqual(events, [{ source: "binary", forceAccountRefresh: true }]);
  identity = "pending";
  notify("rename", "auth.json");
  await f.flush();
  stop();
  release("after");
  await settle();
  assert.equal(events.length, 1);
  assert.ok(f.watched.every((record) => record.closed));
});

test("real parent-directory watch observes atomic auth-file replacement", { timeout: 10_000 }, async (t) => {
  const f = fixture(t);
  let account = "before";
  writeFileSync(f.authPath, "synthetic account fixture");
  let observed;
  let watcherReady = false;
  let reads = 0;
  let initialized;
  const startupChecked = new Promise((resolve) => { initialized = resolve; });
  const probeName = "zz-watch-ready-probe";
  const event = new Promise((resolve) => { observed = resolve; });
  const stop = subscribeNativeCatalogEvents(observed, {
    authPath: f.authPath, binaryRoots: [], resolveBinary: () => undefined,
    readBinaryIdentity: () => undefined, readAccountIdentity: async () => {
      reads += 1;
      if (reads >= 2) initialized();
      return account;
    },
    discoveryOff: () => false, debounceMs: 20,
    watch(directory, flags, callback) {
      return watch(directory, flags, (kind, filename) => {
        if (String(filename).split(/[\\/]/).at(-1) === probeName) watcherReady = true;
        callback(kind, filename);
      });
    },
  });
  t.after(stop);
  await settle();
  const readyDeadline = Date.now() + 2_000;
  while (!watcherReady && Date.now() < readyDeadline) {
    writeFileSync(path.join(f.root, probeName), "synthetic watch readiness");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(watcherReady, true, "the OS must deliver a probe event before the replacement assertion");
  await startupChecked;
  await settle();
  const replacement = `${f.authPath}.replacement`;
  writeFileSync(replacement, "replacement fixture");
  account = "after";
  renameSync(replacement, f.authPath);
  assert.deepEqual(await event, { source: "account", forceAccountRefresh: true, accountChanged: true });
});
