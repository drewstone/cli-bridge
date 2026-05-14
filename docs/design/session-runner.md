# SessionRunner — unified live-CLI session substrate across backends

Status: proposed
Owner: drewstone
Last updated: 2026-05-14

## Problem

`cli-bridge` today spawns a fresh subprocess per request — `claude -p`, `kimi --print`, `opencode run --print`, `pi --print --mode json`, `codex …`. Each request parses one CLI's NDJSON/JSONL stdout and emits OpenAI chat-completions SSE. This works well for stateless calls but bites in three places:

1. **Mosaic session-resume semantics.** Every backend implements continuity differently — `--resume <id>` on claude/kimi, on-disk projects path for pi, an in-process server for opencode, a separate format for codex. Multi-shot evals (VerticalBench shoots 4 follow-ups per leaf) depend on this and the failure modes are per-backend. A regression in one backend's resume path silently degrades the leaderboard.
2. **No mid-turn injection.** A request is fire-and-forget. There is no way to interrupt, redirect, or clarify mid-tool-call. The agent UI and adversarial-eval surfaces both want this.
3. **Backend-skewed trace richness.** Pi's NDJSON carries `text_delta`, `thinking_delta`, `tool_call_request`, `tool_call_response`. Claude `-p` stream-json carries similar but differently shaped events. Opencode `run --print` emits a smaller event set. Codex emits another. Downstream trace consumers see whatever the backend chose to surface — not a uniform shape.

Spawn overhead is a fourth, smaller concern: 1-3 s per spawn × 4 shots × 14 variants × 29 leaves on the Fhenix matrix stacks into ~30-90 min of wall just for cold starts.

## Non-goals

- **Not** a port of `dexhorthy/shannon`. Shannon's screen-scrape-tmux substrate is too brittle for cli-bridge (paste-bracketing, ANSI parsing, reproducibility loss, breaks docker pool mode). The *interface* shannon implies is the right shape; the substrate is wrong for us.
- **Not** a UI/visual session display. tmux-as-render-surface is out of scope.
- **Not** a replacement for one-shot mode. The existing one-shot path stays the default; session mode is opt-in.

## Approach: native bidi channels behind one interface

Every CLI in active rotation already exposes a native bidirectional channel that does **not** require a TTY in the loop:

| Backend     | Native bidi channel                                                              |
| ----------- | -------------------------------------------------------------------------------- |
| claude-code | `--input-format=stream-json --output-format=stream-json` (the Agent SDK channel) |
| kimi-code   | Same protocol as claude-code (fork)                                              |
| opencode    | `opencode serve` — HTTP daemon, persistent session                               |
| pi          | NDJSON over stdin streaming (`--mode json` with `--watch`/stdin input)           |
| codex       | stream-json mode                                                                 |
| factory/amp/forge | Stubbed today; lower priority                                              |

A tmux-scrape fallback exists as a documented escape hatch for any future CLI that ships without a JSON stream mode. We do not plan to use it for any backend currently in rotation.

### Interface

```ts
interface SessionRunner {
  start(opts: StartOpts): Promise<Session>
}

interface StartOpts {
  profile: string                  // backend-defined: model id, provider, …
  auth: BackendAuth                // per-backend credential resolution
  mcp?: McpConfig                  // MCP server entries to inject
  hooks?: HookConfig               // hook entries to inject (where supported)
  cwd?: string                     // working directory inside the runner
  resumeFrom?: string              // session id of a prior session to resume
}

interface Session {
  id: string
  send(message: UserMessage): void
  events: AsyncIterable<BridgeEvent>
  cancel(): Promise<void>
  close(): Promise<void>
  resume(sessionId: string): Promise<void>
}

type BridgeEvent =
  | { type: 'session.created'; sessionId: string }
  | { type: 'text.delta'; text: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'tool_call.start'; toolCallId: string; name: string; args?: unknown }
  | { type: 'tool_call.args.delta'; toolCallId: string; argsDelta: string }
  | { type: 'tool_call.result'; toolCallId: string; result: unknown; isError?: boolean }
  | { type: 'turn.end'; usage?: Usage }
  | { type: 'session.idle' }
  | { type: 'error'; reason: 'not_configured' | 'upstream' | 'timeout' | 'cancelled'; detail?: string }
  | { type: 'done' }
```

Each backend's runner owns translation between its native event format and `BridgeEvent`. The rest of the bridge — session store, transcript writer, route handlers, trace publisher — operates on `BridgeEvent` only.

### Modular shape

```
packages/cli-bridge/src/
  runners/
    base.ts            # SessionRunner interface + BridgeEvent schema
    claude-stream.ts   # ~200 LOC
    kimi-stream.ts     # ~30 LOC (extends claude-stream)
    opencode-serve.ts  # ~250 LOC
    pi-stream.ts       # ~200 LOC (reuses today's NDJSON parser from backends/pi.ts)
    codex-stream.ts    # ~200 LOC
    tmux-fallback.ts   # ~400 LOC (documented fallback, not used by current backends)
  sessions/
    store.ts           # registry, TTL/idle reaper, capacity caps
    transcript.ts      # JSONL writer + replay (one schema, all backends)
    runtime.ts         # ties runner + store + transcript together
  routes/
    sessions.ts        # POST /v1/sessions, DELETE, /inject, /events
    chat.ts            # existing route gains optional `bridge.session_id` binding
```

What is shared across all backends — *written once*:

- **Event normalizer plumbing** (per-runner: a small `nativeEvent → BridgeEvent` mapper; everything downstream is uniform)
- **Session store** (lifecycle, idle reaper, capacity caps — backend-agnostic)
- **Transcript writer** (one JSONL schema → replayable to reconstruct a crashed session, also feeds the trace pipeline)
- **Auth / settings injection** (one config schema; each runner translates to native flags)
- **Trace publisher** (`BridgeEvent` → `agent_submission_trace` / `agent-eval RunRecord` — free unified traces across all backends)
- **Docker-executor wrapper** (existing pool code wraps a runner instead of spawning per-request; one container hosts one runner for its lifetime)

What is per-backend — *written N times but small*:

- Spawn/connect to the native bidi channel
- Map native events → `BridgeEvent`
- Map `UserMessage` → native input format
- Translate auth/MCP/hooks config → native flags

### Public surface — backwards compatible

- `POST /v1/chat/completions` (existing) — stays one-shot, default behavior unchanged.
- Same endpoint gains an optional `bridge.session_id` request field (or `X-Bridge-Session-Id` header). If present, routes to an existing session instead of spawning fresh. If absent, today's behavior.
- `POST /v1/sessions` — explicit warm-session creation. Body matches `StartOpts`. Returns `{ id }`.
- `POST /v1/sessions/:id/inject` — mid-turn user message. Body is a `UserMessage`.
- `DELETE /v1/sessions/:id` — cancel + reap.
- `GET /v1/sessions/:id/events` — SSE re-subscribe (live + replay-from-last-event-id for crash recovery and external observers).
- `GET /v1/sessions/:id/transcript` — full JSONL transcript download.

### Docker executor

The existing per-backend Docker pool already pre-warms one container per slot. Under SessionRunner, each pool slot holds one persistent runner inside one container for the lifetime of one session. When the session closes, the container is recycled (state cleared, runner re-initialized). This matches existing pool semantics — no new infrastructure.

## Cost

- ~2-3k LOC for the abstraction + five runners + routes + tests.
- 1-2 weeks of focused work to land cleanly with tests.
- Each runner is small and lands incrementally — claude-stream first (it has the cleanest reference protocol), then opencode-serve, then pi-stream (reuses today's parser), then kimi-stream (cheap), then codex-stream.

## Risks

- **Native stream-json schemas drift.** Claude has rev'd `--output-format=stream-json` event types twice in the last year. Per-runner adapters absorb the drift; the shared `BridgeEvent` schema does not. Pin minimum CLI versions and run a per-backend conformance test on each release.
- **Opencode `serve` lifecycle.** The daemon mode has had its own bugs (port collisions, stale sockets). Treat the `OpencodeServeRunner` as a longer-lived process with its own health check and supervised restart.
- **Pi stdin streaming.** Pi's stdin streaming path is less battle-tested than its one-shot `--print` mode. We may need to upstream a fix or carry a small patch in our spawn wrapper.
- **Resume semantics.** Each backend's `resume` is best-effort. The SessionRunner contract is "if the runner cannot resume, it returns a fresh session and surfaces a `BridgeEvent.error{reason:'not_configured', detail:'resume unsupported'}` immediately." Callers that require strict resume must check.

## Migration plan

1. Land `runners/base.ts` + tests (interface, BridgeEvent schema, in-memory mock runner).
2. Land `sessions/store.ts` + `sessions/transcript.ts` + tests.
3. Land `routes/sessions.ts` with the in-memory mock runner — full end-to-end test of the public surface.
4. Add `ClaudeStreamRunner` — first real backend.
5. Wire `chat.ts` to accept `bridge.session_id` and route through the runtime when present. One-shot path untouched.
6. Add `KimiStreamRunner` (small).
7. Add `OpencodeServeRunner`.
8. Add `PiStreamRunner`.
9. Add `CodexStreamRunner`.
10. Update `BACKENDS.md` / README to document the dual surface.

Each step is independently mergeable. After step 5, sessions work for claude; everything else extends without regressing one-shot mode.

## Whether to do it

Build this *after* the Fhenix matrix report ships. The matrix currently runs fine in one-shot mode; SessionRunner is a strict superset that solves real pain (resume mosaic, missing mid-turn injection, skewed trace richness, spawn overhead) but adds no capability the matrix needs in the next two weeks.

After Fhenix lands, the next obvious consumer is the agent UI in blueprint-agent and the multi-turn eval suite — both of which want exactly this.
