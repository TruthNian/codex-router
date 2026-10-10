import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { stopServiceChildren } from "../src/service-shutdown.mjs";

const drainMs = 20;
const flushMs = 5;
const phaseMs = 1_025;
const absoluteMs = 2_050;
const flushPromises = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

function clock() {
  let now = 0;
  let serial = 0;
  const pending = new Map();
  const created = [];
  const cleared = [];
  return {
    created,
    cleared,
    now: () => now,
    pending: () => pending.size,
    setTimer(callback, delay) {
      const timer = { id: ++serial, at: now + delay, callback };
      created.push(timer);
      pending.set(timer.id, timer);
      return timer;
    },
    clearTimer(timer) { cleared.push(timer.id); pending.delete(timer.id); },
    async advance(duration) {
      const target = now + duration;
      await flushPromises();
      for (;;) {
        const next = [...pending.values()].filter((timer) => timer.at <= target)
          .sort((left, right) => left.at - right.at || left.id - right.id)[0];
        if (!next) break;
        now = next.at;
        pending.delete(next.id);
        next.callback();
        await flushPromises();
      }
      now = target;
      await flushPromises();
    },
    suspend(timer) { pending.delete(timer.id); },
  };
}

let fakePid = 100;
class Child extends EventEmitter {
  constructor(name, calls) {
    super();
    this.name = name;
    this.calls = calls;
    this.pid = ++fakePid;
    this.exitCode = null;
    this.signalCode = null;
    this.connected = false;
    this.messages = [];
    this.sendCallbacks = [];
  }
  kill(signal) {
    this.calls.push(`${this.name}:${signal}`);
    return true;
  }
  send(message, callback) {
    this.messages.push(message);
    this.sendCallbacks.push(callback);
    this.calls.push(`${this.name}:IPC`);
    return true;
  }
  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.connected = false;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

function harness(names = ["frontend", "forwarder", "gateway"]) {
  const timers = clock();
  const calls = [];
  const children = names.map((name) => new Child(name, calls));
  const options = { frontend: children[0], children, drainMs, flushMs,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer };
  return { timers, calls, children, options };
}

function noListeners(children) {
  for (const child of children) {
    assert.equal(child.listenerCount("exit"), 0, child.name);
    assert.equal(child.listenerCount("close"), 0, child.name);
    assert.equal(child.listenerCount("error"), 0, child.name);
  }
}

test("frontend drains before dependencies receive any stop signal", async () => {
  const h = harness();
  const stop = stopServiceChildren(h.options);
  assert.deepEqual(h.calls, ["frontend:SIGTERM"]);
  await h.timers.advance(100);
  assert.deepEqual(h.calls, ["frontend:SIGTERM"], "downstream calls must remain possible during the drain");
  h.children[0].exit();
  await flushPromises();
  assert.deepEqual(h.calls, ["frontend:SIGTERM", "forwarder:SIGTERM", "gateway:SIGTERM"]);
  h.children[1].exit();
  h.children[2].exit();
  assert.deepEqual(await stop, { timedOut: false, forced: false });
  assert.equal(h.timers.pending(), 0);
  noListeners(h.children);
  await h.timers.advance(absoluteMs);
  assert.equal(h.calls.length, 3, "cleared backstops must never signal again");
});

test("synchronous exits during signaling preserve dependency order and clear every timer", async () => {
  const h = harness();
  for (const child of h.children) {
    child.kill = (signal) => { h.calls.push(`${child.name}:${signal}`); child.exit(); return true; };
  }
  assert.deepEqual(await stopServiceChildren(h.options), { timedOut: false, forced: false });
  assert.deepEqual(h.calls, ["frontend:SIGTERM", "forwarder:SIGTERM", "gateway:SIGTERM"]);
  assert.equal(h.timers.pending(), 0);
  noListeners(h.children);
});

test("an already exited frontend and a startup failure without a frontend stop dependencies immediately", async () => {
  for (const mode of ["already-exited", "not-started"]) {
    const h = harness();
    if (mode === "already-exited") h.children[0].exit();
    else { h.options.frontend = undefined; h.options.children = h.children.slice(1); }
    const stop = stopServiceChildren(h.options);
    assert.deepEqual(h.calls, ["forwarder:SIGTERM", "gateway:SIGTERM"]);
    h.children[1].exit();
    h.children[2].exit();
    assert.deepEqual(await stop, { timedOut: false, forced: false });
    assert.equal(h.timers.pending(), 0);
    noListeners(h.children);
  }
});

test("no children or only reaped children complete without timers or signals", async () => {
  for (const children of [[], [Object.assign(new Child("reaped", []), { exitCode: 0 })]]) {
    const timers = clock();
    const stop = stopServiceChildren({ children, drainMs, flushMs, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    assert.deepEqual(await stop, { timedOut: false, forced: false });
    assert.equal(timers.created.length, 0);
    assert.equal(timers.pending(), 0);
    noListeners(children);
  }
});

test("hung frontend and dependency waiters cannot extend the absolute deadline", async () => {
  const h = harness(["frontend", "dependency"]);
  let settled = false;
  const stop = stopServiceChildren({ ...h.options, waitForExit: () => new Promise(() => {}) });
  stop.then(() => { settled = true; });
  await h.timers.advance(phaseMs - 1);
  assert.deepEqual(h.calls, ["frontend:SIGTERM"]);
  assert.equal(settled, false);
  await h.timers.advance(1);
  assert.deepEqual(h.calls, ["frontend:SIGTERM", "frontend:SIGKILL", "dependency:SIGTERM"]);
  await h.timers.advance(phaseMs - 1);
  assert.equal(settled, false);
  await h.timers.advance(1);
  assert.deepEqual(await stop, { timedOut: true, forced: true });
  assert.equal(h.timers.now(), absoluteMs);
  assert.deepEqual(h.calls, ["frontend:SIGTERM", "frontend:SIGKILL", "dependency:SIGTERM", "dependency:SIGKILL"]);
  assert.equal(h.timers.pending(), 0);
});

test("the absolute backstop still works if a phase callback never progresses", async () => {
  const h = harness(["frontend", "dependency"]);
  const stop = stopServiceChildren({ ...h.options, waitForExit: () => new Promise(() => {}) });
  assert.deepEqual(h.timers.created.map((timer) => timer.at), [absoluteMs, phaseMs]);
  h.timers.suspend(h.timers.created[1]);
  await h.timers.advance(absoluteMs);
  assert.deepEqual(await stop, { timedOut: true, forced: true });
  assert.deepEqual(h.calls, ["frontend:SIGTERM", "frontend:SIGKILL", "dependency:SIGKILL"]);
  assert.equal(h.timers.pending(), 0);
  assert.ok(h.timers.cleared.includes(h.timers.created[1].id));
});

test("injected exit observations are canceled and late resolutions cannot restart shutdown", async () => {
  const h = harness(["frontend", "dependency"]);
  const observers = [];
  const stop = stopServiceChildren({ ...h.options, waitForExit(child, label, { signal }) {
    return new Promise((resolve) => observers.push({ child, label, signal, resolve }));
  } });
  assert.deepEqual(observers.map(({ label }) => label), ["child", "child"]);
  await h.timers.advance(absoluteMs);
  assert.deepEqual(await stop, { timedOut: true, forced: true });
  assert.ok(observers.every(({ signal }) => signal.aborted));
  const stoppedCalls = [...h.calls];
  for (const observer of observers) observer.resolve();
  await flushPromises();
  await h.timers.advance(absoluteMs);
  assert.deepEqual(h.calls, stoppedCalls);
  assert.equal(h.timers.pending(), 0);
});

test("a hung dependency gets its own bounded phase and cleaned exit listeners", async () => {
  const h = harness(["frontend", "dependency"]);
  const stop = stopServiceChildren(h.options);
  await h.timers.advance(10);
  h.children[0].exit();
  await flushPromises();
  await h.timers.advance(phaseMs);
  assert.deepEqual(await stop, { timedOut: true, forced: true });
  assert.equal(h.timers.now(), 10 + phaseMs);
  assert.deepEqual(h.calls, ["frontend:SIGTERM", "dependency:SIGTERM", "dependency:SIGKILL"]);
  assert.equal(h.timers.pending(), 0);
  noListeners(h.children);
  h.children[1].exit();
  await h.timers.advance(absoluteMs);
  assert.equal(h.calls.length, 3);
});

test("stop is idempotent, deduplicates handles, and captures no later foreign child", async () => {
  const h = harness(["frontend", "dependency"]);
  h.options.children.push(h.children[1]);
  const stop = stopServiceChildren(h.options);
  assert.equal(stopServiceChildren(h.options), stop);
  const foreign = new Child("foreign", h.calls);
  h.options.children.push(foreign);
  assert.equal(stopServiceChildren(h.options), stop);
  await h.timers.advance(absoluteMs);
  assert.deepEqual(await stop, { timedOut: true, forced: true });
  assert.deepEqual(h.calls, ["frontend:SIGTERM", "frontend:SIGKILL", "dependency:SIGTERM", "dependency:SIGKILL"]);
  assert.equal(stopServiceChildren(h.options), stop);
  assert.equal(foreign.listenerCount("exit"), 0);
  assert.equal(h.timers.pending(), 0);
});

test("IPC stops connected Node children without abrupt SIGTERM and ignores duplicate acknowledgments", async () => {
  const h = harness(["frontend", "dependency"]);
  for (const child of h.children) child.connected = true;
  const stop = stopServiceChildren(h.options);
  assert.deepEqual(h.calls, ["frontend:IPC"]);
  assert.deepEqual(h.children[0].messages, [{ type: "model-router:shutdown" }]);
  h.children[0].sendCallbacks[0](null);
  h.children[0].sendCallbacks[0](new Error("duplicate callback"));
  assert.deepEqual(h.calls, ["frontend:IPC"]);
  h.children[0].exit();
  await flushPromises();
  assert.deepEqual(h.calls, ["frontend:IPC", "dependency:IPC"]);
  assert.deepEqual(h.children[1].messages, [{ type: "model-router:shutdown" }]);
  h.children[1].sendCallbacks[0](null);
  h.children[1].exit();
  assert.deepEqual(await stop, { timedOut: false, forced: false });
  assert.equal(h.timers.pending(), 0);
  noListeners(h.children);
});

test("IPC failure falls back once, including thrown sends, while late callbacks never kill an exited child", async () => {
  for (const mode of ["callback-error", "throw", "after-exit"]) {
    const h = harness(["frontend"]);
    const child = h.children[0];
    child.connected = true;
    if (mode === "throw") {
      child.send = (_message, callback) => {
        child.sendCallbacks.push(callback);
        h.calls.push("frontend:IPC");
        throw new Error("send failed");
      };
    }
    const stop = stopServiceChildren(h.options);
    if (mode === "after-exit") child.exit();
    child.sendCallbacks[0](new Error("send failed"));
    child.sendCallbacks[0](new Error("duplicate failure"));
    assert.deepEqual(h.calls, mode === "after-exit" ? ["frontend:IPC"] : ["frontend:IPC", "frontend:SIGTERM"]);
    child.exit();
    assert.deepEqual(await stop, { timedOut: false, forced: false });
    child.sendCallbacks[0](new Error("after shutdown"));
    assert.equal(h.calls.length, mode === "after-exit" ? 1 : 2);
    assert.equal(h.timers.pending(), 0);
    noListeners(h.children);
  }
});

test("IPC failure arriving after the backstop cannot add another signal to an unconfirmed child", async () => {
  const h = harness(["frontend"]);
  h.children[0].connected = true;
  const stop = stopServiceChildren(h.options);
  await h.timers.advance(absoluteMs);
  assert.deepEqual(await stop, { timedOut: true, forced: true });
  assert.deepEqual(h.calls, ["frontend:IPC", "frontend:SIGKILL"]);
  h.children[0].sendCallbacks[0](new Error("late IPC failure"));
  h.children[0].sendCallbacks[0](new Error("duplicate late failure"));
  assert.deepEqual(h.calls, ["frontend:IPC", "frontend:SIGKILL"]);
  assert.equal(h.timers.pending(), 0);
  noListeners(h.children);
});

test("throwing signal callbacks and rejected exit observers still settle within the backstop", async () => {
  for (const waitForExit of [() => { throw new Error("observer failed"); }, () => Promise.reject(new Error("observer rejected"))]) {
    const h = harness(["frontend", "dependency"]);
    const stop = stopServiceChildren({ ...h.options, waitForExit,
      signalChild(child, signal) { h.calls.push(`${child.name}:${signal}`); throw new Error("signal failed"); } });
    await h.timers.advance(absoluteMs);
    assert.deepEqual(await stop, { timedOut: true, forced: true });
    assert.deepEqual(h.calls, ["frontend:SIGTERM", "frontend:SIGKILL", "dependency:SIGTERM", "dependency:SIGKILL"]);
    assert.equal(h.timers.pending(), 0);
  }
});

test("failed spawns are observed without exit and are never mistaken for a running process error", async () => {
  const h = harness(["frontend"]);
  h.children[0].pid = undefined;
  const stop = stopServiceChildren(h.options);
  h.children[0].emit("error", new Error("spawn ENOENT"));
  assert.deepEqual(await stop, { timedOut: false, forced: false });
  assert.equal(h.timers.pending(), 0);
  noListeners(h.children);

  const running = harness(["frontend"]);
  const runningStop = stopServiceChildren(running.options);
  running.children[0].emit("error", new Error("running process error"));
  await running.timers.advance(phaseMs - 1);
  assert.deepEqual(running.calls, ["frontend:SIGTERM"]);
  running.children[0].exit();
  assert.deepEqual(await runningStop, { timedOut: false, forced: false });
  assert.equal(running.timers.pending(), 0);
});

test("foreign frontend handles and invalid budgets are rejected before any signal or timer", () => {
  const h = harness(["owned"]);
  const foreign = new Child("foreign", h.calls);
  assert.throws(() => stopServiceChildren({ ...h.options, frontend: foreign }), /must belong to the owned/);
  for (const bad of [-1, Infinity, NaN, "20"]) {
    assert.throws(() => stopServiceChildren({ ...h.options, drainMs: bad }), /finite nonnegative/);
  }
  assert.throws(() => stopServiceChildren({ ...h.options, drainMs: 2_147_483_647 }), /timer limit/);
  assert.throws(() => stopServiceChildren({ children: [123] }), /ChildProcess handles/);
  assert.throws(() => stopServiceChildren({ children: new Set() }), /owned child array/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.created.length, 0);
});
