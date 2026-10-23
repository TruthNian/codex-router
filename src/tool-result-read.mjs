import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRetainedToolResult, searchRetainedToolResults } from "./tool-result-recovery.mjs";

export function readToolResultCommand(args) {
  const [handle, ...rest] = args;
  const options = {};
  const flags = new Set();
  let search = false;
  for (let i = 0; i < rest.length;) {
    const flag = rest[i], value = rest[i + 1];
    if (flag === "--scope-search" && !flags.has(flag)) {
      flags.add(flag); search = true; i += 1; continue;
    }
    if (!["--store", "--offset", "--limit", "--find", "--cursor", "--index"].includes(flag) || value === undefined || flags.has(flag)) {
      throw new Error("Usage: tool-result-read HANDLE [--store DIR] [--offset N] [--limit N] [--find TEXT] [--scope-search [--cursor N --index HASH]]");
    }
    flags.add(flag);
    options[flag === "--store" ? "directory" : flag.slice(2)] =
      ["--offset", "--limit", "--cursor"].includes(flag) ? Number(value) : value;
    i += 2;
  }
  if ((search && flags.has("--offset")) || (!search && (flags.has("--cursor") || flags.has("--index")))) {
    throw new Error("Use --offset for a single archive; --cursor and --index only with --scope-search.");
  }
  if (search) return searchRetainedToolResults(handle, options);
  return readRetainedToolResult(handle, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(readToolResultCommand(process.argv.slice(2)))}\n`); }
  catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error.code || "read_failed", message: error.message })}\n`);
    process.exitCode = 1;
  }
}
