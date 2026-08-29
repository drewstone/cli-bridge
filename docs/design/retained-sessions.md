# Retained sessions and native interactions

Status: implemented for the Pi native backend, with the generic one-shot durable contract exposed for ready non-native routes.

This surface keeps one native CLI process behind a durable bridge session.

The bridge stores the session identity, run admission, normalized events, interaction requests, and replay cursor.

The caller can disconnect and reconnect without starting a second native process.

## Capability admission

Call `GET /v1/capabilities?model=<exact-model>` before choosing a retained or one-shot durable route.

The bridge runs the backend health check through the real executor path.

The backend must publish valid Agent Interface 0.54 capabilities.

The bridge advertises retained sessions only when the backend proves all of these properties:

- native session creation and continuation;
- live output, replay, detach, and turn idempotency;
- exact run identity and event identity;
- cancellation idempotency;
- an atomic native context boundary;
- request idempotency at that boundary;
- replayable interactions and response idempotency.

Native retained sessions remain limited to backends that prove the complete contract above.

For a ready non-native backend, the bridge returns one canonical generic capability document.

That document describes the durable one-shot chat protocol: live output, replay, detach, reconnect, session continuation through the legacy session store, exact run identity, result and event identity, cancellation idempotency, profile forwarding, usage, placement, and lifecycle observation.

It does not claim native continuation or native interactions, and `POST /v1/sessions` still returns `501 capability_denied` for that backend.

The bridge returns `501 capability_denied` for an unready native-session request instead of starting an untracked process.

## Generic one-shot durable coordinates

The one-shot `POST /v1/chat/completions` route accepts optional exact coordinate fields: `provider`, `environment_id`, `session_id`, `execution_id`, and `run_id`.

The three provider fields are all-or-none.

Provider, environment, session, and execution coordinates use the Agent Interface identifier limit of 512 characters.

The durable `run_id` remains a separate HTTP route identifier limited to 128 characters.

An exact request must also carry an explicit run id and session id through the body or accepted headers.

Conflicting body and header aliases fail with `400` before session or run admission.

When exact coordinates are supplied, the bridge persists them unchanged instead of substituting the backend name, `ENVIRONMENT_ID`, or generated run values.

Every run snapshot and control or replay response exposes the same six fields: run id, request digest, provider, environment id, session id, and execution id.

The response headers are `X-Run-Id`, `X-Run-Request-Digest`, `X-Run-Provider`, `X-Run-Environment-Id`, `X-Run-Session-Id`, and `X-Run-Execution-Id`.

## Session and run surface

The retained routes are:

- `POST /v1/sessions` creates a caller-owned session.
- `GET /v1/sessions` lists retained and legacy sessions.
- `GET /v1/sessions/:id` reads the durable session view.
- `POST /v1/sessions/:id/turns` starts one idempotent turn.
- `POST /v1/sessions/:id/continue` performs one Agent Interface native continuation.
- `POST /v1/sessions/:id/continue?return=admission` returns exact control after durable admission.
- `GET /v1/sessions/:id/events` replays normalized session events.
- `GET /v1/sessions/:id/transcript` reads the normalized transcript.
- `GET /v1/sessions/:id/status` reads the current status.
- `POST /v1/sessions/:id/steer` sends a mid-turn message when the backend advertises steering.
- `POST /v1/sessions/:id/cancel` cancels one exact admitted run.
- `POST /v1/sessions/:id/detach` returns the session without killing its native process.
- `POST /v1/sessions/:id/close` closes the native process and owned files.
- `GET /v1/runs/:runId` reads a live or retained run snapshot.
- `GET /v1/runs/:runId/events` replays a live or retained run event stream.

Every retained turn requires caller-owned `run_id` and `execution_id` values.

The bridge binds both values to the normalized request digest before native startup.

The durable session view's `context_boundary` field returns the exact stored `NativeContextBoundaryProof`.

## Native continuation

The continuation route accepts `{ request, turn }` using the pinned Agent Interface schemas.

The bridge validates the turn digest and request digest before it admits the operation.

The request's `run` and `expectedBoundary` must identify the current stored run exactly.

The route records a pending operation before dispatch and uses the existing per-session turn lane.

The internal continuation run id is a fixed-size digest of the operation id, so the maximum valid operation id cannot overflow Agent Interface limits.

The `return=admission` mode returns `202` only after the boundary and new run identity are durable.

Its response contains `phase: admitted`, the observed source boundary, and the exact new control reference.

The caller can use that reference for status, event replay, interaction response, or cancellation while output is active.

Repeating the same continuation without `return=admission` waits for the original terminal result.

Repeating the admission request returns the same identity and does not dispatch another turn.

That lane repeats the boundary comparison before provider startup and observes the native source boundary while the handoff lock is held.

An accepted acknowledgement reports that fresh observation with the source run coordinates.

The bridge never reports the caller's expected proof as if it were a new provider observation.

The acknowledgement includes the exact `AgentTurnResult` and `AgentExactRunControlRef` produced by the retained run.

The same caller, operation id, and request digest replay the stored result without another native turn.

A changed request, different caller, session binding, run binding, or digest returns `conflict` without dispatch.

The route returns `boundary_mismatch`, `unverified`, `unknown_session`, and `transport_failure` as typed Agent Interface acknowledgements.

If the bridge restarts with a pending operation and no durable terminal run, it records `unknown_session` and never repeats the turn.

The pending record stores the fresh source boundary before native run claim, so a durable terminal run can replay successfully after a settle-window crash.

Each turn can request canonical interaction kinds through its `interactions` record.

The bridge admits only kinds advertised by the selected backend.

The normalized interaction posture is part of the run request digest.

A retry cannot widen or change that posture under the same run identity.

The digest also includes the exact provider and environment coordinates accepted by the turn parser.

An unrequested interaction fails closed instead of pausing an unattended run.

Session metadata does not store a second interaction policy.

The existing one-shot run replay and cancel routes remain in place.

The one-shot chat route parses the shared `interactions` and `interaction_policy` fields for wire compatibility.

It rejects a non-empty interaction posture or policy before durable admission because one-shot chat has no response-bound native interaction channel.

Retry-safe one-shot cancellation must repeat the exact provider, environment, session, execution, run, and request-digest coordinates returned by the run snapshot.

## Canonical retained request fields

The session creation wire shape owns `id` or `session_id`, `model`, `cwd`, `mode`, `interaction_policy`, `agent_profile`, `mcp`, `metadata`, `execution`, `env`, `context`, and `provider_options`.

The retained turn wire shape owns `message` or `parts`, `turn_id`, `execution_id`, `run_id`, `provider`, `environment_id`, `interactions`, `context`, `provider_options`, `metadata`, `execution`, and `env`.

The `parts` union accepts strict `text`, `file`, and `image` records with bounded `filename`, `mediaType`, `url`, `path`, and `content` fields where the part type permits them.

The SDK `CliBridgeProviderOptions.defaultExecution` field maps to the retained `execution` field.

The retained contract rejects the literal `defaultExecution` field because it is not a canonical Bridge field.

The SDK `environmentInput.metadata`, `turn.context`, and `turn.providerOptions` values map to the canonical `metadata`, `context`, and `provider_options` fields.

The legacy `/v1/chat/completions` session record persists the exact selected `model`, `agent_profile`, `execution`, `env`, `mcp`, `context`, `provider_options`, and `request_metadata` values.

The selected `model` must already be the exact Bridge model coordinate such as `pi/<provider>/<model>`.

The Bridge does not infer a model from an AgentProfile after restart.

Unsupported retained fields fail closed instead of being silently dropped.

Retained open records reject credential-bearing keys recursively, including nested metadata, context, provider options, and MCP metadata.

Typed AgentProfile configuration and typed MCP environment or header values use the Agent Interface parser.

Typed secret references survive durable storage and restart, while raw credential-like values fail closed.

Retained request environment rejects credential-bearing names and Bridge-owned process controls before child-process injection.

The retained fallback does not change the current-main behavior for a terminal unknown run.

The data-directory and port lock records bind ownership to a platform process start identity as well as the pid.

Linux uses `/proc`, macOS uses `ps`, and Windows uses PowerShell to read that identity.

macOS currently uses `ps -o lstart=` because this package has no libproc binding or native FFI dependency.

Node's standard library exposes no `proc_pidinfo` call, so this repository has no safe native path to that value.

That output has one-second granularity, so every start in one half-open one-second interval has the same identity.

The residual false-live case therefore requires PID reuse within that interval, which this implementation cannot distinguish.

Decoding `sysctl -b kern.proc.pid.<pid>` is intentionally not used because its `kinfo_proc` bytes are not the public `proc_bsdinfo` layout.

A pid-only legacy record is blocked when its process is live and reclaimed only after the liveness check proves it is dead.

The released Agent Interface dependency provides `isCredentialBearingProfileConfigName` from `profile-schema` and `isRuntimeProcessControlEnvironmentName` from `profile-security`.

These exports are provided by `@tangle-network/agent-interface` 1.3.0.

Bridge pins `@tangle-network/agent-interface` 1.3.0 and `@tangle-network/agent-profile-materialize` 0.16.0 before release.

The Bridge keeps only its five Pi-owned child-process control names locally because Agent Interface does not own Pi environment injection.

## Interaction response binding

Native events become the canonical `InteractionRequest` type from `@tangle-network/agent-interface`.

The request includes its own `requestDigest`.

The response route is `POST /v1/runs/:runId/interactions/:interactionId/respond`.

The caller sends one `InteractionResponseCommand` with an `operationId`.

The bridge validates the command digest over the exact binding and response.

The binding must match all of these values:

- the URL run id;
- the URL interaction id;
- the provider coordinate sent by the SDK;
- the environment coordinate sent by the SDK;
- the retained session id;
- the admitted execution id;
- the interaction request digest.

The bridge also checks the durable retained-run admission and the live native session before forwarding the response.

Pi permission requests expose one required `select` grant field and no feedback field.

The response scope is the current interaction only.

The same operation id and bytes replay the stored acknowledgement.

The same operation id with different bytes returns a conflict.

The response reaches the native process only after every identity check passes.

No response is synthesized when the native session lacks an exact interaction adapter.

## Pi native implementation

Pi runs in its documented JSONL RPC mode.

The bridge reuses the current Pi profile, MCP, inference transport, jail, and session-file materializers.

The native session adapter owns prompt, steer, abort, state-boundary, response, close, and cleanup operations.

Pi permission prompts use a request-scoped extension marker.

The bridge emits an interaction event only for an instrumented Pi permission request.

The response path waits for the matching native notification marker before acknowledging the response.

Unrelated Pi output does not count as permission progress.

The first retained turn creates the exact Pi session file before spawning the child.

Later turns resume that same provider session id.

Private roots record device and inode identity before cleanup.

Cleanup refuses a replaced root and schedules retries through the shared process-tree cleanup helper.

The native lease is released only once termination is proven.

Real host Pi retained sessions require an enforced Linux filesystem jail with bubblewrap.

Docker Pi retained sessions remain unavailable because the bridge-owned loopback inference transport is not reachable from the Docker network namespace.

The bridge does not fall back to mounted provider credentials.

Pi maps only `AgentProfile.model.maxTotalOutputTokens` to the native catalog `maxTokens` cap.

Pi rejects `maxVisibleOutputTokens` and `maxReasoningTokens` because its selected runner cannot enforce those ceilings independently.

`reasoningEffort` remains a quality control and never acts as a numeric reasoning-token limit.

`AgentProfile.model.metadata` is not a Pi token authority, and `metadata.maxTokens` is rejected.

## MCP and ACP boundary

The generic MCP implementation belongs to `@tangle-network/sdk-provider-cli-base`.

Its source exports `InteractionMcpServer`, `McpInteractionSupport`, `InteractionBroker`, and `InteractionHttpBridge`.

The bridge does not copy those classes or define replacement interaction contracts.

The live npm registry returned `404` for `@tangle-network/sdk-provider-cli-base` on 2026-08-15.

The currently published profile-materialize package 0.16.0 declares an Interface peer range of `^1.0.0`.

The bridge uses the released Interface 1.3.0 package without a local package link.

Generic MCP interaction capability stays unadvertised until ADC publishes a compatible release and the bridge composes it through the existing profile and MCP materialization path.

ACP remains a one-shot backend in this branch.

It is not a retained-session backend and does not appear in retained capability discovery.

ACP permission requests now fail closed because the one-shot client cannot bind a user response to a retained run.

Replacing that behavior requires a published ACP-native response adapter and an end-to-end test of request, response, replay, retry, and failure states.

Retained Pi responses are at-most-once across process loss.

After native delivery may have applied and then throws, the durable ledger records an interaction-level `effect_unknown` tombstone.

Every later operation id for that interaction returns a non-retryable transport failure without invoking the native process again.

An interrupted response is never sent again unless a future provider supplies a durable effect receipt.

## Proof commands

The focused retained proof is:

```text
pnpm exec vitest run tests/retained-sessions.test.ts -t 'native continuation|native boundary|completed native continuation|pending native continuation'
pnpm exec vitest run tests/retained-sessions.test.ts tests/pi-native.test.ts --reporter dot
pnpm exec vitest run tests/single-instance.test.ts --reporter dot
```

The current-main regression proof is:

```text
pnpm typecheck
pnpm exec vitest run tests/durable-runs.test.ts --reporter dot
pnpm exec vitest run tests/smoke.test.ts --reporter dot
pnpm exec vitest run tests/pi-backend.test.ts --reporter dot
pnpm exec vitest run tests/probe-request-path.test.ts --reporter dot
```

The Pi native suite uses real Python JSONL child processes.

The full retained suite also covers lost responses, restart loss, replay expiry, exact interaction binding, concurrent response and cancellation, terminal persistence failures, and cleanup retry.
