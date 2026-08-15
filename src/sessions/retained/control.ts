/**
 * Steer and cancel against an exactly-identified retained run.
 *
 * Both are idempotent on `operationId`: the operation is recorded durably as
 * `pending` before anything is attempted, so a replay of the same bytes
 * returns the recorded answer and a replay of different bytes under the same
 * id is a conflict. Neither accepts a run reference the durable admission does
 * not confirm — a control command aimed at a run this session no longer owns
 * must not reach a provider.
 */

import {
  canonicalCandidateDigest,
  type AgentRunCancellationRequest,
  type AgentRunControlRef,
} from '@tangle-network/agent-interface'
import type { NativeSession } from '../../backends/types.js'
import { RunInteractionCancelledError, type Run, type RunRegistry } from '../../runs/registry.js'
import type { SessionStore } from '../store.js'
import { controlConflict, statusForControlAcknowledgement } from './control-acknowledgement.js'
import type { RetainedSessionState } from './state.js'
import { ENVIRONMENT_ID, type RetainedControlAcknowledgement } from './types.js'

type ControlResult = { acknowledgement: RetainedControlAcknowledgement; status: number }

class SteerAdmissionLostError extends Error {
  constructor() {
    super('the exact retained run changed before steering was sent')
    this.name = 'SteerAdmissionLostError'
  }
}

export class RetainedControl {
  private readonly inFlight = new Map<string, { requestDigest: string; promise: Promise<ControlResult> }>()

  constructor(
    private readonly store: SessionStore,
    private readonly runs: RunRegistry,
    private readonly state: RetainedSessionState,
  ) {}

  async steer(
    id: string,
    input: { operationId: string; message: string; run: AgentRunControlRef },
    callerId: string,
  ): Promise<ControlResult> {
    this.state.require(id)
    const runId = input.run.runId
    const admission = this.store.getRetainedRun(runId)
    if (
      input.run.provider !== ENVIRONMENT_ID ||
      input.run.environmentId !== ENVIRONMENT_ID ||
      input.run.sessionId !== id ||
      !admission ||
      admission.sessionId !== id ||
      admission.executionId !== input.run.executionId ||
      admission.requestDigest !== input.run.requestDigest
    ) {
      return { acknowledgement: controlConflict(input.operationId, 'steer', id, runId), status: 409 }
    }
    const requestDigest = canonicalCandidateDigest({
      callerId,
      kind: 'steer',
      sessionId: id,
      run: input.run,
      prompt: input.message,
    })
    return this.once(input.operationId, requestDigest, 'steer', id, runId, () =>
      this.executeSteer({
        id,
        prompt: input.message,
        operationId: input.operationId,
        callerId,
        runRef: input.run,
        requestDigest,
      }),
    )
  }

  async cancel(
    id: string,
    waitMs: number,
    request: AgentRunCancellationRequest,
    callerId: string,
  ): Promise<ControlResult> {
    const operationId = request.operationId
    const runId = request.run.runId
    this.state.require(id)
    const admission = runId ? this.store.getRetainedRun(runId) : null
    const liveRun = runId ? this.runs.get(runId) : null
    if (
      request.run.provider !== ENVIRONMENT_ID ||
      request.run.environmentId !== ENVIRONMENT_ID ||
      request.run.sessionId !== id ||
      !admission ||
      admission.executionId !== request.run.executionId ||
      admission.sessionId !== id ||
      admission.requestDigest !== request.run.requestDigest
    ) {
      return {
        acknowledgement: controlConflict(
          operationId,
          'cancel',
          id,
          runId,
          (admission?.requestDigest ?? liveRun?.snapshot().requestDigest) as `sha256:${string}` | undefined,
        ),
        status: 409,
      }
    }
    const requestDigest = canonicalCandidateDigest({ callerId, kind: 'cancel', request })
    return this.once(operationId, requestDigest, 'cancel', id, runId, () =>
      this.executeCancel({ id, operationId, callerId, runId, requestDigest, waitMs }),
    )
  }

  /** Collapse concurrent and replayed operations onto one durable outcome. */
  private async once(
    operationId: string,
    requestDigest: string,
    kind: 'steer' | 'cancel',
    sessionId: string,
    runId: string,
    execute: () => Promise<ControlResult>,
  ): Promise<ControlResult> {
    const inFlight = this.inFlight.get(operationId)
    if (inFlight) {
      if (inFlight.requestDigest === requestDigest) return inFlight.promise
      return {
        acknowledgement: controlConflict(
          operationId,
          kind,
          sessionId,
          runId,
          inFlight.requestDigest as `sha256:${string}`,
        ),
        status: 409,
      }
    }
    const existing = this.existingAcknowledgement(operationId, requestDigest, kind, sessionId, runId)
    if (existing) return existing
    const promise = execute()
    this.inFlight.set(operationId, { requestDigest, promise })
    try {
      return await promise
    } finally {
      if (this.inFlight.get(operationId)?.promise === promise) this.inFlight.delete(operationId)
    }
  }

  /**
   * Reconcile an operation recorded by an earlier process. A `pending` record
   * that outlived its process cannot be resumed, so it is settled from the
   * run's real outcome or reported as an unrepeatable unknown effect.
   */
  private existingAcknowledgement(
    operationId: string,
    requestDigest: string,
    kind: 'steer' | 'cancel',
    sessionId: string,
    runId: string,
  ): ControlResult | null {
    const existing = this.store.getRetainedControlOperation(operationId)
    if (!existing) return null
    if (
      existing.requestDigest !== requestDigest ||
      existing.kind !== kind ||
      existing.sessionId !== sessionId ||
      existing.runId !== runId
    ) {
      return {
        acknowledgement: controlConflict(
          operationId,
          kind,
          sessionId,
          runId,
          existing.requestDigest as `sha256:${string}`,
        ),
        status: 409,
      }
    }
    const persisted = existing.acknowledgement as RetainedControlAcknowledgement
    if (persisted.status === 'pending') {
      const control = this.runs.nativeSession(sessionId)
      const snapshot = control?.run.id === runId ? control.run.snapshot() : this.state.runSnapshot(runId)
      const acknowledgement: RetainedControlAcknowledgement =
        kind === 'cancel' && snapshot?.terminal
          ? {
              ...persisted,
              status:
                snapshot.status === 'unknown'
                  ? 'effect_unknown'
                  : snapshot.status === 'cancelled'
                    ? 'cancelled'
                    : 'already_terminal',
              ...(snapshot.status === 'cancelled'
                ? {}
                : snapshot.status === 'unknown'
                  ? { message: 'the cancellation effect is unknown', retryable: false }
                  : { message: `run ended with status ${snapshot.status}` }),
            }
          : {
              ...persisted,
              status: 'effect_unknown',
              message: 'the server restarted after admitting this operation; its effect will not be repeated',
              retryable: false,
            }
      this.store.updateRetainedControlOperation(operationId, requestDigest, acknowledgement)
      const reconciled = this.store.getRetainedControlOperation(operationId)
      const durable = (reconciled?.acknowledgement ?? acknowledgement) as RetainedControlAcknowledgement
      return { acknowledgement: durable, status: statusForControlAcknowledgement(durable) }
    }
    return {
      acknowledgement: persisted,
      status: statusForControlAcknowledgement(persisted),
    }
  }

  private async executeSteer(input: {
    id: string
    prompt: string
    operationId: string
    callerId: string
    runRef: AgentRunControlRef
    requestDigest: string
  }): Promise<ControlResult> {
    const pending: RetainedControlAcknowledgement = {
      operationId: input.operationId,
      kind: 'steer',
      sessionId: input.id,
      runId: input.runRef.runId,
      status: 'pending',
    }
    this.store.recordRetainedControlOperation({
      operationId: input.operationId,
      callerId: input.callerId,
      kind: 'steer',
      runId: input.runRef.runId,
      sessionId: input.id,
      requestDigest: input.requestDigest,
      acknowledgement: pending,
    })
    const control = this.exactSteerControl(input.id, input.runRef)
    if (!control) {
      const acknowledgement: RetainedControlAcknowledgement = {
        ...pending,
        status: this.durableSteerRefMatches(input.id, input.runRef) ? 'unknown_run' : 'conflict',
        message: this.durableSteerRefMatches(input.id, input.runRef)
          ? 'active run is unknown'
          : 'run reference is not the durable admission for this session',
        retryable: false,
      }
      this.store.updateRetainedControlOperation(input.operationId, input.requestDigest, acknowledgement)
      return { acknowledgement, status: acknowledgement.status === 'unknown_run' ? 404 : 409 }
    }
    try {
      await control.run.withNativeControl(async (native) => {
        const current = this.exactSteerControl(input.id, input.runRef)
        if (!current || current.run !== control.run || current.session !== native) throw new SteerAdmissionLostError()
        await native.steer!(input.prompt)
      })
      const acknowledgement: RetainedControlAcknowledgement = { ...pending, status: 'accepted' }
      this.store.updateRetainedControlOperation(input.operationId, input.requestDigest, acknowledgement)
      return { acknowledgement, status: 200 }
    } catch (error) {
      const acknowledgement: RetainedControlAcknowledgement = {
        ...pending,
        status:
          error instanceof RunInteractionCancelledError
            ? 'cancelled'
            : error instanceof SteerAdmissionLostError
              ? 'conflict'
              : 'effect_unknown',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      }
      this.store.updateRetainedControlOperation(input.operationId, input.requestDigest, acknowledgement)
      return {
        acknowledgement,
        status: error instanceof RunInteractionCancelledError || error instanceof SteerAdmissionLostError ? 409 : 502,
      }
    }
  }

  private durableSteerRefMatches(id: string, ref: AgentRunControlRef): boolean {
    const record = this.store.getRetained(id)
    const admission = this.store.getRetainedRun(ref.runId)
    return Boolean(
      record &&
        ref.provider === ENVIRONMENT_ID &&
        ref.environmentId === ENVIRONMENT_ID &&
        ref.sessionId === id &&
        ref.executionId &&
        ref.requestDigest &&
        admission &&
        admission.sessionId === id &&
        admission.executionId === ref.executionId &&
        admission.requestDigest === ref.requestDigest,
    )
  }

  private exactSteerControl(id: string, ref: AgentRunControlRef): { run: Run; session: NativeSession } | null {
    if (!this.durableSteerRefMatches(id, ref)) return null
    const control = this.runs.nativeSession(id)
    if (!control || control.run.id !== ref.runId || control.run.snapshot().terminal || !control.session.steer)
      return null
    const snapshot = control.run.snapshot()
    if (
      snapshot.sessionId !== id ||
      snapshot.executionId !== ref.executionId ||
      snapshot.requestDigest !== ref.requestDigest
    )
      return null
    return control
  }

  private async executeCancel(input: {
    id: string
    operationId: string
    callerId: string
    runId: string
    requestDigest: string
    waitMs: number
  }): Promise<ControlResult> {
    const pending: RetainedControlAcknowledgement = {
      operationId: input.operationId,
      kind: 'cancel',
      sessionId: input.id,
      runId: input.runId,
      status: 'pending',
    }
    this.store.recordRetainedControlOperation({
      operationId: input.operationId,
      callerId: input.callerId,
      kind: 'cancel',
      runId: input.runId,
      sessionId: input.id,
      requestDigest: input.requestDigest,
      acknowledgement: pending,
    })
    const retained = this.store.getRetained(input.id)
    const control = this.runs.nativeSession(input.id)
    const ownsCurrentRun = retained?.runId === input.runId && retained.status !== 'closed'
    const run = ownsCurrentRun ? (control?.run.id === input.runId ? control.run : this.runs.get(input.runId)) : null
    if (!run || run.sessionId !== input.id) {
      return this.cancelWithoutLiveRun(input, pending)
    }
    const cancellation = run.requestNativeCancellation()
    if (input.waitMs > 0 && !run.snapshot().terminal) {
      try {
        await Promise.race([
          cancellation.then(async () => {
            await run.whenTerminal()
          }),
          new Promise<void>((resolve) => setTimeout(resolve, input.waitMs)),
        ])
      } catch (error) {
        const acknowledgement: RetainedControlAcknowledgement = {
          ...pending,
          status: 'effect_unknown',
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        }
        this.store.updateRetainedControlOperation(input.operationId, input.requestDigest, acknowledgement)
        this.state.updateStatusForRun(input.id, input.runId, 'unknown')
        return { acknowledgement, status: 502 }
      }
    }
    const snapshot = run.snapshot()
    this.store.updateRetainedRun(input.runId, snapshot.requestDigest, snapshot)
    const status =
      snapshot.status === 'unknown'
        ? 'effect_unknown'
        : snapshot.status === 'cancelled'
          ? 'cancelled'
          : snapshot.terminal
            ? 'already_terminal'
            : 'pending'
    const acknowledgement: RetainedControlAcknowledgement = {
      ...pending,
      status,
      ...(status === 'already_terminal' ? { message: `run ended with status ${snapshot.status}` } : {}),
      ...(status === 'effect_unknown' ? { message: 'the cancellation effect is unknown', retryable: false } : {}),
    }
    this.store.updateRetainedControlOperation(input.operationId, input.requestDigest, acknowledgement)
    this.state.updateStatusForRun(
      input.id,
      input.runId,
      snapshot.status === 'cancelled'
        ? 'cancelled'
        : snapshot.status === 'done'
          ? 'idle'
          : snapshot.terminal
            ? 'unknown'
            : 'running',
    )
    if (status === 'pending') this.settleCancelWhenTerminal(input, pending, run, cancellation)
    return { acknowledgement, status: status === 'pending' ? 202 : status === 'effect_unknown' ? 502 : 200 }
  }

  /** The run this cancellation names is not live here; answer from durable state. */
  private cancelWithoutLiveRun(
    input: { id: string; operationId: string; runId: string; requestDigest: string },
    pending: RetainedControlAcknowledgement,
  ): ControlResult {
    const durable = this.state.runSnapshot(input.runId)
    const status =
      durable?.status === 'unknown'
        ? 'effect_unknown'
        : durable?.terminal
          ? durable.status === 'cancelled'
            ? 'cancelled'
            : 'already_terminal'
          : 'unknown_run'
    const acknowledgement: RetainedControlAcknowledgement = {
      ...pending,
      status,
      ...(status === 'already_terminal'
        ? { message: `run ended with status ${durable!.status}` }
        : status === 'effect_unknown'
          ? { message: 'the run outcome is unknown', retryable: false }
          : status === 'unknown_run'
            ? { message: 'active run is unknown', retryable: false }
            : {}),
    }
    this.store.updateRetainedControlOperation(input.operationId, input.requestDigest, acknowledgement)
    if (status === 'unknown_run' || status === 'effect_unknown') {
      this.state.updateStatusForRun(input.id, input.runId, 'unknown')
    }
    return { acknowledgement, status: status === 'unknown_run' ? 404 : status === 'effect_unknown' ? 502 : 200 }
  }

  /** A 202 promises a later durable answer; write it when the run really ends. */
  private settleCancelWhenTerminal(
    input: { id: string; operationId: string; runId: string; requestDigest: string },
    pending: RetainedControlAcknowledgement,
    run: Run,
    cancellation: Promise<boolean>,
  ): void {
    void cancellation
      .then(async () => run.whenTerminal())
      .then(() => {
        const settled = run.snapshot()
        this.store.updateRetainedRun(input.runId, settled.requestDigest, settled)
        const terminalAcknowledgement: RetainedControlAcknowledgement = {
          ...pending,
          status:
            settled.status === 'unknown'
              ? 'effect_unknown'
              : settled.status === 'cancelled'
                ? 'cancelled'
                : 'already_terminal',
          ...(settled.status === 'unknown'
            ? { message: 'the cancellation effect is unknown', retryable: false }
            : settled.status !== 'cancelled'
              ? { message: `run ended with status ${settled.status}` }
              : {}),
        }
        this.store.updateRetainedControlOperation(input.operationId, input.requestDigest, terminalAcknowledgement)
        if (settled.status === 'unknown') this.state.updateStatusForRun(input.id, input.runId, 'unknown')
      })
      .catch((error) => {
        const unknown: RetainedControlAcknowledgement = {
          ...pending,
          status: 'effect_unknown',
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        }
        this.store.updateRetainedControlOperation(input.operationId, input.requestDigest, unknown)
        this.state.updateStatusForRun(input.id, input.runId, 'unknown')
      })
  }
}
