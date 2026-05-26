# cli-bridge resilience plan

Status: investigation complete, no code yet. Owner: Drew + Claude.
Cross-repo: failures observed from VerticalBench (`~/code/blueprint-agent/scripts/experiments`); fixes land here in `~/code/cli-bridge`.

Discipline gate (non-negotiable): **no code merges unless a chaos/stress test fails on today's bridge and passes after the change.** No "should be more resilient" — measured. Attribute before fixing.

## Evidence (from a real VB Fhenix pilot, 2026-05-26)

Failure distribution over 4 cells (2 profiles × 2 leaves, cli-bridge, 30-min backstop):
- 16× `cli-bridge finished with error`  (DOMINANT, and currently a **black box** — cause not attributable from the client side)
- 4× `sse: terminated`
- 3× `claude exited 143` — SIGTERM, with **empty claude stderr** → claude was **externally killed by the bridge's `killTree`**, not crashing. One fired immediately after the client's wall-cap abort.
- 0× `acquire timeout` — concurrency 3 > host max 2 is a real misconfig but was NOT the dominant failure. Do not claim it as the root cause.

Active executor: plain `host` (`scoped-host` falls back to `hostSpawner` when systemd-run is absent), so the 2 GB scope cap is NOT OOM-killing. Ruled out.

## Root-cause hypothesis (evidence-grounded)

**Core flaw: job liveness is coupled to the HTTP/SSE connection.** `chat-completions.ts:238` aborts on client disconnect → `claude.ts:235-236` `killTree`s the running claude → 30 min of work destroyed. Any client-side event — wall-cap, transport-idle, *or our own retry* — triggers this, and the client then cold-restarts. A recoverable blip becomes kill→restart→often-fail-again. The client retry logic is fighting the bridge's kill-on-disconnect.

**Gating problem: observability.** The dominant `finished with error` is unattributable from the client; the bridge logs only to pipes (no capturable file). We cannot honestly fix what we cannot attribute.

## Plan — layered, each pillar provable

### Pillar 0 — Observability first (blocks all others)
Capture the bridge's per-task ground truth — exit code + signal, full claude stderr, *why* killTree fired (timeout vs client-abort vs shutdown), wall/idle timing, resource snapshot — correlated to the VB cell id, to a durable file (not a pipe). Turn every `finished with error` into a named cause.
Proof: re-run the pilot → an attributed failure-cause histogram instead of one black-box bucket.

### Pillar 1 — Decouple job from connection (highest leverage)
The bridge must run the CLI **to completion independent of the client connection**, persist/buffer the stream, and let the client **re-attach** to an in-flight or finished task. Client disconnect/retry then costs nothing — no kill, no lost work. (`sessions.sqlite` already persists sessions; the gap is the task/stream lifecycle being bound to the HTTP request.)

**Leading implementation candidate — tmux/PTY-backed durable sessions (Drew's idea):**
- A tmux (or node-pty) session is a battle-tested *reattachable terminal that survives client disconnects by design* — it IS Pillar 1 with a proven primitive. Detach/attach is free; a dropped client never kills the job.
- It also runs the CLIs in their **native interactive mode** (the bridge currently uses headless `claude -p`); the headless path may itself be a source of `finished with error` / `produced no stream output`. Interactive mode is the mode these TUIs are built and tested for.
- **Liveness via `tmux capture-pane` text diffing**: poll the pane, diff content; changing = progressing, static for N s = stalled. Robust, cheap, transport-independent — strictly better than parsing heartbeats out of a fragile stream. (Pixel/vision reading of the rendered pane is OVERKILL for text CLIs — `capture-pane -p` returns the text deterministically; reserve vision only for genuinely graphical TUIs.)
- **Caveat — do NOT extract structured results by scraping the TUI or sending keystrokes.** That trades transport-fragility for parsing-fragility and timing races (permission prompts, redraws, spinners). Split responsibilities: tmux/PTY for **session durability + liveness**; the CLI's structured log file + the **workspace filesystem** for the **result** (VB already scores from the workspace, not the terminal). Keystroke-driving is a last resort, not the data path.
Proof (chaos test): drop the client mid-stream → assert (a) claude keeps running, (b) reconnect returns the full result, (c) no orphaned process.

### Pillar 2 — Retry = resume, never cold-restart
On a transient blip, re-attach to the *same* session (driver already passes `resume=task-…`) instead of abort→kill→restart-from-shot-1.
Proof: inject a transport blip → job continues from where it was.

### Pillar 3 — Capacity correctness + backpressure
Match client concurrency to advertised host capacity (or raise `BRIDGE_HOST_MAX_CONCURRENCY` deliberately); make the acquire deadline proportional to job length (60 s is absurd for 30-min jobs); client reads capacity and does not oversubscribe.
Proof: run concurrency > capacity → graceful queueing, not failures.

### Pillar 4 — Kill discipline
Distinguish "client went away but wants the result" (don't kill) from "client cancelled" (kill). Today conflated. Covered by the Pillar-1 chaos test.

## Proof methodology — local-first, deterministic, regression-gated
A cli-bridge chaos/stress harness reproducing each failure: (1) concurrency > slots, (2) mid-stream client drop, (3) long silent run, (4) injected SSE termination, (5) kill-and-reconnect. Every fix lands only with a chaos test that fails-before / passes-after, validated locally against the real Fhenix workload before any staging spend.

## Production / staging parity
The durability + reconnect + kill-discipline are transport-agnostic and carry to the staging sandbox orchestration. Cost note: staging loses the local subscription advantage — feasibility spike (separate, after local proof): provision the harness subscriptions *inside* the staging environments so the CLIs authenticate with their own OAuth/subscription in-env, enabling subscription-rate runs there too.

## Sequencing
0. Pillar 0 (observability) → attributed failure histogram. ← immediate next step.
1. Spike: tmux/PTY durable-session prototype vs server-side SSE buffering — pick Pillar 1 implementation on evidence.
2. Pillars 1-4 with chaos tests.
3. Staging parity + subscription-in-env spike.
