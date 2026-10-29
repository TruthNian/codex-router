import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const report = fileURLToPath(new URL("../.claude/skills/codex-subagents/subagent-report.mjs", import.meta.url));

for (const selected of ["MODEL_ROUTER_STATE_DIR", "CODEX_ROUTER_STATE_DIR", "KIMI_CODEX_STATE_DIR", "CODEX_HOME", "HOME", "USERPROFILE"]) {
  test(`subagent readiness follows ${selected}`, { skip: selected === "USERPROFILE" && process.platform !== "win32" }, () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "subagent-report-"));
    try {
      const home = path.join(directory, "home");
      const cwd = path.join(directory, "cwd");
      mkdirSync(home);
      mkdirSync(cwd);
      // A fresh environment cannot borrow the operator's state aliases or keys.
      const env = { USERPROFILE: home, HOME: home, MODEL_ROUTER_TARGET: "codex" };
      for (const name of ["SystemRoot", "WINDIR"]) {
        if (process.env[name]) env[name] = process.env[name];
      }
      const aliases = ["MODEL_ROUTER_STATE_DIR", "CODEX_ROUTER_STATE_DIR", "KIMI_CODEX_STATE_DIR", "CODEX_HOME"];
      const first = aliases.indexOf(selected);
      if (first >= 0) {
        for (const name of aliases.slice(first)) env[name] = path.join(directory, name);
      }
      if (selected === "USERPROFILE") delete env.HOME;
      const state = first >= 0 && selected !== "CODEX_HOME"
        ? env[selected]
        : path.join(env.CODEX_HOME || path.join(home, ".codex"), "codex-router");
      mkdirSync(state, { recursive: true });
      writeFileSync(path.join(state, "merged-models.json"), JSON.stringify({ models: [
        { slug: `fixture/${selected}`, multi_agent_version: "v2", priority: 1 },
      ] }));
      const output = execFileSync(process.execPath, [report], { env, cwd, encoding: "utf8", timeout: 10_000, windowsHide: true });
      assert.match(output, /Catalog:  1 models, 1 spawnable as subagents/);
      assert.ok(output.includes(`fixture/${selected}`));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
