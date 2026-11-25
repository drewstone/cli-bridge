# cli-bridge

**Use your local coding-CLI subscriptions as one OpenAI-compatible HTTP API — with persistent session resume.**

Model ids are `<harness>/<model>`. The harness is the agent runtime (Claude Code, Codex, opencode, claudish, …); the model is whatever that runtime can address. One string, both choices explicit.

Supported backends:

| Harness | Status | What it is |
|---|---|---|
| `claude/` | ✓ | [Claude Code](https://github.com/anthropics/claude-code) CLI — your Claude Max / Pro subscription |
| `claudish/` | ✓ | Claude Code + [claudish](https://github.com/MadAppGang/claudish) — Claude's workflow, a different brain |
| `codex/` | ✓ | [OpenAI Codex CLI](https://github.com/openai/codex) — your ChatGPT Plus/Pro subscription |
| `opencode/` | ✓ | [opencode](https://github.com/sst/opencode) — multi-provider; the vehicle for Kimi Code via the `opencode-kimi-full` plugin |
| `cursor/` | ✓ | Cursor Agent CLI — local native chats and `--resume` |
| `gemini/` | ✓ | [Gemini CLI](https://github.com/google-gemini/gemini-cli) — Google's official Gemini coding CLI |

Personal productivity tool. Single-user by default. Loopback-only by default. No ambition to be a shared proxy.

Install a reviewed source revision with `npm install https://github.com/drewstone/cli-bridge/archive/<commit>.tar.gz`;
the npm registry package named `cli-bridge` belongs to another project. The artifact
includes the existing TypeScript server and its runtime loader, so it needs no
repository build or development dependencies. `cli-bridge` starts the normal server.

Applications may import `{ loadConfig, startServer }` from `cli-bridge` and call
`await startServer({ config: { ...loadConfig(env), port: 0 }, cwd: workspace, handleSignals: false, quiet: true })`.
`cwd` pins baseline model discovery to that workspace and the backend's default settings policy. Fresh admission uses each final invocation's cwd, environment and flags.
The returned `{ url, close }` is ready to serve; `await close()` stops only that
server and its owned work. Embedded mode leaves process signals and error handlers
with the caller. Use a private data directory and a generated bearer in `env`.

`cli-bridge --seats --json` or `await detectLocalSeats({ config })` reports native
login facts for Claude Code, Codex, OpenCode, Kimi Code, Gemini, Cursor, and Pi. No model
turn is sent; no credential or account identity appears in the result. Each fact
has `harness`, `provider` (or null), `status`, `authMode`, `source`, an optional `credential`, and an optional `fix` command.
OpenCode reports one fact per provider credential in its own store, the same fact `/v1/models` gives that provider's routes.
Model selection, ranking, and seat syntax belong to the consuming seat resolver.

`authenticated` means the native status command recognizes a login, not that an
inference was verified. Kimi Code's login comes from Kimi's own local server
(`kimi web --json`, then `GET /api/v1/auth` and `/api/v1/config`), started with its model-catalog
refresh off so the read calls no Kimi API and refreshes no token. It covers only models
that Kimi routes through its managed `kimi-code` subscription, whose provider is `moonshot`.
A Kimi Code membership key draws the same plan: when the same server's `GET /api/v1/providers` lists the serving
provider as type `kimi` on `https://api.kimi.com/coding/v1`, with a key and Kimi's own `connected` status, the fact reads
`authenticated`, `authMode: subscription`, `credential: plan_key`, while the managed login reads signed out. Kimi lists
a provider that holds both a key and an OAuth table as `error` and refuses to run it. A key on a Moonshot platform
endpoint bills per token and is not admitted.
Where inventory reads Gemini's own OAuth store or OpenCode's credential store,
the result is `configured` rather than a verified live login. Missing or malformed
state stays `signed_out` or `unknown`; OAuth and API-key state stay distinct.
Pi checks use `--no-refresh`. `CLAUDE_BIN`, `CODEX_BIN`, `OPENCODE_BIN`, `KIMI_BIN`,
`GEMINI_BIN`, `CURSOR_BIN`, and `PI_BIN` select the same binaries for inventory and execution.

Flat-rate coding plans that a subscription pays for and a plan key authenticates are named in one table,
`PLAN_KEYED_PROVIDERS` in [src/local-seats.ts](src/local-seats.ts): `zai-coding-plan` (Z.ai GLM Coding Plan) and
`kimi-for-coding` (Kimi Code through OpenCode). A stored key for one of them reports `authMode: subscription` with
`credential: plan_key`, and `authenticated` once OpenCode's own `opencode models <provider> --pure` lists the model.
A key for any other provider stays `api_key`, whatever its name; nothing is inferred from a key or a host.
Subscription-only admission (`BRIDGE_SUBSCRIPTIONS_ONLY=1`, the `tangle graph run` default) still requires an
`authenticated` subscription fact, so a plan key passes it and a per-token key does not.

The real-CLI seat proof in `tests/local-seats.integration.mjs` needs the OpenCode and Kimi Code CLIs. A Beelink gate has
neither, so its command fetches the pinned packages into a temporary prefix:
`beelink-gate auto https://github.com/drewstone/cli-bridge.git "$(git rev-parse HEAD)" -- sh -c 'n=$(mktemp -d) && trap "rm -rf $n" EXIT && npm install --prefix "$n" --no-save --ignore-scripts --no-audit --no-fund opencode-linux-x64@1.19.6 @moonshot-ai/kimi-code@2.7.2 >/dev/null && pnpm typecheck && OPENCODE_BIN="$n/node_modules/opencode-linux-x64/bin/opencode" KIMI_BIN="$n/node_modules/.bin/kimi" node --test tests/local-seats.integration.mjs'`.
Without them the test is skipped with that reason.

---

## The idea in two sentences

Every AI lab now ships a CLI, each with its own subscription + better session economics than the metered API. cli-bridge exposes all of them as one OpenAI-compatible endpoint so your tools (editor, aider, tangle-router, a bash script) can switch harnesses with a single string.

## Model id scheme

```
<harness>/<model>

claude/sonnet                        # Claude Code + Anthropic Sonnet
claude/opus                          # Claude Code + Anthropic Opus
claude/claude-sonnet-5-5             # Claude Code + specific version

claudish/openrouter@deepseek/deepseek-r1   # Claude Code workflow, DeepSeek brain
claudish/google@gemini-2.0-flash           # Claude Code workflow, Gemini brain
claudish/zai@glm-4.6                       # Claude Code workflow, Z.AI brain

codex/gpt-5-codex                    # Codex CLI, Codex model
opencode/kimi-for-coding             # opencode + kimi-full plugin (Kimi Code sub)
opencode/anthropic/claude-sonnet-5-5 # opencode's configured anthropic provider
gemini/gemini-2.5-pro                # Gemini CLI with explicit model
gemini/gemini-2.5-flash              # Gemini CLI Flash model

```

The registry matches on the `<harness>/` prefix; first-registered-first-match wins. `bridge/claude` (no model) defaults to whatever the harness default is.

## Through tangle-router

When reaching cli-bridge via tangle-router's `/api/chat`, prefix the whole thing with `bridge/`:

```
bridge/claude/sonnet
bridge/claudish/openrouter@deepseek/deepseek-r1
bridge/opencode/kimi-for-coding
bridge/gemini/gemini-2.5-pro
```

The router's short-circuit strips the leading `bridge/` and forwards the `<harness>/<model>` as-is.

For native model discovery without starting an HTTP listener or creating execution state, import
`listLocalModels({ config, cwd, signal })` from the package root. Its options are optional. It returns the same ordered native model
entries and authentication facts as `/v1/models`. It reads local metadata only and rejects on cancellation;
it does not validate an execution jail or start a model turn.

`localBackends` from the package root is the server-owned list of local driver
registrations, with `name` (the `BRIDGE_BACKENDS` key), canonical `harness`, and
driver `kind`. `loadConfig` accepts either the key or the canonical harness name.
Use this metadata to route an explicit harness even when it publishes no model
catalog. It does not establish that a binary, login, model, or requested profile
feature is available; backend health, capability negotiation and native admission
remain authoritative. `BRIDGE_SUBSCRIPTIONS_ONLY=1` continues to refuse routes
without verified subscription admission.

## Local checks

Local Beelink gate (set `TOUCHED_INTEGRATION_TEST` to the affected integration test file; the gate installs from the frozen pnpm lockfile): `beelink-gate auto https://github.com/drewstone/cli-bridge.git "$(git rev-parse HEAD)" -- sh -c 'pnpm typecheck && pnpm exec vitest run "$1"' _ "${TOUCHED_INTEGRATION_TEST:?set touched integration test path}"`. Live inference still runs locally through `pnpm test:local-inference` with its explicit model and filesystem-jail prerequisites.

## Install

```bash
git clone https://github.com/drewstone/cli-bridge.git
cd cli-bridge
pnpm install
cp .env.example .env
# edit .env to taste
pnpm verify   # probes each configured backend, reports ready/unavailable
pnpm start
# → http://127.0.0.1:3344  (was 8787; changed to dodge port collisions)
```

**Prereqs:** Node 22.13+. For each backend you want enabled, install + log in on the host. The install commands below are wrapped by:

```bash
pnpm install:harness -- claude
pnpm install:harness -- codex
pnpm install:harness -- opencode
pnpm install:harness -- kimi
pnpm install:harness -- gemini
pnpm install:harness -- pi
pnpm install:harnesses      # all harnesses
```

| Backend | Install | Auth |
|---|---|---|
| `claude` | `npm i -g @anthropic-ai/claude-code` | `claude /login` (OAuth, opens browser) |
| `claudish` | claude above + run `claudish` locally, point `CLAUDISH_URL` at it | claudish's own provider config |
| `codex` | `brew install openai/homebrew-tap/codex` | `codex login` |
| `opencode` | `brew install sst/tap/opencode` (+ [`opencode-kimi-full`](https://github.com/lemon07r/opencode-kimi-full) plugin for Kimi Code) | `opencode login` |
| `gemini` | `npm install -g @google/gemini-cli` | Gemini CLI's official auth/login flow |
| `pi` | `pnpm install:harness pi` (qualified Pi 1.0.2) | Explicit provider/model config in `~/.pi/agent/models.json`; cli-bridge resolves its credential before spawn |
| `prime` | prime-agent, the PrimeIntellect fork of pi. It is **not installable from npm**: the registry serves the upstream pi line under the fork's own package name `@earendil-works/pi-coding-agent` (latest `0.84.x`; the fork's `0.7.x` does not exist there), and the two are wire-incompatible. Run `pnpm install:harness prime` — it builds from source at the pinned commit and installs the entrypoint as `prime-agent`, which is what `PRIME_BIN` defaults to. Do **not** install it as `pi` | Operator `models.json` named by `PRIME_MODELS_JSON`, materialized into an isolated per-run agent dir; only the apiKey env vars it names are forwarded |

For Codex, enable `codex` in `BRIDGE_BACKENDS` on the bridge process that will serve the request.
That process selects one subscription account from `CODEX_HOME/auth.json`, or from `$HOME/.codex/auth.json` when `CODEX_HOME` is unset.
Use a separate bridge process and port for each account, and send Runtime to the port for the intended account.
Check that account's authentication before a run; a healthy bridge on another port does not validate it.

For a Nix-provisioned host shell with the shared prerequisites:

```bash
nix-shell nix/harness-profile.nix
sh scripts/install-harness.sh all
```

## Cursor

Enable `BRIDGE_BACKENDS=cursor` and install Cursor's official `cursor-agent` CLI.
`CURSOR_BIN` selects the executable (default `cursor-agent`). Send `cursor/<model>`;
`cursor/default` keeps Cursor's configured default. Read available model IDs with
`cursor-agent models`. `CURSOR_TIMEOUT_MS` overrides the shared CLI deadline.

Execution requires an API key. Credentials come from `CURSOR_API_KEY` or `CURSOR_API_KEY_FILE` (default
`~/.config/fleet/secrets/CURSOR_SERVICE_TOKEN`). Token files must be regular,
owner-only files owned by the bridge user; symlinks are refused. Credentials go
only in the child environment. Seat inventory reports configured API-key auth
separately from browser login; it does not infer subscription access. Browser login
alone does not authorize execution through this backend.

Each invocation passes `--trust --workspace <request cwd>` and runs in that cwd.
Only use this BYOB backend with a workspace whose project instructions and tools
you trust. The bridge never passes `--force`; it passes `--approve-mcps` only on a turn
whose MCP servers it mounted itself.
The persisted native chat ID goes to `--resume` on the next external session turn.
Cursor's native chat store must survive alongside the bridge data directory.

This backend supports text, streamed reasoning and tool events, native chat
continuation and durable run cancellation/replay. An AgentProfile reaches Cursor through its
project files for that one turn, and the bridge restores the workspace afterwards:
`prompt.instructions` becomes the always-applied rule `.cursor/rules/cli-bridge-agent-profile.mdc`,
and the profile's or request's MCP servers replace `.cursor/mcp.json`. `--approve-mcps` loads
those servers; their tool calls run through one `Mcp(<server>:*)` grant per server in
`.cursor/cli.json`, whose lists keep every entry of the user's and the workspace's own config.
One profiled run per workspace runs at a time. Cursor has no system-prompt control for a customer seat, so
`prompt.systemPrompt` and `prompt.appendSystemPrompt` are refused, as are profile tools,
permissions, subagents, hooks, modes, resources and model hints beyond the model. Public request
env, attachments, reasoning/sampling overrides and hosted modes are refused.
The existing capability response advertises those limits. Token counts use the
CLI's terminal receipt when present; billed cost and served model stay unknown
when Cursor does not report authoritative observations.

Run the real HTTP proof on Beelink: `CURSOR_BIN=$HOME/.local/bin/cursor-agent
pnpm exec tsx tests/cursor-real.integration.ts`. It invokes Grok and a non-Grok
model, restarts the bridge between turns, verifies native resume and cancellation,
and checks capabilities, credential-file protection, cwd and seat inventory.

## Quick test

```bash
curl -N http://127.0.0.1:3344/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Session-Id: my-first-session' \
  -d '{
    "model": "claude/sonnet",
    "messages": [{"role": "user", "content": "say hi in 3 words"}],
    "stream": true
  }'
```

Subsequent calls with the same `X-Session-Id` resume the conversation. Claude Code sees prior context, doesn't re-charge you for replaying it.

## API

The durable retained-session and native-interaction contract is documented in [docs/design/retained-sessions.md](docs/design/retained-sessions.md).

### `POST /v1/chat/completions`

OpenAI Chat Completions.
Model id routes via harness prefix.
The OpenAI-compatible default is non-streaming; pass `stream: true` for SSE.
Session resume uses the `session_id` body field or `X-Session-Id` header.

When the bridge can verify a Kimi provider failure in the submitted turn's native record, `error.type` carries the native provider code. The optional `error.status` and `error.retryable` fields carry the provider’s reported HTTP status and retry decision. A response that already delivered content keeps that content with its terminal error.

Extra fields this bridge accepts beyond vanilla OpenAI:

- `cwd`: persist a working directory for the session and run future resumed turns there
- `agent_profile`: full `AgentProfile` object
- `mcp`: standardised MCP server passthrough (see [MCP passthrough](#mcp-passthrough))
- `runtime_attachments`: platform MCP endpoints mounted outside the bound profile (see [Runtime attachments](#runtime-attachments))
- `run_id`: caller-owned durable job id (also accepted as `X-Run-Id`)
- `execution`: execution location plus an optional caller-owned `timeoutMs` process deadline
- `interactions` and `interaction_policy`: parsed with the shared interaction contract; one-shot chat rejects a non-empty posture or policy with `501 capability_denied` before durable admission because response-bound interactions require a retained native session
- `tool_choice`: the standard OpenAI field, accepted as `'none'` or `'auto'`. `'none'` is the
  explicit text-inference request with standard semantics — the model makes no tool calls at
  all: the turn's model requests carry zero tools, ambient action tools and caller-bound MCP
  servers alike (analysis/trace callbacks belong outside the nested model call, on their own
  authority, and stay usable there). OpenCode and local Kimi Code implement this control.
  Kimi uses a native empty-tool profile on single requests. Short prompts use the CLI's
  agent file. Long prompts bind the same policy to a new native session and send the
  original prompt through ACP. Kimi binds the agent for the life of a session, so
  requests with a session id return `501 capability_denied` before execution. Other backends are refused with
  `400 invalid_request_error` naming the gap rather than accepting and ignoring the field,
  until it declares a verified zero-tool control. On OpenCode the turn runs under a fresh
  bridge-named agent whose permission is the native wildcard deny — appended after every
  global and agent default, checking every tool id — so inherited configuration (operator
  global config including JSONC, ambient config content, agent defaults, the project layer)
  cannot reintroduce a tool, and a project-configured provider keeps working. Sandbox
  delegation is refused because its task boundary drops the field. `'auto'` and an absent
  field are the native default everywhere — ordinary turns keep their native coding tools
  and MCP passthrough, and an absent or empty `tools` list is never read as a request.
  This is a provider tool-list restriction, not hosted-safe isolation. Measured against
  OpenCode 1.18.30 with a local recording endpoint
  (`tests/opencode-text-only-tool-choice-real.test.ts`).

Behavior:

- `sandbox` backends honor the full `agent_profile` natively
- local harness backends (`claude-code`, `codex`, `kimi-code`, `gemini`, `pi`, `prime`) persist the full profile and reject profile dimensions they cannot execute
- `codex/default` and `codex/<provider>/default` select the Codex CLI configured model without a model override; the qualified form retains the explicit provider.
  Its exact profile may omit `model.provider` or name the harness as the provider.
  A harness name is never passed to a CLI as its model provider. The backend drops a provider
  segment equal to its own name when it builds the arguments, so the rule also holds for a
  request that carries no profile.
- Codex reasoning maps the shared values directly and maps `ultracode` to native `ultra`.
  Codex CLI 0.147.0 supplied the accepted values through direct probes.
- A jailed OpenCode run seeds only `auth.json` into its writable private data directory.
  The bridge does not expose or copy the host database and logs.
- OpenCode turns accept an explicit `max_tokens`. The request value becomes the runner's
  experimental output-token maximum (`OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`) for that one
  turn, fresh or resumed. Its budget plugin reserves each model request before sending it.
  OpenCode names the new assistant and its user parent before the request. Only a step that
  starts and finishes on that assistant in the same session can return unused tokens, once,
  with complete positive output accounting (visible plus reasoning). A provider can omit
  all usage or report only its reasoning subtotal after producing text or a tool call.
  OpenCode writes zero for each missing counter, and the bridge keeps the full grant reserved.
  A pure reasoning step can establish complete usage when the total reconciles with its input. A final answer still completes. Another call needs
  unreserved tokens. An overlapping call or an uncertain retry is refused before dispatch.
  If the runner or bridge dies, an explicitly capped turn cannot automatically resume because
  its outstanding reservation went with the process. New uncapped turns retain automatic
  recovery. Older OpenCode runner records lack the original cap and close with that uncertainty.
  The turn names its own session title (`--title`), because title generation is a model call
  whose billing prints no receipt. A provider that stops a completion at the bound ends the
  turn `finish_reason: "length"`, as does a step receipt that spends the budget while more
  calls would follow. A lower operator flag (`OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` in the
  bridge environment) or `agent_profile.model.maxTotalOutputTokens` is preserved via `min`,
  and the runner's own `min` with the model catalog's output limit applies on the wire.
  Measured against OpenCode 1.18.30 with a local recording endpoint
  (`tests/opencode-output-cap-real.test.ts`, `tests/opencode-output-cap-plugin.test.ts`):
  wire `max_tokens` per request, receipt-refunded remainders on continuations, hidden retries
  after refused attempts and lost streams refused before the wire, reasoning tokens counted,
  duplicate and cross-session notifications replayed, concurrent-turn isolation, and uncapped
  turns unchanged (title call included, 32000 default bound).
- the dollar channel has two lanes and they never merge. `cost` travels only with `cost_known: true` and `cost_provenance: provider-receipt` or `billing-receipt`; a consumer may debit a dollar budget with it. Every other case reports `cost_known: false`, plus an optional `estimated_cost` tagged `catalog-estimate` that is never billed spend. A backend that reports no dollars sends no dollar amount, because a zero would read as a measured free turn
- Claude Code computes `total_cost_usd` locally from token prices. It is an estimate, including when the amount is zero, and is not subscription billing or an invoice. Bridge retains it as `estimated_cost`, with `catalog-estimate` provenance and `cost_scope: total`; actual billed cost remains unknown. An absent amount stays absent. See [Claude Code's cost documentation](https://code.claude.com/docs/en/costs#using-the-usage-command).
- Pi requires `pi/<provider>/<model>`. The provider and model must have an explicit `baseUrl` and API mode in Pi's `models.json`; the bridge refuses missing or ambiguous selections before Pi starts
- Pi streams the model's reasoning (`thinking_delta`) as `choices[0].delta.reasoning`, coalesced to 256 characters or 250 ms per chunk. Reasoning never enters `message.content`; the retained event log keeps it on the inner event as `reasoning`
- Pi publishes `provider_models` only from its explicit provider `responseModel`, preserving any response fingerprint. One-shot and retained native turns share this projection and token accounting: input includes fresh input, cache reads and cache writes; missing token classes remain unknown, and native catalog costs remain estimates. A configured `model` or fingerprint without `responseModel` does not establish served identity.
- Gemini retains its native session ID and confirms the same ID on `--resume`. Its stream-json assistant output, exact tool calls/results, and positive reported input/cache subtotals survive the bridge; an incomplete native stream fails even after exit zero. Native stats default missing token classes to zero and aggregate requests without per-response coverage, so a zero stays unknown; output and total are reported only when input, output and total are all positive and the total is exactly input plus output, and are otherwise unknown. Fresh input requires observed input and cache terms; an all-zero native record suppresses text-token estimates. Native visible-output details remain in the harness's raw evidence and session reader, outside normalized complete usage. Its init/stats model labels can fall back to the requested model and do not establish served identity.
- Pi model traffic uses a request-scoped local forwarder. The Pi process, its Bash tools, and descendants receive only a short-lived local token—not daemon provider or GitHub credentials—and the forwarder closes when the run ends. The jail's own network namespace reaches only the forwarder's port, through a per-spawn socket, and Pi uses its SSE transport because the forwarder relays HTTP requests only. Request bodies and non-authentication headers pass through unchanged, including provider prompt-caching controls. Exact-model inspection defaults to a 256 MiB request maximum; callers can raise it with `maxInferenceRequestBytes`, and operators can set `CLI_BRIDGE_PI_MAX_REQUEST_BYTES`
- Runtime may send `X-Cli-Bridge-Model-Credential` for a protected Pi model call. The bridge accepts this header only over a loopback socket, never stores it in request, session, trace, or replay data, and binds its SHA-256 digest into durable run identity so a changed token cannot resume an existing run.
- Pi's isolated transport requires `PI_EXECUTOR=host` plus `execution.jail.mode=fs-jail` (or `BRIDGE_JAIL_MODE=fs-jail`) on a Linux host with bubblewrap, or with Landlock selected under its host prerequisites (see [Filesystem jail on Linux](#filesystem-jail-on-linux)). The bridge refuses before credential resolution when real read isolation is unavailable, and `BRIDGE_JAIL_FALLBACK=warn` cannot downgrade a Pi request. Docker refuses because its separate network cannot reach the bridge's loopback address without reintroducing mounted provider credentials
- caller sessions use Pi's native `--session-dir`, with one stable opaque directory per external session under `PI_CODING_AGENT_SESSION_DIR`. Only that directory enters the read-confined process, so continuation works without exposing sibling sessions; anonymous calls remain temporary
- every request accepted by the local forwarder is counted. The run refuses completion when forwarded calls differ from Pi's usage receipts, when any scoped request is rejected or fails, or when traffic remains in flight
- an exact Pi profile's completed `profile_materialization` acknowledgement includes the upstream endpoint and API mode, request counts, token and prompt-cache usage, and `costKnown: false` because Pi exposes a local catalog estimate rather than provider-billed dollars; neither credential is exposed
- Pi passes the replacement system prompt, additive instructions, skills, and prompt templates through Pi's native per-process flags using unique files that are removed after the run; a profile grants run-scoped project-file trust without persisting approval, while ambient context, skill, and prompt-template discovery stays disabled
- `agent_profile.extensions.pi.load` selects an exact Pi extension set from installed package names or absolute paths; when present, the bridge passes `--no-extensions` plus one `--extension` flag per resolved entry
- when Pi runs inside the OS filesystem jail, the executor translates each installed-package path only after confinement is confirmed; host, Docker, and explicit unconfined-fallback paths keep their normal argv
- an EMPTY `load` list (`"extensions": { "pi": { "load": [] } }`) is the complete-isolation request: `--no-extensions` and nothing else, so no installed extension loads. Use it when a run must not inherit state an extension persists across runs — a paired experiment whose two arms share such an extension is silently unpaired, and nothing in the response reports it
- Pi rejects generic profile file mounts because Pi has no request-scoped loader that can preserve their declared task-relative paths
- a Pi credential failure (401/403/expired) names the credential source the bridge resolved — the agent dir's `auth.json` entry, the env var(s) or literal behind `providers.<p>.apiKey` in its `models.json` (with whether each variable is set in the bridge's environment), or the protected request header — never the value, so a jail or HOME misconfiguration reads as one
- Prime requires `prime/<provider>/<model>`; the run binds to a provider entry in the materialized `models.json` before the CLI starts
- Prime drives prime-agent's `--mode rpc` inside an owned in-process worker — no shared background daemon — and pins a bridge-owned HOME + agent dir per run, so the fork's persistent self-modification state (`harness/harness_state.json`, which rides every future system prompt) never crosses runs. `PRIME_PERSISTENT_AGENT_DIR` is the explicit opt-in to shared state and cannot be combined with `PRIME_MODELS_JSON`
- Prime's child environment is a neutral allowlist: ambient provider keys never reach the CLI or its tools; only the apiKey env vars named by the effective `models.json` are forwarded, declared to the host executor's own env sanitizer by exact name. `PRIME_AGENT_INSTALL_UV`, `PRIME_AGENT_KERNEL_PYTHON`, and `PRIME_AGENT_KERNEL_VENV` pass through so an operator-prepared Python kernel survives the HOME isolation
- a non-zero prime-agent exit reports the exit code (or terminating signal) and the retained stderr in full — including the fork's daemon log path and tail when a daemon launch fails — and, when the fork reached its daemon at all, says so, since the bridge asks for the daemon-free owned-worker frontend. Inside an OS jail the per-run daemon socket dir is exposed writable and the prompt dir readable
- Prime sends request images through the rpc `prompt` command's native `images` field; profile prompt intents ride `--system-prompt` / `--append-system-prompt`; request-scoped MCP is refused (`not_configured`) because the fork has no per-invocation MCP loader
- Prime sessions keep one stable state dir per bridge session and resume with `--continue` against that session's exclusive `--session-dir`; a failed provider call or dead IPython kernel surfaces as a typed error, never a silent empty completion

Example:

```bash
curl http://127.0.0.1:3344/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer '"$BRIDGE_BEARER" \
  -d '{
    "model": "codex/gpt-5.4-mini",
    "session_id": "agent-builder-local",
    "cwd": "/Users/drew/webb/agent-builder",
    "agent_profile": {
      "name": "local-coder",
      "prompt": { "systemPrompt": "Be surgical. No placeholder logic." },
      "skills": ["critical-audit"]
    },
    "messages": [{ "role": "user", "content": "inspect the repo and propose the smallest viable fix" }],
    "stream": false
  }'
```

### Durable run lifecycle

Once accepted, a chat job belongs to the bridge process rather than to the HTTP connection that dispatched it.
Closing an SSE response detaches that reader and does not cancel the backend CLI process.
Only `POST /v1/runs/:id/cancel` sends the backend abort signal.

Set `execution.timeoutMs` to a positive integer up to `2147483647` to bound the backend process in milliseconds.
The deadline belongs to the durable run, so disconnecting and replaying do not stop or restart it.
If omitted, the matching backend's timeout environment setting applies. Codex defaults to the bounded native launch policy in [`src/config.ts`](src/config.ts); other backends retain their existing defaults. Explicit operator values, including zero, and request overrides keep precedence. This bounds each launch, independently of a workflow's total horizon; a timed-out graph leaf does not automatically renew.
An explicit request value always wins over that fallback and is also forwarded to sandbox tasks and the OpenCode wrapper.
`CLI_BRIDGE_SCOPE_RUNTIME_MAX_SEC` and `BRIDGE_SLOT_MAX_HOLD_MS` are separate operator safety caps; both default to disabled and may preempt a longer request only when an operator explicitly configures them.

Supply `run_id` in the body or `X-Run-Id` in the header to make dispatch idempotent.
If both are present they must match.
Ids are 1–128 characters, begin with an ASCII letter or digit, and may then contain letters, digits, `.`, `_`, `:`, or `-`.
Agent Interface provider, environment, session, and execution coordinates accept up to 512 characters under their shared identifier contract.
The bridge binds the id atomically to the normalized execution request before admission or backend setup:

- An identical retry attaches to the existing job and never acquires a second process slot.
- A different request under the same id returns `409 run_identity_conflict` with both request digests.
- The response carries the complete run identity: `X-Run-Id`, `X-Run-Request-Digest`, `X-Run-Provider`, `X-Run-Environment-Id`, `X-Run-Session-Id`, and `X-Run-Execution-Id`.
- Supply `provider`, `environment_id`, `session_id`, `execution_id`, and `run_id` when another system owns the coordinates.
- Exact coordinate fields are all-or-none and must agree with the body and header run/session aliases.
- `GET /v1/runs/:id`, replay, cancellation, and chat responses expose the same six fields so control retries never reconstruct identity from backend defaults.

For `stream: true`, every output delta has a monotonically increasing SSE `id`.
Every numbered frame carries a `data:` line, because SSE parsers and re-encoders never dispatch a frame without data; keepalive and bridge-metadata frames carry an empty `choices: []` chunk.

Codex streams native lifecycle observations as top-level `activity` on numbered frames with `choices: []`. A turn emits `{"type":"turn.started"}` when the CLI reports it. A tool reports `tool.started`, `tool.completed` or `tool.failed` with a `tool` of `command_execution`, `web_search`, `file_change` or `mcp_tool_call`. The optional `call` ordinal pairs start and settlement within a turn. Some tools report only completion. For a public progress view, display the activity fields alone. Other frames can contain operator-only tool arguments, results and diagnostic text. Heartbeats describe the transport. `final_output` publishes the contracted answer after successful completion.

Reconnect with the same request and `Last-Event-ID: N` to receive only events after `N`.
An ahead cursor returns `409 invalid_replay_cursor`.
A cursor older than the retained window returns `410 expired_replay_cursor`; the bridge never silently restarts at event zero.
`Last-Event-ID` is rejected for non-streaming responses because a single JSON response cannot express partial replay.

### Asynchronous durable writes

Set `BRIDGE_ASYNC_DURABLE_WRITES=on` to isolate streamed chat persistence in a worker.
The default is `off` during staged rollout.
All chat backends use the same worker path.

The worker keeps SQLite WAL with `synchronous=FULL`.
It groups queued writes into one transaction, with savepoints isolating invalid requests.
A producer awaits each acknowledgement before exposing its delta and checkpoint.
Terminal state remains pending until its checkpoint is acknowledged.
Write failures produce an unknown outcome; capacity exhaustion refuses further writes explicitly.

The pending queue holds at most 128 requests and 32 MiB of serialized inputs.
Awaiting commits applies backpressure to each source.
Shutdown drains accepted writes before closing the worker.

This option isolates streaming database writes only.
Admission, retained-session controls, raw process capture, and span-file writes still have synchronous paths.
A slow filesystem can still delay those operations.

On 2026-09-29, three live bridge main threads were sampled inside `fsync`.
Their file descriptors resolved to their respective `sessions.sqlite-wal` files.
The streaming path made two FULL commits for each delta.

The regression fixture holds an actual SQLite write lock while requesting HTTP health.
Eight health responses completed with a maximum of 23.6 ms in the initial fixture run.
No pending output became visible.
After releasing the lock, reopening recovered 17 events and their terminal checkpoint.
This proves isolated worker behavior, not deployed fleet performance.

Enable the option first on an idle canary after its existing jobs settle.
Check health latency, admission, persisted replay, cancellation, and native capture before expanding.
Rollback disables the option at the next safe service restart.
Do not restart an active fleet solely to apply this change.

Replay storage is explicitly bounded per process:

- At most `BRIDGE_RUN_MAX_REPLAY_DELTAS` deltas are retained per run (default `10000`).
- At most `BRIDGE_RUN_MAX_REPLAY_BYTES` of delta payload is retained per run (default `33554432`, 32 MiB).
  The delta count alone is not a memory bound, because one delta may carry a whole tool result.
  The oldest deltas are dropped first; the newest delta is always kept.
- Terminal output expires after `BRIDGE_RUN_REPLAY_RETENTION_MS` (default `60000` ms).
- The run-id/request binding remains after output expiry for `BRIDGE_RUN_IDENTITY_RETENTION_MS` (default `86400000` ms) so a late retry cannot accidentally execute the job again.
- `BRIDGE_RUN_MAX_LIFETIME_MS` is an optional emergency cap for one unsettled run.
  It defaults to `0`, so elapsed time alone never cancels a run.

A live run keeps its bounded replay buffer, registry entry, and execution slot until it ends or receives explicit cancellation.
Set a positive `BRIDGE_RUN_MAX_LIFETIME_MS` only when the operator requires a hard process-lifetime policy.

### Portable context transfer

`POST /v1/context-transfers` accepts the canonical `ContextTransferRequest` from
`@tangle-network/agent-interface`: the selected-only transfer plan that
`createContextTransferRequest` projects, so content the user omitted never
reaches the bridge. The request digest binds its accepted plan,
full inline profile, workspace, and allocation resources. The same operation and
digest replay one receipt across restarts; changed input under that operation
returns a conflict. Lookup is available through
`GET /v1/context-transfers/:operationId?request_digest=…` and
`GET /v1/context-transfer-environments/:environmentId` for the same authenticated caller.

An unbound destination omits `plan.destination.environmentId` and supplies its
exact profile. The bridge records a fresh local environment identity separately
and returns it as `receipt.environmentId`, preserving the accepted destination
unchanged. The subsequent turn must use that environment,
session, run, execution, model, and full profile. The model is the route
`agent-provider-cli-bridge` attaches with: the destination model, else the
profile default, qualified by the profile provider when the model names none.
A declared `workspace.cwd` must use `base: "host"`; the turn must use the exact
declared path.

The Codex host backend initializes a fresh native thread with selected text parts
through the public app-server API, preserving message roles and part order. It
uses the exact public profile and the existing profile materializer. The receiver
records the native thread ID before import and the native checkpoint acknowledgement
before returning an accepted receipt. The first turn resumes that native thread
with only the new user input; it requires the exact transfer request. The
installed Codex must report the version qualified in `CodexBackend.health`
(`src/backends/codex.ts`), and an explicit existing host cwd is required. Other
backends and selected non-text or tool-role messages are unavailable until their
native import path is implemented and proved.

`GET /v1/capabilities?model=…` reports `contextTransfer` with `freshSession`,
`requestIdempotency`, `lookup`, and `attach` only for a route whose backend can
perform that import, which today is a qualified Codex host backend with a
retained state directory. Every other route omits `contextTransfer`. `attach`
means a provider's `get(environmentId, { contextTransfer })` can verify the
durable receipt here, and the bridge admits only the first turn that presents the
exact transfer at the accepted coordinates; any other dispatch to that session is
refused until that turn has completed.

The default capability document carries only keys that agent-interface's strict
`AgentEnvironmentCapabilitiesSchema` accepts. `modelReroutes: true` (the stream
reports a provider reroute as `provider_models`; Codex routes) is served only on
`GET /v1/capabilities?model=…&include=modelReroutes`; any other `include` value
is refused with 400.

HTTP receipt loss can replay an acknowledged import after restart. An uncertain
native create or inject acknowledgement remains pending and is never repeated.
Codex's public history projections do not expose the selected raw import before
a turn, so they cannot currently reconcile that uncertainty. The ordinary chat
route cannot bypass this fence by reusing the session ID. Legacy receipts without
native import proof also remain unavailable.

Local transfer currently supports an existing host workspace. It refuses cloud
templates, images, repository cloning, checkpoint restoration, provider workspace
options, and top-level allocation resources before recording a new admission.
`profile.resources` continues through the normal profile materialization path.
This transfers selected conversation context; it does not copy dirty or untracked
workspace files into a fresh local directory.

### Memory

`GET /health` reports `memory.heap_used_bytes`, `memory.heap_limit_bytes` and `memory.heap_used_pct`, plus `memory.runs_retained` and `memory.run_replay_bytes` for the run registry's own share.
Check `heap_used_pct` before dispatching a large wave; heap growth produces no log line, so a dead port is otherwise the first signal.

For multi-agent workloads, run the bridge with `NODE_OPTIONS=--max-old-space-size=4096` or higher.
Node's default old-space limit is well under what four concurrent large-context sessions need, and the retained replay window scales with concurrency: budget roughly `BRIDGE_RUN_MAX_REPLAY_BYTES` per concurrent run plus headroom.

Two harnesses measure these bounds directly:

```sh
node --expose-gc --import tsx scripts/measure-unsettled-runs.ts   # runs that never settle
node --expose-gc --import tsx scripts/measure-live-run-buffer.ts  # replay bytes for one run
```

Model output is not clipped by the bridge's process-diagnostic protection.
The bridge retains at most 64 KiB of each subprocess's stderr/stdout diagnostics, preserving both the beginning and end for failures, while successful streamed content continues through the normal response and replay path.
Progress heartbeats use one live timer per subprocess wait rather than one timer per streamed event.

Do not recycle run ids after the identity window.
A bridge restart loses the in-memory registry; `404` after a restart means the old process is unknown, not proven stopped.

`GET /v1/runs/:id?wait_ms=N` returns the current snapshot and can wait up to 30 seconds for terminal state.
The `state` field is `running` while a reader is attached, `detached` while the job continues without readers, `cancelling` after explicit cancellation but before process exit, and `terminal` only after the backend iterator exits.
The separate `status` field records the outcome as `running`, `done`, `error`, or `cancelled`.

`GET /v1/runs/:id/events` opens a replay-only SSE reader without repeating the original dispatch request.
Send `Last-Event-ID` or `X-Last-Event-Id` to resume strictly after one retained event.
The endpoint returns the same conflict and expiry errors as request replay and ends with the `[DONE]` protocol marker.

`POST /v1/runs/:id/cancel?wait_ms=N` returns:

- `202` while cancellation was requested but process exit is not yet proven.
- `200` only with `terminal: true` and the terminal run snapshot.
- `404` when this bridge process has no record of the run; this is not termination proof.

An empty cancellation body keeps the simple local API above.
For retry-safe control, send the `AgentRunCancellationRequest` from `@tangle-network/agent-interface`.
It contains a stable `operationId`, the complete run control reference, an optional reason, and the canonical request digest.
For one-shot runs, use the `provider`, `environmentId`, `sessionId`, and `executionId` returned in the run snapshot; the bridge rejects a cancellation whose coordinates do not exactly match the claimed run.
Repeating the same operation returns the stored acknowledgement.
Changing its digest returns `409`, and a run id that differs from the URL returns `409` before replay lookup.

The `wait_ms` query is an integer from `0` through `30000` on both endpoints.

### `GET /v1/models`

Catalog entries include configured `provider`, route-scoped `authentication` facts, and optional
`default`/`recommended` hints. Import their `ModelEntry` type from the package root. Unknown routes
keep `provider: null`; configured credentials remain distinct from authenticated native status.
These fields describe native configuration; served model identity comes from a completed turn.
`codex/default` remains a no-override route; use a concrete native default row when one is reported.

Set `BRIDGE_SUBSCRIPTIONS_ONLY=1` (or captured `Config.subscriptionsOnly`) to require authenticated
subscription evidence at every new native invocation and retained continuation. Replay, reads and
cancellation remain available. Admission refusals use HTTP403 and the same SSE/durable error:
`type: subscription_required`, `status: 403`, `cause`, `fix`, `harness`, `provider`, and
`provider_dispatch: not_started`. The fix names the native command or observed environment override.
When the native probe itself fails, the message names its error chain, including the probe's own timeout.
A request cancelled during the probe ends as `type: aborted` instead.

For an embedded host, `startServer({ onRunRedaction })` provides a live redactor bound to the
actual run, session, profile digest and CWD. It includes admitted custom MCP values, Hub grant
tokens and Runtime coordination bearers. The callback receives no values or hashes of values.
It can redact a retained native-file copy after job cleanup while this Bridge remains open;
server close revokes it. Each issued redactor, with the protected values it names, stays in memory
until that close: one entry per run, so a long-lived embedded host restarts its Bridge to bound it. Retain only the redacted copy and mark transformed original-byte coverage
incomplete. This callback does not upload credentials or reconstruct a terminated Bridge.

The existing bearer-protected `GET /` response includes `hostPolicy` with schema
`cli-bridge.host-policy.v1`. It reports whether bearer authentication is required, the immutable startup subscription admission policy,
jail floor/fallback/network default and ceiling, and presence of trusted private-MCP and Hub
ports. It exposes no credential values, key names, paths or grants. Port presence does not establish
readiness, permissions or survival after a Bridge process exits. Clients still discover exact-route
capabilities and actual admission still checks the final native invocation. A profile's
`model.metadata.credentialSource` alone does not enable the process subscription guard.

Lists model ids each ready backend claims, with which harness serves them.

### `GET /health`

Healthy probes use `BRIDGE_HEALTH_CACHE_MS`. Failed probes keep their original
`probed_at` with `cached: true`; `BRIDGE_HEALTH_NEGATIVE_CACHE_MS` bounds how
soon another request starts a shared background refresh. Warm failures return
immediately while that refresh runs. `?force=1` waits for a fresh shared probe;
setting `BRIDGE_HEALTH_CACHE_MS=0` disables caching. Defaults live in
[src/routes/health.ts](src/routes/health.ts).

JSON report per backend — ready / unavailable / error with detail.

When host admission is configured, the report carries an `admission` object.
Read `active` against `live` first:

| Field | Meaning |
| --- | --- |
| `active` | Slots charged against `maxActive`. Admission decisions use this. |
| `live` | Charged slots whose job is still running. |
| `stale` | `active - live`. Capacity charged to work that already finished. |
| `unbound` | Charged slots no caller bound to a job lifetime. |
| `oldestHeldMs` | Age of the longest-held slot. |
| `reclaimed` | Slots the reconciler has taken back since start. |

`stale: 0` means the count matches the work. Anything else is drift, and the
gate reclaims those slots on its next reconcile pass:

```bash
curl -s http://127.0.0.1:3344/health | jq '.admission | {active, live, stale, reclaimed}'
```

The report also carries an `executor` object: the executor semaphore's own counts, so a launcher can check occupancy before it spawns.

| Field | Meaning |
| --- | --- |
| `in_flight` | Slots held by a live spawned process. |
| `max` | `BRIDGE_HOST_MAX_CONCURRENCY`. |
| `queued` | Callers waiting for a slot right now. |
| `acquire_deadline_ms` | Default wait a request with no `execution.acquireTimeoutMs` gets. |
| `max_acquire_deadline_ms` | Ceiling applied to a request-supplied acquire deadline. |
| `acquires` / `timeouts` | Cumulative since start. `timeouts` counts saturation refusals. |
| `scoped_host` | The same counts for the systemd-scoped executor on Linux. |

```bash
curl -s http://127.0.0.1:3344/health | jq '.executor | {in_flight, max, queued}'
```

### `GET /v1/sessions` · `DELETE /v1/sessions/:id`

Inspect / clear external-to-internal session mappings.

### Session profile binding

A session external id is the harness conversation key (`claude --resume`, `opencode -s <id>`), so the bridge binds it to the exact AgentProfile, provider, model, and reasoning effort of its first turn.

- The same binding is the RESUME path. The turn continues the same conversation.
- A different binding returns `409 session_binding_conflict`. The bridge never rebinds an existing session, because adopting one conversation under a second profile would break the record of which profile produced which output.

The client contract is one line: a session external id must be unique per logical run.
The bridge cannot tell an intentional resume from an accidental id collision; only the caller can, by never deriving the same session id for two distinct runs.

Claude profiles can share a task directory while loading different generated tool and permission settings through separate `--settings` files.
The settings path includes the exact profile digest, and the materialization receipt records that path.
Existing Claude sessions retain their recorded plan when resumed after an upgrade.
Shared skills and task files still require identical bytes; conflicting content is refused before the CLI starts.
If a caller derives session ids from a digest, the digest must include an attempt-scoped or run-scoped term.

Every Claude turn runs without the host user's `~/.claude` layer, with or without a profile.
The bridge passes `--setting-sources project,local` and `--strict-mcp-config` and sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
The turn therefore loads no user CLAUDE.md or file it imports, no user skills, commands, subagents, rules, output style, plugins, hooks or auto-memory, and no MCP server outside the request.
The run workspace's own CLAUDE.md and `.claude/` files still load, and so does the profile's generated `--settings` file.
The bridge does not use `--bare`, because bare mode never reads OAuth credentials or the keychain and would sign subscription seats out.
Login is unchanged: the Linux credentials file, the macOS keychain and `CLAUDE_CODE_OAUTH_TOKEN` all keep working.
Host-wide policy belongs in Claude Code's managed settings, which still apply; auth, model, effort, output style, attribution or env defaults set in `~/.claude/settings.json` no longer reach bridged turns.
The Bridge's own `ENABLE_TOOL_SEARCH` reaches every Claude it starts: Claude Code defers MCP tools behind its ToolSearch tool by default, and `ENABLE_TOOL_SEARCH=false` puts them in each model request, for a model endpoint that cannot search first.
A turn without a model or effort therefore uses Claude Code's defaults, and commit and pull request attribution follows Claude Code's default unless the profile's instructions or managed settings say otherwise.
Retention cleanup does not run in these turns: Claude Code skips it when the user settings layer is off, so the host's transcripts keep the host's retention.
CLAUDE.md files in directories above the workspace are still read as project memory, so keep run workspaces outside directories that hold one.
`CLI_BRIDGE_REAL_CLAUDE_TESTS=1 pnpm exec vitest run tests/claude-host-isolation.real.test.ts` checks this against the installed `claude` without a login or any spend.

OpenCode profiles can also share a task directory, and the bridge closes that directory as a channel into the process.
OpenCode reads the project layer of its working directory on every model request, so a file written there changed the next profile's turn.
The bridge no longer writes a profile's generated `opencode.json` into the directory; it passes that config to the one process through `OPENCODE_CONFIG_CONTENT`.
It sets `OPENCODE_DISABLE_PROJECT_CONFIG`, which stops OpenCode from reading `opencode.json`, `.opencode/opencode.json`, every agent, skill, command and custom tool under `.opencode`, and the project context files `AGENTS.md`, `CLAUDE.md` and `CONTEXT.md` in that directory.
Every profile turn is scoped this way, including one whose profile generates no config of its own.
It applies the profile's own OpenCode files into a private directory under the working directory and names it in `OPENCODE_CONFIG_DIR`.
That directory is created for the turn and removed when the turn ends, so a later profile cannot read it and an edited file cannot refuse a later session.
The operator's own global OpenCode config still loads, so provider, model and plugin wiring is unchanged.
This behaviour was measured against OpenCode 1.18.30 with `opencode debug config` and `opencode debug agent`.

Declared task files still land in the shared directory and still require identical bytes across profiles.
The materialization receipt records the workspace plan digest and the relative path of every file written; environment values never enter it.
A profile whose serialized config exceeds one environment value is refused before any process starts, on the host executor and in Docker alike.
The host sanitizer drops an oversize value silently, which would leave OpenCode on its own defaults while the receipt still named the profile.

Three things an operator should count on rather than assume.
No project config is deleted: a config a user wrote and a stale one an earlier bridge version generated cannot be told apart, and neither reaches a profile process now.
Skills under `.claude/skills` and `.agents/skills` in the task directory still reach every profile, because OpenCode gates those on a separate `OPENCODE_DISABLE_EXTERNAL_SKILLS`, which would also remove the operator's own global skills.
An agent that shares the working directory can read and WRITE another profile's private directory while that turn runs, and OpenCode rereads its instruction files on every model request, so a write there changes the running turn.
Both agents run as the same user on the host executor, so no file mode separates them; give a profile its own working directory when that matters.

The refusal body carries both bindings, so a caller can tell a drifted profile from a reused id:

```json
{
  "error": {
    "type": "session_binding_conflict",
    "session_id": "supervised-worker-<hex64>",
    "message": "session \"supervised-worker-<hex64>\" is bound to a different AgentProfile/model",
    "stored_binding": {
      "schema": "cli-bridge.session-agent-profile.v1",
      "effectiveProfileDigest": "sha256:<64 hex>",
      "provider": "anthropic",
      "model": "claude/sonnet",
      "requestedReasoningEffort": null
    },
    "received_binding": { "…": "same shape, the binding this request carried" },
    "provider_dispatch": "not_started"
  }
}
```

`stored_binding: null` means the session predates exact binding; use a new session id.
`provider_dispatch: "not_started"` is the bridge's proof that the refusal happened before any model call, so the turn cost nothing.

### `POST /profiles/:id/v1/chat/completions`

The chat completion above with the cataloged AgentProfile `:id` (a `<id>.json` in `SANDBOX_PROFILES_DIR`) applied, on the harness the request `model` names.
A caller that sets only a base URL, such as a publisher's benchmark runner, reaches a profile with base URL `<bridge>/profiles/<id>/v1`.
An id the catalog lacks rereads the directory once; a changed profile needs a new id. A body `agent_profile` is refused with 400.
The caller's system-role messages, which `/v1/chat/completions` refuses beside a profile, join the profile as `prompt.appendSystemPrompt`.

### `POST /v1/responses` · `POST /profiles/:id/v1/responses`

The text subset of the OpenAI Responses API, for callers that only call `responses.create` (PRBench's runner).
The request runs as one non-streaming chat completion through `/v1/chat/completions`, or `/profiles/:id/v1/chat/completions` with that profile, and the reply comes back as a Responses object whose `output_text` is the answer.
Carried: `model`, `input` (a string or role/content messages with text parts), `instructions`, `max_output_tokens`, `reasoning.effort`; `tools`, `background`, `stream`, `previous_response_id`, `conversation` and structured `text` formats are refused with 400.

### `POST /cad/render`

Render OpenSCAD source to STL + PNG (+ optional GLB). Generic — any
project that wants a parametric-CAD rasterizer behind one bearer can
call it.

```bash
curl -s http://127.0.0.1:3344/cad/render \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer '"$BRIDGE_BEARER" \
  -d '{
    "code": "cube(10);",
    "outputs": ["stl", "png"],
    "imageSize": [800, 600]
  }' | jq '.ok, .durationMs, (.artifacts | keys)'
```

Body shape:

```ts
{
  code: string,            // OpenSCAD source
  outputs?: Array<"stl"|"png"|"glb">,  // default ["stl","png"]
  imageSize?: [number, number],        // png only, default [800,600]
  defines?: Record<string, string | number | boolean>,  // openscad -D vars
}
```

Response: `{ ok: true, artifacts: { stl?, png?, glb? }, durationMs, warnings: [] }`
on success; `{ ok: false, error: string, durationMs }` on openscad
compile failure or artifact-size overflow.

**Dependencies:** `openscad` on `$PATH` (provided by the `hardware`
nix profile in `tangle-network/agent-container`). GLB output
additionally requires `python3` + `trimesh`; if either is missing the
endpoint omits `glb` from `artifacts` and adds a warning rather than
failing. Configure the wall-clock budget via
`CAD_RENDER_TIMEOUT_MS` (default 60_000). Each artifact is capped at
10 MB.

### `POST /v1/images/generations`

OpenAI-compatible image generation, mounted on the standard `/v1` path
so `@tangle-network/tcloud`'s `imageGenerate(...)` (and any OpenAI Node
SDK with `baseURL` pointed at this bridge) Just Works without a custom
transport.

Default model: **`gpt-image-2`**. Override per-call via the OpenAI
standard `model` field.

```bash
curl -s http://127.0.0.1:3344/v1/images/generations \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer '"$BRIDGE_BEARER" \
  -d '{
    "prompt": "a small red square on a white background",
    "size": "1024x1024",
    "quality": "low",
    "n": 1
  }' | jq '.data[0].b64_json | length'
```

Request body (schema is permissive — unknown fields pass through):

```ts
{
  model?: string,                  // default "gpt-image-2"
  prompt: string,
  size?: string,                   // OpenAI-supported sizes
  quality?: string,                // low | medium | high | auto
  n?: number,                      // default 1, capped at 10
  response_format?: "b64_json"|"url",
  // Any future OpenAI params (style, background, output_format, …) pass
  // through unchanged — no schema bump required.
}
```

Response is the upstream's body verbatim (OpenAI-shaped):
`{ created, data: [{ b64_json, revised_prompt? }, …] }`. On upstream
failure the bridge surfaces the upstream's status code and error body
unchanged so `OpenAI`-style error handling on the caller side keeps
working.

**Dispatch order:**

1. `TANGLE_API_KEY` set → forward to `${TANGLE_ROUTER_URL or
   router.tangle.tools/v1}/images/generations`. Router accounts for
   credits + applies the operator's routing policy. Canonical
   production path.
2. `OPENAI_API_KEY` set → forward directly to OpenAI. Local-dev
   fallback.
3. Neither → **HTTP 503** with an OpenAI-shaped
   `{error:{type:"service_unavailable", code:"no_image_backend"}}`.

The bridge never logs prompts (potential PII); only model, size, n,
dispatch route, upstream status, and duration are emitted on stderr.

> **Note on image *editing*.** OpenAI's separate `/v1/images/edits`
> endpoint (multipart, with a reference photo for the "place this in
> your space" workflow) is intentionally NOT proxied yet — `tcloud`
> client doesn't surface it as of v0.4.6, and adding a custom shape
> would re-introduce the very transport asymmetry this route just
> removed. When the editing API lands in `tcloud`, mount a sibling
> `/v1/images/edits` route that mirrors the same router-vs-OpenAI fork.

## MCP passthrough

Every backend cli-bridge wraps loads Model Context Protocol servers
natively. Pass a single canonical shape in the request body and the
bridge translates it to each CLI's native loader — no per-backend
boilerplate, no prompt-injected tool surrogates: every CLI speaks
MCP.

### Wire shape

The shape mirrors Claude Code's `mcp-config.json` so the same JSON can
be forwarded to every backend that natively supports MCP. Pass it as
a top-level `mcp` field on the chat-completions body, or as the
`X-Mcp-Config` HTTP header (JSON-encoded; body wins on per-name
collision).

```jsonc
{
  "model": "claude/sonnet",
  "messages": [{ "role": "user", "content": "list my repos" }],
  "mcp": {
    "mcpServers": {
      "github": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": { "GITHUB_TOKEN": "ghp_xxx" }
      },
      "linear": {
        "type": "http",
        "url": "https://mcp.linear.app/mcp",
        "headers": { "Authorization": "Bearer lin_xxx" }
      }
    }
  }
}
```

Per-server fields:

| field      | type                     | notes                                                  |
| ---------- | ------------------------ | ------------------------------------------------------ |
| `type`     | `stdio`, `http`, `sse`   | optional; inferred from `command`/`url` when missing   |
| `command`  | string                   | stdio: executable to spawn                              |
| `args`     | string[]                 | stdio: argv after `command`                            |
| `env`      | `Record<string,string>`  | stdio: env vars for the spawned MCP server             |
| `url`      | string                   | http/sse: endpoint                                     |
| `headers`  | `Record<string,string>`  | http/sse: request headers (auth, etc.)                 |
| `enabled`  | boolean                  | set `false` to drop without removing the entry         |
| `timeout`  | number (ms)              | per-tool-call timeout                                  |

`agent_profile.mcp` is the sole MCP authority for an exact profile.
Without a profile, callers may use body/header `mcp.mcpServers`.
Sending both is refused before the harness starts.

### Host-owned private MCP credentials

Embedded hosts may pass `startServer({ mcpSecrets: { get: async key => /* host vault */ } })`.
Declare references in `agent_profile.mcp.<name>.env` or `.headers` as
`{ "kind": "secret-ref", "key": "tool-account", "format": "bearer" }` (omit `format`
for raw values). The HTTP API accepts references only; it cannot install a resolver.
Claude and Codex local execution resolve these references into private temporary
configs, removed after the turn. Missing bindings, sandbox execution, other backends,
and references in argv fail before dispatch. Native stdout/stderr are filtered for
exact admitted credential bytes before parsing, durable deltas, and raw capture;
raw capture manifests label this transformation. Terminal native copies below
use the same protected values. A tool's independent files still need their own
retention policy.

### Runtime attachments

A dispatching runtime mounts its own MCP endpoints with
`runtime_attachments.mcp`. Each entry uses the `agent_profile.mcp` server
schema and merges into the same materialized config the harness loads.

```jsonc
{
  "model": "claude/sonnet",
  "messages": [{ "role": "user", "content": "drive the run" }],
  "agent_profile": { "name": "supervised-manager" },
  "runtime_attachments": {
    "mcp": {
      "coordination": { "transport": "http", "url": "http://127.0.0.1:36827/mcp" }
    }
  }
}
```

This channel is accepted beside `agent_profile`, and it is the only channel
that is. It exists because an attachment endpoint is process-ephemeral: a
runtime that restarts serves the same coordination server on a new port. So
an attachment is excluded from:

- the exact session AgentProfile binding, which keeps one durable session
  usable across a restart that rebinds the port;
- every profile materialization receipt digest;
- durable-run request identity, so a reconnect re-attaches to the in-flight
  run instead of conflicting;
- durable session state, which is why the caller sends the attachment on
  every request that needs the mount.

Refused before the harness starts: an alias already declared by the profile
or the request `mcp` channel, an `enabled: false` entry, and a value that is
not a typed MCP server. `runtime_attachments` is also accepted on
`POST /v1/sessions` and `POST /v1/sessions/:id/turns`, where a turn value
replaces the created value for the spawn that turn starts.
Under the Linux bwrap jail, a plain-HTTP attachment that coordination or Hub routing has not bound is also refused
before the harness starts unless its exact URL is a live endpoint the embedding host registered with
`registerPrivateMcpEndpoint`, and such an attachment may carry only secret-ref headers.
An `agent_profile.mcp` server whose URL is on host loopback (`localhost`, `127.0.0.1`, `[::1]`) is refused there by name;
only a runtime attachment can claim a registered endpoint.

Clients discover the channel from `capabilities.runtimeAttachments.mcp` in
the root document (`GET /`), and must refuse rather than fold the endpoint
into the profile when the flag is absent.

### Per-backend support matrix

| backend    | stdio MCP | http/sse MCP | loader mechanism                                              |
| ---------- | --------- | ------------ | ------------------------------------------------------------- |
| claude     | yes       | no (caveat)  | `--mcp-config <tempfile>` (canonical `mcp-config.json` shape) |
| codex      | yes       | yes          | Isolated `CODEX_HOME` with per-turn `config.toml`         |
| kimi       | yes       | no           | project-local `<cwd>/.kimi-code/mcp.json` (restored after the turn) |
| opencode   | yes       | no           | `OPENCODE_CONFIG=<tempfile>` (opencode's per-config schema)   |
| gemini     | yes       | yes          | project-local `<cwd>/.gemini/settings.json` (restored after the turn), which the Bridge tells Gemini to trust for that turn; inline in `session/new` for a retained session |

**stdio**: every MCP-enabled backend loads stdio MCP servers — `command`, `args`,
and `env` round-trip through the materialised config file unchanged
(verified end-to-end in [`tests/mcp-passthrough.test.ts`](./tests/mcp-passthrough.test.ts)).

Claude Code host execution attests its native store from the executor's actual
jailed HOME mapping, including an explicit config-directory override when present.
The authenticated exact-session lookup retains this binding with the native session,
run and request identity; ordinary completion payloads do not expose host paths.

New host Codex sessions retain native rollouts and indexes under `BRIDGE_DATA_DIR/codex/<session-id-sha256>`, including sessions created without MCP.
The existing session execution lease serializes turns using that home.
The Codex backend serializes selected account preparation and refresh on one bridge process; access-only jailed turns can run concurrently.
Unconfined ChatGPT turns hold that account lease until their native turn ends because the CLI may refresh during inference.
Host turns link `auth.json` to that home, so Codex writes a refreshed token to the persistent account file.
ChatGPT subscription turns in an enforced `fs-jail` receive only their selected account's access credential.
This subscription isolation requires Linux read confinement using bubblewrap or explicitly selected Landlock with its host prerequisites; the bridge rejects macOS jailed subscription turns.
The bridge refuses a ChatGPT subscription turn in `write-jail` because that mode can read the host refresh token.
An unavailable jail cannot fall back to an unconfined subscription turn, even with `BRIDGE_JAIL_FALLBACK=warn`.
Recognized non-ChatGPT file auth modes retain their existing credential behavior; unrecognized files fail closed.
Env-authenticated launches can materialize MCP config without a local `auth.json`.
For Codex exec, a nonempty `CODEX_API_KEY` or `CODEX_ACCESS_TOKEN` takes precedence over persisted `auth.json`.
The bridge preserves that effective credential in a jail and does not seed an unrelated subscription account.
Docker Codex turns keep the container's mounted account home and receive only the declared MCP settings through a private per-turn config file.
The bridge removes ambient MCP servers even when a turn declares none, then restores the original config after the turn.
It refuses base config MCP syntax it cannot safely remove.
Docker and jailed Codex turns omit saved project trust from their temporary config, so project `.codex/` config, hooks, and rules cannot add tools outside the request.
Per-slot Docker Codex sessions use a stable slot chosen from the external session ID while the pool size stays fixed.
A busy slot queues the turn until its acquire deadline, even when another slot is free.
Changing the pool size can remap existing sessions; migrate or finish them before resizing.
Per-slot Docker turns do not inherit the bridge process's ambient Codex credentials.
Docker turns sharing one account home run one at a time while their private MCP config is installed.
Before a jailed turn whose deadline extends past access-token expiry, the bridge asks the installed Codex app-server to refresh the persistent account, then checks the selected account and token lifetime.
The jail receives the current per-turn MCP configuration, including changed Runtime attachment endpoints.
When a jailed turn declares no MCP servers, its account settings are retained without ambient MCP servers.
The bridge removes its temporary auth link and MCP configuration after the turn.
One-shot MCP homes are removed entirely.
Native session files remain with the bridge data directory; deleting a session mapping does not erase its transcripts.
Previously deleted temporary rollouts cannot be recovered by this change.
Legacy sessions without a retained home can continue without MCP on their original home; adding MCP is refused before execution.
Start a new external session with explicitly carried context when that legacy session needs MCP.
Continuity assumes an unchanged execution mode; moving a native session between host and jail is not verified.

**http/sse caveat**: claude/opencode load HTTP MCP via the
respective CLI's separate `mcp add --transport http` registry, which
is per-user persistent state and not safe for cli-bridge to touch on
every request. HTTP entries you pass to those backends are dropped at
materialisation. Use codex for stateless remote-MCP passthrough until
the upstream CLIs expose a per-invocation HTTP MCP loader.

## Claudish setup

Claudish is a separate tool (Hono-based Anthropic proxy). Run it locally:

```bash
brew install claudish   # or install-from-source per its repo
claudish --port 3456
# then in cli-bridge .env:
CLAUDISH_URL=http://127.0.0.1:3456
BRIDGE_BACKENDS=claude,claudish
```

Now every `claudish/<model>` call spawns Claude Code with `ANTHROPIC_BASE_URL=http://127.0.0.1:3456` — Claude Code's workflow, whatever-you-configured's brain.

## Use with Tangle products

**VerticalBench** — swap `claude -p` subprocess calls for HTTP to cli-bridge with `X-Session-Id: leaf-<id>`. Durable session state across runs, no re-billing replays.

**Agent Builder dev** — `BYOK_CLI_ENDPOINT=http://host.docker.internal:3344` in `.dev.vars`. Forge drives your Claude Code subscription locally during development. Never ship that to production.

**PR reviews & automations** — any bash cron / GitHub Action can hit `POST /v1/chat/completions` with a stable `X-Session-Id`.

## Executor concurrency

Every host spawn takes a slot from one process-wide semaphore before the CLI starts.
The semaphore is the box-protection layer: each `claude --print` is 500 MB to 2 GB resident, so unchecked spawns exhaust a 32 GB box and sshd can no longer fork a login shell.

| Setting | Default | Meaning |
| --- | --- | --- |
| `BRIDGE_HOST_MAX_CONCURRENCY` | `4` | Concurrent host spawns; `0` removes the bound. |
| `BRIDGE_HOST_ACQUIRE_DEADLINE_MS` | `60000` | Default wait for a slot before the bridge answers 429. |
| `BRIDGE_HOST_MAX_ACQUIRE_DEADLINE_MS` | `900000` | Ceiling on a request-supplied acquire deadline. |
| `CLI_BRIDGE_SCOPE_MAX_CONCURRENCY` | `4` | The same cap for the systemd-scoped executor on Linux. |
| `CLI_BRIDGE_SCOPE_ACQUIRE_DEADLINE_MS` | `60000` | Its default wait. |
| `CLI_BRIDGE_SCOPE_MAX_ACQUIRE_DEADLINE_MS` | `900000` | Its ceiling on a request value. |
| `CLI_BRIDGE_SCOPE_MEMORY_MAX` | host RAM ÷ 8, from `3G` to `8G` | `MemoryMax` of each systemd scope, for the CLI and every process under it. |
| `BRIDGE_POOL_ACQUIRE_DEADLINE_MS` | `60000` | Default wait for a Docker pool slot. |
| `BRIDGE_POOL_MAX_ACQUIRE_DEADLINE_MS` | `900000` | Its ceiling on a request value. |

The scope memory cap follows host memory, so a new box needs no override.
The bridge divides `MemTotal` by 8, rounds up to a whole GiB, and keeps the result from `3G` to `8G`.
A host with 64 GB or more gets `8G`; a 32 GB host gets `4G`; a 24 GB or smaller host gets `3G`.
Rounding up absorbs up to 8 GiB of firmware and integrated-GPU reservation, so a 128 GB host that reports 121 GiB still counts as large.
One eighth keeps the default 4 concurrent scopes within half of host memory.
The `3G` floor is the previous fixed default, so no host gets a tighter cap than before.
The `8G` ceiling is about 2.6 times the largest legitimate lane observed: python review lanes at 3.0 GB were OOM-killed under the old `3G` cap.
Set `CLI_BRIDGE_SCOPE_MEMORY_MAX` to any systemd `MemoryMax=` value to override it.
`/health` reports the effective value as `executor.scoped_host.memory_max`.
The value is `null` when systemd scopes are unavailable, because spawns then run without a cap.

`BRIDGE_HEALTH_READY_CACHE_TTL_MS` optionally caches successful backend readiness probes for the
specified number of milliseconds. It defaults to `0`, so readiness is rechecked on every request.
Use a short interval only when repeated cold-start probes exceed the caller's admission deadline;
failures are never cached.

**A slot is held per live SESSION on a retained backend, not per turn.**
For `pi`, the RPC child holds its slot from spawn to session termination, including the idle time between turns.
Size `BRIDGE_HOST_MAX_CONCURRENCY` against peak concurrent live sessions — leads plus workers — not against peak concurrent turns. An account-admitted fleet can set both `BRIDGE_HOST_MAX_CONCURRENCY=0` and `BRIDGE_HOST_CHAT_MAX_ACTIVE=0` to admit every turn; uncapped admission uses `BRIDGE_HOST_CHAT_RESERVED_ACTIVE=0` (also its default in that mode). Actual process lifetimes and cancellation still own release.
A fleet of one lead and three workers holds four slots for the whole run, so the default cap of 4 is already full and a fifth session waits.
One-shot backends (`claude`, `codex`, `opencode`, `kimi-code`, `gemini`) hold a slot only for the turn.

### Waiting for a slot, and being refused

A request can buy itself a longer queue with `execution.acquireTimeoutMs`, capped by `BRIDGE_HOST_MAX_ACQUIRE_DEADLINE_MS`:

```json
{ "model": "pi/anthropic/claude-sonnet-5-5", "execution": { "kind": "host", "acquireTimeoutMs": 900000 } }
```

A supervisor that already grants a worker a 15-minute settle grace can spend that grace queueing instead of losing the spawn to the fixed 60-second default.

When the wait runs out, the bridge answers `429` with `Retry-After: 5`:

```json
{
  "error": {
    "type": "executor_saturated",
    "capacity": true,
    "provider_dispatch": "not_started",
    "status": 429,
    "executor": "host",
    "in_flight": 4,
    "max": 4,
    "queued": 1,
    "deadline_ms": 60000,
    "retry_after_ms": 5000,
    "message": "host-executor: acquire timeout after 60000ms (in_flight=4/4, queued=1)"
  }
}
```

`capacity: true` and `provider_dispatch: "not_started"` are the two facts a caller retries on: the refusal happened before the child existed, so no model call was made and a retry loses nothing.
A streaming request has already committed to `200` plus SSE by the time the spawn seam refuses, so the same fields ride on the terminal error frame, including `status: 429`.
The counts are the retry signal: `in_flight` still equal to `max` means wait, not fail.

Host execution is the supported local executor. `<NAME>_EXECUTOR=host` and
`BRIDGE_DEFAULT_EXECUTOR=host` remain accepted. Docker executor and net-jail
settings are refused at startup; requests containing `execution.netJail` are
rejected. Use the maintained container platform for network confinement.

## Filesystem jail on Linux

`BRIDGE_JAIL_MODE=fs-jail` uses bubblewrap by default. A failed bubblewrap probe
never substitutes another backend. An operator may explicitly select
`BRIDGE_JAIL_BACKEND=landlock`; it needs an unprivileged user with no held Linux
capabilities, `python3`, and an architecture and ABI accepted by
`src/jail/landlock-exec.py`. Missing support preserves the startup refusal.
Before a host switches to Landlock, one real claude turn and one real codex turn
must pass under it on that host. A provider quota refusal proves the network path,
not a completed model turn; strict-box receipts are recorded on PR #375.
Use the host's own subscription logins for those turns; never add an API key.
The selected backend is captured with each request's operator policy, including
when an embedded server loads configuration from a custom environment. No compiled
helper or install step is required. macOS continues to use sandbox-exec unless an
unsupported backend is explicitly selected.

Both Linux backends derive their filesystem grants from one path policy. Under
Landlock, readable grants protect file contents; writable grants cover the workspace,
jail home and explicit writable paths. A read-only path beneath a writable grant is
refused because additive grants cannot protect that subtree. Grant identities are
checked again by the launcher before enforcement. The Nix store is exposed only
when a selected toolchain or the Landlock interpreter needs it.
HOME, configuration/cache directories and TMPDIR point into the jail home. The
Landlock payload receives no host session-bus, runtime-directory or socket-discovery
environment variables, even when an outer scope wrapper needs them. The policy then supplies its jail-local runtime directory. Restrictions
survive exec and are inherited by descendants. A failed rule or launcher exits
without executing the command.

| Boundary | Bubblewrap | Landlock | Residual risk / refusal |
| --- | --- | --- | --- |
| Path mappings | Bind source at destination | Same-path grants only | Any remapped bind is refused, including remapped read-only auth. Global Git snapshots use their own read-only paths and `GIT_CONFIG_GLOBAL`. A host with such mappings may start but refuse requests. |
| Temporary files | Private `/tmp` mount | Private TMPDIR under jail home; shared `/tmp` has no grant | Hardcoded `/tmp` access fails unless the spec explicitly exposes that exact path. |
| Egress state | Masks siblings with tmpfs | No broad grant covering the egress parent; only own CA files granted; launcher policies remain beneath that hidden parent | Pathname Unix-socket connections are unmediated by these Landlock ABIs; the launcher refuses AF_UNIX socket creation. |
| `/proc`, devices and metadata | Private proc/device mounts and read-only binds | Read-only own numeric `/proc/<pid>/{maps,stat,statm,cgroup}` files for runtime stack bounds and metrics; only null, zero, random and urandom device grants | Metadata remains visible. Mode, ownership, timestamps and extended attributes are outside this allowlist, including on ungranted files the user owns. Other process directories and host proc files have no read grant. Exec preserves the numeric PID grant; forked children inherit it, not a new grant for their PID. A Bun child with a different PID can abort at startup because it cannot read its own maps. |
| Process and IPC | Separate PID/IPC/UTS namespaces | Host namespaces; direct launcher dies when its parent exits; signal and abstract-socket scopes where supported | No PID namespace or whole-tree parent-death guarantee. Without kernel signal scopes, same-user signalling remains possible. A descendant that leaves the process group outlives the spawn's cleanup with its Landlock grants (see Network). |
| Network | Separate network namespace with relay shim | Seccomp allows only ordinary TCP Internet sockets; AF_UNIX socket creation is refused and stream socketpair remains available for local IPC; TCP connects limited by port grants, with no TCP bind grants | Ports do not restrict addresses. A relay with allowed hosts captures the bridge's `HTTPS_PROXY`/`https_proxy` and `NO_PROXY`/`no_proxy` at startup; bubblewrap relays and relays without allowed hosts dial directly. Allowed non-intercepted targets use HTTP CONNECT without local target DNS only when `BRIDGE_JAIL_OUTER_PROXY_ENFORCED=1` declares that the operator proxy refuses all private destinations, including names resolving to private addresses. Before opening a relay, the bridge verifies HTTP 403 refusals for `127.0.0.1:443` and `localhost:443`; missing declarations, successful tunnels, authentication failures and transport errors refuse relay startup without fallback. Private and loopback IP literals (including IPv4-mapped IPv6) and localhost names are independently refused before CONNECT. URL credentials become Basic proxy authentication. Verification samples the declared policy; operators must maintain that policy for every destination. Direct and NO_PROXY dials retain private-address checks. Intercepted `proxySecrets` traffic retains iron-proxy's own routing and deny list; strict-box outer-proxy support for that path remains unresolved. `listen()` on an unbound AF_INET socket can autobind without the bind hook. UDP, MPTCP, other Internet protocols, netlink, MSG_FASTOPEN sends and io_uring creation are refused by seccomp. Pathname Unix-socket connections, including systemd user-manager and session-bus access, are refused by denying AF_UNIX socket creation; stream socketpair stays available for local IPC. Only measured stream socketpairs are retained; datagram pairs can reconnect to pathname peers. The TCP relay creates no pathname socket and requires a per-spawn proxy credential; other host processes can still reach its listener. Host-service claims have a separate random URL credential, compared in constant time. A revoked claim answers 403 while its spawn runs, and that spawn's cleanup closes the listener; a claim no spawn adopted closes on revoke. Accepted residual: a descendant that outlives cleanup keeps its connect grant to the closed claim port, which another host process could later bind. |
| Write jail | Host-wide read-only mount with hidden egress state | Refused; use fs-jail | A configured write-jail floor can pass the availability probe but each Landlock request is refused. |

Every Landlock request, including `network: none`, is refused with HTTP 501 unless
`BRIDGE_JAIL_HOST_EGRESS_ENFORCED=1` (default off). This is an operator assertion
that the box's external egress policy is strict. The launcher also enforces a
seccomp socket filter under NO_NEW_PRIVS, independent of the assertion. Only
AF_INET/AF_INET6 SOCK_STREAM with protocol zero or IPPROTO_TCP may be created;
AF_UNIX socket creation, non-stream socketpairs and io_uring_setup are refused; stream socketpair remains available for local IPC. Landlock then admits only
the spawn's TCP ports. A user-only firewall cannot distinguish the bridge and
payload, which share a user and network namespace. Host policy must still protect
other host services and pathname Unix sockets; Landlock supplies no mount or
network namespace. If the box's egress policy stops being strict, the operator
must restart the bridge with the assertion cleared, or clear the assertion and
restart before admitting further work. It is captured at startup. This assertion
and the backend choice are never request fields and add no served capability or
policy keys. Trusted private host-service aliases use one ephemeral loopback listener
per claim when that assertion is enabled. Protected headers remain in the host relay,
and claims cannot be adopted by a second spawn. The URL is allocated before native
configuration, so it cannot share the later per-spawn proxy listener. Pi's isolated
transport runs under either backend: under Landlock its TCP grants name only the run's
own loopback inference port and relay, and its Bash reads neither the bridge's `/proc`
environment nor another run's agent directory (`tests/pi-landlock-jail.integration.test.ts`).

The integration proof is `tests/landlock-jail.integration.test.ts`. Run it with
`CLI_BRIDGE_REQUIRE_LANDLOCK=1` to make an unavailable kernel a failure rather than
a skip. Each confinement case also runs against an unconfined launcher and must
fail its boundary assertion. Kernel and ABI are printed with the result. See the
[kernel UAPI documentation](https://docs.kernel.org/userspace-api/landlock.html)
for the rights and limits of each ABI.

## Traces

Every chat request emits one OTLP span, in the shape defined by
`@tangle-network/agent-trace-contract`.
Because every harness routes through this one service, instrumenting here traces
claude, kimi, codex, opencode and pi identically — there is no per-harness adapter.

The contract is an ordinary registry dependency (`@tangle-network/agent-trace-contract`,
`^1.0.1` on npmjs) — the same package the trace analyzer and VerticalBench depend on, so
all three agree on the span shape without sharing code.

```
chat <backend>   (LLM)    gen_ai.request.model, gen_ai.system,
  │                       gen_ai.usage.input_tokens / output_tokens / cost_usd,
  │                       cli_bridge.usage.scope (only when model-call children exist)
  ├─ model call  (LLM)    gen_ai.request.model, gen_ai.response.model (when reported),
  │                       gen_ai.usage.input_tokens (fresh only) / output_tokens,
  │                       gen_ai.usage.cache_read.input_tokens / cache_creation.input_tokens,
  │                       gen_ai.usage.reasoning.output_tokens
  └─ <tool name> (TOOL)   gen_ai.tool.name, gen_ai.tool.call.id
```

Spans land as JSON lines in `<BRIDGE_DATA_DIR>/traces/spans.jsonl`.
Each span is written once. A tool span lands the moment the model asks for the call (as soon as the
request's agent is named), so a reader tailing the file sees an agent working before its turn ends; the
`chat` span, which carries the turn's tokens and status, lands when the request closes.

**Per-call usage.** When a backend reports each provider call's usage as it finishes (opencode's
per-step receipts), each call gets a `model call` child span the moment its receipt arrives, so a
reader can sum a long run's tokens while it runs. A call span runs from the previous call's end (or
the request start) to the receipt. On a call span `gen_ai.usage.input_tokens` is FRESH input only;
cache reads and cache writes are their own keys, so the whole prompt is their sum (the span contract
of tangle-network/traces). `output_tokens` includes the reasoning tokens. The `chat` span's
`input_tokens` is unchanged: the whole prompt, cache included. A count the backend did not report is
absent, never `0`. cli-bridge writes raw tokens only, no prices.

The `chat` span keeps the turn's total, so a reader of that span alone is unchanged. When every
token-bearing record of the turn was a model call, it also carries
`cli_bridge.usage.scope = "sum_of_children"`: its usage is the sum of its `model call` children
(its `input_tokens` equals the children's fresh input plus their cache reads and writes). A reader
that sums usage over every LLM span must skip a span carrying it, or it counts the turn twice.
Backends that report one usage record per turn write no children and no marker.

`BRIDGE_TRACE=off` disables emission. A sink failure is logged and swallowed —
tracing never fails a request.

**Rotation.** The active file rotates to `spans.jsonl.1`, `.2`, … once the next
write would exceed `BRIDGE_TRACE_MAX_BYTES`, and the oldest generation is deleted,
so retained trace bytes are bounded by `BRIDGE_TRACE_MAX_BYTES × BRIDGE_TRACE_MAX_FILES`.
Because tracing is on by default, that ceiling defaults to a deliberately small
**32 MiB** (16 MiB × 2) — an operator who never configured it does not pay for a
retention target they never asked for. A span is a few hundred bytes, so 32 MiB
still holds tens of thousands of requests; raise both values for longer history.

### Correlation

Send your own trace context and the bridge's span nests under yours, so a caller's
round and the harness invocation it caused are one tree:

```bash
curl http://127.0.0.1:3344/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' \
  -d '{"model":"opencode/deepseek/deepseek-chat","messages":[{"role":"user","content":"hi"}]}'
```

W3C `traceparent` is preferred; `X-Trace-Id` + `X-Parent-Span-Id` are the fallback
for callers without a tracing SDK (a dashed UUID is accepted as a trace id). Without
either, the request becomes its own root trace. `cli_bridge.trace.correlation` on the
span records which path was taken — `invalid` means a header was sent and could not
be used.

Both forms require the OTLP encoding: 32 lowercase hex characters for a trace id, 16
for a span id. A caller whose own ids are human — VerticalBench names a round
`oc-glm52@generic-…-r0` — derives the wire ids with the contract's `deriveHexId` and
keeps the readable name as an attribute on its own span. That derivation is pure and
dependency-free, so the caller and the bridge mint the same ids without talking to
each other. Sending the human id raw is the failure this prevents: the request still
succeeds, but the span roots itself and `cli_bridge.trace.correlation` reads `invalid`.

A correlated span names a parent that lives in the CALLER's export, so validating
this file alone reports `orphan-parent`. That is the fragment saying where it
attaches; concatenate both exports and the tree validates clean.

### Session lineage

A caller that runs under the operator's `lineage` tool (tangle-tools `lineage/`) sends its worker's session ids as `x-tangle-*` headers.
The bridge sets them as the harness child's `TANGLE_*` environment on the host, scoped-host and docker executors, and adds them to its `OTEL_RESOURCE_ATTRIBUTES`.
The recognized headers are `x-tangle-run-id`, `-parent-run-id`, `-root-run-id`, `-edge-kind`, `-operator`, `-project`, `-account` and `-harness`.
`TANGLE_HOST` is the bridge's own host, because the child runs there.
Retained sessions read the same headers on `POST /v1/sessions/:id/turns`; the turn that starts the native process sets its lineage.
A request without `x-tangle-run-id` stamps nothing.
The bridge never passes its own ambient `TANGLE_*` lineage to a child.
Header values outside `[A-Za-z0-9_.:@+/-]`, or longer than 128 characters, are dropped.
agent-runtime's bridge executor sends these headers when its supervisor process carries a `TANGLE_RUN_ID`.

### Bridge-specific attributes

Everything a semantic convention already names uses the standard key. These are
the bridge's own execution context:

| Attribute | Meaning |
|---|---|
| `cli_bridge.run.id` | Durable run id — joins to `GET /v1/runs/:id` |
| `cli_bridge.session.id` | Caller-owned session id, when resuming |
| `cli_bridge.backend.session_id` | The harness's own session id — joins to that CLI's transcript |
| `cli_bridge.profile.effective_digest` | WHICH AGENT ran this — `sha256:…` of the effective `agent_profile` |
| `cli_bridge.profile.name` | The caller's `agent_profile.name`, verbatim. A readable label, not an identity |
| `cli_bridge.mode` / `cli_bridge.execution` | `byob`/`hosted-safe` and `host`/`sandbox` |
| `cli_bridge.trace.correlation` | `traceparent` / `headers` / `none` / `invalid` |
| `cli_bridge.finish_reason` | Terminal reason — separates `length` from `stop` |
| `cli_bridge.usage.estimated` | Present and `true` when tokens were derived from text, not measured |
| `cli_bridge.tool_calls.observed` / `.dropped` | Tool calls seen, and any beyond the per-request span cap |

A tool span keeps only what ran and where, as `input.value` JSON: `command`, `file_path`,
`path`, `pattern`, `query` or `url`, scrubbed of credentials and capped. File contents, edit
bodies, prompts and tool output are never written. Cost is
written only when every usage record reported one, so a floor is never read as a
total. The profile is written as a DIGEST for the same reason — the profile itself
carries prompts and instructions.

**Which agent did this.** `cli_bridge.profile.effective_digest` is the one attribute
that makes a multi-agent trace readable. Several agents commonly share one run and
one `spans.jsonl`; without it the only discriminator left is `gen_ai.request.model`,
which is not an identity — two agents on the same model are indistinguishable, and
one agent whose model changed reads as two. The value is the SAME `sha256:` string
the bridge already reports as `effectiveProfileDigest` on the profile-materialization
receipt (`GET /v1/runs/:id`) and on the session's profile binding: the profile is
resolved once per request and memoized, so the three cannot disagree. `agent-runtime`
records that digest per node on its spawn journal (`profileDigest` /
`authoredProfileDigest`), so span → node is a join, not an inference. Both attributes
are absent — never a placeholder — on a request that carried no `agent_profile`,
and they appear on the tool spans as well as the request span, so filtering the file
to one agent's work does not require rebuilding the tree first.

## Deploy

See `deploy/README.md` for Hetzner box (Docker or systemd). Remote deploy requires `BRIDGE_BEARER` — cli-bridge refuses to bind non-loopback without one.

## Design notes

- **Explicit in the model id, not the env.** The `<harness>/<model>` scheme means "what you type is what runs." No mode toggles that change behavior under the same id.
- **Harnesses are independent.** Each is a class implementing `Backend`; add a new one in `src/backends/*.ts`, register it in `src/server.ts`.
- **Single-user assumption is deliberate.** No per-call user auth beyond the optional bearer.

## License

MIT


### Process and native evidence

Set `BRIDGE_RAW_CAPTURE_DIR` to a private absolute directory to retain original stdout and stderr for one-shot durable runs.
The Bridge creates that directory, or narrows one its own user owns, to mode 0700; it refuses a link or another user's directory.
Use an enforced filesystem jail whose writable workspace cannot reach that directory.
The shared host, scoped-host, and Docker process seam captures bytes before a harness parser decodes them.
Each private frame records byte length, SHA-256, process ID, sequence, and timestamp.
A protocol frame binds the process to the existing durable run coordinates.
A terminal records the actual exit and capture errors.
A separate manifest links those coordinates to native session IDs observed by the backend.
Capture write failures fail the run; they never become successful capture receipts.

Known admitted custom-MCP values, Hub grants and runtime coordination bearers
are filtered before parsing or retaining process bytes. Other output can still
be sensitive. The bridge exposes no download endpoint for these private files.

For Linux host-jailed Claude Code and Codex one-shot runs, the same producer
captures the exact native family after its child closes and before releasing
private grants. `RunSnapshot.nativeCapture` identifies the committed private
manifest by path, digest and byte length, or explicitly names an unavailable
capture. The existing durable run snapshot retains this reference across reader
disconnect and Bridge restart. This does not reconstruct a native child after
Bridge death.

The existing session row checkpoints nonsecret redaction history before a new
native launch. When this Bridge cannot name every protected value a native
conversation may hold, the turn still runs and keeps no retained copy: no
process frames, no native copy, and `nativeCapture` names the reason. A
conversation continued after a Bridge restart reports
`native-redaction-history-unavailable`, as does a legacy native row without this
history. An accepted native context import, which carries no source redaction
provenance, reports `native-context-import-without-redaction-provenance`. The
unchanged history row keeps every later turn of that conversation withheld.
Output in such a turn is filtered only for the values admitted since this
Bridge started, as on a Bridge without cross-turn redaction. Neither private
values nor hashes of those values are persisted. An embedded host's
`onRunRedaction` redactor for a withheld run throws with the reason.

Native payloads use the existing `tangle.raw-evidence-archive.v2` copy format and
the harness-sessions family verifier. The manifest adds exact Bridge run,
profile, CWD, child attribution and source-versus-retained file provenance.
Only transformed copies are written; original vendor files stay unchanged.
Redaction makes original-byte coverage incomplete even when the retained family
passes identity and integrity checks. Missing children, unsafe paths, partial
lines, inventory bounds and unsupported stores remain explicit gaps. Read bounds
come from `@tangle-network/harness-sessions`.

Native copies are written only to `BRIDGE_RAW_CAPTURE_DIR`, beside the process
frames; without it a run reports `native-capture-not-configured`. The Bridge
applies no retention to that directory: its operator owns the byte and age
bound. A capture that commits no manifest removes the payloads it wrote. macOS descriptor-relative capture and Pi's retained native-session
API jobs are unsupported by this producer. The filesystem jail's network policy
also applies to local MCP/Hub URLs; an unjailed authentication test does not prove
their reachability from a jailed native process.
