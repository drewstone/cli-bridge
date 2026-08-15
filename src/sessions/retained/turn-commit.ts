/**
 * The two durable writes that close out a retained turn.
 *
 * A turn either produced a terminal run — and its outcome, turn count, and
 * context boundary must land together — or it never became executable, and the
 * session must be left in the state a caller can act on: `unknown` whenever a
 * native child may still exist or a write may have been lost, and the exact
 * prior state only when nothing was started.
 */

import type { NativeSession } from '../../backends/types.js'
import type { Run } from '../../runs/registry.js'
import type { SessionStore } from '../store.js'
import { completedTurnBoundary } from './context-boundary.js'
import { RetainedSessionError } from './types.js'

export async function commitCompletedTurn(input: {
  store: SessionStore
  sessionId: string
  runId: string
  requestDigest: string
  backend: string
  run: Run
  native: NativeSession
}): Promise<void> {
  const { store, sessionId, runId, requestDigest, run, native } = input
  const snapshot = run.snapshot()
  store.updateRetainedRun(runId, requestDigest, snapshot)
  const current = store.getRetained(sessionId)
  if (!current || current.runId !== runId) return
  let boundary = current.contextBoundary
  if (snapshot.status === 'done') {
    boundary = await completedTurnBoundary(native, {
      runId,
      sessionId,
      backend: input.backend,
      executionId: snapshot.executionId ?? runId,
      requestDigest: snapshot.requestDigest,
    })
  }
  // Boundary observation is asynchronous. Re-read immediately before
  // the synchronous SQLite update so a close that won during that wait
  // remains terminal instead of being resurrected as idle.
  const latest = store.getRetained(sessionId)
  if (!latest || latest.runId !== runId) return
  store.updateRetained(sessionId, {
    status:
      latest.status === 'running'
        ? snapshot.status === 'cancelled'
          ? 'cancelled'
          : snapshot.status === 'done'
            ? 'idle'
            : 'unknown'
        : latest.status,
    turns: snapshot.status === 'done' ? latest.turns + 1 : latest.turns,
    internalId: native.providerSessionId() ?? latest.internalId,
    contextBoundary: boundary,
  })
}

/**
 * Terminalize a claimed run whose startup or handoff failed, record what is
 * durably known, and rethrow. Always throws.
 */
export async function recoverFailedTurnAdmission(input: {
  store: SessionStore
  sessionId: string
  runId: string
  requestDigest: string
  run: Run
  error: unknown
  /** True once this run owned a native child, so a leftover process may exist. */
  nativeOwnedByRun: boolean
  priorTurns: number
}): Promise<never> {
  const { store, sessionId, runId, requestDigest, run } = input
  run.failCanonicalSetup(input.error)
  let cleanupFailure: unknown
  try {
    await run.whenTerminal()
  } catch (failure) {
    cleanupFailure = failure
  }
  const snapshot = run.snapshot()
  let persistenceFailure: unknown
  try {
    store.updateRetainedRun(runId, requestDigest, snapshot)
  } catch (failure) {
    persistenceFailure = failure
  }
  try {
    const current = store.getRetained(sessionId)
    if (current?.runId === runId && current.status !== 'closed') {
      store.updateRetained(sessionId, {
        status:
          cleanupFailure || persistenceFailure
            ? 'unknown'
            : snapshot.status === 'cancelled'
              ? 'cancelled'
              : input.nativeOwnedByRun
                ? 'unknown'
                : input.priorTurns > 0
                  ? 'idle'
                  : 'created',
        runId,
      })
    }
  } catch (failure) {
    persistenceFailure ??= failure
  }
  if (cleanupFailure) {
    throw new RetainedSessionError(
      `native session cleanup failed: ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}`,
      502,
      'close_failed',
    )
  }
  if (persistenceFailure) {
    throw new RetainedSessionError(
      `retained run failure could not be durably recorded: ${persistenceFailure instanceof Error ? persistenceFailure.message : String(persistenceFailure)}`,
      502,
      'unknown_session',
    )
  }
  throw input.error
}
