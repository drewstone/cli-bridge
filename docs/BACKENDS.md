# Backend capability evidence

This matrix records what the bridge can prove today.

The bridge advertises retained interaction capability only after the installed runner protocol passes the native subprocess test.

An unlisted capability is unavailable, not an implied best effort.

| Runner | Pinned evidence version | One-shot chat | Retained native session | Interactions | Native continuation | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Pi | 0.83.0 | Yes | Yes | Permission select only, with exact marker proof | Unavailable: boundary check only; no atomic/idempotent admission | `src/backends/pi.ts`, `tests/pi-native.test.ts`, gated real test |
| ACP agents | No retained minimum | Yes | No | False in one-shot; permission fails closed unless an explicit named policy receipt is present | Not advertised | `src/backends/acp.ts`, `tests/acp.test.ts` |
| OpenCode | No retained minimum | Yes | No | False in one-shot; default permission posture is deny | Not advertised | `src/backends/opencode.ts`, `src/backends/profile-support.ts` |
| Claude Code | No retained minimum | Yes | No | False in one-shot | Not advertised | Existing print-mode adapter |
| Codex | No retained minimum | Yes | No | False in one-shot | Not advertised | Existing one-shot adapter |
| Kimi Code | No retained minimum | Yes | No | False in one-shot | Not advertised | Existing one-shot adapter |
| Gemini, NanoClaw, Factory, Amp, Forge, passthrough, Sandbox | No retained minimum | Yes where configured | No | False in one-shot | Not advertised | Existing backend adapters |

## Pi native contract

The bridge starts Pi with `--mode rpc` and communicates with one JSON object per LF-terminated stdin/stdout line.

The first turn uses `prompt`.

Later turns use the same child and Pi session state rather than resending the transcript.

Active steering uses `steer` when the run is still active.

Explicit cancellation uses `abort`.

The bridge obtains the provider session identifier from Pi's `session` event and obtains a safety-check revision from `get_state`.

The public native-continuation capability is intentionally absent: Pi cannot atomically compare the expected boundary, admit the digest-bound turn, and replay a prior operation id.

The retained HTTP surface still uses the same child for later turns, but its pre-turn boundary check must not be confused with that unavailable public operation.

Pi's `agent_end` is retained as a provider observation because it can be followed by retry or compaction.

The retained turn reaches terminal state at Pi's `agent_settled` event.

Pi extension dialogs arrive as `extension_ui_request` and only an injected permission `select` carrying the bridge marker is answerable.

The bridge maps only those instrumented dialogs to the public `InteractionRequest` and accepts only a matching public `InteractionResponseCommand`.

The injected extension derives a unique token from a per-child nonce and permission sequence, sanitizes the public tool title, appends the token to the Pi title, and emits `cli-bridge.permission-applied.v1:<token>:<selected-value>` after `await ctx.ui.select` returns.

The bridge waits for that exact marker after writing the matching `extension_ui_response`, so arbitrary later Pi traffic cannot acknowledge the response.

Uninstrumented Pi dialogs are warnings rather than answerable public interactions.

The profile path uses the existing exact Pi materializer and stores its `cli-bridge.profile-materialization.v1` receipt on the retained session.

Filesystem confinement mounts an existing Pi AgentDir read-only and independently redirects `PI_CODING_AGENT_SESSION_DIR` into writable jail-owned state.

The state redirect remains active when the configured AgentDir is missing, and macOS CI executes the custom-extension and state-write path through `sandbox-exec`.

Pi's advertised `profile.mcp` capability is dynamic: it is `true` only when the installed `pi-mcp-adapter` is detected, and MCP session creation is rejected otherwise.

Pi 0.83.0 is the pinned minimum for the current advertisement because that is the installed binary whose RPC protocol and subscription path were inspected.

Do not lower this version or advertise another Pi release without rerunning the conformance flow.

Capability discovery and retained-session creation share the same cancellable, time-limited backend probe as `/health` and refuse a native backend whose health state is not `ready`.

## One-shot behavior

The existing `POST /v1/chat/completions` route remains the compatibility path and still starts one-shot runners by default.

One-shot adapters do not expose retained-session capabilities or an interaction response transport.

The bridge therefore reports no interactive capability for those adapters and does not create a retained session for them.

The `/input` route defaults to a per-session queue depth of `16` and a wait bound of `30000` milliseconds.

Queue overflow returns `429 input_queue_full`, while timeout or request cancellation returns `408 input_queue_timeout` or `408 input_queue_aborted` before a durable run admission exists.

Steer requests require an exact `AgentRunControlRef` with run, provider, environment, session, execution, and request-digest coordinates.

The bridge validates the durable run admission and current live native run immediately before `steer`, and operation-id retries return the original acknowledgement without repeating the native call.

ACP no longer selects the first permission option automatically.

OpenCode no longer writes implicit `allow` permissions.

The one-shot default is deny for OpenCode permissions.

Pi one-shot calls pass `--no-tools` by default and therefore cannot silently execute a tool without an approval path.

Pi one-shot `unattended-allow` loads a separate approval extension only after the named profile receipt has been validated.

An unattended allow is accepted only when the caller supplies `interaction_policy=unattended-allow`, a profile with `metadata.cliBridge.interactionPolicy=unattended-allow-v1`, and a receipt whose digest matches that exact profile.

The receipt is returned in the chat response metadata and is not a substitute for an interactive response channel.

The bridge-level one-shot run registry still distinguishes an SSE reader disconnect from explicit run cancellation.

That does not turn a print-mode runner into a retained provider session, so one-shot clients must use the run endpoints for the behavior the adapter actually proves.

## Conformance commands

The deterministic native-child proof is:

```bash
VITEST_CACHE_DIR=/tmp/cli-bridge-vitest-cache \
node node_modules/vitest/vitest.mjs run tests/pi-native.test.ts \
  --reporter=verbose --no-file-parallelism --cache=false
```

The gated live command uses the installed Pi binary and subscription:

```bash
CLI_BRIDGE_REAL_PI=1 \
CLI_BRIDGE_PI_BIN=/home/drew/bin/pi \
CLI_BRIDGE_REAL_PI_MODEL=pi/deepseek/deepseek-v4-pro \
VITEST_CACHE_DIR=/tmp/cli-bridge-vitest-cache \
node node_modules/vitest/vitest.mjs run tests/pi-native-real.test.ts \
  --reporter=verbose --no-file-parallelism --cache=false
```

The live command is intentionally gated because it uses a real provider subscription and may incur provider cost.

The retained-session implementation consumes the published `@tangle-network/agent-interface@0.43.0` contract directly.

Startup validates every retained SQLite table, column type, nullability, primary-key position, event-identity uniqueness rule, and named index before serving requests.
