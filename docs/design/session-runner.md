# Retained native sessions

Status: implemented in W3.

This document describes the shipped retained-session surface in cli-bridge.

It replaces the earlier proposed private session abstraction and bridge-specific event union.

Neither is a production contract.

## Boundary

`POST /v1/chat/completions` remains the default one-shot compatibility route.

Retained sessions are explicit resources under `/v1/sessions`.

Only a backend that exposes a native bidirectional protocol and a validated Agent Interface capability document can create one.

Pi is the first and currently only backend that satisfies this condition.

The retained service owns storage, run identity, event commit order, replay, interaction binding, and lifecycle state.

The backend adapter owns its private child-process protocol.

The outward boundary is the public Agent Interface 0.43 schema set.

## HTTP surface

| Route | Meaning |
| --- | --- |
| `POST /v1/sessions` | Create one retained resource after capability admission. |
| `GET /v1/sessions` | List retained resources. |
| `GET /v1/sessions/:id` | Return resource state, exact create digest, capabilities, profile receipt, and boundary proof. |
| `POST /v1/sessions/:id/turns` | Start the next turn. |
| `POST /v1/sessions/:id/input` | Queue a next turn behind the active run, or start it immediately when idle, with bounded per-session depth and waiting time. |
| `GET /v1/sessions/:id/events` | Stream committed canonical envelopes and replay after `Last-Event-ID`. |
| `GET /v1/runs/:runId/events` | Stream one run's canonical envelopes and replay with a run-local sequence cursor. |
| `GET /v1/sessions/:id/transcript` | Rebuild messages, interactions, usage, and the latest event cursor. |
| `GET /v1/sessions/:id/status` | Return the resource status. |
| `POST /v1/sessions/:id/steer` | Send active-run input only when the native adapter implements steering. |
| `POST /v1/sessions/:id/cancel` | Accept one digest-bound public cancellation request and return its exact public acknowledgement. |
| `POST /v1/sessions/:id/detach` | Return the session without cancelling its run. |
| `POST /v1/sessions/:id/close` | Close an idle or unknown resource, release its native child, and refuse while a run is active. |
| `POST /v1/runs/:runId/interactions/:interactionId/respond` | Submit one public interaction response command. |

The response route binds the URL, command binding, retained session, run, interaction, and authenticated caller operation.

The caller operation identifier is stored with a digest of the caller and complete command body.

The same identifier and digest return the stored acknowledgement.

A changed body or caller returns `already_resolved_different` and never reaches the runner.

Capability discovery and retained-session creation share the same cancellable, time-limited backend probe as `/health` and refuse a native backend whose health state is not `ready`.

The `/input` queue defaults to depth `16` and `30000` milliseconds and returns `429 input_queue_full` or `408 input_queue_timeout`/`input_queue_aborted` before turn admission when those limits are reached.

Steer requests require an exact `AgentRunControlRef` with run, provider, environment, session, execution, and request-digest coordinates.

The bridge validates the durable run admission and current live native run immediately before `steer`, and operation-id retries return the original acknowledgement without repeating the native call.

## Storage and run ownership

`SessionStore` stores retained session rows, exact create digests, run admissions, canonical event rows, interaction operations, and retained control operations in the existing SQLite database.

`RunRegistry` remains the only process-local owner of active execution.

Each retained turn claims one durable run identity with a request digest and stores the caller's public execution id separately from the wire run id.

The caller must provide the retained session id and each turn's run id.
The service rejects missing identities instead of creating random resources that a retry could duplicate.

The request digest covers the session, model, public execution id, turn id, wire run id, and normalized text input.

Inputs the native text channel cannot preserve are rejected before admission.

The retained event callback commits the envelope to SQLite before it becomes replayable from the in-memory live buffer.

The database assigns one monotonic numeric cursor per retained session.

The run assigns one monotonic sequence per run.

The session event stream uses the durable session cursor and includes all retained runs for that session.

The run event stream uses the durable run sequence and excludes events from every other run.

The run stream writes that sequence as the SSE id without replacing the session cursor inside the canonical envelope.

The event identifier is stable as `<run-id>:<run-sequence>` when the native provider has no durable event identifier.

Duplicate run sequence and event identifier writes are accepted only when their identity and event body match.

Conflicting writes fail closed.

A reader disconnect only aborts its reader signal.

It does not call `Run.cancel` and does not terminate the native child.

An explicit cancel requires and validates the public request digest, exact session and run binding, stored run-admission digest, authenticated caller, and durable operation id before it aborts the run controller and sends the native abort command.

Cancellation waits behind any native interaction response already in flight, so a successful response is durably acknowledged before cancellation can withdraw remaining interactions.

The cancel route returns `202` with `effect="cancel_requested"` until terminal cancellation is observed and `200` with `effect="cancelled"` or `effect="not_live"` after terminal state is proven.

Repeating the same operation after a restart returns the same binding and effect without repeating the native cancellation; changed reuse returns `status="conflict"` and `effect="unknown"`.

Closing an active resource is rejected so close cannot become an accidental cancellation path.

## Canonical events

Every stored event is a public `RuntimeEventEnvelope` whose `event` is validated by the public `CanonicalStreamEventSchema` shape.

The service maps native observations to existing public event members.

| Native observation | Public event |
| --- | --- |
| Text delta | `message.part.updated` with a text part and optional `delta`. |
| Thinking delta | `message.part.updated` with a reasoning part and optional `delta`. |
| Tool call or execution state | `message.part.updated` with a public tool part state. |
| Pi session identity | `session.updated`. |
| Instrumented permission-select dialog | `interaction` with a public `InteractionRequest`. |
| Dialog withdrawal or explicit run cancellation | `interaction.cancel` with the provider or bridge reason. |
| Durable plan shape | `plan.submitted` only after public plan validation. |
| Token receipt | Public `raw` event carrying `event.type="usage"` and public `TokenUsage` field names. |
| Provider or adapter diagnostic | Public `raw` or `warning` event. |
| Turn lifecycle | Public `status` events. |

No bridge-specific event union is introduced.

The public interface has no dedicated usage member in `StreamEvent`.

Usage therefore uses the public raw carrier instead of inventing a `usage` event type.

The transcript extracts those usage carriers without adding them to the canonical union.

## Pi protocol

The Pi adapter starts `pi --mode rpc` with stdin and stdout pipes.

The adapter sends `prompt`, `steer`, `abort`, and `get_state` JSON commands using Pi's documented JSONL protocol.

The adapter consumes Pi's `session`, turn, message, tool, usage, error, `agent_end`, and `agent_settled` records.

`agent_end` is a low-level attempt boundary and can be followed by retry or compaction.

The adapter completes a retained turn only at Pi's session-level `agent_settled` boundary.

The same child remains open between retained turns.

The first `session` record and `get_state` response establish the provider session id.

The stored native boundary is a public `NativeContextBoundaryProof` with a Pi revision derived from session id and message count.

A later retained turn is attempted only when a fresh provider boundary matches that stored proof.

An unavailable or changed boundary is returned as an explicit capability or mismatch error instead of silently continuing.

No transcript is resent during the retained turn.

This Pi boundary check is not the public native-continuation operation.

Pi's capability document omits `nativeContinuation` because Pi has no atomic boundary comparison plus turn admission and no request-id replay primitive.

Pi extension dialog records use the documented `extension_ui_request` and `extension_ui_response` subprotocol.

Pi 0.83 sends no response message for `extension_ui_response`.

The injected extension puts a unique sanitized token in each permission title and emits `cli-bridge.permission-applied.v1:<token>:<selected-value>` only after `await ctx.ui.select` returns.

The adapter waits for that exact marker after writing the matching response, so unrelated Pi traffic or a marker for another token or value cannot acknowledge the response.

If the exact marker does not arrive within the configured Pi timeout, the public operation returns `transport_failure`, marks the effect unknown, and is not retryable because repeating it could apply the response twice.

The retained bridge-generated interaction extension pauses tool calls and offers only `allow_once` or `deny` to the user-facing public response.

Source exhaustion without Pi's explicit `agent_settled` event creates a failed terminal status.

Pi one-shot calls pass `--no-tools` unless the request carries the exact named unattended policy receipt.

That named policy loads a separate headless approval extension and is the only one-shot path that enables tool execution.

The exact existing Pi profile materializer supplies system prompt, instructions, skills, prompt templates, extensions, and MCP configuration.

Its immutable materialization receipt is persisted on the retained session.

## Capability honesty

The Pi capability document advertises live streaming, replay, detach, session continuation, messages, permission-select interactions, usage, active steering, and all four retained-control identity promises.

It does not advertise native continuation.

Pi does not advertise branching or secret answers.

All other current runners remain one-shot because their installed/native protocols have not passed the same flow.

They are not admitted by `POST /v1/sessions`.

Their one-shot route reports no retained interaction capability.

Their bridge-level run behavior remains whatever the existing one-shot run registry proves.

The OpenCode one-shot config defaults permissions to `deny`.

The ACP one-shot client refuses interactive permission requests instead of selecting the first option.

An explicit unattended allow is available only when the request names the policy, supplies the matching profile metadata, and carries the matching profile digest receipt.

The retained native path rejects unattended policy values because it has a real response transport and must remain interactive.

Uninstrumented Pi dialogs are recorded as warnings and are not advertised as answerable interactions.

Startup validates every retained SQLite table, column type, nullability, primary-key position, event-identity uniqueness rule, and named index before serving requests.

## Restart and unknown state

The SQLite rows survive a bridge restart.

The process-local native child and run owner do not.

If a stored running session has no matching live run after restart, the service changes it to `unknown`.

It never changes restart loss to `cancelled`.

A next turn on a session with prior turns and no recoverable native owner returns `unknown_session`.

This prevents an unsafe fresh context from masquerading as continuation.

Persisted events remain readable for transcript and replay queries after this state change.

Persisted create, public execution identity, run, and cancellation digests remain authoritative after restart, so retries either recover the exact prior admission or fail with a conflict.

Shutdown synchronously closes run admission before the HTTP server and current run collection begin draining.

Requests already reading a body on a persistent connection therefore receive `503 run_admission_closed` and cannot create a child outside the shutdown snapshot.

An unexpected native close retains its cleanup owner and first cleanup failure until shutdown reports it; a later shutdown call retries the same owner.

## Proof commands

The real-child subprocess proof is `tests/pi-native.test.ts`.

The gated provider proof is `tests/pi-native-real.test.ts`.

Run the real Pi proof with:

```bash
CLI_BRIDGE_REAL_PI=1 \
CLI_BRIDGE_PI_BIN=/home/drew/bin/pi \
CLI_BRIDGE_REAL_PI_MODEL=pi/deepseek/deepseek-v4-pro \
VITEST_CACHE_DIR=/tmp/cli-bridge-vitest-cache \
node node_modules/vitest/vitest.mjs run tests/pi-native-real.test.ts \
  --reporter=verbose --no-file-parallelism --cache=false
```

The command is gated because it uses the installed Pi subscription.

The public 0.43 source evidence is agent-sdk merge commit `7000e82752d86cd69aa56d51911541ec63c8c2b6` and the published `@tangle-network/agent-interface@0.43.0` package.

See [BACKENDS.md](../BACKENDS.md) for the capability matrix and pinned runner evidence.
