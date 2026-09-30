import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { watchNativeCatalog } from "../src/native-catalog-drift.mjs";

test("native catalog checks at startup and once a day, not every five minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const stop = watchNativeCatalog({
    immediate: true,
    republish: async () => { calls += 1; },
  });
  try {
    assert.equal(calls, 1, "startup still checks immediately");
    await Promise.resolve();
    t.mock.timers.tick(5 * 60_000);
    assert.equal(calls, 1, "five minutes must not trigger another check");
    t.mock.timers.tick((24 * 60 - 5) * 60_000 - 1);
    assert.equal(calls, 1, "no periodic check before a full day");
    t.mock.timers.tick(1);
    assert.equal(calls, 2, "check again after 24 hours");
    await Promise.resolve();
    t.mock.timers.tick(24 * 60 * 60_000);
    assert.equal(calls, 3, "daily checks continue while the service runs");
  } finally {
    stop();
  }
});

test("native catalog watcher refreshes periodically without overlapping passes", async () => {
  let tick;
  let release;
  let calls = 0;
  const stop = watchNativeCatalog({
    clear(timer) { assert.equal(timer, 1); },
    interval(callback, delay) {
      tick = callback;
      assert.equal(delay, 86_400_000);
      return 1;
    },
    republish() {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    },
  });

  const first = tick();
  await tick();
  assert.equal(calls, 1);
  release();
  await first;
  const second = tick();
  assert.equal(calls, 2);
  release();
  await second;
  stop();
});

test("native catalog watcher recovers after synchronous and asynchronous refresh failures", async () => {
  let tick;
  let calls = 0;
  const messages = [];
  const stop = watchNativeCatalog({
    interval(callback) { tick = callback; return 1; },
    clear() {},
    log(message) { messages.push(message); },
    republish() {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      if (calls === 2) return Promise.reject(new Error("temporary failure"));
      return Promise.resolve(false);
    },
  });
  try {
    await tick();
    await tick();
    await tick();
    assert.equal(calls, 3, "a failed refresh must not block later intervals");
    assert.deepEqual(messages, [
      "[codex-router] Native catalog refresh failed: offline",
      "[codex-router] Native catalog refresh failed: temporary failure",
    ]);
  } finally {
    stop();
  }
});

test("initial refresh shares the periodic guard and stopping prevents subsequent work", async () => {
  let tick;
  let release;
  let calls = 0;
  let cleared = false;
  const stop = watchNativeCatalog({
    immediate: true,
    interval(callback) { tick = callback; return 1; },
    clear() { cleared = true; },
    republish() {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  assert.equal(calls, 1, "startup refresh starts immediately");
  await tick();
  assert.equal(calls, 1, "an interval must not overlap the startup pass");
  stop();
  release(false);
  await Promise.resolve();
  await tick();
  assert.equal(cleared, true);
  assert.equal(calls, 1, "a callback queued before stop must not refresh");
});

test("the background watcher does not keep a finished process alive", () => {
  const moduleUrl = new URL("../src/native-catalog-drift.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval",
    `import { watchNativeCatalog } from ${JSON.stringify(moduleUrl)};\n` +
    "watchNativeCatalog({ republish: async () => false });\n",
  ], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
  assert.equal(result.error, undefined, "watcher held the process open");
  assert.equal(result.status, 0, result.stderr);
});
