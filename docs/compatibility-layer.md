# Optional compatibility layer

The LiteLLM compatibility layer is enabled by default for existing installations.
An installation which uses only native GPT and Responses-native provider routes
can explicitly disable it. This preserves model IDs, provider selections, endpoint
bindings and credential references. It does not convert a Chat or Messages API
into Responses or change a model's declared capabilities.

## Configure

From the installed checkout:

```sh
node src/control.mjs compatibility-layer status
node src/control.mjs compatibility-layer off
```

The private `compatibility-layer.json` in the shared Router state directory stores
`{"version":1,"enabled":false}`. The choice applies to all clients using that
installation and survives source updates and repairs. Missing state preserves the
legacy enabled default. Invalid or unreadable explicit state disables compatibility
routes and is reported by doctor; it never authorizes a Python gateway launch.

The command persists the choice and returns `restartRequired: true`. It does not
stop an active conversation. Prepare dependencies, restart the installed service,
then refresh the installed client catalogs. Health-based publication refuses a
process which has not adopted the stored choice. Preserve an independent recovery
path before restarting a Router which carries the operator's current conversation.

For a fresh source checkout, the dependency-free configuration command can run
before installation:

```sh
node src/compatibility-layer-state.mjs off
```

Then run the ordinary installer for the desired client. Both source installers,
including `--force-deps` / `-ForceDeps` repair, skip Python installation and probes
while the compatibility layer is disabled. No environment variable can silently
override the stored opt-out. Native GPT and HTTP/WebSocket Responses routes remain
available; existing text-only models can still use an independently configured
native vision bridge. Model visibility remains a separate menu preference.

## Disabled routes and re-enabling

Chat, Messages, Vertex, OAuth and Ollama routes which depend on LiteLLM are
excluded from the effective model catalogs and dependency set. Requests naming
these routes, gateway IDs, or aliases fail with `compatibility_layer_disabled`
before upstream delivery. An explicit native redirect to a disabled route also
fails rather than silently sending its conversation to OpenAI. Stored model
definitions, credentials and visibility choices are retained for re-enablement.

```sh
node src/control.mjs compatibility-layer on
```

After enabling, prepare dependencies before restarting and publishing the newly
available routes. An update or rollback to a revision without this policy support
is refused while the opt-out is stored, before replacing the checkout. An explicit
rollback to older software must restore its matching configuration snapshot too.

## Package-managed installations

The existing full Homebrew formula includes Python at package build time. Disabling
compatibility does not uninstall dependencies owned by Homebrew or make its build
per-user dependent. Runtime startup and doctor still honor the stored choice and
do not probe or execute its Python gateway. Use a source installation when the
installation itself must have no Python dependency. Package splitting is separate
from runtime policy; no system Python or shared package is removed automatically.

The opt-out also does not delete a cached `.venv`. Keeping it outside execution
allows rollback without downloading dependencies. Remove a Router-owned cached
environment only after verification and a separate recovery snapshot; do not
delete the system Python used by other tools.
