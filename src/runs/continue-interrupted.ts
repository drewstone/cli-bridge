/**
 * Bridge start: continue the turns an earlier bridge process left running, for
 * every backend that declares a native resume (`runRunner`: Claude, Codex, opencode).
 *
 * A one-shot run whose last snapshot is not terminal lost its owner. Its
 * retained events name the runner's scope and native session. When that scope
 * still holds tasks, the runner outlived the bridge (measured: a Claude runner
 * wrote its next step 45 s after the bridge was SIGKILLed, and so does a Codex
 * runner). The scope is killed and drained first, and only then is the turn
 * resumed once, under the same run id and after its last committed sequence, so
 * a reader that reattaches with Last-Event-ID sees the continuation event and
 * the rest of the turn.
 *
 * The continuation holds the session's execution lease, and it resends the
 * system messages its runner record retained.
 *
 * Every other unsettled run stays `unknown`, as before: no recorded scope, a
 * scope that is already empty, no native session id, or a run that was already
 * continued once.
 */

import type { ChatDelta, ChatRequest } from '../backends/types.js'
import { continueTurn, type NativeResumeBackend } from '../backends/runner-continuation.js'
import type { BackendRegistry } from '../backends/registry.js'
import { drainOrphanScope } from '../executors/scoped-host.js'
import { hostRequestJail } from '../jail/host-request.js'
import type { DurableRunWriter } from '../sessions/durable-writer.js'
import type { RetainedRunAdmission, SessionStore } from '../sessions/store.js'
import { chatDeltaFromRetainedEvent } from './persisted-chat-event.js'
import { chatCompletionDeltaOptions } from './delta-stream.js'
import type { RunRegistry } from './registry.js'

export async function continueInterruptedRuns(deps: {
  store: SessionStore
  runs: RunRegistry
  registry: BackendRegistry
  durableWriter: Pick<DurableRunWriter, 'commit'> | null
  jailEnv: NodeJS.ProcessEnv
}): Promise<void> {
  for (const admission of deps.store.unsettledOneShotRuns()) {
    try {
      await continueRun(admission, deps)
    } catch (error) {
      console.error(`[cli-bridge] run ${admission.runId} was left unknown after restart:`, error)
    }
  }
}

async function continueRun(
  admission: RetainedRunAdmission,
  deps: Parameters<typeof continueInterruptedRuns>[0],
): Promise<void> {
  const events = deps.store.retainedEventsAfterRun(admission.sessionId, admission.runId)
  const deltas = events.map((record) => chatDeltaFromRetainedEvent(record)).filter((delta): delta is ChatDelta => delta !== null)
  const runner = deltas.findLast((delta) => delta.runner)?.runner
  if (!runner?.scope || !await drainOrphanScope(runner.scope)) return
  const backend = deps.registry.byName(runner.backend)
  const nativeSessionId = deltas.findLast((delta) => delta.internal_session_id)?.internal_session_id
  if (!backend?.runRunner || !nativeSessionId || deltas.some((delta) => delta.continuation)) {
    console.error(`[cli-bridge] run ${admission.runId}: killed its orphaned runner ${runner.pid}; the turn stays unknown`)
    return
  }
  const session = deps.store.get(admission.sessionId, backend.name)
  const snapshot = admission.snapshot as { model?: unknown }
  const model = typeof snapshot.model === 'string' ? snapshot.model : session?.metadata.model
  if (typeof model !== 'string') return
  const openTools = new Map<string, string>()
  let lastActivityCall = 0
  for (const delta of deltas) {
    if (delta.activity && 'call' in delta.activity) lastActivityCall = Math.max(lastActivityCall, delta.activity.call ?? 0)
    for (const call of delta.tool_calls ?? []) openTools.set(call.id, call.name)
    for (const result of delta.tool_results ?? []) openTools.delete(result.id)
  }
  const req: ChatRequest = {
    model,
    messages: (runner.system ?? []).map((chunks) => ({ role: 'system' as const, content: chunks.join('') })),
    stream: true,
    mode: runner.mode,
    ...(runner.cwd ? { cwd: runner.cwd } : {}),
    ...(session ? { session_id: admission.sessionId } : {}),
    ...(session?.metadata.agent_profile ? { agent_profile: session.metadata.agent_profile as ChatRequest['agent_profile'] } : {}),
    ...(session?.metadata.execution ? { execution: session.metadata.execution as ChatRequest['execution'] } : {}),
  }
  req.jailSpec = hostRequestJail(req, backend.name, deps.jailEnv)

  const { store, durableWriter } = deps
  const { run } = deps.runs.claim(admission.runId, admission.requestDigest, {
    owner: 'one-shot',
    model,
    provider: admission.provider,
    environmentId: admission.environmentId,
    sessionId: admission.sessionId,
    executionId: admission.executionId,
    startAfterSeq: events.at(-1)?.envelope.sequence ?? 0,
    commitDelta: (input) => durableWriter
      ? durableWriter.commit({ method: 'appendRetainedDelta', args: [admission.sessionId, input] })
      : void store.appendRetainedDelta(admission.sessionId, input),
    commitSnapshot: (next) => durableWriter
      ? durableWriter.commit({ method: 'updateRetainedRun', args: [admission.runId, admission.requestDigest, next] })
      : void store.updateRetainedRun(admission.runId, admission.requestDigest, next),
  })
  // The continuation owns the session lane like any turn, so a new turn on it waits.
  const lease = session ? await deps.store.acquireExecution(admission.sessionId, backend.name) : null
  const interruption = { reason: 'bridge_restart' as const, pid: runner.pid, nativeSessionId, openTools, lastActivityCall, recordedMaxTokens: runner.max_tokens }
  void run.pump(continueTurn(backend as NativeResumeBackend, req, session, interruption, run.signal), chatCompletionDeltaOptions(req))
    .finally(() => lease?.release())
}
