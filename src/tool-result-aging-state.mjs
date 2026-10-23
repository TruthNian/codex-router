import {
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";
import {
  RETENTION_DEFAULT_TTL_DAYS,
  RETENTION_MAX_TTL_DAYS,
  RETENTION_MIN_TTL_DAYS,
  retentionTtlMsFromDays,
} from "./tool-result-retention.mjs";
import { toolResultAgingTotals } from "./usage-events.mjs";
import { TOOL_RESULT_AGING_MIN_BYTES } from "./tool-result-aging.mjs";

export const TOOL_RESULT_AGING_STATE_PATH =
  process.env.MODEL_ROUTER_TOOL_RESULT_AGING_STATE ||
  path.join(STATE_DIR, "tool-result-aging.json");

// Both paths default off. Compaction rewrites tool results the model already
// acted on: it saves real context, but it is a change to what the model sees
// mid-conversation, and its savings figures are still being validated against
// provider-billed tokens. That is an experiment to opt into, not a default to
// discover after it has already altered a session. The structural rule from
// the vision bridge applies here too -- an absent file means nobody has
// answered and the current default applies, while a stored value is the
// operator's own answer and is kept verbatim, so turning this on survives any
// later change of default.
function defaultSettings() {
  return {
    version: 1,
    enabled: false,
    nativeEnabled: false,
    retentionTtlDays: RETENTION_DEFAULT_TTL_DAYS,
    defaulted: true,
  };
}

function disabledSettings() {
  return {
    version: 1,
    enabled: false,
    nativeEnabled: false,
    retentionTtlDays: RETENTION_DEFAULT_TTL_DAYS,
  };
}

// How long a retained original lives. Absent means nobody has answered, so the
// default applies and a later release may change it; a stored number is the
// operator's own answer and is kept verbatim, including `0`, which is "keep
// them until I say otherwise" and is the one answer a default must never
// overwrite -- expiry deletes bytes the model already saw.
function readRetentionTtlDays(value) {
  if (value === undefined || value === null) return RETENTION_DEFAULT_TTL_DAYS;
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) return RETENTION_DEFAULT_TTL_DAYS;
  if (days === 0) return 0;
  return Math.min(RETENTION_MAX_TTL_DAYS, Math.max(RETENTION_MIN_TTL_DAYS, days));
}

export function readToolResultAgingSettings() {
  if (!existsSync(TOOL_RESULT_AGING_STATE_PATH)) return defaultSettings();
  try {
    const parsed = JSON.parse(readFileSync(TOOL_RESULT_AGING_STATE_PATH, "utf8"));
    if (parsed?.version === 1 && typeof parsed.enabled === "boolean") {
      return {
        version: 1,
        enabled: parsed.enabled,
        // Absent on files written before the native flag existed; absence is
        // the off default, never an error.
        nativeEnabled: parsed.nativeEnabled === true,
        // Absent on every file written before the TTL existed, which reads as
        // the default rather than as "keep forever" -- those installs never
        // had a choice to preserve.
        retentionTtlDays: readRetentionTtlDays(parsed.retentionTtlDays),
        ...modelThresholds(parsed.modelMinBytes),
        ...readbackHintSettings(parsed.readbackHintModels),
      };
    }
  } catch {
    // A malformed explicit choice must not silently change routed context.
  }
  return disabledSettings();
}

// Per-model opt-in only. Existing installations keep the 32KiB policy; an
// invalid entry cannot lower the floor. Keep the frontier and recovery checks
// in the shared aging pass, regardless of this size policy.
function validModel(model) {
  return typeof model === "string" && /^[a-z0-9][a-z0-9._/-]{0,199}$/u.test(model);
}

function validMinBytes(value) {
  return Number.isSafeInteger(value) && value >= 8 * 1024 && value <= TOOL_RESULT_AGING_MIN_BYTES;
}

function modelThresholds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter(([model, bytes]) => validModel(model) && validMinBytes(bytes));
  return entries.length ? { modelMinBytes: Object.fromEntries(entries) } : {};
}

function readbackHintSettings(value) {
  const models = Array.isArray(value) ? [...new Set(value.filter(validModel))].sort() : [];
  return models.length ? { readbackHintModels: models } : {};
}

export function toolResultAgingOptions(model) {
  const settings = readToolResultAgingSettings();
  return {
    minBytes: settings.modelMinBytes && Object.hasOwn(settings.modelMinBytes, model)
      ? settings.modelMinBytes[model] : TOOL_RESULT_AGING_MIN_BYTES,
    readbackHint: settings.readbackHintModels?.includes(model) === true,
    ...(settings.readbackHintModels?.includes(model) === true ? { minSavingsBytes: 128 * 1024 } : {}),
  };
}

export function toolResultAgingMinBytes(model) {
  return toolResultAgingOptions(model).minBytes;
}

export function setToolResultReadbackHint(model, enabled) {
  if (!validModel(model) || typeof enabled !== "boolean") throw new Error("Readback hint requires a model slug and boolean.");
  const current = readToolResultAgingSettings();
  const models = new Set(current.readbackHintModels || []);
  if (enabled) models.add(model);
  else models.delete(model);
  const { defaulted: _defaulted, readbackHintModels: _previous, ...rest } = current;
  return writeSettings({ ...rest, ...readbackHintSettings([...models]) });
}

export function setToolResultAgingMinBytes(model, bytes) {
  if (!validModel(model)) throw new Error("Aging threshold requires a valid model slug.");
  if (bytes !== undefined && !validMinBytes(bytes)) {
    throw new Error("Aging threshold must be an integer between 8192 and 32768 bytes.");
  }
  const current = readToolResultAgingSettings();
  const entries = new Map(Object.entries(current.modelMinBytes || {}));
  if (bytes === undefined) entries.delete(model);
  else entries.set(model, bytes);
  const { defaulted: _defaulted, modelMinBytes: _previous, ...rest } = current;
  return writeSettings({ ...rest, ...modelThresholds(Object.fromEntries(entries)) });
}

function writeSettings(settings) {
  writePrivateJson(TOOL_RESULT_AGING_STATE_PATH, settings, { directoryMode: 0o700 });
  return settings;
}

export function setToolResultAgingEnabled(enabled) {
  const current = readToolResultAgingSettings();
  return writeSettings({
    version: 1,
    enabled: enabled === true,
    nativeEnabled: current.nativeEnabled === true,
    retentionTtlDays: current.retentionTtlDays,
    ...modelThresholds(current.modelMinBytes),
    ...readbackHintSettings(current.readbackHintModels),
  });
}

export function setNativeToolResultAgingEnabled(enabled) {
  const current = readToolResultAgingSettings();
  return writeSettings({
    version: 1,
    enabled: current.enabled === true,
    nativeEnabled: enabled === true,
    retentionTtlDays: current.retentionTtlDays,
    ...modelThresholds(current.modelMinBytes),
    ...readbackHintSettings(current.readbackHintModels),
  });
}

/**
 * Choose how long retained originals live. `0` keeps them until an explicit
 * purge; `undefined` restores the default and lets a later release move it.
 */
export function setRetentionTtlDays(days) {
  const current = readToolResultAgingSettings();
  let requested;
  if (days === undefined || days === null || days === "") {
    requested = RETENTION_DEFAULT_TTL_DAYS;
  } else {
    const value = Number(days);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `Retention TTL must be a number of days, or 0 to keep retained results: ${days}`,
      );
    }
    if (value > 0 && (value < RETENTION_MIN_TTL_DAYS || value > RETENTION_MAX_TTL_DAYS)) {
      throw new Error(
        `Retention TTL must be 0 (off) or between ${RETENTION_MIN_TTL_DAYS} and ` +
          `${RETENTION_MAX_TTL_DAYS} days: ${days}`,
      );
    }
    requested = value;
  }
  return writeSettings({
    version: 1,
    enabled: current.enabled === true,
    nativeEnabled: current.nativeEnabled === true,
    retentionTtlDays: requested,
    ...modelThresholds(current.modelMinBytes),
    ...readbackHintSettings(current.readbackHintModels),
  });
}

export function retentionTtlDays() {
  return readToolResultAgingSettings().retentionTtlDays;
}

// The lifetime every reader of the store resolves. The environment kill switch
// is deliberately not consulted: it stops the router rewriting request context,
// and expiry is disk hygiene for bytes that were already written -- silencing
// compaction is no reason to keep an aging archive alive forever.
export function retentionTtlMs() {
  return retentionTtlMsFromDays(retentionTtlDays());
}

export function toolResultAgingEnabled() {
  if (process.env.CODEX_ROUTER_TOOL_RESULT_AGING === "0") return false;
  return readToolResultAgingSettings().enabled;
}

// The environment kill switch silences both paths: it exists to stop the
// router rewriting request context at all, not one flavor of it.
export function nativeToolResultAgingEnabled() {
  if (process.env.CODEX_ROUTER_TOOL_RESULT_AGING === "0") return false;
  return readToolResultAgingSettings().nativeEnabled === true;
}

export function toolResultAgingSnapshot() {
  const settings = readToolResultAgingSettings();
  const environmentOverride = process.env.CODEX_ROUTER_TOOL_RESULT_AGING === "0";
  return {
    ...settings,
    enabled: environmentOverride ? false : settings.enabled,
    configured: existsSync(TOOL_RESULT_AGING_STATE_PATH),
    environmentOverride,
    path: TOOL_RESULT_AGING_STATE_PATH,
    // Cumulative savings derived from recorded usage events, so every status
    // surface (CLI, desktop, tray) can show what the feature actually bought.
    stats: toolResultAgingTotals(),
  };
}
