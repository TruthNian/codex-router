// One observed service-manager snapshot. A failed query or contradictory
// registration/process facts cannot authorize a mutation as if stopped.
export function normalizeServiceStatus(status) {
  const installed = status?.installed === true;
  const loaded = status?.loaded === true;
  const state = typeof status?.state === "string" ? status.state : "unknown";
  const known = typeof status?.installed === "boolean"
    && typeof status?.loaded === "boolean"
    && state.trim() !== "" && state.toLowerCase() !== "unknown"
    && status?.statusUnknown !== true
    && (loaded || !["running", "active"].includes(state.toLowerCase()));
  return { installed, loaded, state: known ? state : "unknown", ...(!known ? { statusUnknown: true } : {}) };
}

export function assertKnownServiceStatus(status) {
  const observed = normalizeServiceStatus(status);
  if (observed.statusUnknown) {
    throw Object.assign(new Error("The background service state could not be verified; no caller capability was changed."), {
      code: "SERVICE_STATUS_UNKNOWN",
    });
  }
  return observed;
}
