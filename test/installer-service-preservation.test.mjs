import "./helpers/isolated-runtime-environment.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { posixShell } from "./helpers/posix-shell.mjs";

const shell = posixShell();
for (const name of ["install", "enable"]) test(`${name} failure rolls back the synthetic client without uninstalling any service`, { skip: !shell }, () => {
  const source = readFileSync(new URL(`../bin/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("rollback() {");
  const end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start);
  const rollback = source.slice(start, end + 3);
  for (const initial of ["true", "false", "unknown"]) {
    const result = spawnSync(shell, ["-s"], {
      encoding: "utf8", timeout: 5_000,
      input: `set -eu\ncalls=''\nconfig_enabled=true\nconfig_was_enabled=false\nconfig_manager=synthetic-config\nconfig_disable_command=disable\nadopt_native_catalog=false\nreadiness_timeout=false\nservice_installed=true\nservice_was_installed=${initial}\nnode() { calls="$calls|$*"; }\n${rollback}\nrollback\nprintf '%s' "$calls"\n`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "|synthetic-config disable", `initial registration=${initial}`);
  }
});

test("Windows installer failure preserves service definitions and the retryable client state", { skip: process.platform !== "win32" }, () => {
  const source = readFileSync(new URL("../install.ps1", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.lastIndexOf("\n} catch {");
  const end = source.indexOf("\n} finally {", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start + "\n} catch {".length, end);
  for (const timeout of [false, true]) {
    const script = `$ErrorActionPreference='Stop'; $script:calls=@(); function node { $script:calls += ($args -join ' ') }; $ConfigEnabled=$true; $ConfigWasEnabled=$false; $ConfigManager='synthetic-config'; $ConfigDisableCommand='disable'; $AdoptionPending=$false; $ReadinessTimedOut=$${timeout}; try { try { throw 'synthetic failure' } catch { ${body} } } catch {}; [Console]::Out.Write((ConvertTo-Json -InputObject @($script:calls) -Compress))`;
    const result = spawnSync(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), timeout ? [] : ["synthetic-config disable"]);
  }
});
