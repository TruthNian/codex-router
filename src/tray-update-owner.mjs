import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closeOwnerServer, ownerLeaseEndpoint, startOwnerServer } from "./kernel-owner-lease.mjs";
import { operationDeadlineFromEnvironment, runOperationProcessTree, runProcessTree } from "./process-tree.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function canonicalLocation(location) {
  const tail = [];
  let current = path.resolve(location);
  for (;;) {
    try { return path.join(realpathSync(current), ...tail.reverse()); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export async function withTrayUpdateOwner(operation, {
  root = ROOT, home = os.homedir(), platform = process.platform,
  waitMs = 15_000, start = startOwnerServer, close = closeOwnerServer,
} = {}) {
  const location = platform === "darwin" ? path.join(home, "Applications")
    : path.join(root, "apps", "control-center", "release");
  const canonical = canonicalLocation(location);
  const identity = platform === "win32" ? canonical.toLowerCase() : canonical;
  const endpoint = ownerLeaseEndpoint("update", identity, 35_000, { family: "tray" });
  const deadline = Date.now() + waitMs;
  let server;
  for (;;) {
    try { server = await start(endpoint); break; }
    catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Another tray update still owns this package; no recovery was attempted.", { cause: error });
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    }
  }
  try { return await operation(); }
  finally { await close({ server }); }
}

export async function runTrayUpdate(args, { run = runProcessTree, runOperation = runOperationProcessTree, withOwner = withTrayUpdateOwner } = {}) {
  const [mode, ...forwarded] = args;
  let command, commandArgs;
  if (mode === "posix") {
    command = "/bin/sh";
    commandArgs = [path.join(ROOT, "src", "tray-update-posix.sh"), ...forwarded];
  } else if (mode === "windows") {
    command = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
    commandArgs = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "src", "router-commands-windows.ps1"), ...forwarded];
  } else if (mode === "macos-restore" && process.platform === "darwin") {
    const applications = path.join(os.homedir(), "Applications");
    if (forwarded.length !== 2 || path.resolve(forwarded[0]) !== path.join(applications, ".model-router-tray-transaction")
        || !["Codex Router.app", "Model Router.app"].some((name) => path.resolve(forwarded[1]) === path.join(applications, name))) {
      throw new Error("Invalid tray supervision recovery paths.");
    }
    command = "/bin/sh";
    commandArgs = [path.join(ROOT, "src", "macos-tray-supervision-restore.sh"), "settle", ROOT, ...forwarded];
  } else throw new Error("Unknown private tray update entrypoint.");
  return withOwner(async () => {
    const deadline = operationDeadlineFromEnvironment();
    const execute = deadline === undefined ? run : runOperation;
    const result = await execute(command, commandArgs, { cwd: ROOT, stdio: "inherit", deadline, childMayOwnProcessTrees: true });
    return result.status ?? 1;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runTrayUpdate(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
