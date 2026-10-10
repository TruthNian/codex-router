import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";

import { assertCallerSecret } from "./caller-auth.mjs";
import {
  CALLER_SECRET_PATH,
  CURSOR_CATALOG_PATH,
  INTERNAL_SECRET_PATH,
  LITELLM_CONFIG_PATH,
  MERGED_CATALOG_PATH,
  PORTS,
  PROVIDER_SELECTION_PATH,
  SOURCE_ROOT,
  STATE_DIR,
  TARGET,
  loopback,
} from "./paths.mjs";
import { SHUTDOWN_DRAIN_MS, SHUTDOWN_FLUSH_MS } from "./http-utils.mjs";
import { clearStartupTimeouts, runtimeChildEnvironment, startupTimeoutMs } from "./startup-timeout.mjs";
import { waitForHealth as pollHealth } from "./health-probe.mjs";
import { describeChildExit, fatalExitFollowUp } from "./fatal-exit.mjs";
import { gatewaySupervisorLimits, superviseGateway } from "./gateway-supervisor.mjs";
import { stopServiceChildren } from "./service-shutdown.mjs";
import { writeLiteLlmConfig } from "./litellm-config.mjs";
import { MODELS, RUNTIME_PROVIDERS, providerForModel } from "./model-registry.mjs";
import { createExecutionPlan } from "./route-execution-plan.mjs";
import { antigravityOAuthStartupState } from "./antigravity-oauth-status.mjs";
import { attemptAntigravityProbePromotionAfterReadiness } from "./antigravity-probe-activation.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";
import { ensureOllamaHeadless } from "./ollama-runtime.mjs";
import { venvRuntimeOutcome } from "./venv-runtime.mjs";
import { dependencyRepairHint } from "./dependency-repair.mjs";
import {
  clearServiceProcessState,
  isForegroundSupervisor,
  shouldRecordServiceProcess,
  writeServiceProcessState,
} from "./service-process.mjs";
import {
  STARTUP_BACKOFF_EXIT_CODE,
  clearStartupAttempts,
  readStartupAttempts,
  recordStartupFailure,
  startupBackoffDisabled,
  startupBackoffRemainingMs,
} from "./startup-attempts.mjs";
import {
  environmentProxyOptedIn,
  inheritedProxyEnvironment,
  redactProxyCredentials,
} from "./proxy-environment.mjs";
import { antigravityOAuthStatus } from "./antigravity-oauth-status.mjs";
import { cursorTunnelRunSpec } from "./cursor-cloudflare-tunnel.mjs";
import { readProviderSelection } from "./provider-selection.mjs";

// The foreground entry marks itself before importing this module. Direct
// start.mjs remains the OS payload; only it consumes managed retry state.
const automaticStartup = !isForegroundSupervisor();
let startupReady = false;
if (automaticStartup && !startupBackoffDisabled()) {
  const backoffRecord = readStartupAttempts();
  const backoffRemaining = startupBackoffRemainingMs(backoffRecord);
  if (backoffRemaining > 0) {
    // Written synchronously on purpose: process.exit() does not flush an
    // asynchronous stream, and this message is the entire point of the exit.
    writeSync(
      2,
      `[model-router] backing off for another ${Math.ceil(backoffRemaining / 1000)}s after ` +
        `${backoffRecord?.consecutiveFailures ?? 0} consecutive failed start(s); ` +
        "`service restart` clears this, and CODEX_ROUTER_DISABLE_STARTUP_BACKOFF=1 bypasses it.\n",
    );
    process.exit(STARTUP_BACKOFF_EXIT_CODE);
  }
}

// Before anything reads the environment or spawns a child. A service manager
// hands this process the proxy the install recorded; a shell hands it whatever
// the shell had, which for a desktop-app-spawned shell is nothing. Restoring
// the recorded values here makes every start path -- managed, foreground, or
// accidental -- reach upstreams the same way, and `commonEnv` below propagates
// them to the router and the forwarders through `process.env`.
const restoredProxy = inheritedProxyEnvironment();
for (const [name, value] of Object.entries(restoredProxy)) {
  process.env[name] = value;
}
// Unconditionally, and never behind MODEL_ROUTER_QUIET: this silently changes
// where every upstream request goes, and the whole reason the original failure
// took so long to find is that nothing near the router ever said which network
// path it was using. A managed start never reaches here -- its environment is
// declared -- so this line appears only on the paths that need it. The
// credential in a proxy URL is stripped; the host and port are the point.
if (Object.keys(restoredProxy).length > 0) {
  const address = restoredProxy.https_proxy ?? restoredProxy.HTTPS_PROXY
    ?? restoredProxy.http_proxy ?? restoredProxy.HTTP_PROXY;
  const shown = redactProxyCredentials({ address }).address;
  console.error(
    "[model-router] no proxy environment was inherited; restored the installed one" +
    `${shown ? ` (${shown})` : ""} from the install manifest.`,
  );
}

const dependencyFix = dependencyRepairHint();

const selectedProviders = new Set(readProviderSelection());
// A pending explicit probe needs its listener even before provider selection.
// A verified but unselected account still contributes no ordinary route.
const antigravityStartup = antigravityOAuthStartupState();
const executionPlan = createExecutionPlan({
  models: MODELS,
  providerForModel,
  routeEnabled: (model) => RUNTIME_PROVIDERS.get(model.provider)?.generic === true
    || selectedProviders.has(model.provider),
  pendingAntigravity: Boolean(antigravityStartup.pendingActivationGeneration),
});
const requiredServices = new Set(executionPlan.services);
let gatewayStartupError;

const litellm =
  process.env.MODEL_ROUTER_LITELLM_BIN ||
  (TARGET === "codex"
    ? process.env.CODEX_ROUTER_LITELLM_BIN || process.env.KIMI_LITELLM_BIN
    : undefined) ||
  path.join(
    SOURCE_ROOT,
    ".venv",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "litellm.exe" : "litellm",
  );
if (executionPlan.needsGateway && !existsSync(litellm)) {
  gatewayStartupError = new Error(`LiteLLM is not installed at ${litellm}. ${dependencyFix}.`);
}

// A launcher file that exists on disk is not proof the venv works: an
// interpreter home pointing at a cleared temporary directory (macOS wipes
// /private/tmp, and an installer that recorded a temporary Python as the venv
// home leaves `.venv/bin/python` dangling) makes every spawn fail with ENOENT
// while the launcher itself is still present. Probe the interpreter
// explicitly so a broken venv fails here with a readable message and a fix
// path instead of feeding launchd's restart loop an unreadable crash.
// The probe applies only to the bundled venv: a custom launcher
// (MODEL_ROUTER_LITELLM_BIN or a codex-target alias) may deliberately ship
// without the bundled `.venv`, and CI exercises startup with
// MODEL_ROUTER_LITELLM_BIN=process.execPath on a fresh checkout that has no
// venv at all.
const usesBundledVenv = !process.env.MODEL_ROUTER_LITELLM_BIN &&
  !(TARGET === "codex" &&
    (process.env.CODEX_ROUTER_LITELLM_BIN || process.env.KIMI_LITELLM_BIN));
if (executionPlan.needsGateway && !gatewayStartupError && usesBundledVenv) {
  const venvPython = path.join(
    SOURCE_ROOT,
    ".venv",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  );
  const venvOutcome = venvRuntimeOutcome(venvPython);
  if (venvOutcome.kind === "timeout") {
    console.warn(`The LiteLLM virtual environment probe did not finish (${venvOutcome.message}); continuing with the bounded gateway readiness check.`);
  } else if (venvOutcome.kind !== "ok") {
    gatewayStartupError = new Error(
      `The LiteLLM virtual environment is broken at ${venvPython} (${venvOutcome.message}). ` +
        `${dependencyFix}.`,
    );
  }
}
if (!existsSync(INTERNAL_SECRET_PATH)) {
  throw new Error(`Internal service key is missing; run ./bin/install.`);
}
if (!existsSync(CALLER_SECRET_PATH)) {
  throw new Error(`Router caller key is missing; run ./bin/install.`);
}
const internalKey = readFileSync(INTERNAL_SECRET_PATH, "utf8").trim();
if (!internalKey) throw new Error("Internal service key is empty.");
const callerKey = assertCallerSecret(
  readFileSync(CALLER_SECRET_PATH, "utf8").trim(),
);
if (executionPlan.needsGateway) writeLiteLlmConfig();

// Missing credentials are an actionable route error, not permission to erase
// an operator's selection. The client catalog still applies credential gates.

// A checked local model means the operator intends to route through Ollama,
// so keep its daemon available for the gateway. This never installs software
// or pulls a model during service startup; a missing runtime remains a doctor
// warning, while a present runtime is started as a detached, headless server.
if (requiredServices.has("ollama")) {
  try {
    await ensureOllamaHeadless({ install: false });
  } catch (error) {
    console.error(`Local Ollama is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Same rule, one layer up: a curated model is what gives a provider a gateway
// route, so it is also what makes that provider's own forwarder worth a
// process and a port. `writeLiteLlmConfig()` above emits the
// `DEVIN_CLI_FORWARD_BASE_URL` route from this same MODELS array on this same
// boot, so the route and the listener cannot disagree -- no curated Devin
// model means no route to the port and nothing bound to it. Devin ships
// catalog-only (`bin/curate-models devin-cli`), so an operator who never asked
// for it pays nothing: no fourth child, no fourth port, no fourth health wait.
//
// The stored credential is deliberately *not* the gate. Someone who curated a
// model but has not run `devin auth login` should get the forwarder's 401
// naming that command, not a bare connection error from a port nobody is
// listening on.
const cursorInstalled = existsSync(CURSOR_CATALOG_PATH);

const commonEnv = {
  MODEL_ROUTER_EXECUTION_PLAN_FINGERPRINT: executionPlan.fingerprint,
  MODEL_ROUTER_PENDING_ANTIGRAVITY: antigravityStartup.pendingActivationGeneration ? "1" : "0",
  MODEL_ROUTER_TARGET: TARGET,
  MODEL_ROUTER_STATE_DIR: STATE_DIR,
  MODEL_ROUTER_CALLER_KEY: callerKey,
  MODEL_ROUTER_INTERNAL_KEY: internalKey,
  MODEL_ROUTER_GATEWAY_BASE_URL: loopback(PORTS.gateway, "/v1"),
  MODEL_ROUTER_OAUTH_HEALTH_URL: loopback(PORTS.oauth, "/health"),
  MODEL_ROUTER_API_HEALTH_URL: loopback(PORTS.api, "/health"),
  MODEL_ROUTER_GATEWAY_HEALTH_URL: loopback(PORTS.gateway, "/health/liveliness"),
  MODEL_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
  // LiteLLM's ollama_chat provider talks to the daemon root, not the
  // OpenAI-compatible /v1 surface the bridge uses for inference.
  MODEL_ROUTER_LOCAL_BASE_URL_ROOT:
    (process.env.MODEL_ROUTER_LOCAL_BASE_URL || "http://127.0.0.1:11434/v1").replace(/\/v1\/?$/, ""),
  MODEL_ROUTER_OAUTH_PORT: String(PORTS.oauth),
  MODEL_ROUTER_API_PORT: String(PORTS.api),
  MODEL_ROUTER_PORT: String(PORTS.router),
  MODEL_ROUTER_GROK_OAUTH_PORT: String(PORTS.grokOauth),
  GROK_OAUTH_FORWARD_BASE_URL: loopback(PORTS.grokOauth, "/v1"),
  MODEL_ROUTER_ANTIGRAVITY_OAUTH_PORT: String(PORTS.antigravityOauth),
  ANTIGRAVITY_OAUTH_FORWARD_BASE_URL: loopback(PORTS.antigravityOauth, "/v1"),
  MODEL_ROUTER_DEVIN_CLI_PORT: String(PORTS.devinCli),
  DEVIN_CLI_FORWARD_BASE_URL: loopback(PORTS.devinCli, "/v1"),
  MODEL_ROUTER_CURSOR_PUBLIC_PORT: String(PORTS.cursorPublic),
  MODEL_ROUTER_QUIET: "1",
  CODEX_ROUTER_CALLER_KEY: callerKey,
  CODEX_ROUTER_INTERNAL_KEY: internalKey,
  KIMI_INTERNAL_KEY: internalKey,
  KIMI_OAUTH_FORWARD_BASE_URL: loopback(PORTS.oauth, "/v1"),
  CODEX_ROUTER_API_FORWARD_BASE_URL: loopback(PORTS.api, "/v1"),
  CODEX_ROUTER_ANTHROPIC_FORWARD_BASE_URL: loopback(PORTS.api),
  CODEX_ROUTER_GATEWAY_BASE_URL: loopback(PORTS.gateway, "/v1"),
  CODEX_ROUTER_OAUTH_HEALTH_URL: loopback(PORTS.oauth, "/health"),
  CODEX_ROUTER_API_HEALTH_URL: loopback(PORTS.api, "/health"),
  CODEX_ROUTER_GATEWAY_HEALTH_URL: loopback(PORTS.gateway, "/health/liveliness"),
  CODEX_ROUTER_CATALOG: MERGED_CATALOG_PATH,
  CODEX_ROUTER_OAUTH_PORT: String(PORTS.oauth),
  CODEX_ROUTER_API_PORT: String(PORTS.api),
  CODEX_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
  CODEX_ROUTER_PORT: String(PORTS.router),
  LITELLM_MASTER_KEY: internalKey,
  LITELLM_LOG: "ERROR",
  LITELLM_TELEMETRY: "False",
  NO_COLOR: "1",
  // LiteLLM prints Unicode banners at startup; on a non-UTF-8 Windows code page
  // (e.g. cp1252) that raises UnicodeEncodeError and the child never comes up.
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
  // `--use-env-proxy` is a process argument, not an inherited environment
  // variable. Preserve its positive decision for the Node forwarders this
  // process launches; NODE_OPTIONS and NODE_USE_ENV_PROXY already inherit via
  // process.env.
  ...(environmentProxyOptedIn() ? { NODE_USE_ENV_PROXY: "1" } : {}),
};

const children = [];
let shuttingDown = false;
let frontendChild;
let shutdownPromise;
const shutdownController = new AbortController();
let stopNativeCatalogWatch = () => {};
let nativeCatalogWatchStarted = false;

async function startNativeCatalogWatch() {
  if (shuttingDown || nativeCatalogWatchStarted) return;
  nativeCatalogWatchStarted = true;
  try {
    const [{ watchNativeCatalog }, { subscribeNativeCatalogEvents }] = await Promise.all([
      import("./native-catalog-drift.mjs"), import("./native-catalog-events.mjs"),
    ]);
    if (!shuttingDown) stopNativeCatalogWatch = watchNativeCatalog({
      immediate: true, subscribeEvents: subscribeNativeCatalogEvents,
    });
  } catch (error) {
    nativeCatalogWatchStarted = false;
    console.error(`[codex-router] Native drift check failed: ${error.message}`);
  }
}

// Every child goes through `spawnableCommand` for the one case that needs it:
// a Windows `.cmd`/`.bat` launcher, which Node has refused to spawn without a
// shell since the CVE-2024-27980 fix and answers with a bare EINVAL. The
// installer produces `litellm.exe`, so the shipped path is untouched
// pass-through -- but `MODEL_ROUTER_LITELLM_BIN` and `CODEX_ROUTER_LITELLM_BIN`
// are operator-set, and a batch wrapper there used to take the whole service
// down before it spawned anything, with an error naming neither the file nor
// the reason. Our own Node children resolve to `process.execPath`, so they are
// pass-through on every platform.
function run(command, args, extraEnv = {}) {
  if (shuttingDown) throw new Error("Service shutdown has started; no new child can be launched.");
  const spawnable = spawnableCommand(command, args);
  const child = spawn(spawnable.command, spawnable.args, {
    cwd: SOURCE_ROOT,
    // Only this supervisor consumes startup allowances. Request handlers,
    // diagnostic subprocesses, and restarted children keep normal runtime bounds.
    env: runtimeChildEnvironment({ ...process.env, ...commonEnv, ...extraEnv }),
    stdio: command === process.execPath ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
    ...spawnable.options,
  });
  children.push(child);
  return child;
}

function waitForExit(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ label, code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ label, code, signal }));
  });
}

// The probe loop lives in src/health-probe.mjs so it can be tested directly;
// importing this file starts the whole service pipeline.
function waitForHealth(label, url, headers = {}, timeoutMs = 30_000, expectedService, child) {
  return pollHealth({
    label,
    url,
    headers,
    timeoutMs,
    expectedService,
    child,
    isShuttingDown: () => shuttingDown,
  });
}

function stopChildren() {
  if (shuttingDown) return shutdownPromise;
  shuttingDown = true;
  shutdownController.abort();
  stopNativeCatalogWatch();
  shutdownPromise = stopServiceChildren({
    frontend: frontendChild,
    children,
    drainMs: SHUTDOWN_DRAIN_MS,
    flushMs: SHUTDOWN_FLUSH_MS,
  });
  return shutdownPromise;
}

const FRONTEND = { script: "router.mjs", service: "codex-router", label: "Codex router" };
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stopChildren);
if (process.connected) {
  process.on("message", (message) => {
    if (message?.type === "model-router:shutdown") stopChildren();
  });
}

// Boot-health allowance for spawned children (forwarders, router frontend).
// Slow hosts (VDI Task Scheduler ancestry adds ~60 s per spawn level) raise
// this via CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS; the default is unchanged.
// The LiteLLM gateway keeps its own longer allowance below. Runtime request,
// inference, and retry timeouts are unaffected.
const STARTUP_CHILD_HEALTH_TIMEOUT_MS =
  startupTimeoutMs("CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS", 30_000);
const STARTUP_GATEWAY_HEALTH_TIMEOUT_MS =
  startupTimeoutMs("CODEX_ROUTER_GATEWAY_HEALTH_TIMEOUT_MS", 300_000);

async function main() {
  // Bind the common plane before optional dependencies finish cold-starting.
  // Liveness means this process can serve independent routes; /health retains
  // the stricter readiness/adoption contract for all selected dependencies.
  const frontend = FRONTEND;
  const frontendService = frontend.service;
  // `children` retains every handle for shutdown ownership. Readiness instead
  // follows each required service's current handle, including a replacement
  // that has not passed its own health check yet.
  const currentChildren = new Map();
  const track = (service, child, healthy = false) => {
    currentChildren.set(service, { child, healthy });
    return child;
  };
  const markHealthy = (service, child) => {
    const current = currentChildren.get(service);
    if (current?.child === child) current.healthy = true;
  };
  const router = run(process.execPath, [path.join(SOURCE_ROOT, "src", frontend.script)]);
  track("router", router);
  frontendChild = router;
  await waitForHealth(
    frontend.label,
    loopback(PORTS.router, "/health/live"),
    {},
    STARTUP_CHILD_HEALTH_TIMEOUT_MS,
    frontendService,
    router,
  );
  markHealthy("router", router);
  const specs = [
    ["kimi", "OAuth forwarder", "oauth-forwarder.mjs", PORTS.oauth, "codex-router-oauth-forwarder"],
    ["api", "API forwarder", "api-forwarder.mjs", PORTS.api, "codex-router-api-forwarder"],
    ["grok", "Grok OAuth forwarder", "grok-oauth-forwarder.mjs", PORTS.grokOauth, "codex-router-grok-oauth-forwarder"],
    ["antigravity", "Antigravity OAuth forwarder", "antigravity-oauth-forwarder.mjs", PORTS.antigravityOauth, "codex-router-antigravity-oauth-forwarder"],
    ["devin", "Devin CLI forwarder", "devin-cli-forwarder.mjs", PORTS.devinCli, "codex-router-devin-cli-forwarder"],
  ].filter(([service]) => requiredServices.has(service));
  const forwarders = specs.map(([service, label, script, port, expectedService]) => {
    const start = () => track(service, run(process.execPath, [path.join(SOURCE_ROOT, "src", script)]));
    return {
      service, label, start, child: start(),
      waitForHealth: async (child) => {
        await waitForHealth(label, loopback(port, "/health"),
          { Authorization: `Bearer ${internalKey}` }, STARTUP_CHILD_HEALTH_TIMEOUT_MS,
          expectedService, child);
        markHealthy(service, child);
      },
    };
  });
  if (executionPlan.needsGateway) track("gateway", undefined);
  const startGateway = () =>
    track("gateway", run(litellm, [
      "--config",
      LITELLM_CONFIG_PATH,
      "--host",
      "127.0.0.1",
      "--port",
      String(PORTS.gateway),
    ]));
  // LiteLLM cold starts can take minutes when launchd starves the job under
  // system load; killing it mid-import restarts the import from scratch and
  // the service loops forever, so wait long enough for a starved import.
  // Slow hosts (VDI Task Scheduler ancestry plus a saturated CPU) raise this
  // via CODEX_ROUTER_GATEWAY_HEALTH_TIMEOUT_MS; the default is unchanged.
  // This is a boot-health allowance, not an inference or request timeout.
  const gatewayHealthy = async (child) => {
    await waitForHealth(
      "LiteLLM gateway",
      loopback(PORTS.gateway, "/health/liveliness"),
      { Authorization: `Bearer ${internalKey}` },
      STARTUP_GATEWAY_HEALTH_TIMEOUT_MS,
      undefined,
      child,
    );
    markHealthy("gateway", child);
  };
  // The watchdog's probe is deliberately short: it runs on a timer while the
  // gateway is otherwise idle, so it must never park the supervisor for the
  // cold-start budget `gatewayHealthy` is allowed.
  const gatewayLivenessCheck = () =>
    waitForHealth(
      "LiteLLM gateway liveness",
      loopback(PORTS.gateway, "/health/liveliness"),
      {},
      4_000,
    );
  const gateway = executionPlan.needsGateway && !gatewayStartupError ? startGateway() : undefined;
  if (gatewayStartupError) console.error(`[${frontendService}] gateway unavailable: ${gatewayStartupError.message}`);
  const readiness = await Promise.allSettled([
    ...forwarders.map((forwarder) => forwarder.waitForHealth(forwarder.child)),
    ...(gateway ? [gatewayHealthy(gateway)] : []),
  ]);
  for (const result of readiness) {
    if (result.status === "rejected" && !shuttingDown) {
      console.error(`[${frontendService}] dependency unavailable: ${result.reason.message}`);
    }
  }
  let finalization = Promise.resolve();
  let finalizationFailure;
  let antigravityPromoted = false;
  const finalizeHealthyGeneration = (healthTimeoutMs) => {
    const next = finalization.then(async () => {
      if (finalizationFailure) throw finalizationFailure;
      if (shuttingDown) return false;
      try {
        await waitForHealth(frontend.label, loopback(PORTS.router, "/health"), {},
          healthTimeoutMs, frontendService, router);
      } catch (error) {
        if (!shuttingDown) console.error(`[${frontendService}] dependency readiness unavailable: ${error.message}`);
        return false;
      }
      if (shuttingDown) return false;
      // Read the slots after the aggregate probe: another recovery may have
      // replaced a child while it was in flight. Never omit a dead/missing
      // required child to make the activation appear ready.
      const current = [...currentChildren.values()];
      if (current.some(({ child, healthy }) => !healthy || !child || child.exitCode !== null || child.signalCode !== null)) {
        console.error(`[${frontendService}] dependency readiness lost its current child; activation remains pending.`);
        return false;
      }
      if (!antigravityPromoted && antigravityStartup.pendingActivationGeneration) {
        antigravityPromoted = await attemptAntigravityProbePromotionAfterReadiness({
          generation: antigravityStartup.pendingActivationGeneration,
          sessionGeneration: antigravityStartup.pendingSessionGeneration,
          children: current.map(({ child }) => child),
        });
        if (!antigravityPromoted && !shuttingDown) {
          console.error("[codex-router] Antigravity live-proof activation was superseded or startup lost a child; the route remains disabled.");
        }
      }
      if (shuttingDown) return false;
      const latest = [...currentChildren.values()];
      if (latest.length !== current.length || latest.some((value, index) =>
        value !== current[index] || !value.healthy || !value.child ||
        value.child.exitCode !== null || value.child.signalCode !== null)) {
        console.error(`[${frontendService}] dependency changed during activation; readiness must be confirmed again.`);
        return false;
      }
      // Promotion is the last bootstrap write. Both initial readiness and
      // later recovery retire startup allowances before catalog publication.
      clearStartupTimeouts(process.env);
      startupReady = true;
      if (automaticStartup) {
        try { clearStartupAttempts(); } catch { /* Operational cache only. */ }
      }
      await startNativeCatalogWatch();
      return true;
    });
    finalization = next.catch((error) => { finalizationFailure = error; });
    return next;
  };
  const ready = !gatewayStartupError && readiness.every((result) => result.status === "fulfilled")
    ? await finalizeHealthyGeneration(STARTUP_CHILD_HEALTH_TIMEOUT_MS)
    : false;

  // A degraded initial attempt also retires its bootstrap environment. A
  // later recovery uses runtime bounds and the captured exact proof generation.
  clearStartupTimeouts(process.env);

  const cursorEdge = cursorInstalled
    ? run(process.execPath, [path.join(SOURCE_ROOT, "src", "cursor-public-edge.mjs")])
    : undefined;
  if (cursorEdge) {
    track("cursor-edge", cursorEdge);
    await waitForHealth(
      "Cursor public edge",
      loopback(PORTS.cursorPublic, "/health"),
      {},
      STARTUP_CHILD_HEALTH_TIMEOUT_MS,
      "codex-router-cursor-edge",
      cursorEdge,
    );
    markHealthy("cursor-edge", cursorEdge);
  }
  // Cursor App sends BYOK requests from Cursor's backend, so its loopback edge
  // is paired with a user-owned named tunnel when one has been provisioned.
  // The generated ingress points only at port 4214 and ends in a 404 catch-all.
  const cursorTunnelSpec = cursorEdge ? cursorTunnelRunSpec() : undefined;
  const cursorTunnel = cursorTunnelSpec
    ? run(cursorTunnelSpec.command, cursorTunnelSpec.args)
    : undefined;
  if (cursorTunnel) track("cursor-tunnel", cursorTunnel, true);

  console.error(ready
    ? `[${frontendService}] ready (authenticated loopback endpoint)`
    : `[${frontendService}] serving independent routes; selected dependencies are degraded.`);
  startupReady = ready;
  // A dependency may exhaust its bounded restart allowance without ending
  // independent native/direct routes. Readiness stays degraded and publication
  // fails closed; a manual service restart starts a new bounded recovery epoch.
  const keepIndependentRoutes = async (supervision) => {
    const result = await supervision;
    // A canceled recovery can carry an old dependency exit status. During
    // intentional shutdown only the frontend's actual exit settles main().
    if (shuttingDown) return new Promise(() => {});
    if (!shuttingDown && result.exhausted) {
      console.error(`[${frontendService}] ${result.label} recovery exhausted; independent routes remain available.`);
      return new Promise(() => {});
    }
    return result;
  };
  const supervisionOptions = {
    waitForExit,
    isShuttingDown: () => shuttingDown,
    signal: shutdownController.signal,
    onHealthy: () => finalizeHealthyGeneration(4_000),
    log: (message) => console.error(`[${frontendService}] ${message}`),
    ...gatewaySupervisorLimits(),
  };
  const result = await Promise.race([
    ...forwarders.map((forwarder) => keepIndependentRoutes(superviseGateway({
      ...supervisionOptions,
      label: forwarder.label,
      child: forwarder.child,
      start: forwarder.start,
      waitForHealth: forwarder.waitForHealth,
    }))),
    ...(gateway ? [keepIndependentRoutes(superviseGateway({
      ...supervisionOptions,
      label: "LiteLLM gateway",
      child: gateway,
      start: startGateway,
      waitForHealth: gatewayHealthy,
      healthCheck: gatewayLivenessCheck,
    }))] : []),
    ...(cursorEdge ? [waitForExit(cursorEdge, "Cursor public edge")] : []),
    ...(cursorTunnel ? [waitForExit(cursorTunnel, "Cursor named tunnel")] : []),
    waitForExit(router, frontend.label),
  ]);
  if (!shuttingDown) {
    // A Windows fatal status is named in the line itself (src/fatal-exit.mjs)
    // and earns a capture pointer on the next one; every other exit renders
    // exactly as before. Crash lines are never gated on CODEX_ROUTER_QUIET.
    console.error(
      `[${frontendService}] ${result.label} exited (${describeChildExit(result)}).`,
    );
    const followUp = fatalExitFollowUp(result);
    if (followUp) console.error(`[${frontendService}] ${followUp}`);
  }
  return result.code || 0;
}

let exitCode = 0;
let serviceProcessRecorded = false;
try {
  // Task Scheduler can report its wscript host as stopped while the detached
  // cmd/node descendants still own every router port. Record the verified
  // start.mjs identity so the Windows service manager can terminate that tree
  // before it launches a replacement. Other platforms keep their native
  // supervisor semantics and do not need this marker, and neither does the
  // unmanaged foreground supervisor, which the service manager never owns.
  if (shouldRecordServiceProcess()) {
    writeServiceProcessState();
    serviceProcessRecorded = true;
  }
  exitCode = await main();
} catch (error) {
  if (!shuttingDown) {
    const reason = (error instanceof Error && error.message) || String(error);
    console.error(`[model-router] startup failed: ${reason}; inspect the service logs above for details.`);
    if (automaticStartup && !startupReady && !startupBackoffDisabled()) {
      // Do not infer policy from an error message or from try-block placement.
      // Configuration, credentials, child exit and file/ACL errors stay fatal.
      const failure = error?.probeOutcome === "timeout"
        ? "health-timeout"
        : error?.serviceProcessFailure === "identity-unavailable"
          ? "process-identity-unavailable"
          : error?.serviceProcessFailure === "command-line-unavailable"
            ? "process-command-line-unavailable"
            : undefined;
      if (failure) recordStartupFailure({ reason: failure });
    }
    exitCode = 1;
  }
} finally {
  const shutdown = await stopChildren();
  if (shutdown.timedOut) console.error("[model-router] owned-child shutdown exceeded its graceful allowance; force-stop was requested.");
  if (serviceProcessRecorded) {
    try {
      clearServiceProcessState();
    } catch {
      // A stale record is harmless after the root and its children are gone;
      // the next Windows stop re-validates identity before it can signal one.
    }
  }
  // Receiving shutdown through IPC keeps that channel referenced. Release it
  // only after owned-child shutdown, so the supervisor can drain and exit.
  if (process.connected) process.disconnect();
}
// All children have exited, so let Node drain its own child-process bookkeeping
// before terminating. A synchronous process.exit() here races libuv's Windows
// async-handle close path and can abort with UV_HANDLE_CLOSING after a child
// fails during startup (for example, an EADDRINUSE forwarder).
process.exitCode = exitCode;
