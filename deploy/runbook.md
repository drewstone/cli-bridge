# Operator Runbook — cli-bridge + tangle-router

Everything deployed at `router.tangle.tools`. The bridge short-circuits
on model prefix `bridge/<harness>/<model>` and forwards to cli-bridge
at `http://cli-bridge:3344` on the internal docker network.

## Current state (last verified 2026-04-22)

| Backend | Health | Real response | Your next step |
|---|---|---|---|
| `claude` | ready | ✓ `"Hi there, friend!"` | nothing — already logged in |
| `claudish` | ready | ⚠ 524 (Cloudflare timeout on first hit) | retry — probably cold-start |
| `codex` | ready | `finish_reason: error` | `codex login` inside the container |
| `opencode` | ready | `finish_reason: error` | `opencode auth login …` inside the container |
| `passthrough` | ready | on-demand | set provider API keys in `/srv/router/.env` |

## One-time auth inside the container

Each CLI OAuths from the box with `device flow` (prints a URL + code,
you open on laptop, paste back). Auth lands in a host-mounted volume
so it survives container recreates.

```bash
ssh root@178.104.236.58

# Claude Code — already done
docker exec -it tangle-cli-bridge claude /login

# Codex (ChatGPT Plus / Pro subscription)
docker exec -it tangle-cli-bridge codex login

# opencode (has its own auth manager; pick a provider)
docker exec -it tangle-cli-bridge opencode auth login
# pick anthropic / openai / kimi / etc. For Kimi Code specifically:
docker exec -it tangle-cli-bridge opencode auth login kimi
```

For opencode + Kimi Code specifically, you'll also need the
`opencode-kimi-full` plugin installed inside the container. That's a
separate step — `docker exec -it tangle-cli-bridge opencode plugin add
…` or copy the plugin files into `/root/.config/opencode/plugins/`.
Not wired automatically because the install path is nontrivial.

## Using it

From anywhere with a valid `sk-tan-*`:

```bash
curl -N https://router.tangle.tools/api/chat \
  -H 'Authorization: Bearer sk-tan-YOUR_KEY' \
  -H 'X-Bridge-Unlock: <token from devops/secrets/tangle-router.env>' \
  -H 'X-Resume: my-conversation-id' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "bridge/claude/sonnet",
    "messages": [{"role":"user","content":"write a haiku about sqlite"}],
    "stream": true
  }'
```

Model ids you can use:

| Model id | What it drives |
|---|---|
| `bridge/claude` / `bridge/claude/sonnet` | Claude Code + Anthropic Sonnet |
| `bridge/claude/opus` | Claude Code + Anthropic Opus |
| `bridge/claude/haiku` | Claude Code + Anthropic Haiku |
| `bridge/claude/claude-sonnet-4-5-20250929` | specific Anthropic version id |
| `bridge/claudish/gemini-2.0-flash` | Claude Code workflow, Gemini brain |
| `bridge/claudish/<whatever>` | whatever BIG_MODEL / SMALL_MODEL are set to in env |
| `bridge/codex` / `bridge/codex/gpt-5-codex` | Codex CLI, Codex subscription |
| `bridge/opencode/kimi-for-coding` | opencode + kimi plugin → Kimi Code sub |
| `bridge/opencode/anthropic/claude-sonnet-4-5` | opencode against Anthropic |
| `bridge/openai/gpt-4o` | direct OpenAI API, metered |
| `bridge/zai/glm-4.6` | direct Z.AI API, metered |

Session id aliases — all of these resume the same conversation:

- `X-Session-Id: <id>` (canonical)
- `X-Resume: <id>` (alias)
- `X-Conversation-Id: <id>` (alias)
- body field `session_id` or `resume_id`

## Gate values (keep handy)

- `X-Bridge-Unlock`: decrypt `CLI_BRIDGE_UNLOCK_TOKEN` from
  `devops/secrets/tangle-router.env`
- `CLI_BRIDGE_ALLOWED_USER_IDS`: empty — fill with your platform userId
  for a second gate factor

## Tuning claudish

`claudish` uses `claude-code-proxy` under the hood, configured via:

```
CLAUDE_PROXY_PROVIDER=google          # or openai, openrouter
CLAUDE_PROXY_BIG_MODEL=gemini-2.0-flash
CLAUDE_PROXY_SMALL_MODEL=gemini-2.0-flash-lite
GEMINI_API_KEY=...
OPENROUTER_API_KEY=...                 # if provider=openrouter
```

Want Z.AI? Set `CLAUDE_PROXY_PROVIDER=openrouter`, then pick a Z.AI
model id through OpenRouter (claude-code-proxy uses LiteLLM's routing).

After changing any of those, redeploy:

```bash
cd /srv/router && docker compose up -d claude-code-proxy cli-bridge
```

## Diagnostics

```bash
# Probe cli-bridge health from the router network
ssh root@178.104.236.58 \
  'docker exec tangle-backend node -e "fetch(\"http://cli-bridge:3344/health\").then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))"'

# Watch a specific backend's logs
ssh root@178.104.236.58 'docker logs -f tangle-cli-bridge'
ssh root@178.104.236.58 'docker logs -f tangle-claude-code-proxy'
ssh root@178.104.236.58 'docker logs -f tangle-backend'

# End-to-end probe through Cloudflare → caddy → backend → cli-bridge → claude
UNLOCK=$(dotenvx run -f ~/company/devops/secrets/tangle-router.env -- bash -c 'echo $CLI_BRIDGE_UNLOCK_TOKEN')
curl -sS https://router.tangle.tools/api/chat \
  -H 'Content-Type: application/json' \
  -H "X-Bridge-Unlock: $UNLOCK" \
  -d '{"model":"bridge/claude/sonnet","messages":[{"role":"user","content":"ping"}],"stream":false}'
```

## If it breaks

- **502 bridge_unreachable** — `docker ps | grep cli-bridge`; recreate
  with `docker compose up -d cli-bridge`.
- **401 bridge_not_permitted** — header mismatch; decrypt
  `CLI_BRIDGE_UNLOCK_TOKEN` fresh and try again.
- **Claude returns "Not logged in"** — re-run `claude /login` inside
  the container. OAuth tokens rotate; the file lives in
  `/srv/cli-bridge/claude-home/` on the host.
- **524 Cloudflare timeout on claudish** — cold-start or upstream slow.
  Retry; if it persists, check `docker logs tangle-claude-code-proxy`
  for upstream errors (Gemini API 5xx, key invalid, etc.).
- **Lockfile stale on claude-code-proxy image rebuild** — host
  `/srv/claude-code-proxy` has the patched Dockerfile
  (`FROM python:3.12-slim`, no `--locked`). If you repull from origin,
  reapply those edits.
