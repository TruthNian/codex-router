import "./helpers/isolated-runtime-environment.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/control.mjs", import.meta.url), "utf8");
const start = source.indexOf("async function handleTray(");
const end = source.indexOf("async function handleNativeRedirect(", start);
assert.ok(start >= 0 && end > start);
// Inject only the import boundary. The tested dispatch and gate are the
// complete shipped handler; no scheduler, GUI, or package command can run.
const handler = source.slice(start, end).replace('await import("./tray-update-owner.mjs")', "{ withTrayUpdateOwner: fixtureTrayOwner }");

function fixture(platform, withOwner) {
  const events = [];
  let held = false;
  const handleTray = vm.runInNewContext(`${handler}\nhandleTray`, {
    path, REPO_ROOT: "/synthetic", TRAY_COMMANDS: { enable: "install", disable: "uninstall", status: "status", restart: "restart" },
    process: { platform, env: {}, stdout: { write() {} } }, routerNodeBinary: () => "synthetic-node",
    operationDeadlineFromEnvironment: () => undefined,
    spawnSync: (command, args) => { events.push(command === "powershell.exe" ? "public-transaction" : `read:${args.at(-1)}`); return { status: 0 }; },
    runProcessTree: async (_command, args, options) => { assert.equal(held, true); assert.equal(options.ownerLifetimeFd, platform === "win32" ? undefined : 123); events.push(`mutate:${args.at(-1)}`); return { status: 0 }; },
    fixtureTrayOwner: async (run) => {
      events.push("owner");
      return (withOwner || (async (operation) => operation()))(async () => {
        held = true;
        try { return await run(platform === "win32" ? undefined : 123); }
        finally { held = false; }
      });
    },
  });
  return { handleTray, events };
}

for (const platform of ["linux", "darwin", "win32"]) {
  for (const action of ["enable", "disable", "restart", "status"]) {
    test(`${platform} control tray ${action} uses exactly its required owner boundary`, async () => {
      const { handleTray, events } = fixture(platform);
      await handleTray(action);
      if (action === "status") assert.deepEqual(events, ["read:status"]);
      else if (platform === "win32" && action === "enable") assert.deepEqual(events, ["public-transaction"]);
      else assert.deepEqual(events, ["owner", `mutate:${{ enable: "install", disable: "uninstall", restart: "restart" }[action]}`]);
    });
  }
}

test("a UI disable waits for the active update before uninstalling supervision", async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const { handleTray, events } = fixture("linux", async (run) => { await barrier; return run(); });
  const disabled = handleTray("disable");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["owner"], "disable cannot enter the active update's service mutation");
  release();
  await disabled;
  assert.deepEqual(events, ["owner", "mutate:uninstall"]);
});
