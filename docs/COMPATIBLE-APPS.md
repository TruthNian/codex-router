# Compatible clients

English · [简体中文](zh-CN/COMPATIBLE-APPS.md) · [日本語](ja/COMPATIBLE-APPS.md)

One installation serves all supported clients: one router service, one provider
selection, and one credential store. A target names the client configuration
being changed, not another router. Install a client before enabling its
integration unless the documented setup action explicitly offers to install it.

Commands below use a macOS/Linux source checkout. On Windows use
`.\model-router.ps1 TARGET COMMAND` instead of `./bin/model-router TARGET COMMAND`
and `node src/control.mjs` instead of `./bin/control`. Client installation and
restart requirements differ; read the matching section before changing an
existing setup.

- [DeepSeek Harness](#make-models-appear-in-deepseek-harness)
- [Gemini CLI](#make-models-appear-in-gemini-cli)
- [Cursor Agent and App](#make-models-appear-in-cursor)
- [Claude Code](#make-models-appear-in-claude-code)
- [OpenClaw](#make-models-appear-in-openclaw)
- [opencode, pi, omp, Command Code, and Hermes](#make-models-appear-in-opencode-pi-omp-command-code-and-hermes-agent)
- [Subscription agent bridges](#subscription-agent-bridges-experimental)
- [T3 Code](#t3-code)

## Make models appear in DeepSeek Harness

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)
reads its provider routes from `$DSH_HOME/settings.yaml`, which it watches and
hot-reloads. Its shipped bundle mounts the generic `dsh-llm-pi-ai` adapter
*dormant* — zero routes until a settings section supplies some — so publishing
every routed model into it is a settings write, not a plugin or composition
change.

```sh
./install.sh --target dsh --auto --providers configured
# or, on an install that already serves Codex:
./bin/model-router dsh enable
```

That writes one route, `llm-pi-ai.providers.codex-router`, and one credential
reference, `CODEX_ROUTER_CALLER_KEY`, into `$DSH_HOME/.credentials.yaml`:

```yaml
llm-pi-ai:
  providers:
    codex-router:
      displayName: "Codex Router"
      api: "openai-responses"
      baseURL: "http://127.0.0.1:4202/_codex-router/…/v1"
      apiKeyEnv: "CODEX_ROUTER_CALLER_KEY"
      models:
        - id: "deepseek/deepseek-v4-pro"
          name: "DeepSeek V4 Pro (API)"
          contextWindow: 1048576
          input:
            - "text"
          reasoningEfforts:
            high: "high"
            max: "max"
```

Nothing needs restarting: the harness picks the route up on its next request,
and every model appears in its Models page with the context window, image
support, and reasoning efforts the registry records.

**What you keep.** The route points at the same endpoint Codex uses, so a
harness turn goes through the same routed request path and gets the same
router capabilities: tool-result ageing, the vision bridge for text-only
models, the substituted prompt-token count that keeps compaction working
against providers that report zero, bounded upstream retries, and the usage
and tokens-per-second accounting behind `node src/control.mjs provider-usage --json`.

**What is preserved.** The router owns that one route and that one credential
and nothing else. Other provider routes, other settings sections, your
comments, and your other stored keys are left exactly as they were —
`./bin/model-router dsh disable` removes the route and restores the document.
A settings file this build cannot read unambiguously is refused with the file
untouched rather than rewritten on a guess.

**Native GPT models require one explicit local authorization.** They are
authorized by a ChatGPT session and a harness request carries none of its own.
Sign in through the official Codex browser flow, then authorize this shared
router plane once:

```sh
codex login
./bin/model-router codex chatgpt-session enable
```

DeepSeek Harness, Gemini CLI, OpenClaw, and future clients installed for this same OS
user then reuse that one authorization over the loopback; there is no login per
harness and the marker stores no credential. Native models are withheld until
both the authorization and a usable Codex session exist, and disappear again
when the session is missing or expired. Run `codex login` to renew the session;
the one-time authorization remains in place.

It is a fallback and never an override: a request that presents its own
credential is relayed untouched, so nothing about a Codex turn changes. The
authorization widens what the local caller key reaches, from API-key providers
to your ChatGPT subscription as well. Revoke it everywhere with
`./bin/model-router codex chatgpt-session disable`; Codex stays signed in and
keeps its own native models. Headless operators may set
`CODEX_ROUTER_NATIVE_SESSION_FALLBACK=1` as an explicit opt-in (`0` always
forces it off).

**Subagents.** A child spawned by `dsh-tool-subagent` with no model of its own
inherits the default model selection, so it is already routed once this route
is the default. To put children on a *different* routed model, paste the block
from `./bin/model-router dsh subagent-preset` into your preset's
`agent.cordis.yml` — the router will not edit a preset it does not own.

## Make models appear in Gemini CLI

[Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`) speaks only
the Gemini API, so the router serves it one: a Gemini-shaped endpoint that
translates each turn into the same Responses request Codex makes and answers
with the same models. Google ships no bring-your-own-provider setting, but the
CLI does read its endpoint, its credential, and its default model from the
environment — which is the whole integration.

```sh
./install.sh --target gemini --auto --providers configured
# or, on an install that already serves Codex:
./bin/model-router gemini enable
```

That writes one marker block into `~/.gemini/.env`:

```sh
# BEGIN codex-router-gemini
GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:4202/_codex-router/<caller-key>/gemini
GEMINI_API_KEY=<caller-key>
GEMINI_MODEL=deepseek/deepseek-v4-flash
# END codex-router-gemini
```

The next `gemini` run picks it up — there is nothing to restart. If the CLI asks
how to authenticate, choose **Use Gemini API key** once; the key is this
router's local caller capability, not a Google one, and it never leaves the
machine.

**What is preserved.** Your `settings.json` is never opened for writing: it is
JSONC and carries your comments, and this integration does not need it. Every
other line of `~/.gemini/.env` is left exactly as it was, and
`./bin/model-router gemini disable` removes the block and restores the file. An
assignment of one of those three keys *outside* the block stops the publish with
the line named rather than being silently overwritten — `dotenv` lets the last
assignment win, so a duplicate would quietly decide which endpoint is in force.

**Picking a model.** `--model vendor/slug` overrides the published default for
one run; `GEMINI_MODEL` in the block is the default for the rest. Pass
`--no-default-model` to `src/gemini-config-manager.mjs install` to leave the key
out entirely, in which case the CLI falls back to its own Gemini default — which
this router does not route, so a turn without `--model` will be refused by name.

**What is not served.** Gemini embeddings (`:embedContent`) are refused with a
named 501. The separate OpenAI-compatible `/v1/embeddings` surface is explicitly
model-gated and is not translated into Gemini's contract; a fabricated vector
would be worse than an error. `:countTokens` is answered from a byte-count
estimate rather than by spending a real turn upstream.

**Native GPT models** publish here under the same rule as the harness, described
above: after the one-time shared-plane authorization, while this machine has a
usable Codex session, and withheld the moment either condition stops holding.

## Make models appear in Cursor

The `cursor` target serves both official clients through different edges:

- `cursor-router-agent` launches Cursor Agent against the router's authenticated
  loopback Connect/protobuf adapter.
- Cursor App uses OpenAI BYOK. Retail Cursor sends those requests through
  Cursor's backend, so a loopback URL is rejected; the app needs a stable public
  HTTPS tunnel forwarding to the app-only edge on `127.0.0.1:4214`.

In the Control Center's Harness page, nothing Cloudflare-related runs during
detection or page load. **Connect Cursor** is one resumable action: it installs
the fixed connector when needed, opens `cloudflared tunnel login`, resolves the
domain selected during browser authorization, creates a unique named hostname,
waits for Cursor to be fully quit, publishes and verifies the routed catalog,
then reopens Cursor. Progress stays inside the Cursor row. The Cloudflare token
is used only for that one zone-name lookup and is never returned to the
renderer, logged, or copied into router state.

A domain managed by the user's Cloudflare account is the only external
prerequisite. Cursor's retail BYOK backend cannot call a loopback-only service,
and Cloudflare cannot create stable public DNS without a domain. Users who
already have a preferred public hostname can expand **Use an existing
Cloudflare hostname**; everyone else leaves it blank.
The equivalent CLI path is to install `cloudflared`, run `cloudflared tunnel
login` once, and then give the router a hostname on that Cloudflare account. It
adds the DNS route, writes the edge-only ingress, and keeps the connector
running with the router service:

```sh
./install.sh --target cursor --auto --providers configured \
  --cursor-hostname cursor-router.example.com

# Or add Cursor to an existing router. Fully quit Cursor first.
./bin/model-router cursor enable \
  --hostname cursor-router.example.com
```

An already-managed tunnel remains supported with `--cursor-public-url
https://cursor-router.example.com`; that is the advanced/manual path.

The public hostname must not point at the main router port. Port 4214 exposes
only the secret-bearing `/v1/models` and `/v1/chat/completions` app surface;
accepted requests re-enter the same `/v1/responses` path used by Codex. Cursor
misclassifies a custom id that contains one of its built-in model ids and then
rejects it with “This model does not support custom API keys.” The router
therefore publishes readable, collision-safe ids such as
`codex_router/gpt_5_6_sol__419255f2/high`. The suffix is the reasoning effort;
choose another row for Low, Medium, High, and so on. Cursor does not expose its
native effort control for ordinary user-added BYOK models.

```sh
cursor-router-agent --list-models
# Copy one exact id from that list, including its effort suffix.
cursor-router-agent --model 'PASTE_ID_FROM_THE_LIST' --print "Reply with OK"
```

Reopen Cursor App and choose a `codex_router/...` model. Cursor's base-URL override
is global, so Cursor-managed models (`Auto`/`default`, `grok-4.6`, Claude, Composer,
and other first-party ids) are also sent to the custom endpoint while it is enabled
and then rejected with “This model does not support custom API keys.” Turn the
override off when switching back to Cursor's own models. `cursor enable` switches
the composer selection away from those Cursor-managed ids onto a published
`codex_router/...` alias.

Cursor Agent text turns are supported and verified against the official CLI.
Its local read/shell/edit/write loop is also mapped onto Cursor's controlled-
exec protocol: Cursor applies its permission mode and performs the operation,
then the router resumes the selected model with the typed result. Cursor MCP
tools use a separate exec shape and are not advertised yet. Cursor App Agent
requests continue through Cursor's own orchestration.

`./bin/model-router cursor disable` removes router-owned aliases and restores
the prior base URL and BYOK toggle when they still match the published values.
Cursor must be fully stopped for enable, repair, or disable because it owns its
SQLite settings database while running.

## Make models appear in Claude Code

The `claude` target adds a private `claude-router` launcher. It does not edit
Claude Code's settings or replace its login. The launcher points only that
process at the router's loopback Anthropic Messages surface and enables gateway
model discovery:

```sh
./install.sh --target claude --auto --providers configured
# or add Claude Code to an existing router
./bin/model-router claude enable

claude-router
# then use /model and choose codex_router/anthropic/<provider>/<model>
```

All selected, credentialed routes are discoverable—not only Anthropic models.
Messages, tools, tool results, images, streaming, and token estimates are
translated into the router's canonical `/v1/responses` request path, so the
same failover, usage accounting, provider credentials, and model selection
apply. Anthropic documents gateways for Claude models; non-Claude routed models
work through this compatibility layer but are not an Anthropic-supported Claude
Code configuration.

Claude models in Codex Router remain the other direction: enable
`anthropic-api` and store an Anthropic API key through the hidden prompt. A
Claude.ai subscription login is not converted into a reusable API credential.

For the Gemini CLI integration:

```sh
./bin/model-router gemini enable         # publish the routed models
./bin/model-router gemini doctor
./bin/model-router gemini status
./bin/model-router gemini disable        # remove the managed block, keep the rest
```

For Cursor Agent and Cursor App, quit Cursor before mutations:

```sh
./bin/model-router cursor enable --hostname cursor-router.example.com
./bin/model-router cursor doctor
./bin/model-router cursor status
./bin/model-router cursor disable
```

For Claude Code:

```sh
./bin/model-router claude enable
./bin/model-router claude doctor
./bin/model-router claude status
./bin/model-router claude disable
```

## Make models appear in OpenClaw

The `openclaw` target is the one-click path from the Control Center's Harness
page. **Set up** installs the official `openclaw@latest` npm package when it is
missing, then publishes every selected, credentialed router model under one
OpenClaw provider:

```sh
./install.sh --target openclaw --auto --providers configured
# or add OpenClaw to an existing router
./bin/model-router openclaw enable

openclaw
```

The router owns only `models.providers.codex-router` and a private publication
marker. It writes the provider through `openclaw config patch --stdin`, so the
local caller capability never appears in command arguments. Existing OpenClaw
agents, channels, plugins, and other providers stay untouched. If no default
model exists on first setup, the router selects its highest-priority route; an
existing default or a later user override is preserved.

OpenClaw model references use `codex-router/<router-slug>` and speak
`openai-responses` to the same authenticated loopback path as the other local
clients. Context windows, text/image input, and the router's exact reasoning
effort ladder are published with each model. Disable removes only the managed
provider and removes the default only when it is still the value the router
set:

```sh
./bin/model-router openclaw doctor
./bin/model-router openclaw status
./bin/model-router openclaw disable
```

OpenClaw's AgentHarnessV2 API is a native runtime-plugin boundary, not a new
HTTP model protocol. The router therefore remains an ordinary Responses model
provider; when no native plugin claims the route, OpenClaw correctly uses its
embedded runtime. No restart is required after publication.

The optional live check makes one small request per selected provider and may
consume paid quota:

```sh
./bin/model-router codex smoke-test --yes
```

`disable` removes only the selected client integration and retires the shared
service only when no installed client still uses it.
`uninstall` intentionally retains the checkout, logs, backups, internal keys,
and provider credentials so routine removal cannot destroy authentication or
recovery data.

## Make models appear in opencode, pi, omp, Command Code, and Hermes Agent

Five more coding clients keep their providers in a configuration document you
also own. The Control Center's Harness page lists each of them, and **Set up**
is the whole integration: install the client's CLI when this router can, then
write the one provider key the router owns into that document.

| Client | Document the router edits | Wire | Install |
| --- | --- | --- | --- |
| opencode | `~/.config/opencode/opencode.json` | Responses | `opencode-ai` |
| pi | `~/.pi/agent/models.json` | Responses | `@earendil-works/pi-coding-agent` |
| omp (oh-my-pi) | `~/.omp/agent/models.yml` | Responses | install omp yourself first ([omp.sh](https://omp.sh/); it runs on Bun) |
| Command Code | `~/.commandcode/providers.json` | Anthropic Messages | `command-code` 1.30.0 or later (setup updates an older one) |
| Hermes Agent | `~/.hermes/config.yaml` | Anthropic Messages | install Hermes yourself first |

opencode honours `OPENCODE_CONFIG`, pi and omp both honour
`PI_CODING_AGENT_DIR`, and omp's `models.yaml` is edited in place when it has
no `models.yml` beside it, so the router writes the file each client actually
reads.

From the terminal, the same action is one command per client:

```sh
./bin/control client-setup opencode
./bin/control client-setup pi
./bin/control client-setup omp
./bin/control client-setup commandcode
./bin/control client-setup hermes

./bin/control client-disconnect opencode
```

**Keeping them current is its own command.** Setup installs a client that is
missing, but deliberately leaves one that is already there at the version you
have — bumping a global coding agent is not something that should happen
because you republished a model list. To move them:

```sh
./bin/control client-update opencode   # runs `opencode upgrade`
./bin/control client-update --all      # every client you actually have
```

Each runs the client's *own* updater (`opencode upgrade`, `pi update --self`,
`command-code update`, `hermes update --yes`) rather than `npm install -g`, so
a CLI you installed with Homebrew or a `curl | sh` script is updated in place
instead of gaining a second npm copy that may win or lose on PATH. omp has
neither, so its row prints the project's own installs. `--all` skips clients
you have not installed and reports each one rather than stopping at the first
failure. The Harness page has the same thing as an **Update** button per row
and **Update all** in the header.

Each client is published *into* rather than installed *as*: there is no
`MODEL_ROUTER_TARGET` for these five and no second service. They share the
router plane every other client uses, so enabling a provider, storing a key, or
curating a model republishes all of them together and no picker is left
advertising a model the others just lost.

**The wire is one the router already serves.** Clients that speak the Responses
API are pointed at the authenticated loopback `/v1` path with the router's own
slugs. Command Code and Hermes have no Responses client, so they are pointed at
the same Anthropic Messages surface Claude Code uses, with
`codex_router/anthropic/<router-slug>` ids. No client is handed a protocol the
router does not implement.

**The router owns one key and nothing else.** That is
`provider.codex-router` (opencode, Command Code) or `providers.codex-router`
(pi, omp, Hermes), plus a private publication marker in the router's own state
directory. YAML documents are spliced by line range rather than parsed and
rewritten, so comments, hand-formatting, and every sibling provider survive a
publish. A JSON document the router cannot round-trip — one carrying `//`
comments, or an `opencode.jsonc` sitting beside `opencode.json` — is refused
with an explanation rather than reformatted.

A `codex-router` provider whose base URL this router did not issue is treated
as somebody else's: both setup and disconnect refuse rather than overwrite it.
opencode's default model is claimed only when you have not chosen one, and is
released again the moment you pick your own. Every published document is
written `0600`, because the base URL carries the local caller capability as a
path segment.

Removing one of these clients never retires the shared service while another
client is still pointed at it:

```sh
./bin/control client-disconnect hermes
```

## Subscription agent bridges (experimental)

The Harness page also detects three optional, client-owned agent sessions:
Claude Code, Cursor Agent, and Gemini CLI. These are deliberately separate from
the `codex_router/...` model catalog:

- Claude runs through the installed official `claude` process and its existing
  Claude.ai login. A successful `claude auth status` proves login only; the
  account must separately be entitled to use non-interactive/SDK turns. The
  bridge reports Anthropic's refusal verbatim when it is not.
- Cursor Agent runs through its official ACP stdio server (`agent acp`).
- Gemini CLI runs through its official ACP stdio server (`gemini --acp`).

The router never reads or copies those clients' OAuth tokens. It stores only
bounded metadata for sessions created through the bridge: client, session ID,
workspace path, and timestamps. Prompts and transcripts stay out of the bridge
index. File-system and terminal capabilities are not advertised yet, and
permission requests are rejected by default until the Control Center has a
foreground approval surface.

These bridges run the owning clients' agent processes and use those clients'
sessions and quotas. They are listed separately from the routed model catalog.

Inspect the optional bridges without spending a model request:

```sh
./bin/model-router codex agents status
./bin/model-router codex agents probe anthropic
./bin/model-router codex agents probe cursor
./bin/model-router codex agents probe gemini
```

Run a prompt only when you intend to spend the owning client's quota. Prompt
text is read from stdin so it is absent from the process list:

```sh
printf '%s' 'Explain this repository.' |
  ./bin/model-router codex agents prompt anthropic --cwd "$PWD"
```

Claude prompts also accept `--model` and `--effort`, including when resuming
with `--session`. See the [adaptive worker routing pilot](experiments/adaptive-worker-routing.md)
for the supported controls and an offline comparison of routing policies.

The ACP integrations follow the official [Cursor ACP](https://prod.cursor.com/docs/cli/acp)
and [Gemini CLI ACP](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md)
contracts. Direct reuse of Gemini CLI OAuth tokens in third-party software is
not implemented; Google's published [Gemini CLI terms](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md)
explicitly prohibit that access pattern.



## T3 Code

[T3 Code](https://t3.codes/) is a GUI that
drives official coding CLIs through adapters rather
than talking to models directly. Because of that, **you integrate the underlying
CLI, and T3 Code inherits the added models** — there is no T3 Code target to
install.

1. Install the router for the CLI T3 Code drives:
   - Codex adapter → `./install.sh --target codex --guided`.
2. Fully quit and reopen T3 Code so its adapter reloads the model list.
3. Pick the added model in T3 Code's model selector; project context and thread
   history are preserved by T3 Code as usual.

The router's job for T3 Code is only to expose the shared provider registry
through the endpoint the driven CLI already knows how to consume.
