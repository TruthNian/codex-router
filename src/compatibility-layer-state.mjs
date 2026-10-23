import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";
import { routeExecution } from "./route-execution-plan.mjs";

export const COMPATIBILITY_LAYER_PATH = path.join(STATE_DIR, "compatibility-layer.json");

// Missing preserves existing installations. An explicit choice which cannot
// be read must never authorize execution of the optional Python gateway.
export function readCompatibilityLayerSettings() {
  try {
    const value = JSON.parse(readFileSync(COMPATIBILITY_LAYER_PATH, "utf8").replace(/^\uFEFF/u, ""));
    if (value?.version !== 1 || typeof value.enabled !== "boolean") {
      throw new Error("Invalid compatibility layer settings");
    }
    return { version: 1, enabled: value.enabled, configured: true };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, enabled: true, configured: false };
    return { version: 1, enabled: false, configured: true, invalid: true };
  }
}

export function setCompatibilityLayerEnabled(enabled) {
  if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
  writePrivateJson(COMPATIBILITY_LAYER_PATH, { version: 1, enabled }, { directoryMode: 0o700 });
  return { ...readCompatibilityLayerSettings(), path: COMPATIBILITY_LAYER_PATH,
    restartRequired: true };
}

export function requiresCompatibilityLayer(model, providerForModel) {
  return routeExecution(model, { providerForModel }).transport === "litellm";
}

export function compatibilityLayerError(model) {
  return { error: { type: "invalid_request_error", code: "compatibility_layer_disabled",
    message: `Model ${String(model).slice(0, 160)} requires the disabled compatibility layer. ` +
      "Enable it with control compatibility-layer on, prepare dependencies, restart the router and refresh catalogs." } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || "status";
  if (command === "status" || command === "required") {
    const state = readCompatibilityLayerSettings();
    process.stdout.write(command === "required" ? `${state.enabled ? "required" : "unused"}\n` :
      `${JSON.stringify({ ...state, path: COMPATIBILITY_LAYER_PATH })}\n`);
  } else if (["on", "off"].includes(command) && process.argv.length === 3) {
    process.stdout.write(`${JSON.stringify(setCompatibilityLayerEnabled(command === "on"))}\n`);
  } else {
    console.error("Usage: compatibility-layer-state.mjs status|required|on|off");
    process.exitCode = 2;
  }
}
