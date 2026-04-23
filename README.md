# cli-bridge

**Use your local coding-CLI subscriptions as one OpenAI-compatible HTTP API — with persistent session resume.**

Model ids are `<harness>/<model>`. The harness is the agent runtime (Claude Code, Codex, opencode, claudish, …); the model is whatever that runtime can address. One string, both choices explicit.

Backends this is built for (✓ implemented, ◦ stubbed):

| Harness | Status | What it is |
|---|---|---|
| `claude/` | ✓ | [Claude Code](https://github.com/anthropics/claude-code) CLI — your Claude Max / Pro subscription |
| `claudish/` | ✓ | Claude Code + [claudish](https://github.com/MadAppGang/claudish) — Claude's workflow, a different brain |
| `codex/` | ◦ | [OpenAI Codex CLI](https://github.com/openai/codex) — your ChatGPT Plus/Pro subscription |
| `opencode/` | ◦ | [opencode](https://github.com/sst/opencode) — multi-provider; the vehicle for Kimi Code via the `opencode-kimi-full` plugin |
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

**Prereqs:** Node 22+. For each backend you want enabled, install + log in on the host:

| Backend | Install | Auth |
|---|---|---|
| `claude` | `npm i -g @anthropic-ai/claude-code` | `claude /login` (OAuth, opens browser) |
| `claudish` | claude above + run `claudish` locally, point `CLAUDISH_URL` at it | claudish's own provider config |
| `codex` | `brew install openai/homebrew-tap/codex` | `codex login` |
| `opencode` | `brew install sst/tap/opencode` (+ [`opencode-kimi-full`](https://github.com/lemon07r/opencode-kimi-full) plugin for Kimi Code) | `opencode login` |
| `passthrough` | (none) | provider API keys in `.env` |

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

OpenAI Chat Completions. Model id routes via harness prefix. Supports streaming (default) or `stream: false`. Session resume via `session_id` body field or `X-Session-Id` header.

Extra fields this bridge accepts beyond vanilla OpenAI:

- `cwd`: persist a working directory for the session and run future resumed turns there
- `agent_profile`: full `AgentProfile` object

Behavior:

- `sandbox` backends honor the full `agent_profile` natively
- local harness backends (`claude-code`, `codex`, `kimi-code`) persist the full profile, honor the executable subset directly where possible, and compile the remaining context into a deterministic system-prompt preamble

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

### `GET /v1/models`

Lists model ids each ready backend claims, with which harness serves them.

### `GET /health`

JSON report per backend — ready / unavailable / error with detail.

### `GET /v1/sessions` · `DELETE /v1/sessions/:id`

Inspect / clear external-to-internal session mappings.

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

## Deploy

See `deploy/README.md` for Hetzner box (Docker or systemd). Remote deploy requires `BRIDGE_BEARER` — cli-bridge refuses to bind non-loopback without one.

## Design notes

- **Explicit in the model id, not the env.** The `<harness>/<model>` scheme means "what you type is what runs." No mode toggles that change behavior under the same id.
- **Harnesses are independent.** Each is a class implementing `Backend`; add a new one in `src/backends/*.ts`, register it in `src/server.ts`.
- **Single-user assumption is deliberate.** No per-call user auth beyond the optional bearer.

## License

MIT
