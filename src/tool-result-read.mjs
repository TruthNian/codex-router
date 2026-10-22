import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRetainedToolResult } from "./tool-result-recovery.mjs";

export function readToolResultCommand(args) {
  const [handle, ...rest] = args;
  const options = {};
  const flags = new Set();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i], value = rest[i + 1];
    if (!["--store", "--offset", "--limit", "--find"].includes(flag) || value === undefined || flags.has(flag)) {
      throw new Error("Usage: tool-result-read HANDLE [--store DIR] [--offset N] [--limit N] [--find TEXT]");
    }
    flags.add(flag);
    options[flag === "--store" ? "directory" : flag.slice(2)] =
      flag === "--offset" || flag === "--limit" ? Number(value) : value;
  }
  return readRetainedToolResult(handle, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(readToolResultCommand(process.argv.slice(2)))}\n`); }
  catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error.code || "read_failed", message: error.message })}\n`);
    process.exitCode = 1;
  }
}
