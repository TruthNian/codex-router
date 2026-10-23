import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { nextBetaVersion } from "../scripts/next-beta-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("automatic releases advance the current beta", () => {
  assert.equal(nextBetaVersion("0.4.0-beta.2"), "0.4.0-beta.3");
  assert.equal(nextBetaVersion("12.3.4-beta.99"), "12.3.4-beta.100");
});

test("a stable version starts the next patch beta series", () => {
  assert.equal(nextBetaVersion("1.2.3"), "1.2.4-beta.1");
});

test("unknown prerelease channels fail closed", () => {
  assert.throws(() => nextBetaVersion("1.2.3-rc.1"), /Cannot automatically advance/);
  assert.throws(() => nextBetaVersion("main"), /Cannot automatically advance/);
});

test("the widget keeps production App Group and local-source read-only contracts separate", () => {
  const productionEntitlements = readFileSync(
    path.join(
      root,
      "apps",
      "macos",
      "RouterUsageWidget",
      "RouterUsageWidget",
      "RouterUsageWidget.entitlements",
    ),
    "utf8",
  );
  const localEntitlements = readFileSync(
    path.join(
      root,
      "apps",
      "macos",
      "RouterUsageWidget",
      "RouterUsageWidget",
      "RouterUsageWidget.local.entitlements",
    ),
    "utf8",
  );
  assert.match(productionEntitlements, /com\.apple\.security\.application-groups/);
  assert.match(productionEntitlements, /group\.io\.github\.codex-router/);
  assert.doesNotMatch(productionEntitlements, /temporary-exception\.files/);
  assert.match(localEntitlements, /com\.apple\.security\.app-sandbox/);
  assert.match(
    localEntitlements,
    /com\.apple\.security\.temporary-exception\.files\.home-relative-path\.read-only/,
  );
  assert.match(
    localEntitlements,
    /\/Library\/Application Support\/Codex Router Widget\//,
  );
  assert.doesNotMatch(localEntitlements, /com\.apple\.security\.application-groups/);
  assert.doesNotMatch(localEntitlements, /home-relative-path\.read-write|absolute-path/);
});

test("releases are tag-driven and validate every asset before publishing", () => {
  const ci = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const release = readFileSync(
    path.join(root, ".github", "workflows", "release.yml"),
    "utf8",
  );

  // CI validates upstream main, the personal maintenance branch, and PRs.
  // Publishing is tag-triggered; an ordinary branch push cannot release.
  assert.match(ci, /push:\s*\n\s+branches: \[main, personal\]/);
  assert.match(ci, /pull_request:\s*\{\}/);
  assert.doesNotMatch(ci, /uses:\s+\.\/\.github\/workflows\/release\.yml/);
  assert.match(release, /push:\s*\n\s+tags:\s*\n\s+- "v\*"/);
  assert.doesNotMatch(release, /workflow_call:/);
  assert.doesNotMatch(release, /branches:\s*\[?main/);
  assert.match(release, /Verify tag matches package version/);
  assert.match(release, /test "v\$package_version" = "\$GITHUB_REF_NAME"/);
  assert.match(release, /actions: read/);
  assert.match(release, /git fetch --no-tags origin main:refs\/remotes\/origin\/main/);
  assert.match(release, /test "\$tag_commit" = "\$GITHUB_SHA"/);
  assert.match(release, /test "\$tag_commit" = "\$main_commit"/);
  assert.match(release, /actions\/workflows\/ci\.yml\/runs\?head_sha=\$\{GITHUB_SHA\}/);
  assert.match(release, /select\(\.conclusion == "success"/);
  assert.match(release, /needs: release-preflight/);
  assert.match(release, /needs: \[release-preflight, unified-app, unified-app-macos\]/);
  assert.ok(
    release.indexOf("- run: npm test") < release.indexOf("gh release create"),
    "the release must pass the full test suite before publishing assets",
  );
  assert.match(release, /git archive --format=tar\.gz/);
  assert.match(release, /git archive --format=zip/);
  assert.match(release, /name: Unsigned tester app \(\$\{\{ matrix\.platform \}\}\)/);
  assert.match(release, /electron-builder --win --publish never/);
  assert.match(release, /electron-builder --linux --publish never/);
  assert.match(release, /Smoke the packaged Linux application/);
  assert.match(release, /Smoke the packaged Windows application/);
  assert.match(release, /--no-sandbox --tray-only/);
  assert.match(release, /--no-sandbox --quit-for-update/);
  assert.match(release, /-ArgumentList "--tray-only"/);
  assert.match(release, /-ArgumentList "--quit-for-update"/);
  assert.match(release, /install -m 0755/);
  assert.match(release, /model-router-\$\{version\}-linux-x64\.tar\.gz/);
  assert.match(release, /unified-app-macos:/);
  assert.match(release, /continue-on-error: true/);
  assert.match(release, /trusted signing team is pinned/);
  assert.match(release, /signing team does not match the repository trust pin/);
  assert.match(release, /needs\.release-preflight\.result == 'success'/);
  assert.match(release, /needs\.unified-app\.result == 'success'/);
  assert.match(release, /unsigned tester artifacts/);
  assert.match(release, /matching Codex Router version/);
  assert.match(release, /sha256sum codex-router-\* model-router-\* > SHA256SUMS/);
  assert.doesNotMatch(release, /codex-router-desktop|build-desktop-tray/);
  assert.match(release, /actions\/attest-build-provenance@v4/);
  assert.match(release, /gh release create "\$GITHUB_REF_NAME" dist\/\* --verify-tag/);
  assert.match(release, /generate-formula\.mjs/);
  assert.match(release, /git push origin main/);
  assert.doesNotMatch(release, /HOMEBREW_TAP_TOKEN/);

  // macOS release assets remain disabled until a trusted signer is configured.
  // CI requests both architectures and verifies the actual nested executables,
  // rather than trusting the builder's output filename.
  assert.match(ci, /MODEL_ROUTER_TRAY_UNIVERSAL: "1"/);
  assert.match(ci, /CFBundleShortVersionString/);
  assert.match(ci, /ModelRouterControlVersion/);
  assert.match(ci, /CFBundleVersion/);
  assert.match(ci, /test "\$actual_build_version" = "\$GITHUB_RUN_NUMBER"/);
  assert.match(ci, /lipo "\$app\/Contents\/MacOS\/ModelRouterTray" -verify_arch x86_64 arm64/);
  assert.match(
    ci,
    /lipo "\$widget\/Contents\/MacOS\/RouterUsageWidget" -verify_arch x86_64 arm64/,
  );
  assert.match(ci, /widget-entitlements\.plist/);
  assert.match(ci, /ModelRouterWidgetStorageMode/);
  assert.match(ci, /temporary-exception\.files\.home-relative-path\.read-only:0/);
  assert.match(ci, /production_entitlements=.*RouterUsageWidget\.entitlements/);
  assert.match(ci, /local_entitlements=.*RouterUsageWidget\.local\.entitlements/);
  assert.match(
    ci,
    /lipo "\$app\/Contents\/Resources\/Control Center\.app\/Contents\/MacOS\/Codex Router" -verify_arch x86_64 arm64/,
  );
  assert.match(ci, /Smoke the unified macOS app lifecycle/);
  assert.match(ci, /"\$outer" --supervised/);
  assert.match(ci, /if ! last_state=\$\(query_lifecycle\); then\s+cat "\$log" >&2 \|\| true\s+return 1/);
  assert.match(ci, /terminate_bundle io\.github\.codex-router\.control-center/);
  assert.match(ci, /terminate_bundle io\.github\.codex-router\.tray/);
  assert.match(ci, /assert_single_outer_host/);
  assert.equal(
    (ci.match(/^[ ]+assert_single_outer_host$/gm) || []).length,
    2,
    "each macOS reopen must prove it did not create a second native host",
  );
  assert.match(ci, /test "\$second_pid" != "\$first_pid"/);

  // A process merely disappearing is not a successful lifecycle smoke test.
  assert.match(ci, /if wait "\$pid"; then/);
  assert.match(ci, /if \(\$open\.ExitCode -ne 0\)/);
  assert.match(ci, /if \(\$quit\.ExitCode -ne 0\)/);
  assert.match(ci, /if \(\$process\.ExitCode -ne 0\)/);
});

test("the macOS CI lifecycle probe reads real state without starting helper processes", () => {
  const ci = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const query = ci.slice(ci.indexOf("          query_lifecycle() {"), ci.indexOf("          wait_for_lifecycle() {"));
  const script = query.match(/node(?: --input-type=module)? -e '([\s\S]*?)'/)?.[1];
  assert.ok(script, "the smoke test must provide an executable Node lifecycle query");
  const directory = mkdtempSync(path.join(os.tmpdir(), "macos-ci-lifecycle-"));
  const stateFile = path.join(directory, "control-center-lifecycle.json");
  const updatedAt = new Date().toISOString();
  const live = { version: 1, pid: process.pid, ready: true, visible: true, updatedAt };
  const guard = `
    import { createRequire, syncBuiltinESMExports } from "node:module";
    const require = createRequire(import.meta.url);
    const childProcess = require("node:child_process");
    for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
      childProcess[method] = () => { throw new Error("A lifecycle observation must not launch a helper process"); };
    }
    syncBuiltinESMExports();
  `;
  try {
    for (const [record, running] of [[live, true], [{ ...live, pid: 2147483647 }, false], ["invalid JSON", false]]) {
      writeFileSync(stateFile, typeof record === "string" ? record : JSON.stringify(record));
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", guard + script], {
        cwd: root,
        env: { ...process.env, MODEL_ROUTER_CONTROL_CENTER_STATE: stateFile },
        encoding: "utf8", timeout: 10_000, maxBuffer: 8192, windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const state = JSON.parse(result.stdout);
      assert.equal(state.version, 1);
      assert.equal(state.running, running);
      assert.equal(state.pid, running ? process.pid : null);
      assert.equal(state.ready, running);
      assert.equal(state.visible, running);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
