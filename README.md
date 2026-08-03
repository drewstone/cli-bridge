# cli-bridge

**Use your local coding-CLI subscriptions as one OpenAI-compatible HTTP API — with persistent session resume.**

Model ids are `<harness>/<model>`. The harness is the agent runtime (Claude Code, Codex, opencode, claudish, …); the model is whatever that runtime can address. One string, both choices explicit.

Backends this is built for (✓ implemented, ◦ stubbed):

| Harness | Status | What it is |
|---|---|---|
| `claude/` | ✓ | [Claude Code](https://github.com/anthropics/claude-code) CLI — your Claude Max / Pro subscription |
| `claudish/` | ✓ | Claude Code + [claudish](https://github.com/MadAppGang/claudish) — Claude's workflow, a different brain |
| `codex/` | ✓ | [OpenAI Codex CLI](https://github.com/openai/codex) — your ChatGPT Plus/Pro subscription |
| `opencode/` | ✓ | [opencode](https://github.com/sst/opencode) — multi-provider; the vehicle for Kimi Code via the `opencode-kimi-full` plugin |
| `gemini/` | ✓ | [Gemini CLI](https://github.com/google-gemini/gemini-cli) — Google's official Gemini coding CLI |
| `factory/` | ◦ | [Factory Droid](https://docs.factory.ai/) |
| `amp/` | ◦ | [Sourcegraph Amp](https://ampcode.com/) |
| `forge/` | ◦ | [Forge Code](https://github.com/antinomyhq/forge) |
| `<provider>/` | ✓ | Passthrough: `openai/`, `anthropic/`, `moonshot/`, `zai/` — direct vendor API, not a CLI |

Personal productivity tool. Single-user by default. Loopback-only by default. No ambition to be a shared proxy.

---

## The idea in two sentences

Every AI lab now ships a CLI, each with its own subscription + better session economics than the metered API. cli-bridge exposes all of them as one OpenAI-compatible endpoint so your tools (editor, aider, tangle-router, a bash script) can switch harnesses with a single string.

## Model id scheme

```
<harness>/<model>

claude/sonnet                        # Claude Code + Anthropic Sonnet
claude/opus                          # Claude Code + Anthropic Opus
claude/claude-sonnet-4-5-20250929    # Claude Code + specific version

claudish/openrouter@deepseek/deepseek-r1   # Claude Code workflow, DeepSeek brain
claudish/google@gemini-2.0-flash           # Claude Code workflow, Gemini brain
claudish/zai@glm-4.6                       # Claude Code workflow, Z.AI brain

codex/gpt-5-codex                    # Codex CLI, Codex model
opencode/kimi-for-coding             # opencode + kimi-full plugin (Kimi Code sub)
opencode/anthropic/claude-sonnet-4-5 # opencode's configured anthropic provider
gemini/gemini-2.5-pro                # Gemini CLI with explicit model
gemini/gemini-2.5-flash              # Gemini CLI Flash model

openai/gpt-4o                        # passthrough — OpenAI API, metered
zai/glm-4.6                          # passthrough — Z.AI API, metered
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

**Prereqs:** Node 22+. For each backend you want enabled, install + log in on the host. The install commands below are wrapped by:

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
| `pi` | `npm install -g @earendil-works/pi-coding-agent` | Provider credentials in `~/.pi/agent` |
| `passthrough` | (none) | provider API keys in `.env` |

For a Nix-provisioned host shell with the shared prerequisites:

```bash
nix-shell nix/harness-profile.nix
sh scripts/install-harness.sh all
```

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

### `POST /v1/chat/completions`

OpenAI Chat Completions.
Model id routes via harness prefix.
The OpenAI-compatible default is non-streaming; pass `stream: true` for SSE.
Session resume uses the `session_id` body field or `X-Session-Id` header.

Extra fields this bridge accepts beyond vanilla OpenAI:

- `cwd`: persist a working directory for the session and run future resumed turns there
- `agent_profile`: full `AgentProfile` object
- `mcp`: standardised MCP server passthrough (see [MCP passthrough](#mcp-passthrough))
- `run_id`: caller-owned durable job id (also accepted as `X-Run-Id`)
- `execution`: execution location plus an optional caller-owned `timeoutMs` process deadline

Behavior:

- `sandbox` backends honor the full `agent_profile` natively
- local harness backends (`claude-code`, `codex`, `kimi-code`, `gemini`, `pi`) persist the full profile and reject profile dimensions they cannot execute
- Pi passes the replacement system prompt, additive instructions, skills, and prompt templates through Pi's native per-process flags using unique files that are removed after the run; a profile grants run-scoped project-file trust without persisting approval, while ambient context, skill, and prompt-template discovery stays disabled
- `agent_profile.extensions.pi.load` selects an exact Pi extension set from installed package names or absolute paths; when present, the bridge passes `--no-extensions` plus one `--extension` flag per resolved entry
- when Pi runs inside the OS filesystem jail, the executor translates each installed-package path only after confinement is confirmed; host, Docker, and explicit unconfined-fallback paths keep their normal argv
- an EMPTY `load` list (`"extensions": { "pi": { "load": [] } }`) is the complete-isolation request: `--no-extensions` and nothing else, so no installed extension loads. Use it when a run must not inherit state an extension persists across runs — a paired experiment whose two arms share such an extension is silently unpaired, and nothing in the response reports it
- Pi rejects generic profile file mounts because Pi has no request-scoped loader that can preserve their declared task-relative paths

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
If the field is omitted, the matching backend's timeout environment setting is an operator fallback; all timeout fallbacks default to `0`, which means no deadline.
An explicit request value always wins over that fallback and is also forwarded to sandbox tasks and the OpenCode wrapper.
`CLI_BRIDGE_SCOPE_RUNTIME_MAX_SEC` and `BRIDGE_SLOT_MAX_HOLD_MS` are separate operator safety caps; both default to disabled and may preempt a longer request only when an operator explicitly configures them.

Supply `run_id` in the body or `X-Run-Id` in the header to make dispatch idempotent.
If both are present they must match.
Ids are 1–128 characters, begin with an ASCII letter or digit, and may then contain letters, digits, `.`, `_`, `:`, or `-`.
The bridge binds the id atomically to the normalized execution request before admission or backend setup:

- An identical retry attaches to the existing job and never acquires a second process slot.
- A different request under the same id returns `409 run_identity_conflict` with both request digests.
- The response carries `X-Run-Id` and `X-Run-Request-Digest`; retain both with the trace.

For `stream: true`, every output delta has a monotonically increasing SSE `id`.
Reconnect with the same request and `Last-Event-ID: N` to receive only events after `N`.
An ahead cursor returns `409 invalid_replay_cursor`.
A cursor older than the retained window returns `410 expired_replay_cursor`; the bridge never silently restarts at event zero.
`Last-Event-ID` is rejected for non-streaming responses because a single JSON response cannot express partial replay.

Replay storage is explicitly bounded per process:

- At most `BRIDGE_RUN_MAX_REPLAY_DELTAS` deltas are retained per run (default `10000`).
- Terminal output expires after `BRIDGE_RUN_REPLAY_RETENTION_MS` (default `60000` ms).
- The run-id/request binding remains after output expiry for `BRIDGE_RUN_IDENTITY_RETENTION_MS` (default `86400000` ms) so a late retry cannot accidentally execute the job again.

Model output is not clipped by the bridge's process-diagnostic protection.
The bridge retains at most 64 KiB of each subprocess's stderr/stdout diagnostics, preserving both the beginning and end for failures, while successful streamed content continues through the normal response and replay path.
Progress heartbeats use one live timer per subprocess wait rather than one timer per streamed event.

Do not recycle run ids after the identity window.
A bridge restart loses the in-memory registry; `404` after a restart means the old process is unknown, not proven stopped.

`GET /v1/runs/:id?wait_ms=N` returns the current snapshot and can wait up to 30 seconds for terminal state.
The `state` field is `running` while a reader is attached, `detached` while the job continues without readers, `cancelling` after explicit cancellation but before process exit, and `terminal` only after the backend iterator exits.
The separate `status` field records the outcome as `running`, `done`, `error`, or `cancelled`.

`POST /v1/runs/:id/cancel?wait_ms=N` returns:

- `202` while cancellation was requested but process exit is not yet proven.
- `200` only with `terminal: true` and the terminal run snapshot.
- `404` when this bridge process has no record of the run; this is not termination proof.

The `wait_ms` query is an integer from `0` through `30000` on both endpoints.

### `GET /v1/models`

Lists model ids each ready backend claims, with which harness serves them.

### `GET /health`

JSON report per backend — ready / unavailable / error with detail.

### `GET /v1/sessions` · `DELETE /v1/sessions/:id`

Inspect / clear external-to-internal session mappings.

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
nix profile in `tangle-network/agent-dev-container`). GLB output
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

`agent_profile.mcp` (sandbox-native shape) is also honored — request
body `mcp.mcpServers` wins on per-name collision so caller's per-turn
intent always overrides profile defaults.

### Per-backend support matrix

| backend    | stdio MCP | http/sse MCP | loader mechanism                                              |
| ---------- | --------- | ------------ | ------------------------------------------------------------- |
| claude     | yes       | no (caveat)  | `--mcp-config <tempfile>` (canonical `mcp-config.json` shape) |
| codex      | yes       | yes          | `CODEX_HOME=<tempdir>` with synthesised `config.toml`         |
| kimi       | yes       | no           | `--mcp-config-file <tempfile>` (same shape as claude)         |
| opencode   | yes       | no           | `OPENCODE_CONFIG=<tempfile>` (opencode's per-config schema)   |
| gemini     | no        | no           | not wired until Gemini exposes/validates per-invocation MCP   |

**stdio**: every MCP-enabled backend loads stdio MCP servers — `command`, `args`,
and `env` round-trip through the materialised config file unchanged
(verified end-to-end in [`tests/mcp-passthrough.test.ts`](./tests/mcp-passthrough.test.ts)).

**http/sse caveat**: claude/kimi/opencode load HTTP MCP via the
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
BRIDGE_BACKENDS=claude,claudish,passthrough
```

Now every `claudish/<model>` call spawns Claude Code with `ANTHROPIC_BASE_URL=http://127.0.0.1:3456` — Claude Code's workflow, whatever-you-configured's brain.

## Use with Tangle products

**VerticalBench** — swap `claude -p` subprocess calls for HTTP to cli-bridge with `X-Session-Id: leaf-<id>`. Durable session state across runs, no re-billing replays.

**Agent Builder dev** — `BYOK_CLI_ENDPOINT=http://host.docker.internal:3344` in `.dev.vars`. Forge drives your Claude Code subscription locally during development. Never ship that to production.

**PR reviews & automations** — any bash cron / GitHub Action can hit `POST /v1/chat/completions` with a stable `X-Session-Id`.

## Parallel mode (Docker pool)

Default behavior spawns the CLI on the host. That's fine for one
caller; under N concurrent chat() calls you hit:

- shared `~/.claude` (or `~/.kimi`, `~/.codex`, `~/.config/opencode`) OAuth state
- shared scratch dirs (multiple CLI processes touching the same tmp)
- single CLI subprocess instance contending with itself

The Docker executor solves all three: each chat() runs inside a
pre-warmed container slot, and session_id sticks the same caller to
the same slot so `--resume` reads the same on-disk transcript
turn-to-turn. Works for **every subprocess backend** — claude, kimi,
gemini, codex, opencode, pi — through the same `Spawner` abstraction.

```bash
# 1. build the unified runtime image once (has all coding CLIs installed)
pnpm docker:build:runtime

# Or build a smaller subset/layerable image for a specific deployment.
docker build -f docker/Dockerfile.cli-runtime \
  --build-arg CLI_BRIDGE_HARNESSES=codex,gemini \
  -t cli-bridge-cli-runtime:codex-gemini .

# 2. enable per backend (any subset)
cat >> .env <<'EOF'
CLAUDE_EXECUTOR=docker
CLAUDE_DOCKER_POOL_SIZE=4
CLAUDE_DOCKER_WORKSPACE_ROOT=/tmp/cli-bridge-workspaces
CLAUDE_DOCKER_NETWORK=research-services
KIMI_EXECUTOR=docker
KIMI_DOCKER_POOL_SIZE=2
GEMINI_EXECUTOR=docker
GEMINI_DOCKER_POOL_SIZE=2
CODEX_EXECUTOR=host
OPENCODE_EXECUTOR=host
EOF

# Or flip everything at once:
# echo 'BRIDGE_DEFAULT_EXECUTOR=docker' >> .env

# 3. start as usual
pnpm start
# [cli-bridge] claude executor: docker pool size=4 image=cli-bridge-cli-runtime:latest
# [cli-bridge] kimi    executor: docker pool size=2 image=cli-bridge-cli-runtime:latest
# [cli-bridge] gemini  executor: docker pool size=2 image=cli-bridge-cli-runtime:latest
```

OAuth mount modes:

- `share` (default) — bind-mounts host `~/.claude` (etc) into every slot.
  Simplest; concurrent token-refresh can race on the same session DB.
- `per-slot` — each slot gets its own named docker volume. Full OAuth
  isolation; one `<cli> /login` per slot on first run.

Coding runs can expose one dedicated host workspace tree with
`<NAME>_DOCKER_WORKSPACE_ROOT=/absolute/path`. The bridge canonicalizes an
existing directory, rejects `/`, mounts it read-write at the identical path in
every worker, and rejects request `cwd` values outside it. OAuth remains a
separate mount controlled by the mode above. Use a narrow per-experiment root,
not a home or repository parent directory.

Pool workers can join one existing Docker network with
`<NAME>_DOCKER_NETWORK=<network-name>`. The bridge passes the validated name to
`docker run --network`; it does not create or remove the network. Leave this
unset to retain Docker's default networking behavior.

### net-jail — deny-by-default egress (`WORKER_NET_JAIL`)

`WORKER_FS_JAIL` confines what a worker can READ. `WORKER_NET_JAIL=1` confines
where it can CONNECT: the worker's process tree gets no egress at all except to
an allowlist that always contains the backend's own model endpoint.

```bash
OPENCODE_EXECUTOR=docker
WORKER_NET_JAIL=1
# optional extras beyond the model endpoint, which is derived automatically
BRIDGE_NET_JAIL_ALLOW=registry.npmjs.org,internal-svc.example:8443
```

The gap it closes: denying the harness's `webfetch` tool removes a *tool*. It
does not stop `bash` from running `curl` or `git clone`, so a worker with bash
and no network policy has the whole internet regardless of its permission map.
A benchmark rig was one run from a large fake result because the worker could
clone the public upstream of the repository it was being graded on.

**How it is enforced.** Three layers, and all three are load-bearing.

*The network.* For each jailed backend the bridge creates an `--internal` Docker
network — no default route off it, no external DNS — plus a relay container
attached to both that network and an ordinary one, pinned to a fixed address.
The relay is registered on the internal network under a network-scoped alias for
every allowlisted hostname, and it checks the name each connection claims (TLS
SNI, or the `Host` header for cleartext) before forwarding a byte. TLS is never
terminated: the relay splices raw bytes, so certificate validation still happens
end-to-end against the real origin.

*The filter.* `--internal` denies routing OFF the bridge; it does not deny the
bridge. Docker still configures the host's gateway address on that subnet, and
it is on-link in the worker's own network — as is every other container there.
A jailed worker used exactly that to pull 339,594 bytes of github.com with a
valid certificate chain, through a service listening on the Docker host. So each
jailed container also gets a packet filter in its OWN network namespace: default
policy DROP in both directions, and exactly two exceptions — loopback (Docker's
embedded resolver lives there) and the relay's pinned address. The host gateway,
peer containers, the host's other interfaces, link-local metadata addresses
(`169.254.0.0/16`) and all IPv6 are rejected by the kernel.

The rules are written by a throwaway sidecar that joins the worker's network
namespace with `CAP_NET_ADMIN` and exits. The worker itself never holds that
capability, so `iptables` inside it fails with `Permission denied` even as uid
0, and the filter outlives the sidecar because it is state of the namespace. A
slot whose filter cannot be installed is destroyed rather than served. This
needs `iptables` in the runtime image; `docker/Dockerfile.cli-runtime` installs
it, and a net-jailed backend refuses to start without it.

*Surviving a restart.* A filter is state of a network namespace, and Docker
destroys and recreates that namespace every time a container restarts — same
container id, same mounts, same filesystem, empty rules. A worker can cause the
restart: when a worker's command exits non-cleanly the executor runs `docker
restart` on its slot, because killing the local `docker exec` client does not
stop the process tree inside the container. Before this was closed, exiting
non-zero and then asking for one more turn pulled 339,598 bytes of github.com
out of a real pool slot through the Docker host. So the filter is treated as
belonging to a container START rather than to a container: a jailed slot carries
**no Docker restart policy** (a dead one is replaced, which reinstalls the
filter, instead of being revived in place), and every handout compares the
container's `StartedAt` against the start the filter was installed for and
reinstalls it before the slot can be used. The window in between contains
nothing but the idle `tail -f /dev/null` entrypoint, and the slot stays reserved
across it, so no request is ever dispatched into an unfiltered namespace. A
container whose filter cannot be reinstalled is replaced, not served.

There is deliberately no proxy environment variable. `HTTPS_PROXY` is a request
an agent can decline with `unset`; here the worker never learns a relay exists,
its clients dial what they believe is the origin, and clearing every variable in
its environment changes nothing about what it can reach.

**The model endpoint is derived, not typed.** The host and port come from the
configured base URL (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`,
`TANGLE_ROUTER_URL`, …), falling back to the CLI's own default endpoint when
none is set. A caller asking for a net-jail names no hosts and still gets a
working agent. Multi-provider CLIs (opencode, pi) have no single default; set a
base URL or name the endpoint in `BRIDGE_NET_JAIL_ALLOW`, and the bridge refuses
to start rather than hand back a jail that denies its own model.

**Docker only, and it says so.** A CLI spawned on the host shares this machine's
network namespace, and there is no unprivileged mechanism that gives it a
partial egress policy. So the bridge REFUSES to start when `WORKER_NET_JAIL` is
set alongside a host-executed backend, naming each backend and the
`<NAME>_EXECUTOR=docker` that fixes it. No weaker env-proxy fallback is offered:
a control that can be turned off by the thing it constrains is not isolation,
and shipping it under the same name is how the leak above survived.

Startup provisioning ends by PROVING the jail on a throwaway container drawn
from the same image, the same network AND the same filter a worker gets, with a
listening peer container beside it on the bridge:

| Proven at provisioning | Why it is checked |
| --- | --- |
| no default route | the network denies routing off the bridge |
| the Docker host's gateway is unreachable | an address that answers on the worker's own subnet is a next hop that never passes the relay |
| a peer container is unreachable while listening | the relay must be the only next hop, not merely the only *external* one |
| link-local is unreachable | cloud instance metadata, and the credentials it hands out, live at `169.254.169.254` |
| the worker cannot run `iptables` | a worker that can flush the rules is not confined by them |
| the relay IS reachable | the control: a container with a dead network stack denies everything and proves nothing |
| a non-allowlisted name does not resolve | DNS is scoped to the allowlist |
| an allowlisted name resolves and completes a real TLS handshake | the jail does not deny its own model |
| **every line above, again, after restarting the probe** | a restart empties the namespace, and a worker can cause one by exiting non-zero |

Failing any one of these is fatal. Reachability is judged by the ERROR, not by
whether something answered: `ECONNREFUSED` means a packet came back, which
proves the address is reachable and merely silent on that port, so it counts as
a leak.

The restart round is run with the same `docker restart --time 0` the executor
uses to kill a worker's process tree, and the filter is put back by the same
function the pool's slot provisioning calls — verifying through a second
implementation would prove a jail no worker runs in. Provisioning also fails if
the probe's start time does not move, because a restart that did not happen
makes the second round a re-run of the first.

Each of the two escapes found so far was found because the verifier checked
something adjacent to it. The first version checked only the route table, the
two DNS facts and the handshake, and passed the jail the host-gateway escape was
performed on. The second checked the filter's presence at one instant, and
passed a jail that a worker could empty by exiting non-zero. Each round's fix is
therefore added here as a direct probe of the escape itself.

Per request, `execution.netJail` mirrors `execution.jail`:

```jsonc
{
  "execution": {
    "kind": "host",
    "netJail": { "mode": "net-jail", "allow": ["router.tangle.tools:443"] }
  }
}
```

`mode` follows the same floor rule as the fs-jail: the env setting can be raised
by a request, never lowered. `allow` ASSERTS the enforced allowlist rather than
changing it — a pooled worker joined its network when the bridge started and
cannot be re-jailed per request, so a list that differs from what is in force
fails with 501 instead of silently widening. A net-jail requested of a backend
with none provisioned, or of `execution.kind=sandbox`, fails the same way and
names the mode. Nothing is ever accepted and then not applied.

### Topology guide

cli-bridge spawns pool containers by talking to the **host docker
daemon** — pool slots are siblings of cli-bridge, not nested. Two
shapes work:

- **cli-bridge on host** (recommended for autoresearch / dev). The
  bridge runs as `pnpm start`; pool containers spawn directly via the
  host docker daemon. Callers (orchestrators, evals) hit
  `127.0.0.1:3344`.

- **cli-bridge in a container** (deployment). The compose stack
  bind-mounts `/var/run/docker.sock` so the bridge can drive the host
  daemon to spawn pool slots as siblings on the host. Set
  `<NAME>_DOCKER_HOST_CONFIG_DIR` to a HOST path (not a path inside the
  bridge container) — the daemon resolves binds against the host fs.

Either way, an orchestrator running in its own container hits the bridge
at `host.docker.internal:3344` (Docker Desktop) or the bridge gateway
IP (Linux). No DinD anywhere.

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
  │                       gen_ai.usage.input_tokens / output_tokens / cost_usd
  └─ <tool name> (TOOL)   gen_ai.tool.name, gen_ai.tool.call.id
```

Spans land as JSON lines in `<BRIDGE_DATA_DIR>/traces/spans.jsonl`.
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

### Bridge-specific attributes

Everything a semantic convention already names uses the standard key. These are
the bridge's own execution context:

| Attribute | Meaning |
|---|---|
| `cli_bridge.run.id` | Durable run id — joins to `GET /v1/runs/:id` |
| `cli_bridge.session.id` | Caller-owned session id, when resuming |
| `cli_bridge.backend.session_id` | The harness's own session id — joins to that CLI's transcript |
| `cli_bridge.mode` / `cli_bridge.execution` | `byob`/`hosted-safe` and `host`/`sandbox` |
| `cli_bridge.trace.correlation` | `traceparent` / `headers` / `none` / `invalid` |
| `cli_bridge.finish_reason` | Terminal reason — separates `length` from `stop` |
| `cli_bridge.usage.estimated` | Present and `true` when tokens were derived from text, not measured |
| `cli_bridge.tool_calls.observed` / `.dropped` | Tool calls seen, and any beyond the per-request span cap |

Tool ARGUMENTS are never written: they carry prompts, paths and file contents, and
a trace file must not become a second copy of everything the agent read. Cost is
written only when every usage record reported one, so a floor is never read as a
total.

## Deploy

See `deploy/README.md` for Hetzner box (Docker or systemd). Remote deploy requires `BRIDGE_BEARER` — cli-bridge refuses to bind non-loopback without one.

## Design notes

- **Explicit in the model id, not the env.** The `<harness>/<model>` scheme means "what you type is what runs." No mode toggles that change behavior under the same id.
- **Harnesses are independent.** Each is a class implementing `Backend`; add a new one in `src/backends/*.ts`, register it in `src/server.ts`.
- **Single-user assumption is deliberate.** No per-call user auth beyond the optional bearer.

## License

MIT
