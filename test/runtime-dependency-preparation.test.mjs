import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { prepareRuntimeDependencies, prepareRuntimeDependenciesFresh,
  runtimeDependencyInstallInvocation } from "../src/runtime-dependency-preparation.mjs";

test("native and direct Responses plans never probe or install unused Python", async () => {
  const calls = [];
  const result = await prepareRuntimeDependencies({
    requirements: () => ({ needsGateway: false }),
    stepStatus: (step) => { calls.push(step); assert.equal(step, "node-deps"); return "skip"; },
    run: async () => assert.fail("matching Node and unused Python must not invoke an installer"),
  });
  assert.deepEqual(calls, ["node-deps"]);
  assert.deepEqual(result, { prepared: true, installed: false, needsGateway: false });
});

test("a ready translated plan does not reinstall matching dependency trees", async () => {
  const calls = [];
  const result = await prepareRuntimeDependencies({
    requirements: () => ({ needsGateway: true }),
    stepStatus: (step) => { calls.push(step); return "skip"; },
    run: async () => assert.fail("ready runtime must not reinstall"),
  });
  assert.deepEqual(calls, ["node-deps", "python-deps"]);
  assert.equal(result.installed, false);
});

test("first translated activation prepares missing Python before adoption", async () => {
  let installed = false;
  let invocation;
  const result = await prepareRuntimeDependencies({
    environment: {}, sourceRoot: "/synthetic/router", platform: "linux",
    requirements: () => ({ needsGateway: true }),
    stepStatus: (step) => step === "node-deps" || installed ? "skip" : "run",
    run: async (command, args, options) => {
      invocation = { command, args, options };
      installed = true;
      return { status: 0 };
    },
  });
  assert.equal(invocation.command, "sh");
  assert.deepEqual(invocation.args, [path.join("/synthetic/router", "bin", "install"), "--dependencies-only"]);
  assert.equal(invocation.options.env.MODEL_ROUTER_TARGET, "codex");
  assert.ok(Number.isSafeInteger(invocation.options.deadline));
  assert.equal(invocation.options.windowsHide, true);
  assert.deepEqual(result, { prepared: true, installed: true, needsGateway: true });
});

test("missing Node repairs before importing route requirements and leaves unused Python alone", async () => {
  let installed = false;
  const events = [];
  await prepareRuntimeDependencies({
    requirements: () => { assert.equal(installed, true); events.push("requirements"); return { needsGateway: false }; },
    stepStatus: (step) => { assert.equal(step, "node-deps"); events.push(step); return installed ? "skip" : "run"; },
    run: async () => { events.push("install"); installed = true; return { status: 0 }; },
  });
  assert.deepEqual(events, ["node-deps", "install", "node-deps", "requirements"]);
});

test("installer failure or unchanged required stamps never become a ready result", async () => {
  await assert.rejects(prepareRuntimeDependencies({
    requirements: () => ({ needsGateway: true }),
    stepStatus: () => "run",
    run: async () => ({ status: 1, stderr: "SYNTHETIC_SECRET_DO_NOT_RELAY" }),
  }), (error) => /could not be prepared/.test(error.message) && !error.message.includes("SYNTHETIC_SECRET"));
  await assert.rejects(prepareRuntimeDependencies({
    requirements: () => ({ needsGateway: true }),
    stepStatus: (step) => step === "node-deps" ? "skip" : "run",
    run: async () => ({ status: 0 }),
  }), /gateway dependencies are still missing/);
});

test("ambiguous dependency metadata and cancellation fail before installation", async () => {
  await assert.rejects(prepareRuntimeDependencies({ stepStatus: () => "unknown",
    run: async () => assert.fail("unknown readiness cannot install blindly") }), /readiness could not be verified/);
  await assert.rejects(prepareRuntimeDependencies({ stepStatus: () => "skip", requirements: () => ({}),
    run: async () => assert.fail("unknown requirements cannot install blindly") }), /requirements could not be verified/);
  const aborted = new AbortController();
  aborted.abort(new Error("synthetic dependency cancellation"));
  await assert.rejects(prepareRuntimeDependencies({ signal: aborted.signal,
    stepStatus: () => assert.fail("aborted preparation cannot inspect runtime"),
  }), /synthetic dependency cancellation/);
});

test("Windows dependency preparation uses a hidden noninteractive checkout-only installer", () => {
  const invocation = runtimeDependencyInstallInvocation({ platform: "win32", sourceRoot: "C:\\synthetic\\router",
    environment: { SystemRoot: "C:\\Windows" } });
  assert.equal(invocation.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.ok(invocation.args.includes("-NonInteractive"));
  assert.deepEqual(invocation.args.slice(-4), ["-CheckoutInstall", "-DependenciesOnly", "-Target", "codex"]);
  assert.equal(invocation.args.includes("-ForceDeps"), false);
});

test("fresh dependency preparation preserves bounded owner cleanup and validates its result", async () => {
  let invocation;
  const deadline = Date.now() + 60_000;
  const result = await prepareRuntimeDependenciesFresh({ executable: "/runtime/node", sourceRoot: "/synthetic/router",
    environment: {}, deadline,
    run: async (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: '{"prepared":true,"installed":false,"needsGateway":false}\n' };
    },
  });
  assert.equal(invocation.command, "/runtime/node");
  assert.equal(invocation.args[1], "--prepare-in-fresh-process");
  assert.equal(invocation.options.deadline, deadline);
  assert.equal(invocation.options.env.CODEX_ROUTER_OPERATION_DEADLINE_MS, String(deadline - 10_000));
  assert.deepEqual(result, { prepared: true, installed: false, needsGateway: false });
  await assert.rejects(prepareRuntimeDependenciesFresh({
    run: async () => ({ status: 0, stdout: '{"prepared":true}\n' }),
  }), /invalid result/);
});
