import {
  apiProvider,
  credentialLabel,
  credentialPaths,
  credentialSetupHint,
  credentialStatus,
  writeProviderCredential,
} from "./provider-credentials.mjs";
import { lstatSync } from "node:fs";
import { PROVIDER_CATALOG_CACHE_PATH, PROVIDER_SELECTION_PATH } from "./paths.mjs";
import { applyModelOverlayPublication, transactModelOverlayMutation } from "./model-overlay-publication.mjs";
import { operationDeadlineFromEnvironment } from "./process-tree.mjs";
import { providerNeedsCuration, removeApiCredential } from "./provider-onboarding.mjs";
import { withProviderCatalogCacheTransaction } from "./model-catalog-cache.mjs";
import { providerCatalogFamilyCacheIds } from "./provider-catalogs.mjs";
import { enableProvider } from "./provider-selection.mjs";
import { withModelOverlayLock } from "./model-overlay-lock.mjs";
import { promptForSecret } from "./secret-prompt.mjs";
import {
  targetCli,
  targetRestartHint,
} from "./target-integration.mjs";

const providerId = process.argv[2];
const command = process.argv[3] || "status";
const options = process.argv.slice(4);
const stage = options.includes("--stage");
const fromStdin = options.includes("--stdin");

if (!providerId || !new Set(["status", "set", "remove"]).has(command)
  || options.some((option) => !["--stage", "--stdin"].includes(option))
  || (fromStdin && command !== "set") || (stage && command === "status")) {
  console.error("Usage: provider-key.mjs PROVIDER status|set|remove [--stage] [--stdin]");
  process.exit(2);
}

const provider = apiProvider(providerId);
const credentialType = credentialLabel(provider);
const credentialNoun = credentialType === "API key" ? "key" : credentialType.toLowerCase();

export {
  powerShellStartupError,
  WINDOWS_HIDDEN_PROMPT_SCRIPT,
  windowsHiddenPromptArgs,
} from "./secret-prompt.mjs";

async function readSecretFromStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error("The provider credential is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function mutateCredential(mutate, changed = () => true) {
  const deadline = operationDeadlineFromEnvironment(process.env, {
    timeoutMs: 45 * 60_000, maximumMs: 45 * 60_000,
  });
  const files = [...credentialPaths(provider), PROVIDER_SELECTION_PATH, PROVIDER_CATALOG_CACHE_PATH];
  // Bootstrap explicitly stages credential/selection state. An ordinary CLI
  // change must adopt a prepared runtime before any installed client sees it.
  // Hold model -> catalog -> service order through exact-state rollback.
  await withModelOverlayLock(() => withProviderCatalogCacheTransaction((catalog) => {
    for (const file of files) {
      try {
        const entry = lstatSync(file);
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw new Error(`Managed provider state contains an incompatible file entry at ${file}; inspect it before changing the credential.`);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return transactModelOverlayMutation({
      files,
      mutate: () => mutate(catalog),
      restart: !stage,
      applyPublication: (operation) => stage || !changed()
        ? undefined : applyModelOverlayPublication(operation),
      lock: false,
      deadline,
    });
  }));
}

if (command === "status") {
  const status = credentialStatus(provider);
  const credentialLabel = provider.credential?.resolver ? "authentication" : "key";
  process.stdout.write(
    status.configured
      ? `${provider.displayName} ${credentialNoun} is configured via ${status.source}.${
          status.persistent
            ? ""
            : ` This environment-only ${credentialNoun} is not inherited by the background service; run the set command to save it securely.`
        }\n`
      : `${provider.displayName} ${credentialNoun} is not configured.\n`,
  );
  if (!status.configured) process.exitCode = 1;
} else if (command === "set") {
  if (provider.credential?.resolver) {
    throw new Error(`${provider.displayName} does not accept API keys; ${credentialSetupHint(provider)}`);
  }
  // The prompt stays in the controlling terminal; detached process trees
  // cannot open /dev/tty. Automated callers pass secrets solely through stdin.
  const value = fromStdin ? await readSecretFromStdin()
    : promptForSecret(provider.credential.prompt || `${provider.displayName} API key`);
  if (Buffer.byteLength(value, "utf8") > 16 * 1024) {
    throw new Error("The provider credential is too large.");
  }
  let target;
  await mutateCredential((catalog) => {
    target = writeProviderCredential(provider, value);
    catalog.forget(providerCatalogFamilyCacheIds(provider.id));
    enableProvider(provider.id);
  });
  process.stdout.write(
    `${provider.displayName} ${credentialNoun} saved to protected local storage at ${target}. The provider is enabled.${
      stage ? " Changes staged; setup will publish the models after router readiness." : ` ${targetRestartHint()}`
    }\n`,
  );
  if (providerNeedsCuration(provider.id)) {
    process.stdout.write(
      `${provider.displayName} ships no preselected models. Run \`${targetCli(`curate-models ${provider.id}`)}\` ` +
        `in an interactive terminal to choose which of its models appear in the picker.\n`,
    );
  }
} else {
  let removal;
  let noChange = false;
  await mutateCredential(async (catalog) => {
    removal = await removeApiCredential(provider.id);
    noChange = removal.removedFiles === 0;
    if (!noChange) catalog.forget(providerCatalogFamilyCacheIds(provider.id));
  }, () => !noChange);
  process.stdout.write(
    removal.removedFiles
      ? `Removed ${removal.removedFiles} managed ${provider.displayName} ${credentialNoun} file${removal.removedFiles === 1 ? "" : "s"} and disabled the provider.${
          stage ? " Changes staged; setup will publish the models after router readiness." : ` ${targetRestartHint()}`
        }\n`
      : `No managed ${provider.displayName} ${credentialNoun} file exists.\n`,
  );
  if (removal.stillConfigured) {
    process.stdout.write(
      `A ${provider.displayName} ${credentialNoun} is still available from ${removal.remainingSource}; remove it there to fully disconnect.\n`,
    );
  }
}
