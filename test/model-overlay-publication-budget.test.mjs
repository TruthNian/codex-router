import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";

import { applyModelOverlayPublication, captureModelOverlayFiles, restoreModelOverlayFiles,
  transactModelOverlayMutation } from "../src/model-overlay-publication.mjs";

function fixtures(t, count) {
  const directory = mkdtempSync(path.join(process.env.MODEL_ROUTER_STATE_DIR || os.tmpdir(), "overlay-budget-"));
  mkdirSync(directory, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = Array.from({ length: count }, (_, index) => path.join(directory, `private-${index}.json`));
  for (let index = 0; index < files.length; index += 1) writeFileSync(files[index], `old-${index}\n`);
  return files;
}

function fakeClock(t) {
  let current = Date.now();
  const start = current;
  t.mock.method(Date, "now", () => current);
  return { start, advance: (milliseconds) => { current += milliseconds; }, now: () => current };
}

function publicationPhase(events, clock, fail = false) {
  return (options) => applyModelOverlayPublication({ ...options,
    prepareDependencies: async ({ deadline }) => {
      assert.ok(deadline - clock.now() >= 600_000, "the dependency child retains its full epoch");
      events.push("dependencies");
    },
    prepare: async ({ deadline }) => {
      assert.ok(deadline - clock.now() >= 30_000);
      events.push("gateway");
      return {};
    },
    restartService: async ({ deadline }) => {
      assert.ok(deadline - clock.now() >= 330_000, "status, ownership and health allowances remain complete");
      events.push("restart");
      return true;
    },
    publish: async ({ deadline }) => {
      assert.ok(deadline - clock.now() >= 300_000);
      events.push("clients");
      if (fail) throw new Error("partial client publication failed");
    },
  });
}

test("a 30-second mutation preserves full adoption and publication within the 45-minute ceiling", async (t) => {
  const files = fixtures(t, 6);
  const clock = fakeClock(t);
  const events = [];
  await transactModelOverlayMutation({ files, lock: false, restart: true,
    deadline: clock.start + 45 * 60_000,
    mutate: async () => {
      clock.advance(30_000);
      for (const file of files) writeFileSync(file, "new\n");
      events.push("mutate");
    },
    applyPublication: publicationPhase(events, clock),
  });
  assert.deepEqual(events, ["mutate", "dependencies", "gateway", "restart", "clients"]);
  for (const file of files) assert.equal(readFileSync(file, "utf8"), "new\n");
});

test("six 15-second private restorations retain the complete independent rollback publication", async (t) => {
  const files = fixtures(t, 6);
  const prior = files.map((file) => readFileSync(file));
  const clock = fakeClock(t);
  const events = [];
  let publication = 0;
  await assert.rejects(transactModelOverlayMutation({ capture: () => captureModelOverlayFiles(files), lock: false, restart: true,
    deadline: clock.start + 45 * 60_000,
    mutate: async () => {
      clock.advance(30_000);
      for (const file of files) writeFileSync(file, "new\n");
      events.push("mutate");
    },
    restore: (snapshots) => restoreModelOverlayFiles(snapshots, {
      protect: (file) => {
        assert.ok(files.includes(file));
        events.push("protect");
        clock.advance(15_000);
      },
    }),
    applyPublication: (options) => {
      publication += 1;
      if (publication === 2) assert.equal(options.signal, undefined);
      return publicationPhase(events, clock, publication === 1)(options);
    },
  }), /partial client publication failed/);
  assert.equal(publication, 2);
  assert.deepEqual(files.map((file) => readFileSync(file)), prior);
  assert.equal(events.filter((event) => event === "protect").length, 6);
  assert.deepEqual(events.slice(-4), ["dependencies", "gateway", "restart", "clients"]);
  assert.equal(clock.now() - clock.start, 120_000);
});

test("an expired mutation restores every changed byte before independent rollback publication", async (t) => {
  const files = fixtures(t, 2);
  const created = path.join(path.dirname(files[0]), "created.json");
  const prior = files.map((file) => readFileSync(file));
  const clock = fakeClock(t);
  const events = [];
  await assert.rejects(transactModelOverlayMutation({ files: [...files, created], lock: false, restart: true,
    mutate: async () => {
      for (const file of [...files, created]) writeFileSync(file, "partial\n");
      clock.advance(61_000);
      events.push("mutate");
    },
    restore: (snapshots) => restoreModelOverlayFiles(snapshots, {
      protect: () => { clock.advance(15_000); events.push("protect"); },
    }),
    applyPublication: (options) => {
      assert.equal(options.signal, undefined, "only rollback may run after mutation expires");
      return publicationPhase(events, clock)(options);
    },
  }), { code: "router_operation_timeout" });
  assert.deepEqual(files.map((file) => readFileSync(file)), prior);
  assert.equal(existsSync(created), false);
  assert.deepEqual(events, ["mutate", "protect", "protect", "dependencies", "gateway", "restart", "clients"]);
});

test("insufficient caller time is rejected before changing a captured private file", async (t) => {
  const files = fixtures(t, 6);
  const prior = files.map((file) => readFileSync(file));
  const clock = fakeClock(t);
  await assert.rejects(transactModelOverlayMutation({ files, lock: false, restart: true,
    deadline: clock.start + 2_680_000,
    mutate: () => assert.fail("the required 2690-second transaction cannot fit"),
    applyPublication: () => assert.fail("no publication may precede a refused mutation"),
  }), { code: "router_operation_timeout" });
  assert.deepEqual(files.map((file) => readFileSync(file)), prior);
});

test("file-array capture callbacks count existing files and reject excessive restore allowance", async (t) => {
  const files = fixtures(t, 7);
  await assert.rejects(transactModelOverlayMutation({ lock: false, restart: true,
    capture: () => captureModelOverlayFiles(files),
    mutate: () => assert.fail("seven per-file ACL operations cannot fit the rollback owner allowance"),
  }), { code: "router_operation_timeout" });
});

test("custom snapshot arrays retain a bounded unknown restoration allowance", async (t) => {
  const clock = fakeClock(t);
  let state = "old";
  let calls = 0;
  await assert.rejects(transactModelOverlayMutation({ lock: false, restart: true,
    capture: () => [{ customState: state }],
    mutate: () => { state = "new"; clock.advance(20_000); },
    restore: (snapshots) => { state = snapshots[0].customState; clock.advance(45_000); },
    applyPublication: (options) => {
      calls += 1;
      assert.ok(options.deadline - clock.now() >= 1_260_000);
      if (calls === 1) throw new Error("custom forward failure");
    },
  }), /custom forward failure/);
  assert.equal(state, "old");
  assert.equal(calls, 2);
});

test("an oversized configured per-file ACL timeout is refused before mutation", async (t) => {
  const files = fixtures(t, 1);
  const previous = process.env.CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS;
  process.env.CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS = "900000";
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS;
    else process.env.CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS = previous;
  });
  await assert.rejects(transactModelOverlayMutation({ files, lock: false, restart: true,
    mutate: () => assert.fail("an explicit timeout cannot silently overrun the rollback owner"),
  }), { code: "router_operation_timeout" });
});
