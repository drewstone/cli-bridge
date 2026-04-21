# cli-bridge

**Use your local coding-CLI subscriptions as one OpenAI-compatible HTTP API — with persistent session resume.**

Backends this is built for (implemented or planned):

- [Claude Code](https://github.com/anthropics/claude-code) — ✓ implemented
- [OpenAI Codex CLI](https://github.com/openai/codex) — stubbed
- [opencode](https://github.com/sst/opencode) — stubbed
- [Kimi Code](https://platform.moonshot.ai/) (Kimi For Coding) — stubbed (via `opencode-kimi-full` plugin)
- [Factory Droid](https://docs.factory.ai/) — planned
- [Amp](https://ampcode.com/) — planned
- [Forge Code](https://github.com/antinomyhq/forge) — planned

Plus a thin passthrough backend for vendor HTTP APIs (OpenAI, Anthropic, Moonshot, Z.AI) when you want to mix metered traffic alongside subscription-backed traffic on the same endpoint.

Personal productivity tool. Single-user by default. Loopback-only by default. No ambition to be a shared proxy.

---

## The idea

Every AI lab now ships a CLI: `claude` (Claude Code), `codex`, `opencode`, `kimi-cli`. Each comes with better session economics than their metered API — Claude Code's context compression, opencode's workspace model, Codex's session cache — because you're paying a flat subscription, not per token.

`cli-bridge` exposes those CLIs as one OpenAI-compatible endpoint (`POST /v1/chat/completions`). Point any OpenAI client — cursor, aider, a bash script, Tangle's internal dev tools — at `http://127.0.0.1:8787` and it drives the CLI of your choice under the hood. Session resume is tracked in a local SQLite so `X-Session-Id: foo` across calls resumes the same Claude Code conversation.

## Why this exists, plainly

- **Your own productivity**, anywhere. Submit a task to your dev box from your phone, resume it from your laptop, pipe it into verticalbench, use it for PR reviews. Your subscription, your compute, stays yours.
- **Stable external session ids**. CLIs rotate internal ids, cli-bridge keeps a mapping so your caller doesn't have to.
- **One API surface**. Your clients speak OpenAI; under the hood you pick `claude` or `codex` or whatever by model prefix.

## Why NOT to use this

- You want to share one subscription across your team / customers / marketplace. **Don't.** Most vendor terms scope these to one seat. Moonshot's Kimi For Coding rejects non-coding-agent callers at the backend by policy, not by bug — build a real pay-per-token API integration instead.
- You want a full-featured router with cost tracking / fallback chains / budgets. Use LiteLLM, OpenRouter, or similar. `cli-bridge` is deliberately small.

---

## Install

```bash
git clone https://github.com/drewstone/cli-bridge.git
cd cli-bridge
pnpm install
cp .env.example .env
# edit .env to taste
pnpm verify   # probes each configured backend, reports ready/unavailable
pnpm start
# → http://127.0.0.1:8787
```

**Prereqs:** Node 22+. For each backend you want enabled, install + log in on the host:

| Backend | Install | Auth |
|---|---|---|
| Claude Code | `npm i -g @anthropic-ai/claude-code` | `claude /login` (OAuth, opens browser) |
| Codex CLI | `brew install openai/homebrew-tap/codex` | `codex login` |
| opencode | `brew install sst/tap/opencode` | `opencode login` |
| Kimi Code | `brew install sst/tap/opencode` + [`opencode-kimi-full`](https://github.com/lemon07r/opencode-kimi-full) plugin | OAuth device flow via plugin (Kimi For Coding subscription) |
| Factory / Amp / Forge | tbd — see backend stubs | tbd |
| Passthrough | (none) | provider API keys in `.env` |

## Quick test

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-Session-Id: my-first-session' \
  -d '{
    "model": "claude-sonnet",
    "messages": [{"role": "user", "content": "say hi in 3 words"}],
    "stream": true
  }'
```

Subsequent calls with the same `X-Session-Id` resume the conversation — Claude Code sees the prior context, doesn't re-charge you for replaying it (one of the real wins vs. metered APIs).

## API

### `POST /v1/chat/completions`

OpenAI Chat Completions, streaming by default. Supports:
- `model` — picks backend by prefix (`claude*` → Claude Code, `gpt*`/`o1*` → OpenAI passthrough, `kimi*` → Moonshot passthrough, `glm*` → Z.AI passthrough)
- `messages` — standard chat array
- `stream` — default true; `false` returns a single JSON response
- `session_id` (body) or `X-Session-Id` (header) — stable id you control

### `GET /v1/models`

Lists model ids each backend claims.

### `GET /health`

JSON report of each backend's probe state — useful as liveness + "which CLIs are ready on this host?"

### `GET /v1/sessions` · `DELETE /v1/sessions/:id`

Inspect / clear session mappings. Useful when a CLI rewrites its session format and old internal ids no longer resolve.

## Claude Code with a different brain

Claude Code is the best agent workflow shell. If you want that workflow but with a Z.AI / OpenRouter / Gemini model driving the responses, chain it with [`claudish`](https://github.com/MadAppGang/claudish) — a local Anthropic-format proxy that translates to other providers.

Run claudish on a port, then point cli-bridge's Claude subprocess at it:

```bash
# .env
CLAUDE_ANTHROPIC_BASE_URL=http://127.0.0.1:3456  # claudish instance
```

cli-bridge's Claude backend will spawn `claude` with `ANTHROPIC_BASE_URL=…` and the agent talks to your preferred backend model.

## Use with Tangle products

**VerticalBench** — replace `claude -p` subprocess calls in `blueprint-agent/scripts/experiments/lib/meta-reviewer.ts` with an HTTP call to cli-bridge, using a stable `session_id` per leaf. The driver agent's enrichment loop now has durable session state across runs.

**Agent Builder (Forge, dev mode)** — set `BYOK_CLI_ENDPOINT=http://host.docker.internal:8787` in agent-builder's dev `.dev.vars`. Forge talks to your subscribed Claude Code locally instead of charging against platform credits during development. (Never ship this to production — the router is the right path for paying customer traffic.)

**PR reviews & automations** — any bash cron / GitHub Action / Coolify job can hit `POST /v1/chat/completions` against the remote cli-bridge and drive your subscription. Pair with `X-Session-Id: pr-review-#{pr_id}` so follow-up comments land on the same Claude Code context.

## Deploy

See `deploy/README.md` for the Hetzner box setup (Docker or systemd). Remote deploy requires `BRIDGE_BEARER` — cli-bridge refuses to bind non-loopback without one.

## Design notes

- **Backends are independent.** Each is a class implementing `Backend`. Add a new one in `src/backends/*.ts`, register it in `src/server.ts`. See `codex.ts` / `opencode.ts` for stubs.
- **SSE framing is standard.** OpenAI's `chat.completion.chunk` shape. Tested against cursor, aider, Tangle's router — no client-side adapters needed.
- **Single-user assumption is deliberate.** No per-call user auth beyond the optional bearer. Not a multi-tenant server.

## License

MIT
