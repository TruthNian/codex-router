import path from "node:path";
import { fileURLToPath } from "node:url";

import { routerNodeBinary } from "./node-runtime.mjs";
import { operationDeadlineFromEnvironment, remainingOperationMs,
  runOperationProcessTree, runProcessTree } from "./process-tree.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), "..");
const CHILD_ARGUMENT = "--prepare-in-fresh-process";
export const RUNTIME_DEPENDENCY_PREPARATION_MS = 600_000;

function preparationDeadline(deadline, environment) {
  return operationDeadlineFromEnvironment(Number.isSafeInteger(deadline)
    ? { ...environment, CODEX_ROUTER_OPERATION_DEADLINE_MS: String(deadline) } : environment,
  { timeoutMs: RUNTIME_DEPENDENCY_PREPARATION_MS, maximumMs: RUNTIME_DEPENDENCY_PREPARATION_MS });
}

export function runtimeDependencyInstallInvocation({ platform = process.platform,
  sourceRoot = REPO_ROOT, environment = process.env } = {}) {
  if (platform === "win32") {
    const shell = environment.SystemRoot
      ? path.win32.join(environment.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    return { command: shell, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(sourceRoot, "install.ps1"), "-CheckoutInstall", "-DependenciesOnly", "-Target", "codex"] };
  }
  return { command: "sh", args: [path.join(sourceRoot, "bin", "install"), "--dependencies-only"] };
}

/** Only dependency trees change; installer owns hash verification and repair. */
export async function prepareRuntimeDependencies({
  requirements,
  stepStatus,
  run = runProcessTree,
  sourceRoot = REPO_ROOT,
  environment = process.env,
  platform = process.platform,
  signal,
  deadline,
} = {}) {
  const operationDeadline = preparationDeadline(deadline, environment);
  const status = stepStatus || (await import("./install-plan.mjs")).stepStatus;
  const required = requirements || (async () => (await import("./runtime-dependency-requirements.mjs"))
    .runtimeDependencyRequirements());
  const readStep = (step) => {
    remainingOperationMs(operationDeadline, signal);
    const result = status(step, { root: sourceRoot, platform });
    if (!["skip", "run"].includes(result)) throw new Error("Runtime dependency readiness could not be verified.");
    return result;
  };
  const readRequirements = async () => {
    remainingOperationMs(operationDeadline, signal);
    const result = await required();
    if (typeof result?.needsGateway !== "boolean") throw new Error("Runtime dependency requirements could not be verified.");
    return result;
  };
  // A missing Node tree may prevent registry imports. The dependency-only
  // installer repairs Node before asking the same route requirement helper.
  let needsInstall = readStep("node-deps") === "run";
  let plan;
  if (!needsInstall) {
    plan = await readRequirements();
    needsInstall = plan.needsGateway && readStep("python-deps") === "run";
  }
  if (needsInstall) {
    const invocation = runtimeDependencyInstallInvocation({ platform, sourceRoot, environment });
    const result = await runOperationProcessTree(invocation.command, invocation.args, {
      cwd: sourceRoot, env: environment, childEnvironment: { MODEL_ROUTER_TARGET: "codex" },
      signal, deadline: operationDeadline, run, windowsHide: true,
    });
    remainingOperationMs(operationDeadline, signal);
    if (result?.status !== 0) throw new Error("Required runtime dependencies could not be prepared; model routes were not published.");
    if (readStep("node-deps") !== "skip") throw new Error("Node dependencies are still missing or outdated after preparation.");
    plan = await readRequirements();
    if (plan.needsGateway && readStep("python-deps") !== "skip") {
      throw new Error("Required gateway dependencies are still missing or outdated after preparation.");
    }
  }
  remainingOperationMs(operationDeadline, signal);
  return { prepared: true, installed: needsInstall, needsGateway: plan.needsGateway };
}

/** Registry and selected-route requirements must be loaded after mutation. */
export async function prepareRuntimeDependenciesFresh({
  run = runProcessTree,
  sourceRoot = REPO_ROOT,
  environment = process.env,
  executable = routerNodeBinary(environment),
  signal,
  deadline,
} = {}) {
  const operationDeadline = preparationDeadline(deadline, environment);
  const result = await runOperationProcessTree(executable, [SELF, CHILD_ARGUMENT], {
    cwd: sourceRoot, env: environment, childEnvironment: { MODEL_ROUTER_TARGET: "codex" },
    signal, deadline: operationDeadline, run, encoding: "utf8", windowsHide: true,
  });
  if (result?.status !== 0) throw new Error("Required runtime dependencies could not be prepared; model routes were not published.");
  // Installer progress can precede the final JSON result, but no output from
  // dependency tooling is forwarded to the caller or included in this result.
  let prepared;
  try { prepared = JSON.parse(String(result.stdout || "").trim().split(/\r?\n/).at(-1)); } catch {
    throw new Error("Runtime dependency preparation returned an invalid result.");
  }
  if (prepared?.prepared !== true || typeof prepared.installed !== "boolean" || typeof prepared.needsGateway !== "boolean") {
    throw new Error("Runtime dependency preparation returned an invalid result.");
  }
  return { prepared: true, installed: prepared.installed, needsGateway: prepared.needsGateway };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (process.argv[2] !== CHILD_ARGUMENT || process.argv.length !== 3) {
    console.error(`Usage: node ${path.basename(SELF)} ${CHILD_ARGUMENT}`);
    process.exitCode = 2;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(await prepareRuntimeDependencies())}\n`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
