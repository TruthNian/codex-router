import path from "node:path";

import { SOURCE_ROOT } from "./paths.mjs";
import {
  operationDeadlineFromEnvironment,
  remainingOperationMs,
  runOperationProcessTree,
  runProcessTree,
} from "./process-tree.mjs";
import { routerNodeBinary } from "./node-runtime.mjs";
import { waitForRouterHealth } from "./router-health.mjs";

const SERVICE_SCRIPT = path.join(SOURCE_ROOT, "src", "service.mjs");
const SERVICE_STATUS_OPERATION_MS = 10_000;
const SERVICE_PROCESS_OWNER_RESERVE_MS = 10_000;
const SERVICE_PLATFORM_COMMAND_RESERVE_MS = 10_000;
const SERVICE_READINESS_ALLOWANCE_MS = 300_000;
export const ROUTER_SERVICE_RESTART_MINIMUM_MS =
  SERVICE_STATUS_OPERATION_MS
  + SERVICE_PROCESS_OWNER_RESERVE_MS
  + SERVICE_PLATFORM_COMMAND_RESERVE_MS
  + SERVICE_READINESS_ALLOWANCE_MS;
export const ROUTER_SERVICE_RESTART_OPERATION_MS =
  ROUTER_SERVICE_RESTART_MINIMUM_MS + 1_000;
const SERVICE_RESTART_PHASE_MINIMUM_MS =
  SERVICE_PROCESS_OWNER_RESERVE_MS
  + SERVICE_PLATFORM_COMMAND_RESERVE_MS
  + SERVICE_READINESS_ALLOWANCE_MS;

function serviceOperationDeadline(deadline, env) {
  const boundedEnvironment = Number.isSafeInteger(deadline)
    ? { ...env, CODEX_ROUTER_OPERATION_DEADLINE_MS: String(deadline) }
    : env;
  return operationDeadlineFromEnvironment(boundedEnvironment, {
    timeoutMs: ROUTER_SERVICE_RESTART_OPERATION_MS,
    maximumMs: ROUTER_SERVICE_RESTART_OPERATION_MS,
  });
}

function serviceStatusDeadline(deadline, env) {
  const boundedEnvironment = Number.isSafeInteger(deadline)
    ? { ...env, CODEX_ROUTER_OPERATION_DEADLINE_MS: String(deadline) }
    : env;
  return operationDeadlineFromEnvironment(boundedEnvironment, {
    timeoutMs: SERVICE_STATUS_OPERATION_MS,
    maximumMs: SERVICE_STATUS_OPERATION_MS,
  });
}

export function routerServiceRestartCommand(platform = process.platform) {
  return platform === "win32"
    ? "node .\\src\\control.mjs service restart"
    : "./bin/control service restart";
}

function assertOperationActive(signal, deadline) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("The router operation was aborted.");
  }
  remainingOperationMs(deadline, signal, {
    message: "The router operation deadline expired before service readiness completed.",
  });
}

function assertOperationAllowance(signal, deadline, minimumMs, message) {
  const remaining = remainingOperationMs(deadline, signal, { message });
  if (remaining !== undefined && remaining < minimumMs) {
    const error = new Error(message);
    error.code = "router_operation_timeout";
    throw error;
  }
}

async function invokeService(
  args,
  {
    spawn,
    env,
    signal,
    deadline,
    stdio = "capture",
    childOwnsOperations = true,
  },
) {
  const run = spawn
    ? async (command, commandArgs, options) => spawn(command, commandArgs, {
      ...options,
      encoding: "utf8",
      ...(stdio === "inherit" ? { stdio: "inherit" } : {}),
    })
    : runProcessTree;
  const options = {
    cwd: SOURCE_ROOT,
    env,
    signal,
    deadline,
    stdio,
  };
  // A Homebrew Node upgrade deletes the Cellar path this long-running process
  // was started from, so process.execPath can name a binary that no longer
  // exists. The refresh spawns already prefer the configured stable runtime;
  // the restart has to as well, or a refresh succeeds and the restart it asks
  // for dies with ENOENT.
  const nodeBinary = routerNodeBinary(env);
  return childOwnsOperations
    ? runOperationProcessTree(nodeBinary, [SERVICE_SCRIPT, ...args], { ...options, run })
    : run(nodeBinary, [SERVICE_SCRIPT, ...args], options);
}

export async function routerServiceStatus({
  spawn,
  env = process.env,
  signal,
  deadline,
} = {}) {
  const operationDeadline = serviceStatusDeadline(deadline, env);
  assertOperationActive(signal, operationDeadline);
  const result = await invokeService(["status"], {
    spawn,
    env,
    signal,
    deadline: operationDeadline,
    childOwnsOperations: false,
  });
  assertOperationActive(signal, operationDeadline);
  if (result.error || result.status !== 0) {
    return { installed: false, statusUnknown: true };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (
      typeof parsed?.installed !== "boolean" ||
      typeof parsed?.loaded !== "boolean" ||
      typeof parsed?.state !== "string" ||
      (parsed.statusUnknown !== undefined && typeof parsed.statusUnknown !== "boolean")
    ) {
      return { installed: false, statusUnknown: true };
    }
    return {
      installed: parsed.installed,
      loaded: parsed.loaded,
      state: parsed.state,
      ...(parsed.statusUnknown === true || parsed.state === "unknown"
        || (!parsed.installed && !parsed.loaded && parsed.state !== "stopped")
        ? { statusUnknown: true } : {}),
    };
  } catch {
    return { installed: false, statusUnknown: true };
  }
}

function environmentMutationError(message) {
  const error = new Error(message);
  error.code = "provider_api_key_pool_service_environment_stale";
  return error;
}

export async function environmentPoolMutationServiceStatus({
  spawn,
  env = process.env,
  waitForHealth = waitForRouterHealth,
  signal,
  deadline,
} = {}) {
  const status = await routerServiceStatus({ spawn, env, signal, deadline });
  if (status.statusUnknown) {
    throw environmentMutationError(
      "Cannot safely add an environment-backed API-key pool entry because the background service state could not be verified. " +
        "Repair or stop the service, then retry; publishing while ownership is unknown could expose a route that cannot authenticate.",
    );
  }
  if (status.loaded) {
    throw environmentMutationError(
      "Cannot add an environment-backed API-key pool entry while the managed router service is running. " +
        "Stop the service, repeat the command with every pooled variable set, then rerun the installer; " +
        "a restart alone does not rewrite the service environment.",
    );
  }

  let health;
  try {
    health = await waitForHealth({ timeoutMs: 0, requestTimeoutMs: 1_000 });
  } catch {
    health = { ok: false };
  }
  const liveRouter = health?.ok === true || health?.degradedPayload?.service === "codex-router";
  if (liveRouter) {
    throw environmentMutationError(
      "Cannot add an environment-backed API-key pool entry while a live router process is already serving. " +
        "Stop the foreground router, repeat the command from the environment containing every pooled variable, then start it again.",
    );
  }
  if (health?.connectionRefused !== true) {
    throw environmentMutationError(
      "Cannot safely add an environment-backed API-key pool entry because the router process state could not be verified. " +
        "Stop or repair the router, then retry; only a confirmed empty loopback port is safe to publish against.",
    );
  }
  return {
    ...status,
    serviceReinstallRequired: status.installed === true,
  };
}

export function environmentPoolRemovalReminder(status) {
  if (status?.installed === true) {
    return (
      "Environment-backed pool metadata removed. Rerun the installer to remove the retired secret " +
      "from the managed service definition; a service restart alone replays the old definition.\n"
    );
  }
  if (status?.statusUnknown) {
    return (
      "Environment-backed pool metadata removed. Background service status could not be verified; " +
      "if one is installed, rerun the installer to remove the retired secret from its definition; " +
      "a restart alone may replay the old definition.\n"
    );
  }
  if (status?.loaded === true) {
    return (
      "Environment-backed pool metadata removed. Stop and restart the loaded router process to " +
      "drop the retired variable from its inherited environment.\n"
    );
  }
  return (
    "Environment-backed pool metadata removed. Restart any foreground router to drop the retired " +
    "variable from its process environment.\n"
  );
}

function adoptionError(message) {
  const error = new Error(message);
  error.code = "model_overlay_adoption_failed";
  return error;
}

async function probeRouterOwnership({ waitForHealth, signal, deadline }) {
  assertOperationActive(signal, deadline);
  const remaining = remainingOperationMs(deadline, signal);
  const health = await waitForHealth({
    timeoutMs: 0,
    requestTimeoutMs: Math.max(1, Math.min(1_000, remaining ?? 1_000)),
  });
  assertOperationActive(signal, deadline);
  return health;
}

/** Verify the registry generation a healthy running Router actually adopted. */
export async function verifyRouterExecutionPlanAdoption({
  expectedFingerprint,
  allowOffline = true,
  waitForHealth = waitForRouterHealth,
  serviceStatus = routerServiceStatus,
  signal,
  deadline,
} = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedFingerprint || "")) {
    throw adoptionError("A prepared model overlay has no valid execution-plan fingerprint.");
  }
  const health = await probeRouterOwnership({ waitForHealth, signal, deadline });
  if (health?.ok === true && health.payload?.service === "codex-router") {
    if (health.payload.executionPlan?.fingerprint !== expectedFingerprint) {
      throw adoptionError(
        "The running router has not adopted the prepared model routes; client publication was stopped. " +
        `Restart it with \`${routerServiceRestartCommand()}\` before retrying.`,
      );
    }
    return { adopted: true, offline: false };
  }
  if (allowOffline && health?.connectionRefused === true) {
    const status = await serviceStatus({ signal, deadline });
    assertOperationActive(signal, deadline);
    if (status?.statusUnknown !== true && status?.installed === false && status?.loaded === false) {
      // Confirm the port remains empty after the ownership probe; a failed or
      // stopped installed job must never be reclassified as an offline setup.
      const confirmed = await probeRouterOwnership({ waitForHealth, signal, deadline });
      if (confirmed?.connectionRefused === true) return { adopted: false, offline: true };
    }
  }
  throw adoptionError(
    "The prepared model routes could not be verified on a healthy router; client publication was stopped. " +
    "Repair or stop the router, then retry.",
  );
}

export async function restartRouterServiceIfInstalled({
  spawn,
  env = process.env,
  expectedFingerprint,
  waitForHealth = waitForRouterHealth,
  writeDiagnostics = (value) => process.stderr.write(value),
  signal,
  deadline,
} = {}) {
  const operationDeadline = serviceOperationDeadline(deadline, env);
  const status = await routerServiceStatus({
    spawn,
    env,
    signal,
    deadline: operationDeadline,
  });
  if (status.statusUnknown) {
    throw adoptionError(
      "The router service state could not be verified; client publication was stopped. " +
      "Repair or stop the service, then retry.",
    );
  }
  if (!status.installed) {
    if (status.loaded) {
      throw adoptionError("A loaded router job has no installed service definition and cannot safely adopt new routes.");
    }
    const health = await probeRouterOwnership({ waitForHealth, signal, deadline: operationDeadline });
    if (health?.ok === true || health?.degradedPayload?.service === "codex-router") {
      throw adoptionError(
        "A foreground router is serving but cannot be reloaded by the background service; client publication was stopped. " +
        "Stop the foreground router, apply the model change, then start it again.",
      );
    }
    if (health?.connectionRefused !== true) {
      throw adoptionError("The router process state could not be verified; only a confirmed empty loopback port is safe for offline publication.");
    }
    return false;
  }
  assertOperationAllowance(
    signal,
    operationDeadline,
    SERVICE_RESTART_PHASE_MINIMUM_MS,
    "The service operation deadline cannot preserve the full router readiness allowance.",
  );
  const relay = (output) => {
    for (const value of [output?.stdout, output?.stderr, !output?.stderr ? output?.error?.message : undefined]) {
      if (typeof value === "string" && value) writeDiagnostics(value.endsWith("\n") ? value : `${value}\n`);
    }
  };
  let result;
  try {
    // The caller may own a machine-readable stdout response (for example a
    // provider removal). Service progress belongs to stderr at that boundary.
    result = await invokeService(["restart"], {
      spawn, env, signal, deadline: operationDeadline, stdio: "capture",
    });
  } catch (error) {
    relay(error);
    throw error;
  }
  relay(result);
  assertOperationActive(signal, operationDeadline);
  if (result.error || result.status !== 0) {
    const error = new Error(
      "The router service could not be restarted; routes requiring fresh process state " +
        `will not go live until it is. Retry with \`${routerServiceRestartCommand()}\`.`,
      result.error ? { cause: result.error } : undefined,
    );
    error.status = result.status ?? result.error?.status;
    error.stdout = result.stdout ?? result.error?.stdout ?? "";
    error.stderr = result.stderr ?? result.error?.stderr ?? "";
    error.output = result.output || result.error?.output || [null, error.stdout, error.stderr];
    if (result.signal || result.error?.signal) error.signal = result.signal || result.error.signal;
    throw error;
  }
  if (expectedFingerprint !== undefined) {
    await verifyRouterExecutionPlanAdoption({
      expectedFingerprint,
      allowOffline: false,
      waitForHealth,
      signal,
      deadline: operationDeadline,
    });
  }
  return true;
}
