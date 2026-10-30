import "./helpers/isolated-runtime-environment.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { spawnEnvironment } from "../src/npm-global-install.mjs";

const options = { recorded: {}, execArgv: [], platform: "win32" };
const nodeDir = path.dirname(process.execPath);

test("Windows CLI children keep inherited Path and emit only one case-insensitive key", () => {
  const inherited = { Path: "C:\\fixture-git\\bin;C:\\fixture-tools\\bin" };
  const actual = spawnEnvironment(inherited, options);
  assert.deepEqual(Object.keys(actual).filter((key) => key.toUpperCase() === "PATH"), ["Path"]);
  assert.equal(actual.Path, `${nodeDir};${inherited.Path}`);
  assert.deepEqual(inherited, { Path: "C:\\fixture-git\\bin;C:\\fixture-tools\\bin" });
  assert.equal(spawnEnvironment(actual, options).Path, actual.Path, "Node is prepended only once");
});

test("duplicate Windows spellings preserve Node's selected path; POSIX remains case-sensitive", () => {
  const windows = spawnEnvironment({ Path: "ignored", PATH: "selected" }, options);
  assert.deepEqual(Object.keys(windows).filter((key) => key.toUpperCase() === "PATH"), ["PATH"]);
  assert.equal(windows.PATH, `${nodeDir};selected`);
  const posix = spawnEnvironment({ Path: "unrelated", PATH: "/fixture/bin" }, { ...options, platform: "linux" });
  assert.equal(posix.Path, "unrelated");
  assert.equal(posix.PATH, `${nodeDir}:/fixture/bin`);
});
