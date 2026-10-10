import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { protectPrivateFile } from "./file-security.mjs";
import { withModelOverlayLock } from "./model-overlay-lock.mjs";
import { routerNodeBinary } from "./node-runtime.mjs";
import { STATE_DIR } from "./paths.mjs";
import { startupTimeoutMs } from "./startup-timeout.mjs";
import { prepareRuntimeDependenciesFresh, RUNTIME_DEPENDENCY_PREPARATION_MS } from "./runtime-dependency-preparation.mjs";
import {
  ROUTER_SERVICE_RESTART_MINIMUM_MS,
  ROUTER_SERVICE_RESTART_OPERATION_MS,
} from "./router-restart.mjs";
import {
  contractOperationDeadline,
  operationDeadlineFromEnvironment,
  remainingOperationMs,
  runDuringOwnerSignalCleanup,
  runOperationProcessTree,
  runProcessTree,
  withOwnerSignalExitBarrier,
} from "./process-tree.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), "..");
const CHILD_ARGUMENT = "--publish-in-fresh-process";
const PREPARE_CHILD_ARGUMENT = "--prepare-in-fresh-process";
const TARGETS_CHILD_ARGUMENT = "--publish-targets-in-fresh-process";
const ADOPTED_CHILD_ARGUMENT = "--publish-adopted-in-fresh-process";
const VERIFY_ADOPTED_CHILD_ARGUMENT = "--verify-adopted-in-fresh-process";
const OVERLAY_PREPARE_OPERATION_MS = 30_000;
const OVERLAY_PUBLISH_OPERATION_MS = 5 * 60_000;
// Prepare, adopt, and client publication are sequential. Give preparation its
// own finite envelope and preserve complete restart and publication epochs.
const OVERLAY_SERVICE_RESTART_RESERVE_MS =
  ROUTER_SERVICE_RESTART_OPERATION_MS + 9_000;
const OVERLAY_RESTARTING_PUBLICATION_MS =
  RUNTIME_DEPENDENCY_PREPARATION_MS + OVERLAY_PREPARE_OPERATION_MS + OVERLAY_PUBLISH_OPERATION_MS + OVERLAY_SERVICE_RESTART_RESERVE_MS;
const OVERLAY_RESTARTING_PUBLICATION_MINIMUM_MS =
  RUNTIME_DEPENDENCY_PREPARATION_MS + OVERLAY_PREPARE_OPERATION_MS + OVERLAY_PUBLISH_OPERATION_MS + ROUTER_SERVICE_RESTART_MINIMUM_MS;
const OVERLAY_OFFLINE_PUBLICATION_MINIMUM_MS =
  RUNTIME_DEPENDENCY_PREPARATION_MS + OVERLAY_PREPARE_OPERATION_MS + OVERLAY_PUBLISH_OPERATION_MS;
const OVERLAY_OFFLINE_PUBLICATION_MS = OVERLAY_OFFLINE_PUBLICATION_MINIMUM_MS + 10_000;
const OVERLAY_MUTATION_OPERATION_MS = 60_000;
const OVERLAY_RESTORE_OVERHEAD_MS = 10_000;
const OVERLAY_UNKNOWN_RESTORE_OPERATION_MS = 60_000;
const OVERLAY_ROLLBACK_OWNER_MAX_MS = 23 * 60_000;
const OVERLAY_OWNER_CLEANUP_RESERVE_MS = 10_000;
const DEFAULT_OVERLAY_TRANSACTION_MS = 45 * 60_000;
const MAX_OVERLAY_TRANSACTION_MS = DEFAULT_OVERLAY_TRANSACTION_MS;

function overlayPublicationDeadline(
  deadline,
  environment = process.env,
  { restart = false, restoreAllowanceMs = 0 } = {},
) {
  const boundedEnvironment = Number.isSafeInteger(deadline)
    ? { ...environment, CODEX_ROUTER_OPERATION_DEADLINE_MS: String(deadline) }
    : environment;
  const publicationMs = restart
    ? OVERLAY_RESTARTING_PUBLICATION_MS
    : OVERLAY_OFFLINE_PUBLICATION_MS;
  const maximumMs = publicationMs + Math.max(0, Math.min(
    Number.isSafeInteger(restoreAllowanceMs) ? restoreAllowanceMs : 0,
    OVERLAY_ROLLBACK_OWNER_MAX_MS - publicationMs - OVERLAY_OWNER_CLEANUP_RESERVE_MS,
  ));
  return operationDeadlineFromEnvironment(boundedEnvironment, {
    timeoutMs: maximumMs,
    maximumMs,
  });
}

function overlayTransactionDeadline(deadline, environment = process.env) {
  const boundedEnvironment = Number.isSafeInteger(deadline)
    ? { ...environment, CODEX_ROUTER_OPERATION_DEADLINE_MS: String(deadline) }
    : environment;
  return operationDeadlineFromEnvironment(boundedEnvironment, {
    timeoutMs: DEFAULT_OVERLAY_TRANSACTION_MS,
    maximumMs: MAX_OVERLAY_TRANSACTION_MS,
  });
}

function overlayRollbackDeadline(restart, restoreAllowanceMs) {
  // This epoch deliberately ignores both caller cancellation and the caller's
  // absolute deadline. Forward work was contracted before mutation to leave
  // room for it, but an uncooperative mutation or a late thrown error must not
  // turn an already-expired caller epoch into an immediate rollback failure.
  return overlayPublicationDeadline(undefined, {}, { restart, restoreAllowanceMs });
}

function overlayRestoreAllowanceMs(snapshots) {
  // File-array captures expose the number of prior private files that need
  // hardening after restoration. Custom snapshot shapes cannot prove a file
  // count; their callback retains a separate, explicitly bounded allowance.
  if (!Array.isArray(snapshots) || snapshots.some((snapshot) =>
    typeof snapshot?.path !== "string" || !path.isAbsolute(snapshot.path)
      || typeof snapshot.existed !== "boolean")) return OVERLAY_UNKNOWN_RESTORE_OPERATION_MS;
  const fileCount = snapshots.filter((snapshot) => snapshot?.existed === true).length;
  return OVERLAY_RESTORE_OVERHEAD_MS
    + fileCount * startupTimeoutMs("CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS", 15_000);
}

async function freshRegistryExecutionPlan() {
  const [registry, selection, execution, antigravity] = await Promise.all([
    import("./model-registry.mjs"), import("./provider-selection.mjs"),
    import("./route-execution-plan.mjs"), import("./antigravity-oauth-status.mjs"),
  ]);
  const enabled = new Set(selection.readProviderSelection());
  // An explicit proof can be pending while the provider remains unselected.
  // Preserve its temporary listener without enabling verified inactive routes.
  const startup = antigravity.antigravityOAuthStartupState();
  return execution.createExecutionPlan({
    models: registry.MODELS,
    providerForModel: registry.providerForModel,
    routeEnabled: (model) => {
      const provider = registry.RUNTIME_PROVIDERS.get(model.provider);
      return provider?.generic === true ? provider.enabled !== false : enabled.has(model.provider);
    },
    pendingAntigravity: Boolean(startup.pendingActivationGeneration),
  });
}

/** Prepare only gateway inputs and a nonsecret adoption identity. */
export async function prepareModelOverlayPublication({
  writeGateway,
  executionPlan = freshRegistryExecutionPlan,
  signal,
  deadline,
} = {}) {
  const operationDeadline = overlayPublicationDeadline(deadline);
  remainingOperationMs(operationDeadline, signal);
  const plan = await executionPlan();
  if (!/^[a-f0-9]{64}$/.test(plan?.fingerprint || "")) {
    throw new Error("The model overlay has no valid execution-plan fingerprint.");
  }
  const write = writeGateway || (await import("./litellm-config.mjs")).writeLiteLlmConfig;
  remainingOperationMs(operationDeadline, signal);
  const gatewayPath = write();
  remainingOperationMs(operationDeadline, signal);
  return { gatewayPath, expectedFingerprint: plan.fingerprint };
}

/** Publish clients only after the fresh registry still matches preparation. */
export async function publishModelOverlayTargets({
  expectedFingerprint,
  executionPlan = freshRegistryExecutionPlan,
  refreshTargets,
  signal,
  deadline,
} = {}) {
  const operationDeadline = overlayPublicationDeadline(deadline);
  remainingOperationMs(operationDeadline, signal);
  const plan = await executionPlan();
  if (!/^[a-f0-9]{64}$/.test(expectedFingerprint || "") || plan?.fingerprint !== expectedFingerprint) {
    const error = new Error("Model routes changed after preparation; client publication was stopped before touching any client.");
    error.code = "model_overlay_adoption_failed";
    throw error;
  }
  const refresh = refreshTargets || (await import("./target-integration.mjs")).refreshTargetPickerIfInstalled;
  remainingOperationMs(operationDeadline, signal);
  const targetsRefreshed = await refresh({ signal, deadline: operationDeadline });
  return { targetsRefreshed };
}

function adoptedOverlayDeadline(deadline, environment = process.env) {
  return operationDeadlineFromEnvironment(
    Number.isSafeInteger(deadline)
      ? { ...environment, CODEX_ROUTER_OPERATION_DEADLINE_MS: String(deadline) }
      : environment,
    { timeoutMs: OVERLAY_PUBLISH_OPERATION_MS, maximumMs: OVERLAY_PUBLISH_OPERATION_MS },
  );
}

/** Validate this process's registry without writing; offline profiles opt in. */
export async function verifyAdoptedModelOverlayPublication({
  allowOffline = false,
  executionPlan = freshRegistryExecutionPlan,
  verifyAdoption,
  signal,
  deadline,
} = {}) {
  const operationDeadline = adoptedOverlayDeadline(deadline);
  remainingOperationMs(operationDeadline, signal);
  const plan = await executionPlan();
  const verify = verifyAdoption || (await import("./router-restart.mjs")).verifyRouterExecutionPlanAdoption;
  await verify({ expectedFingerprint: plan?.fingerprint, allowOffline: allowOffline === true, signal, deadline: operationDeadline });
  return { expectedFingerprint: plan.fingerprint };
}

/** Refresh catalogs for the routes a healthy running Router already adopted. */
export async function publishAdoptedModelOverlayPublication({
  executionPlan = freshRegistryExecutionPlan,
  verifyAdoption,
  refreshTargets,
  signal,
  deadline,
} = {}) {
  const operationDeadline = adoptedOverlayDeadline(deadline);
  const { expectedFingerprint } = await verifyAdoptedModelOverlayPublication({
    executionPlan, verifyAdoption, signal, deadline: operationDeadline,
  });
  // Use the same fresh process for verification and publication. The parent
  // owns the model-overlay lock, so cooperating mutations cannot intervene.
  const published = await publishModelOverlayTargets({
    expectedFingerprint, executionPlan, refreshTargets,
    signal, deadline: operationDeadline,
  });
  return { expectedFingerprint, ...published };
}

function assertRestartingPublicationAllowance(deadline, signal) {
  const remaining = remainingOperationMs(deadline, signal, {
    message: "The model-overlay deadline cannot preserve publication and router readiness.",
  });
  if (
    remaining !== undefined
    && remaining < OVERLAY_RESTARTING_PUBLICATION_MINIMUM_MS
  ) {
    const error = new Error(
      "The model-overlay deadline cannot preserve publication and the full router readiness allowance.",
    );
    error.code = "router_operation_timeout";
    throw error;
  }
}

function assertOfflinePublicationAllowance(deadline, signal) {
  const remaining = remainingOperationMs(deadline, signal);
  if (remaining !== undefined && remaining < OVERLAY_OFFLINE_PUBLICATION_MINIMUM_MS) {
    const error = new Error("The model-overlay deadline cannot preserve dependency preparation and client publication.");
    error.code = "router_operation_timeout";
    throw error;
  }
}

function assertServiceRestartAllowance(deadline, signal) {
  const remaining = remainingOperationMs(deadline, signal, {
    message: "The model-overlay deadline cannot preserve router readiness.",
  });
  if (
    remaining !== undefined
    && remaining < ROUTER_SERVICE_RESTART_MINIMUM_MS
  ) {
    const error = new Error(
      "The model-overlay deadline cannot preserve the full router readiness allowance.",
    );
    error.code = "router_operation_timeout";
    throw error;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

// JSON-serializable on purpose: a detached uninstall worker can carry the
// pre-withdrawal state in its protected progress document if a caller needs to
// hand the transaction across a process boundary.
export function captureModelOverlayFiles(
  files,
  {
    exists = existsSync,
    read = readFileSync,
  } = {},
) {
  return [...new Set(files.map((file) => path.resolve(file)))].map((file) => {
    const existed = exists(file);
    return {
      path: file,
      existed,
      contents: existed ? Buffer.from(read(file)).toString("base64") : null,
    };
  });
}

export function restoreModelOverlayFiles(
  snapshots,
  {
    exists = existsSync,
    mkdir = mkdirSync,
    write = writeFileSync,
    chmod = chmodSync,
    protect = protectPrivateFile,
    unlink = unlinkSync,
  } = {},
) {
  for (const snapshot of snapshots) {
    if (!snapshot?.path || !path.isAbsolute(snapshot.path)) {
      throw new Error("A model-overlay snapshot has no absolute path.");
    }
    if (!snapshot.existed) {
      if (exists(snapshot.path)) unlink(snapshot.path);
      continue;
    }
    mkdir(path.dirname(snapshot.path), { recursive: true, mode: 0o700 });
    write(snapshot.path, Buffer.from(snapshot.contents || "", "base64"), { mode: 0o600 });
    chmod(snapshot.path, 0o600);
    // chmod is the complete privacy boundary on POSIX, but it does not remove
    // inherited ACLs on Windows. A rollback can recreate a file that was
    // deleted during the failed mutation, so apply the same owner-only ACL
    // protection as every normal private-state write.
    protect(snapshot.path);
  }
  return snapshots;
}

/**
 * Rebuild gateway inputs and clients together for explicit offline tooling.
 *
 * A caller with a loaded registry must use the fresh-child form below to avoid
 * publishing a pre-mutation snapshot. Live overlay mutations instead use
 * applyModelOverlayPublication(), which verifies service adoption before clients.
 */
export async function rebuildModelOverlayPublication({
  writeGateway,
  refreshTargets,
  signal,
  deadline,
} = {}) {
  const write = writeGateway ||
    (await import("./litellm-config.mjs")).writeLiteLlmConfig;
  const refresh = refreshTargets ||
    (await import("./target-integration.mjs")).refreshTargetPickerIfInstalled;

  const operationDeadline = overlayPublicationDeadline(deadline);
  remainingOperationMs(operationDeadline, signal);
  const gatewayPath = write();
  remainingOperationMs(operationDeadline, signal);
  const targetsRefreshed = await refresh({ signal, deadline: operationDeadline });
  return { gatewayPath, targetsRefreshed };
}

/**
 * Combined offline publication from a fresh registry snapshot. Live mutations
 * must use the separate preparation/adoption/target stages in the finalizer.
 */
export async function publishModelOverlayFresh({
  run = runProcessTree,
  sourceRoot = REPO_ROOT,
  environment = process.env,
  executable = routerNodeBinary(environment),
  signal,
  deadline,
} = {}) {
  const operationDeadline = overlayPublicationDeadline(deadline, environment);
  const result = await runOperationProcessTree(executable, [SELF, CHILD_ARGUMENT], {
    cwd: sourceRoot,
    env: environment,
    childEnvironment: {
      MODEL_ROUTER_TARGET: "codex",
    },
    signal,
    deadline: operationDeadline,
    run,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result?.status !== 0) {
    const detail = String(result?.stderr || "").trim();
    throw new Error(detail || "The shared model routes could not be published.");
  }
  return { published: true };
}

async function runFreshOverlayStage(argument, {
  run = runProcessTree,
  sourceRoot = REPO_ROOT,
  environment = process.env,
  executable = routerNodeBinary(environment),
  expectedFingerprint,
  allowOffline = false,
  signal,
  deadline,
} = {}) {
  const maximumMs = argument === PREPARE_CHILD_ARGUMENT
    ? OVERLAY_PREPARE_OPERATION_MS : OVERLAY_PUBLISH_OPERATION_MS;
  const operationDeadline = operationDeadlineFromEnvironment(
    Number.isSafeInteger(deadline)
      ? { ...environment, CODEX_ROUTER_OPERATION_DEADLINE_MS: String(deadline) } : environment,
    { timeoutMs: maximumMs, maximumMs },
  );
  const args = [SELF, argument];
  if (argument === VERIFY_ADOPTED_CHILD_ARGUMENT && allowOffline === true) args.push("--allow-confirmed-offline");
  if (argument === TARGETS_CHILD_ARGUMENT) {
    if (!/^[a-f0-9]{64}$/.test(expectedFingerprint || "")) {
      throw new Error("Client publication requires its prepared execution-plan fingerprint.");
    }
    args.push(expectedFingerprint);
  }
  const result = await runOperationProcessTree(executable, args, {
    cwd: sourceRoot, env: environment, childEnvironment: { MODEL_ROUTER_TARGET: "codex" },
    signal, deadline: operationDeadline, run, encoding: "utf8", windowsHide: true,
  });
  if (result?.status !== 0) {
    throw new Error(String(result?.stderr || "").trim() || "The shared model-overlay stage could not complete.");
  }
  let prepared;
  try { prepared = JSON.parse(result.stdout); } catch {
    throw new Error("The shared model-overlay stage returned an invalid result.");
  }
  if (argument === PREPARE_CHILD_ARGUMENT && !/^[a-f0-9]{64}$/.test(prepared?.expectedFingerprint || "")) {
    throw new Error("The prepared model overlay returned no valid execution-plan fingerprint.");
  }
  if ([ADOPTED_CHILD_ARGUMENT, VERIFY_ADOPTED_CHILD_ARGUMENT].includes(argument)
      && !/^[a-f0-9]{64}$/.test(prepared?.expectedFingerprint || "")) {
    throw new Error("The adopted model overlay returned no valid execution-plan fingerprint.");
  }
  return prepared;
}

export function prepareModelOverlayFresh(options = {}) {
  return runFreshOverlayStage(PREPARE_CHILD_ARGUMENT, options);
}

export function publishModelOverlayTargetsFresh(options = {}) {
  return runFreshOverlayStage(TARGETS_CHILD_ARGUMENT, options);
}

/**
 * Refresh installed clients without preparing dependencies, rewriting gateway
 * inputs, or restarting services. Acquire the mutation lock before spawning a
 * fresh registry reader. A caller already holding it must pass lock:false.
 */
async function runAdoptedModelOverlayFresh(argument, {
  lock = true,
  environment = process.env,
  signal,
  deadline,
  ...options
} = {}) {
  const operationDeadline = adoptedOverlayDeadline(deadline, environment);
  remainingOperationMs(operationDeadline, signal);
  const publish = () => runFreshOverlayStage(argument, {
    ...options, environment, signal, deadline: operationDeadline,
  });
  return lock ? withModelOverlayLock(publish, {
    stateDir: environment.MODEL_ROUTER_STATE_DIR || environment.CODEX_ROUTER_STATE_DIR
      || environment.KIMI_CODEX_STATE_DIR || STATE_DIR,
    waitMs: Math.min(120_000, remainingOperationMs(operationDeadline, signal)),
  }) : publish();
}

export function publishAdoptedModelOverlayFresh(options = {}) {
  return runAdoptedModelOverlayFresh(ADOPTED_CHILD_ARGUMENT, options);
}

/** Read-only guard; only explicit offline profile callers may allow absence. */
export function verifyAdoptedModelOverlayFresh({ lock = false, ...options } = {}) {
  return runAdoptedModelOverlayFresh(VERIFY_ADOPTED_CHILD_ARGUMENT, { ...options, lock });
}

/**
 * Prepare routing inputs, adopt them, then publish installed client catalogs.
 *
 * A synchronous toggle is fail-closed: its publication or restart error is
 * thrown. A download/removal has already changed physical state, so its caller
 * asks for warningOnly and receives the same catalogError/restartError fields
 * the existing progress surfaces understand instead of a false operation
 * failure.
 */
export async function applyModelOverlayPublication({
  warningOnly = false,
  restart = false,
  prepareDependencies,
  prepare,
  publish,
  verifyAdoption,
  restartService,
  signal,
  deadline,
} = {}) {
  const operationDeadline = overlayPublicationDeadline(deadline, process.env, { restart });
  const warnings = {};
  // A legacy injected publisher is a test/tooling boundary; never introduce a
  // real child write behind it. Full phase injection supplies prepare too.
  // Production defaults always prepare and verify the adoption fingerprint.
  const prepareRoutes = prepare || (publish ? async () => ({}) : prepareModelOverlayFresh);
  const prepareDeps = prepareDependencies || (publish ? async () => ({}) : prepareRuntimeDependenciesFresh);
  const publishTargets = publish || publishModelOverlayTargetsFresh;
  let prepared;
  let allowOffline = !restart;
  try {
    if (restart) {
      assertRestartingPublicationAllowance(operationDeadline, signal);
    } else assertOfflinePublicationAllowance(operationDeadline, signal);
    const dependencyDeadline = contractOperationDeadline(operationDeadline, {
      reserveMs: OVERLAY_PREPARE_OPERATION_MS + OVERLAY_PUBLISH_OPERATION_MS
        + (restart ? OVERLAY_SERVICE_RESTART_RESERVE_MS : 0),
      message: "The model-overlay dependency preparation has no remaining adoption/publication epoch.",
    });
    await prepareDeps({ signal, deadline: dependencyDeadline });
    const prepareDeadline = contractOperationDeadline(operationDeadline, {
      reserveMs: OVERLAY_PUBLISH_OPERATION_MS + (restart ? OVERLAY_SERVICE_RESTART_RESERVE_MS : 0),
      message: "The model-overlay preparation has no remaining adoption/publication epoch.",
    });
    prepared = await prepareRoutes({ signal, deadline: prepareDeadline });
  } catch (error) {
    if (!warningOnly) throw error;
    warnings.catalogError = errorMessage(error);
    return warnings;
  }

  try {
    if (restart) {
      const reload = restartService || (async (operation) => {
        const { restartRouterServiceIfInstalled } = await import("./router-restart.mjs");
        return restartRouterServiceIfInstalled(operation);
      });
      const restartDeadline = contractOperationDeadline(operationDeadline, {
        reserveMs: OVERLAY_PUBLISH_OPERATION_MS,
        message: "The model-overlay restart has no remaining client-publication epoch.",
      });
      assertServiceRestartAllowance(restartDeadline, signal);
      const restarted = await reload({ signal, deadline: restartDeadline, expectedFingerprint: prepared?.expectedFingerprint });
      allowOffline = restarted === false;
    }
    if (prepared?.expectedFingerprint !== undefined) {
      const verify = verifyAdoption || (await import("./router-restart.mjs")).verifyRouterExecutionPlanAdoption;
      await verify({ signal, deadline: operationDeadline, expectedFingerprint: prepared.expectedFingerprint, allowOffline });
    }
  } catch (error) {
    if (!warningOnly) throw error;
    warnings.restartError = errorMessage(error);
    return warnings;
  }

  try {
    remainingOperationMs(operationDeadline, signal);
    await publishTargets({ signal, deadline: operationDeadline, expectedFingerprint: prepared?.expectedFingerprint });
  } catch (error) {
    if (!warningOnly) throw error;
    warnings.catalogError = errorMessage(error);
  }
  return warnings;
}

export async function restorePublishedModelOverlay({
  restore,
  restart = false,
  warningOnly = false,
  applyPublication = applyModelOverlayPublication,
  restartService,
  signal,
  deadline,
  restoreAllowanceMs = 0,
} = {}) {
  const operationDeadline = overlayPublicationDeadline(deadline, process.env, { restart, restoreAllowanceMs });
  // The durable overlay snapshot is the transaction's source of truth. Always
  // restore it first, even when forward publication consumed the remaining
  // budget; the best-effort client/gateway republish below may then report an
  // aggregated deadline failure without leaving the failed mutation on disk.
  await restore();
  remainingOperationMs(operationDeadline, signal);
  const publicationDeadline = overlayPublicationDeadline(operationDeadline, process.env, { restart });
  await applyPublication({
    restart,
    restartService,
    warningOnly,
    signal,
    deadline: publicationDeadline,
  });
}

export function aggregateRollbackError(operationError, rollbackError) {
  return new AggregateError(
    [asError(operationError), asError(rollbackError)],
    "The model-overlay operation failed and its previous state could not be fully restored.",
    { cause: asError(operationError) },
  );
}

/**
 * Mutate state, prepare and adopt it, then publish clients.
 * Any failure restores the exact prior state and prepares/adopts/republishes that
 * state. The original error is preserved when rollback succeeds; an
 * AggregateError makes a failed rollback impossible to mistake for success.
 */
export async function transactModelOverlayMutation({
  files,
  capture,
  mutate,
  restore,
  restart = false,
  warningOnly = false,
  applyPublication = applyModelOverlayPublication,
  restartService,
  lock = true,
  signal,
  deadline,
} = {}) {
  const operationDeadline = overlayTransactionDeadline(deadline);
  const transaction = async () => {
    // Capture only after the cross-process lock is held. Capturing before the
    // lock lets a queued operation retain a stale snapshot and roll back a
    // later successful mutation when its own publication fails.
    const snapshots = capture
      ? await capture()
      : files
        ? captureModelOverlayFiles(files)
        : undefined;
    const restoreState = snapshots === undefined
      ? restore
      : (nextSnapshots = snapshots) => restore
        ? restore(nextSnapshots)
        : restoreModelOverlayFiles(nextSnapshots);

    const restartRequested = typeof restart === "function" ? await restart() : restart;
    const restoreAllowanceMs = overlayRestoreAllowanceMs(snapshots);
    const rollbackPublicationMs = restartRequested
      ? OVERLAY_RESTARTING_PUBLICATION_MS
      : OVERLAY_OFFLINE_PUBLICATION_MS;
    const rollbackReserveMs = rollbackPublicationMs + restoreAllowanceMs;
    const publicationMinimumMs = restartRequested
      ? OVERLAY_RESTARTING_PUBLICATION_MINIMUM_MS
      : OVERLAY_OFFLINE_PUBLICATION_MINIMUM_MS;
    if (rollbackReserveMs + OVERLAY_OWNER_CLEANUP_RESERVE_MS > OVERLAY_ROLLBACK_OWNER_MAX_MS) {
      const error = new Error("The model-overlay transaction cannot preserve its bounded file-restoration and rollback owner allowance.");
      error.code = "router_operation_timeout";
      throw error;
    }
    // Contract the caller before mutation, reserving an independent complete
    // prepare/adopt/publish rollback rather than sharing an expired deadline.
    const forwardDeadline = contractOperationDeadline(operationDeadline, {
      reserveMs: rollbackReserveMs,
      message: "The model-overlay operation has no remaining semantic rollback epoch.",
    });
    if (remainingOperationMs(forwardDeadline, signal) < OVERLAY_MUTATION_OPERATION_MS + publicationMinimumMs) {
      const error = new Error("The model-overlay transaction cannot preserve publication alongside mutation and exact file-restoration allowances.");
      error.code = "router_operation_timeout";
      throw error;
    }
    return withOwnerSignalExitBarrier(async (ownerSignal) => {
      const forwardSignal = signal
        ? AbortSignal.any([signal, ownerSignal])
        : ownerSignal;
      try {
        const mutationDeadline = Math.min(forwardDeadline, Date.now() + OVERLAY_MUTATION_OPERATION_MS);
        remainingOperationMs(mutationDeadline, forwardSignal);
        await mutate();
        remainingOperationMs(mutationDeadline, forwardSignal, {
          message: "The model-overlay mutation exceeded its bounded allowance; restoring the previous state.",
        });
        const publicationDeadline = overlayPublicationDeadline(forwardDeadline, process.env, { restart: restartRequested });
        return await applyPublication({
          restart: restartRequested,
          restartService,
          warningOnly,
          signal: forwardSignal,
          deadline: publicationDeadline,
        });
      } catch (operationError) {
        try {
          if (!restoreState) throw new Error("A model-overlay transaction has no rollback state.");
          const rollbackDeadline = overlayRollbackDeadline(restartRequested, restoreAllowanceMs);
          await runDuringOwnerSignalCleanup(() => restorePublishedModelOverlay({
            restore: restoreState,
            restart: restartRequested,
            // Forward warning-only publication is appropriate only after an
            // irreversible physical operation. Rollback is the consistency
            // boundary and must never turn a failed republish/restart into a
            // warning that lets divergent durable and running state pass.
            warningOnly: false,
            applyPublication,
            restartService,
            signal: undefined,
            deadline: rollbackDeadline,
            restoreAllowanceMs,
          }));
        } catch (rollbackError) {
          throw aggregateRollbackError(operationError, rollbackError);
        }
        throw operationError;
      }
    }, {
      // A received owner signal may interrupt forward publication immediately.
      // Keep the process alive long enough for the independent rollback epoch
      // plus its child-tree cleanup margin, without extending normal callers.
      timeoutMs: rollbackReserveMs + OVERLAY_OWNER_CLEANUP_RESERVE_MS,
    });
  };
  return lock ? withModelOverlayLock(transaction) : transaction();
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const argument = process.argv[2];
  if (![CHILD_ARGUMENT, PREPARE_CHILD_ARGUMENT, TARGETS_CHILD_ARGUMENT, ADOPTED_CHILD_ARGUMENT, VERIFY_ADOPTED_CHILD_ARGUMENT].includes(argument)) {
    console.error(`Usage: node ${path.basename(SELF)} ${CHILD_ARGUMENT}|${PREPARE_CHILD_ARGUMENT}|${TARGETS_CHILD_ARGUMENT}|${ADOPTED_CHILD_ARGUMENT}|${VERIFY_ADOPTED_CHILD_ARGUMENT} [fingerprint|--allow-confirmed-offline]`);
    process.exit(2);
  }
  try {
    const deadline = operationDeadlineFromEnvironment(process.env, {
      timeoutMs: argument === PREPARE_CHILD_ARGUMENT ? OVERLAY_PREPARE_OPERATION_MS : OVERLAY_PUBLISH_OPERATION_MS,
      maximumMs: argument === PREPARE_CHILD_ARGUMENT ? OVERLAY_PREPARE_OPERATION_MS : OVERLAY_PUBLISH_OPERATION_MS,
    });
    const result = argument === PREPARE_CHILD_ARGUMENT
      ? await prepareModelOverlayPublication({ deadline })
      : argument === TARGETS_CHILD_ARGUMENT
        ? await publishModelOverlayTargets({ deadline, expectedFingerprint: process.argv[3] })
        : argument === ADOPTED_CHILD_ARGUMENT
          ? await publishAdoptedModelOverlayPublication({ deadline })
          : argument === VERIFY_ADOPTED_CHILD_ARGUMENT
            ? await verifyAdoptedModelOverlayPublication({ deadline, allowOffline: process.argv[3] === "--allow-confirmed-offline" })
            : await rebuildModelOverlayPublication({ deadline });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
}
