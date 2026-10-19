import { writeFileSync } from "node:fs";
import { lifecycleStatePath, queryLifecycleState } from "../apps/control-center/electron/lifecycle-state.mjs";

// Startup observers must not register another GUI application with macOS.
// Use the same path selection, schema validation and live-PID check as the
// packaged --query-lifecycle handler, without starting the Electron executable.
writeFileSync(1, `${JSON.stringify(queryLifecycleState(lifecycleStatePath()))}\n`);
