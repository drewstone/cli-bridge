/**
 * Continue one turn once after its native runner dies, for any backend whose CLI
 * resumes a session by id. The backend runs one runner process per call and
 * resumes `session.internalId` with its own argv (Claude `--resume <id>`, Codex
 * `exec resume <id>`); everything else here is shared.
 */

import type { SpawnResult } from '../executors/types.js'
import type { BridgeMode } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import { contentToText } from './content.js'
import type { ChatDelta, ChatRequest } from './types.js'

/** What one runner process showed before it ended, for deciding a continuation. */
export interface RunnerWatch {
  pid?: number
  nativeSessionId?: string
  /** Tool calls announced without a result yet, by id, with their tool names. */
  openTools: Map<string, string>
  /** The signal that killed the runner before its terminal event. */
  exit?: string
  /** Its scope was killed and found empty. */
  drained: boolean
}

export interface RunnerInterruption {
  reason: 'runner_exit' | 'bridge_restart'
  pid: number
  exit?: string
  nativeSessionId: string
  openTools: ReadonlyMap<string, string>
}

/** A backend that runs one native runner process per call and resumes `session.internalId` natively. */
export interface NativeResumeBackend {
  readonly name: string
  runRunner(req: ChatRequest, session: SessionRecord | null, signal: AbortSignal, watch: RunnerWatch): AsyncIterable<ChatDelta>
}

export function newRunnerWatch(): RunnerWatch {
  return { openTools: new Map(), drained: false }
}

/**
 * The retained record of a started runner, which a restarted bridge reads to kill
 * and drain it. It keeps the turn's role:system texts, chunked under the retained-string bound.
 */
export function runnerDelta(
  backend: string, pid: number, spawned: Pick<SpawnResult, 'scope'>, mode: BridgeMode, cwd: string | undefined, req: ChatRequest,
): ChatDelta {
  const system = (req.messages ?? []).filter((m) => m.role === 'system').map((m) => contentToText(m.content).match(/[\s\S]{1,16000}/gu) ?? [])
  return { runner: { backend, pid, ...(spawned.scope ? { scope: spawned.scope } : {}), mode, ...(cwd ? { cwd } : {}), ...(system.length ? { system } : {}) } }
}

/**
 * One turn. When its runner dies by a signal the bridge did not send, and its
 * scope drained, the turn continues once in the same native session.
 */
export async function* chatContinuing(
  backend: NativeResumeBackend, req: ChatRequest, session: SessionRecord | null, signal: AbortSignal,
): AsyncIterable<ChatDelta> {
  const watch = newRunnerWatch()
  try {
    yield* backend.runRunner(req, session, signal, watch)
  } catch (error) {
    if (signal.aborted || !watch.exit || !watch.drained || !watch.nativeSessionId || watch.pid === undefined) throw error
    yield* continueTurn(backend, req, session,
      { reason: 'runner_exit', pid: watch.pid, exit: watch.exit, nativeSessionId: watch.nativeSessionId, openTools: watch.openTools }, signal)
  }
}

/**
 * Resume an interrupted turn once with a fixed message. The caller has already
 * killed and drained the dead runner's scope, so the bridge never re-runs a tool
 * and never writes the native session file. Both CLIs accept a session that ends
 * on a tool call with no result (measured: Claude Code 2.1.325 answers it with an
 * "interrupted" tool_result; Codex 0.169.0 resumes the rollout as it is). If this
 * resume dies too, the turn fails as before: one resume per kill.
 */
export async function* continueTurn(
  backend: NativeResumeBackend, req: ChatRequest, session: SessionRecord | null, interruption: RunnerInterruption, signal: AbortSignal,
): AsyncIterable<ChatDelta> {
  const tools = [...interruption.openTools].map(([id, name]) => ({ id, name }))
  yield { continuation: {
    reason: interruption.reason,
    previous_pid: interruption.pid,
    ...(interruption.exit ? { previous_exit: interruption.exit } : {}),
    native_session_id: interruption.nativeSessionId,
    interrupted_tool_calls: tools,
    resumed_at: new Date().toISOString(),
  } }
  const notice = tools.length > 0
    ? tools.map((tool) => `The tool call ${tool.name} (${tool.id}) was interrupted and may have partially run; check its effect before acting again.`).join(' ')
    : 'Your previous response was cut off before it finished.'
  const resumed: ChatRequest = {
    ...req,
    messages: [
      ...(req.messages ?? []).filter((message) => message.role === 'system'),
      { role: 'user', content: `The process running this turn stopped unexpectedly and CLI Bridge resumed your session. ${notice} Do not repeat a step that already completed; continue the task from where it stopped.` },
    ],
  }
  const resumedSession: SessionRecord = session
    ? { ...session, internalId: interruption.nativeSessionId }
    : { externalId: interruption.nativeSessionId, backend: backend.name, internalId: interruption.nativeSessionId,
        cwd: req.cwd ?? null, turns: 1, createdAt: Date.now(), lastUsedAt: Date.now(), metadata: {} }
  // Codex numbers its items per process, so the resumed runner reuses ids the dead one announced.
  const own = (id: string): string => `${id}.resumed`
  for await (const delta of backend.runRunner(resumed, resumedSession, signal, newRunnerWatch())) {
    yield { ...delta,
      ...(delta.tool_calls ? { tool_calls: delta.tool_calls.map((call) => ({ ...call, id: own(call.id) })) } : {}),
      ...(delta.tool_results ? { tool_results: delta.tool_results.map((result) => ({ ...result, id: own(result.id) })) } : {}) }
  }
}
