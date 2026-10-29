import "./helpers/isolated-runtime-environment.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeOwnerServer, startOwnerServer } from "../src/kernel-owner-lease.mjs";
import { runProcessTree } from "../src/process-tree.mjs";
import { ownerLifetimeDescriptor } from "../src/tray-update-owner.mjs";

async function until(predicate, description) {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, description);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("POSIX native mutation retains the lease after owner SIGKILL, but an adopted GUI does not", {
  skip: process.platform === "win32" ? "POSIX descriptor inheritance; Windows uses its existing Job owner" : false,
  timeout: 30_000,
}, async (t) => {
  // Only this fixture's children and private directory are controlled. The
  // ephemeral loopback listener is the lease itself, with no provider traffic.
  const root = mkdtempSync(path.join(os.tmpdir(), "tray-fd-lifetime-"));
  const moduleUrl = (name) => new URL(`../src/${name}.mjs`, import.meta.url).href;
  const ownerFile = path.join(root, "owner.mjs");
  const bodyFile = path.join(root, "body.mjs");
  const guiFile = path.join(root, "gui.mjs");
  const marker = (name) => path.join(root, name);
  writeFileSync(guiFile, `
    import { existsSync, writeFileSync } from "node:fs";
    const root = process.argv[2];
    writeFileSync(root + "/gui-ready", "ready");
    const hardStop = setTimeout(() => process.exit(2), 15_000);
    const poll = setInterval(() => {
      if (existsSync(root + "/gui-ping")) writeFileSync(root + "/gui-pong", "alive");
      if (!existsSync(root + "/release-gui")) return;
      clearInterval(poll); clearTimeout(hardStop);
      writeFileSync(root + "/gui-exited", "done");
    }, 20);
  `);
  writeFileSync(bodyFile, `
    import assert from "node:assert/strict";
    import { existsSync, fstatSync, writeFileSync } from "node:fs";
    import { launchDetached } from ${JSON.stringify(moduleUrl("tray-detached-launch"))};
    const root = process.argv[2];
    assert.equal(fstatSync(3).isSocket(), true);
    await launchDetached(process.execPath, [${JSON.stringify(guiFile)}, root]);
    writeFileSync(root + "/body-ready", "holding-fd-3");
    const hardStop = setTimeout(() => process.exit(2), 15_000);
    const poll = setInterval(() => {
      if (!existsSync(root + "/release-body")) return;
      clearInterval(poll); clearTimeout(hardStop);
      writeFileSync(root + "/body-exited", "done");
    }, 20);
  `);
  writeFileSync(ownerFile, `
    import { writeFileSync } from "node:fs";
    import { withTrayUpdateOwner } from ${JSON.stringify(moduleUrl("tray-update-owner"))};
    import { startOwnerServer } from ${JSON.stringify(moduleUrl("kernel-owner-lease"))};
    import { runProcessTree } from ${JSON.stringify(moduleUrl("process-tree"))};
    process.exitCode = await withTrayUpdateOwner(async (ownerLifetimeFd) => {
      const result = await runProcessTree("/bin/sh", ["-c", 'exec "$1" "$2" "$3"',
        "native-tray-fixture", process.execPath, ${JSON.stringify(bodyFile)}, ${JSON.stringify(root)}],
        { stdio: "inherit", ownerLifetimeFd });
      return result.status ?? 1;
    }, {
      root: ${JSON.stringify(root)},
      start: async () => {
        const server = await startOwnerServer({ host: "127.0.0.1", port: 0, exclusive: true });
        writeFileSync(${JSON.stringify(marker("lease.json"))}, JSON.stringify(server.address()));
        return server;
      },
    });
  `);
  const owner = spawn(process.execPath, [ownerFile], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let diagnostics = "";
  owner.stdout.on("data", (chunk) => { diagnostics += chunk; });
  owner.stderr.on("data", (chunk) => { diagnostics += chunk; });
  const ownerExit = new Promise((resolve, reject) => {
    owner.once("error", reject);
    owner.once("exit", (status, signal) => resolve({ status, signal }));
  });
  t.after(async () => {
    writeFileSync(marker("release-body"), "cleanup");
    writeFileSync(marker("release-gui"), "cleanup");
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    // A failing fixture still exits itself within fifteen seconds. Never kill
    // a PID obtained from a persistent marker or touch another process tree.
    if (existsSync(marker("body-ready"))) await until(() => existsSync(marker("body-exited")), "body cleanup");
    if (existsSync(marker("gui-ready"))) await until(() => existsSync(marker("gui-exited")), "GUI cleanup");
    rmSync(root, { recursive: true, force: true });
  });
  await until(() => existsSync(marker("body-ready")) && existsSync(marker("gui-ready")), `fixture did not start: ${diagnostics}`);
  const { address: host, port } = JSON.parse(readFileSync(marker("lease.json"), "utf8"));
  const endpoint = { host, port, exclusive: true };
  assert.equal(owner.kill("SIGKILL"), true);
  assert.deepEqual(await ownerExit, { status: null, signal: "SIGKILL" });
  await assert.rejects(startOwnerServer(endpoint), { code: "EADDRINUSE" });
  assert.equal(existsSync(marker("body-exited")), false, "the original native body is still active");
  writeFileSync(marker("release-body"), "commit");
  let nextOwner;
  await until(async () => {
    try { nextOwner = await startOwnerServer(endpoint); return true; }
    catch (error) { if (error.code !== "EADDRINUSE") throw error; return false; }
  }, `the exited native body retained its lease: ${diagnostics}`);
  try {
    assert.equal(existsSync(marker("body-exited")), true);
    assert.equal(existsSync(marker("gui-exited")), false, "handoff GUI outlives the native body");
    writeFileSync(marker("gui-ping"), "check");
    await until(() => existsSync(marker("gui-pong")), "the detached GUI must still be alive after lease re-entry");
  } finally { await closeOwnerServer({ server: nextOwner }); }
});

const nativeBody = readFileSync(new URL("../src/tray-update-posix.sh", import.meta.url), "utf8");
const cleanupStart = nativeBody.indexOf("    cleanup_linux() {");
const cleanupEnd = nativeBody.indexOf("\n    if ! prepare_linux_release_root", cleanupStart);
assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart);
const nativeCleanup = nativeBody.slice(cleanupStart, cleanupEnd);

for (const [status, recoveryFailure] of [[0, 0], [17, 0], [75, 0], [17, 1]]) {
  test(`POSIX inherited lease preserves native cleanup and status ${status} (recovery failure ${recoveryFailure})`, {
    skip: process.platform === "win32" ? "POSIX descriptor inheritance" : false,
  }, async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tray-fd-rollback-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const server = await startOwnerServer({ host: "127.0.0.1", port: 0, exclusive: true });
    try {
      // Execute the shipped EXIT cleanup, replacing only the recovery boundary
      // with a fixture action. Success keeps its committed package; a failure
      // invokes recovery and preserves its original code even if recovery fails.
      const script = `transaction_dir=$1\ntransaction_committed=$2\nfixture_recovery_result=$3\n`
        + `recover_linux_transaction() { printf restored > "$transaction_dir/recovered"; return "$fixture_recovery_result"; }\n`
        + nativeCleanup + `\ntrap cleanup_linux EXIT\nexit "$4"\n`;
      const result = await runProcessTree("/bin/sh", ["-c", script, "native-rollback-fixture", root,
        status === 0 ? "1" : "0", String(recoveryFailure), String(status)], {
        ownerLifetimeFd: ownerLifetimeDescriptor(server), deadline: Date.now() + 5_000,
      });
      assert.equal(result.status, status);
      assert.equal(existsSync(path.join(root, "recovered")), status !== 0);
      if (status !== 0) assert.equal(readFileSync(path.join(root, "recovered"), "utf8"), "restored");
    } finally { await closeOwnerServer({ server }); }
  });
}

test("invalid inherited descriptors fail before any Windows or POSIX spawn", () => {
  for (const ownerLifetimeFd of [-1, 0, 2, 3.5, "3"]) {
    assert.throws(() => runProcessTree("never-spawn", [], { platform: "linux", ownerLifetimeFd }), /POSIX descriptor/);
  }
  assert.throws(() => runProcessTree("never-spawn", [], { platform: "win32", ownerLifetimeFd: 3 }), /POSIX descriptor/);
});
