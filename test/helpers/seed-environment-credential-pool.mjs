import { execFileSync } from "node:child_process";
import path from "node:path";

// Credential-store paths are bound to STATE_DIR when their module loads.
// Seed each independent fixture through the existing API in a child whose
// state root is that fixture, without invoking CLI publication or a manager.
export function seedEnvironmentCredentialPool(providerId, names, { stateDir, credentialStorePath, poolStatePath }) {
  const api = new URL("../../src/provider-api-key-control.mjs", import.meta.url).href;
  const source = `import { addEnvironmentCredentialToPool } from ${JSON.stringify(api)};
    for (const name of ${JSON.stringify(names)}) {
      await addEnvironmentCredentialToPool(${JSON.stringify(providerId)}, name);
    }`;
  execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      CODEX_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE: credentialStorePath ?? path.join(stateDir, "provider-credentials.json"),
      MODEL_ROUTER_API_KEY_POOL_PATH: poolStatePath ?? path.join(stateDir, "provider-api-key-pools.json"),
    },
    encoding: "utf8",
  });
}
