# Retained sessions and native interactions

Status: implemented for the Pi native backend.

This surface keeps one native CLI process behind a durable bridge session.

The bridge stores the session identity, run admission, normalized events, interaction requests, and replay cursor.

The caller can disconnect and reconnect without starting a second native process.

## Capability admission

Call `GET /v1/capabilities?model=pi/<provider>/<model>` before creating a retained session.

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

An ordinary one-shot backend does not satisfy this contract.

The bridge returns `501 capability_denied` for that backend instead of starting an untracked process.

## Session and run surface

The retained routes are:

- `POST /v1/sessions` creates a caller-owned session.
- `GET /v1/sessions` lists retained and legacy sessions.
- `GET /v1/sessions/:id` reads the durable session view.
- `POST /v1/sessions/:id/turns` starts one idempotent turn.
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

Each turn can request canonical interaction kinds through its `interactions` record.

The bridge admits only kinds advertised by the selected backend.

The normalized interaction posture is part of the run request digest.

A retry cannot widen or change that posture under the same run identity.

The digest also includes the exact provider and environment coordinates accepted by the turn parser.

An unrequested interaction fails closed instead of pausing an unattended run.

Session metadata does not store a second interaction policy.

The existing one-shot run replay and cancel routes remain in place.

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

These exports are provided by `@tangle-network/agent-interface` 0.54.0 from PR #184.

Bridge pins the released Interface dependency at 0.54.0 before release.

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

The currently published profile-materialize package 0.15.2 declares an Interface peer range below 0.54.0.

The bridge uses the released Interface 0.54.0 package without a local package link.

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
