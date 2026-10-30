# Codex Router repository guidance

## Maintenance

Use `.agents/skills/repo-maintainer/SKILL.md` for consequential changes across
routing, providers, clients, credentials, lifecycle or packaging. Scale checks
to the affected behavior. Preserve unrelated edits.

Record user-visible changes in `changelog.d/<short-slug>.md`.
The release assembler owns `CHANGELOG.md`.

## Sources of truth

- Installation and supported methods: [README](README.md),
  [installation guide](docs/INSTALL.md), [client guide](docs/COMPATIBLE-APPS.md).
- Provider setup and authentication: [provider guide](docs/PROVIDERS.md).
- Routing and context behavior: [Codex guide](docs/CODEX.md),
  [architecture](docs/HOW-IT-WORKS.md).
- Subagent selection: [capability contract](docs/SUBAGENT-CERTIFICATION.md).
- Python compatibility policy: [compatibility layer](docs/compatibility-layer.md).
- Desktop packaging: [desktop companion](docs/DESKTOP-TRAY.md),
  [macOS tray](docs/MACOS-TRAY.md).

Read the relevant implementation and its actual callers before changing a
contract. Historical incidents and feature proposals are not new requirements.

## Runtime boundaries

One shared router plane serves the installed clients. Target selection changes
client configuration, not service identity, ports or credential ownership.
Preserve unrelated client settings and authentication artifacts.

Route the exact selected model, endpoint and account. Preserve model IDs and
opaque protocol data. Request completion follows real protocol termination;
answer wording, HTTP EOF and missing caller output do not prove completion or
that a generation POST was never executed.

Honor explicit provider selection, discovery opt-outs and per-model settings
at their consumers. Resolve credentials through the existing owner; caches and
UI projections do not independently choose an account or expand authorization.

Keep caller capabilities on authenticated local boundaries. Pass only the
provider's own credentials upstream. Secrets belong in private local prompts
and stores, outside chat, command arguments, tracked files and logs.

Antigravity uses an operator-owned Google OAuth client.
Never read or reuse the official `agy`/IDE credential store.
Bind its callback to an OS-assigned port
and identify the app truthfully as Codex Router. The explicit
`providers probe antigravity-oauth --live --yes` operation spends provider quota.

A mutation owns its processes, files and rollback through actual settlement.
A timeout or a PID alone does not grant permission to kill a process, recover
a live transaction or delete another installation. Preserve the distinction
between running, stopped and unknown.

Old tool output may be omitted only with the committed exact original and
usable authenticated readback in the same permission scope. Failed storage or
readback keeps the original. Preserve instruction reads and current results.

## Verification

Use synthetic credentials and isolated temporary homes/state before source
imports. Stub host Keychain access. Run the relevant focused tests and
`npm run check`; use the isolated `npm test` entrypoint for the full suite.
Client UI changes also need their build and behavior checks. Platform-specific
checks belong on the corresponding platform; report skips accurately.

Verify failures with a control that distinguishes the old and new behavior.
Keep necessary checks for real ownership and protocol boundaries; delete dead
features and duplicate authorities before adding another repair layer.

Production installation, service interruption, proxy changes and paid provider
probes require the user's task authorization. During an authorized install,
follow the installation guide and leave the final client restart to the user.
