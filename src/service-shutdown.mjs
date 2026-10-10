// One supervisor owns this stable array. Never infer ownership from a PID or
// from a listener on a port; only its already-verified child handles belong here.
const shutdowns = new WeakMap();
const EXIT_MARGIN_MS = 1_000;
const MAX_TIMER_MS = 2_147_483_647;

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function observeExit(child, label, { signal }) {
  if (hasExited(child)) return Promise.resolve({ label, code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const clean = () => {
      child.off("exit", exited);
      child.off("close", exited);
      child.off("error", spawnFailed);
      signal.removeEventListener("abort", abort);
    };
    const exited = (code, exitSignal) => {
      clean();
      resolve({ label, code, signal: exitSignal });
    };
    const spawnFailed = () => {
      // A failed spawn has no process to drain and may emit close without exit.
      // An error on a running process is not proof that it has exited.
      if (child.pid === undefined) exited(child.exitCode, child.signalCode);
    };
    const abort = () => {
      clean();
      reject(new Error("Shutdown exit observation ended"));
    };
    child.once("exit", exited);
    child.once("close", exited);
    child.on("error", spawnFailed);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else if (hasExited(child)) exited(child.exitCode, child.signalCode);
  });
}

/**
 * Stop owned children in dependency order. The frontend gets drain+flush+1s
 * before downstream services receive shutdown; each phase is bounded, and an
 * absolute backstop is installed at 2*(drain+flush)+2s from the first call.
 *
 * Calls with the same stable children array share one Promise. The caller must
 * stop spawning children before calling. An injected waitForExit receives
 * (child, "child", { signal }); it may use the signal to retire its listeners.
 *
 * { timedOut, forced } describes the shutdown attempt, not proof that an OS
 * process disappeared. Even an uncooperative exit waiter cannot hold the
 * Promise past the backstop. On Windows, graceful shutdown requires the owned
 * Node child's IPC handler; ChildProcess.kill("SIGTERM") itself is abrupt.
 */
export function stopServiceChildren({
  frontend,
  children,
  drainMs = 0,
  flushMs = 0,
  signalChild,
  waitForExit = observeExit,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!Array.isArray(children)) throw new TypeError("children must be the supervisor's owned child array");
  const previous = shutdowns.get(children);
  if (previous) return previous;
  const owned = [...new Set(children)];
  if (owned.some((child) => !child || typeof child.kill !== "function")) {
    throw new TypeError("children must contain owned ChildProcess handles");
  }
  if (frontend !== undefined && !owned.includes(frontend)) {
    throw new TypeError("frontend must belong to the owned children array");
  }
  if (![drainMs, flushMs].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
    throw new TypeError("shutdown drainMs and flushMs must be finite nonnegative numbers");
  }
  const phaseMs = drainMs + flushMs + EXIT_MARGIN_MS;
  if (2 * phaseMs > MAX_TIMER_MS) throw new RangeError("shutdown budget exceeds the timer limit");
  if (typeof waitForExit !== "function" || typeof setTimer !== "function" || typeof clearTimer !== "function" ||
    (signalChild !== undefined && typeof signalChild !== "function")) {
    throw new TypeError("shutdown callbacks must be functions");
  }

  let resolveShutdown;
  const promise = new Promise((resolve) => { resolveShutdown = resolve; });
  shutdowns.set(children, promise);
  const live = new Set(owned.filter((child) => !hasExited(child)));
  const sent = new Map(owned.map((child) => [child, new Set()]));
  const timers = new Set();
  const observation = new AbortController();
  let finished = false;
  let dependenciesStarted = false;
  let frontendTimer;
  let timedOut = false;
  let forced = false;

  const cancelTimer = (timer) => {
    if (!timers.delete(timer)) return;
    clearTimer(timer);
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const timer of [...timers]) cancelTimer(timer);
    observation.abort();
    live.clear();
    resolveShutdown({ timedOut, forced });
  };
  const schedule = (callback, duration) => {
    const timer = setTimer(() => {
      timers.delete(timer);
      if (!finished) callback();
    }, duration);
    timers.add(timer);
    return timer;
  };
  const signalOwned = (child, signal) => {
    if (finished || !live.has(child) || hasExited(child) || sent.get(child).has(signal)) return;
    sent.get(child).add(signal);
    if (signal === "SIGKILL") forced = true;
    if (signalChild) {
      try { Promise.resolve(signalChild(child, signal)).catch(() => {}); } catch { /* The bounded backstop still applies. */ }
      return;
    }
    if (signal === "SIGTERM" && child.connected && typeof child.send === "function") {
      // IPC invokes the same drain handler on Windows; SIGTERM alone forcibly
      // terminates a Node child there. A failed IPC send retains kill fallback.
      let answered = false;
      const sentMessage = (error) => {
        if (answered) return;
        answered = true;
        if (!error || finished || !live.has(child) || hasExited(child)) return;
        try { child.kill(signal); } catch { /* Reaped or still bounded by the backstop. */ }
      };
      try { child.send({ type: "model-router:shutdown" }, sentMessage); } catch (error) { sentMessage(error); }
      return;
    }
    try { child.kill(signal); } catch { /* Reaped or still bounded by the backstop. */ }
  };
  const forceRemaining = () => {
    timedOut = true;
    for (const child of live) signalOwned(child, "SIGKILL");
    finish();
  };
  const stopDependencies = () => {
    if (finished || dependenciesStarted) return;
    dependenciesStarted = true;
    cancelTimer(frontendTimer);
    for (const child of owned) if (child !== frontend) signalOwned(child, "SIGTERM");
    if (!live.size) finish();
    else schedule(forceRemaining, phaseMs);
  };
  const exited = (child) => {
    if (finished || !live.delete(child)) return;
    if (!live.size) finish();
    else if (child === frontend) stopDependencies();
  };

  if (!live.size) {
    finish();
    return promise;
  }
  schedule(forceRemaining, 2 * phaseMs);
  // Register every observer before signaling, including a child whose kill or
  // IPC handler exits synchronously. Rejected waiters never certify an exit.
  for (const child of live) {
    try {
      Promise.resolve(waitForExit(child, "child", { signal: observation.signal })).then(
        () => exited(child), () => {},
      );
    } catch { /* A broken observer cannot remove the owned-child backstop. */ }
  }
  if (frontend && live.has(frontend)) {
    frontendTimer = schedule(() => {
      timedOut = true;
      signalOwned(frontend, "SIGKILL");
      stopDependencies();
    }, phaseMs);
    signalOwned(frontend, "SIGTERM");
  } else stopDependencies();
  return promise;
}
