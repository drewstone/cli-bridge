/**
 * Fail-closed reads of durable retained-session state.
 *
 * Every path that observes a session goes through here, because the honest
 * answer after a process loss is `unknown`, not `idle`. A record whose owning
 * run is gone, whose finalization never committed, or whose native child
 * closed unexpectedly is marked unknown on the way out rather than reported
 * as a session a caller may continue.
 */

import type { NativeSession } from '../../backends/types.js'
import type { Run, RunRegistry } from '../../runs/registry.js'
import type { RunSnapshot } from '../../runs/registry.js'
import type { RetainedSessionRecord, RetainedSessionStatus, SessionStore } from '../store.js'
import { recordValue } from './json-values.js'
import {
  type DurableRetainedRunSnapshot,
  type RetainedRunCoordinates,
  type RetainedSessionView,
  RetainedSessionError,
} from './types.js'

export class RetainedSessionState {
  /** Runs whose terminal outcome was never durably committed. */
  private readonly finalizationFailures = new Map<string, Error>()
  /** Sessions inside the synchronous turn-admission window. */
  private readonly admissions = new Set<string>()

  constructor(
    private readonly store: SessionStore,
    private readonly runs: RunRegistry,
  ) {}

  require(id: string): RetainedSessionRecord {
    let record = this.store.getRetained(id)
    if (!record) throw new RetainedSessionError('retained session not found', 404, 'not_found_error')
    if (
      record.runId &&
      this.finalizationFailures.has(record.runId) &&
      record.status !== 'closed' &&
      record.status !== 'cancelled'
    ) {
      try {
        this.store.updateRetained(id, { status: 'unknown' })
        record = this.store.getRetained(id) ?? { ...record, status: 'unknown' }
      } catch {
        record = { ...record, status: 'unknown' }
      }
    }
    if (
      !this.admissions.has(id) &&
      (record.status === 'running' || (record.status === 'idle' && record.turns > 0)) &&
      !this.runs.nativeSession(id)
    ) {
      this.store.updateRetained(id, { status: 'unknown' })
      record = this.store.getRetained(id)!
    }
    return record
  }

  view(record: RetainedSessionRecord): RetainedSessionView {
    const control = this.runs.nativeSession(record.id)
    const run = (record.runId ? this.runSnapshot(record.runId) : null) ?? control?.run.snapshot()
    const runStatus = run?.status
    const status =
      record.status === 'closed'
        ? 'closed'
        : record.status === 'unknown'
          ? 'unknown'
          : runStatus === 'running'
            ? 'running'
            : runStatus === 'unknown'
              ? 'unknown'
              : runStatus === 'cancelled'
                ? 'cancelled'
                : runStatus === 'done'
                  ? 'idle'
                  : runStatus === 'error'
                    ? 'unknown'
                    : record.status
    return {
      id: record.id,
      object: 'session',
      create_request_digest: record.createRequestDigest,
      backend: record.backend,
      model: record.model,
      status,
      run_id: run?.id ?? record.runId,
      internal_session_id: control?.session.providerSessionId() ?? record.internalId,
      turns: record.turns,
      created_at: new Date(record.createdAt).toISOString(),
      updated_at: new Date(record.lastUsedAt).toISOString(),
      capabilities: record.capabilities,
      profile_materialization_receipt: record.profileMaterializationReceipt,
      context_boundary: record.contextBoundary,
      ...(run ? { run } : {}),
    }
  }

  runSnapshot(runId: string): DurableRetainedRunSnapshot | null {
    const live = this.runs.get(runId)
    if (live) return live.snapshot()
    const admission = this.store.getRetainedRun(runId)
    if (!admission) return null
    const persisted = retainedRunSnapshot(
      admission.snapshot,
      admission.runId,
      admission.executionId,
      admission.requestDigest,
      admission.sessionId,
      { provider: admission.provider, environmentId: admission.environmentId },
    )
    return persisted.terminal
      ? persisted
      : unknownRunSnapshot(
          admission.runId,
          admission.executionId,
          admission.requestDigest,
          admission.sessionId,
          { provider: admission.provider, environmentId: admission.environmentId },
        )
  }

  /**
   * Turn and close claims are synchronous and mutually exclusive, so a close
   * cannot observe a session between turn ownership and native attachment.
   */
  beginAdmission(id: string): void {
    this.admissions.add(id)
  }

  endAdmission(id: string): void {
    this.admissions.delete(id)
  }

  isAdmitting(id: string): boolean {
    return this.admissions.has(id)
  }

  recordFinalizationFailure(runId: string, failure: Error): void {
    this.finalizationFailures.set(runId, failure)
  }

  hasFinalizationFailure(runId: string): boolean {
    return this.finalizationFailures.has(runId)
  }

  markUnknown(sessionId: string, runId: string, requestDigest: string, run: Run): void {
    try {
      this.store.updateRetainedRun(runId, requestDigest, run.snapshot())
    } catch {
      // Continue to mark the parent session unknown even if the run row failed.
    }
    try {
      const current = this.store.getRetained(sessionId)
      if (current?.runId === runId && current.status !== 'closed' && current.status !== 'cancelled') {
        this.store.updateRetained(sessionId, { status: 'unknown' })
      }
    } catch {
      // The in-memory failure map keeps reads and subsequent turns fail-closed.
    }
  }

  recordUnexpectedNativeClose(sessionId: string, runId: string, requestDigest: string, reason: Error): void {
    const run = this.runs.get(runId)
    if (run) this.markUnknown(sessionId, runId, requestDigest, run)
    else {
      try {
        const current = this.store.getRetained(sessionId)
        if (current?.runId === runId && current.status !== 'closed' && current.status !== 'cancelled') {
          this.store.updateRetained(sessionId, { status: 'unknown' })
        }
      } catch {
        // The in-memory ownership was still cleared; the next read fails closed.
      }
    }
    console.error(`[cli-bridge] retained native session ${JSON.stringify(sessionId)} closed unexpectedly:`, reason)
  }

  updateStatusForRun(sessionId: string, runId: string, status: RetainedSessionStatus): void {
    const current = this.store.getRetained(sessionId)
    if (!current || current.runId !== runId || current.status === 'closed') return
    // Unknown is protective and may replace an optimistic state. All other
    // cancellation outcomes may advance only the still-running owner, never a
    // state written by cleanup, close, or another control path.
    if (status === 'unknown' || current.status === 'running') {
      this.store.updateRetained(sessionId, { status })
    }
  }

  /** The live native child of this session, if one is still owned. */
  nativeControl(sessionId: string): { run: Run; session: NativeSession } | null {
    return this.runs.nativeSession(sessionId)
  }
}

export function unknownRunSnapshot(
  runId: string,
  executionId: string,
  requestDigest: string,
  sessionId: string,
  coordinates: RetainedRunCoordinates,
): DurableRetainedRunSnapshot {
  return {
    id: runId,
    executionId,
    requestDigest,
    status: 'unknown',
    state: 'detached',
    terminal: false,
    sessionId,
    provider: coordinates.provider,
    environmentId: coordinates.environmentId,
  }
}

export function retainedRunSnapshot(
  input: unknown,
  runId: string,
  executionId: string,
  requestDigest: string,
  sessionId: string,
  coordinates: RetainedRunCoordinates,
): DurableRetainedRunSnapshot {
  const value = recordValue(input)
  if (
    !value ||
    value.id !== runId ||
    value.executionId !== executionId ||
    value.requestDigest !== requestDigest ||
    value.sessionId !== sessionId ||
    (value.provider !== undefined && value.provider !== coordinates.provider) ||
    (value.environmentId !== undefined && value.environmentId !== coordinates.environmentId) ||
    !['running', 'done', 'error', 'cancelled', 'unknown'].includes(String(value.status)) ||
    typeof value.terminal !== 'boolean'
  ) {
    throw new RetainedSessionError(
      `retained run ${JSON.stringify(runId)} has an invalid durable admission`,
      500,
      'server_error',
    )
  }
  if (value.status === 'unknown') {
    return unknownRunSnapshot(runId, executionId, requestDigest, sessionId, coordinates)
  }
  return {
    ...structuredClone(value),
    provider: coordinates.provider,
    environmentId: coordinates.environmentId,
  } as unknown as RunSnapshot
}
