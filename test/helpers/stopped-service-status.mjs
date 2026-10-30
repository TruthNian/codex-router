import path from "node:path";
import { fileURLToPath } from "node:url";

// Only the three CLI publication/ownership fixtures opt into this preload.
// Keep the CLI, locks, health probes and metadata writes real while replacing
// its exact read-only service-status child, without querying a host manager.
const serviceScript = fileURLToPath(new URL("../../src/service.mjs", import.meta.url));
if (process.argv.length === 3
    && path.resolve(process.argv[1]) === serviceScript
    && process.argv[2] === "status") {
  await new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify({ installed: false, loaded: false, state: "stopped" })}\n`,
      error => error ? reject(error) : resolve());
  });
  process.exit(0);
}

export function stoppedServiceStatusEnvironment() {
  return {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${JSON.stringify(import.meta.url)}`.trim(),
  };
}
