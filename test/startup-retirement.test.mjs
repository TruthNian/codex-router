import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { attemptAntigravityProbePromotionAfterReadiness } from "../src/antigravity-probe-activation.mjs";
import { clearStartupTimeouts, startupTimeoutMs } from "../src/startup-timeout.mjs";
import { stopServiceChildren } from "../src/service-shutdown.mjs";

// Importing start.mjs launches the whole service. Execute its actual post-health
// boundary with isolated process/child/publisher dependencies instead, retaining
// the real activation controller and timeout cleanup. No provider request or
// credential is needed to reproduce losing the remaining bootstrap allowance.
const source = readFileSync(new URL("../src/start.mjs", import.meta.url), "utf8").replace(/\r\n?/g, "\n");
const begin = source.indexOf("  const frontend = FRONTEND;");
const end = source.indexOf("  const cursorEdge =", begin);
assert.ok(begin >= 0 && end > begin, "startup readiness boundary must be present");
const boundary = source.slice(begin, end);
assert.ok(boundary.includes("const finalizeHealthyGeneration ="));
assert.ok(boundary.includes("await startNativeCatalogWatch()"));
const publisherBegin = source.indexOf("async function startNativeCatalogWatch() {");
const publisherEnd = source.indexOf("\n}\n", publisherBegin) + 3;
assert.ok(publisherBegin >= 0 && publisherEnd > publisherBegin);
const publisher = source.slice(publisherBegin, publisherEnd);
assert.ok(publisher.includes('import("./native-catalog-drift.mjs")'));
assert.ok(publisher.includes('import("./native-catalog-events.mjs")'));
const shutdownBegin = source.indexOf("function stopChildren() {");
const shutdownEnd = source.indexOf("const FRONTEND =", shutdownBegin);
assert.ok(shutdownBegin >= 0 && shutdownEnd > shutdownBegin);
const shutdown = source.slice(shutdownBegin, shutdownEnd);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const completeStartup = new AsyncFunction("context", `
  const { FRONTEND, SOURCE_ROOT, run, process, waitForHealth, loopback, PORTS,
    STARTUP_CHILD_HEALTH_TIMEOUT_MS, clearStartupTimeouts,
    attemptAntigravityProbePromotionAfterReadiness, antigravityStartup,
    children, console, path, loadPublisher, loadEvents, stopServiceChildren,
    clearStartupAttempts } = context;
  let shuttingDown = false;
  let startupReady = false;
  const automaticStartup = true;
  let stopNativeCatalogWatch = () => {};
  let frontendChild, shutdownPromise;
  const shutdownController = new AbortController();
  let nativeCatalogWatchStarted = false;
  const requiredServices = new Set();
  const executionPlan = { needsGateway: false };
  const gatewayStartupError = undefined;
  const SHUTDOWN_DRAIN_MS = 1, SHUTDOWN_FLUSH_MS = 1;
  ${publisher.replace('import("./native-catalog-drift.mjs")', "loadPublisher()")
    .replace('import("./native-catalog-events.mjs")', "loadEvents()")}
  ${shutdown}
  context.stopSupervisor = stopChildren;
  ${boundary}
  return { ready, startupReady };
`);

const PRIVATE_TIMEOUT = "CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS";
const GENERATION = "55555555-5555-4555-8555-555555555555";
const SESSION_GENERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function scenario({ pending = true, promotion = true, failure, healthFailure,
  shutdownDuringHealth = false, shutdownDuringLoad = false } = {}) {
  const env = { [PRIVATE_TIMEOUT]: "900000", KEEP_SETTING: "unchanged" };
  const events = [];
  const errors = [];
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  child.kill = (signal) => { child.signalCode = signal; child.emit("exit", null, signal); return true; };
  const context = {
    FRONTEND: { script: "router.mjs", service: "codex-router", label: "Codex router" },
    SOURCE_ROOT: "/unused-startup-fixture",
    run: () => child,
    process: { env, execPath: process.execPath },
    waitForHealth: async (_label, url) => {
      events.push(url.endsWith("/health/live") ? "frontend live" : "frontend healthy");
      if (url.endsWith("/health")) {
        if (shutdownDuringHealth) context.stopSupervisor();
        if (healthFailure) throw healthFailure;
      }
    },
    loopback: (_port, suffix = "") => `http://127.0.0.1${suffix}`,
    PORTS: { router: 1 },
    STARTUP_CHILD_HEALTH_TIMEOUT_MS: 30_000,
    clearStartupTimeouts: (environment) => {
      // Both the successful finalizer and unconditional initial cleanup invoke
      // the real idempotent helper. Record the actual transition only once.
      if (Object.hasOwn(environment, PRIVATE_TIMEOUT)) events.push("startup retired");
      return clearStartupTimeouts(environment);
    },
    clearStartupAttempts: () => {
      assert.deepEqual(env, { KEEP_SETTING: "unchanged" });
      events.push("cooldown cleared");
    },
    attemptAntigravityProbePromotionAfterReadiness: (options) =>
      attemptAntigravityProbePromotionAfterReadiness({
        ...options,
        promote: async (generation, sessionGeneration) => {
          assert.equal(generation, GENERATION);
          assert.equal(sessionGeneration, SESSION_GENERATION);
          events.push("activation started");
          const budget = startupTimeoutMs(PRIVATE_TIMEOUT, 15_000, env);
          // Model a 20 s cold ACL helper: it fits the opted-in startup allowance,
          // but exceeds the 15 s runtime default. Do not actually sleep or spawn.
          assert.ok(budget >= 20_000, `pending startup save lost its allowance: ${budget}ms`);
          await Promise.resolve();
          if (failure) throw failure;
          events.push(promotion ? "activation persisted" : "activation superseded");
          return promotion;
        },
      }),
    antigravityStartup: pending ? {
      pendingActivationGeneration: GENERATION,
      pendingSessionGeneration: SESSION_GENERATION,
    } : {},
    children: [child],
    stopServiceChildren,
    console: { error: (message) => { errors.push(message); } },
    path,
    loadEvents: async () => ({ subscribeNativeCatalogEvents: () => () => {} }),
    loadPublisher: async () => {
      events.push("publisher loaded");
      if (shutdownDuringLoad) context.stopSupervisor();
      const assertRuntime = () => {
        assert.deepEqual(env, { KEEP_SETTING: "unchanged" });
        assert.equal(startupTimeoutMs(PRIVATE_TIMEOUT, 15_000, env), 15_000);
      };
      return {
        watchNativeCatalog: ({ immediate } = {}) => {
          assertRuntime();
          events.push("watcher started");
          if (immediate) events.push("catalog published");
          return () => { events.push("watcher stopped"); };
        },
        republishOnNativeDrift: async () => {
          assertRuntime();
          events.push("catalog published");
        },
      };
    },
  };
  return {
    env, events, errors,
    complete: () => completeStartup(context),
    stop: () => context.stopSupervisor(),
  };
}

async function settlePublishers() {
  await Promise.resolve();
  await Promise.resolve();
}

test("pending activation retains its startup ACL allowance until persistence finishes", async () => {
  const fixture = scenario();
  await fixture.complete();
  await settlePublishers();
  assert.deepEqual(fixture.events, [
    "frontend live", "frontend healthy", "activation started", "activation persisted",
    "startup retired", "cooldown cleared", "publisher loaded", "watcher started", "catalog published",
  ]);
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.env, { KEEP_SETTING: "unchanged" });
});

test("superseded activation still retires startup settings before background publication", async () => {
  const fixture = scenario({ promotion: false });
  await fixture.complete();
  await settlePublishers();
  assert.deepEqual(fixture.events, [
    "frontend live", "frontend healthy", "activation started", "activation superseded",
    "startup retired", "cooldown cleared", "publisher loaded", "watcher started", "catalog published",
  ]);
  assert.equal(fixture.errors.length, 1);
  assert.match(fixture.errors[0], /route remains disabled/);
});

test("a fatal activation failure cannot start background publishers", async () => {
  const failure = new Error("planned activation persistence failure");
  const fixture = scenario({ failure });
  await assert.rejects(fixture.complete(), (error) => error === failure);
  await settlePublishers();
  assert.deepEqual(fixture.events, ["frontend live", "frontend healthy", "activation started"]);
  assert.deepEqual(fixture.errors, []);
});

test("startup without pending activation retires settings before publication", async () => {
  const fixture = scenario({ pending: false });
  await fixture.complete();
  await settlePublishers();
  assert.deepEqual(fixture.events, [
    "frontend live", "frontend healthy", "startup retired", "cooldown cleared", "publisher loaded", "watcher started", "catalog published",
  ]);
  assert.deepEqual(fixture.errors, []);
});

test("supervisor shutdown disposes its catalog watcher exactly once", async () => {
  const fixture = scenario({ pending: false });
  await fixture.complete();
  await settlePublishers();
  assert.ok(fixture.events.includes("watcher started"));
  fixture.stop();
  fixture.stop();
  assert.equal(fixture.events.filter((event) => event === "watcher stopped").length, 1);
});

test("shutdown while the publisher loads cannot start background maintenance", async () => {
  const fixture = scenario({ pending: false, shutdownDuringLoad: true });
  await fixture.complete();
  await settlePublishers();
  assert.deepEqual(fixture.events, [
    "frontend live", "frontend healthy", "startup retired", "cooldown cleared", "publisher loaded",
  ]);
  assert.deepEqual(fixture.errors, []);
});

test("degraded initial readiness retires startup settings without activating or publishing", async () => {
  const fixture = scenario({ healthFailure: new Error("selected dependency unavailable") });
  assert.deepEqual(await fixture.complete(), { ready: false, startupReady: false });
  await settlePublishers();
  assert.deepEqual(fixture.events, ["frontend live", "frontend healthy", "startup retired"]);
  assert.deepEqual(fixture.env, { KEEP_SETTING: "unchanged" });
  assert.equal(fixture.errors.length, 1);
  assert.match(fixture.errors[0], /dependency readiness unavailable: selected dependency unavailable/);
});

test("shutdown during aggregate readiness retires settings without activation or publication", async () => {
  const fixture = scenario({ shutdownDuringHealth: true });
  assert.deepEqual(await fixture.complete(), { ready: false, startupReady: false });
  await settlePublishers();
  assert.deepEqual(fixture.events, ["frontend live", "frontend healthy", "startup retired"]);
  assert.deepEqual(fixture.env, { KEEP_SETTING: "unchanged" });
  assert.deepEqual(fixture.errors, []);
});
