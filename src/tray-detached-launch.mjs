import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detachedOperationEnvironment } from "./process-tree.mjs";

// The caller retains this exact pid in its existing lifecycle/journal checks
// until readiness commits. A separate group keeps an adopted GUI (or delayed
// recovery owner) out of the completed updater's process-tree cleanup.
export function launchDetached(command, args, { spawnImpl = spawn, environment = process.env } = {}) {
  const env = detachedOperationEnvironment(environment);
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { detached: true, stdio: "ignore", windowsHide: true, shell: false, env });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(child.pid);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${await launchDetached(process.argv[2], process.argv.slice(3))}\n`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
