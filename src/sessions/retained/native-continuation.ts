/**
 * The Agent Interface native-continuation boundary for retained sessions.
 *
 * This module owns only the HTTP contract and operation ledger. Turn execution,
 * native boundary inspection, event persistence, and finalization remain in
 * their existing retained-session owners.
 */

import {
  AgentExactRunControlRefSchema,
  AgentNativeContextContinuationResultSchema,
  AgentTurnResultSchema,
  NativeContextBoundaryProofSchema,
  NativeContextContinuationRequestSchema,
  NativeContextContinuationTurnSchema,
  agentNativeContextContinuationResultMatchesRequest,
  canonicalCandidateDigest,
  nativeContextContinuationTurnDigest,
  type AgentEnvironmentEvent,
  type AgentNativeContextContinuationResult,
  type AgentTurnResult,
  type NativeContextBoundaryProof,
  type NativeContextContinuationRequest,
  type NativeContextContinuationTurn,
  type TokenUsage,
} from '@tangle-network/agent-interface'
import type { Run, RunRegistry } from '../../runs/registry.js'
import type { RetainedSessionRecord, SessionStore } from '../store.js'
import { assertRetainedBoundaryMatches, RetainedBoundaryError } from './context-boundary.js'
import type { RetainedSessionState } from './state.js'
import type { RetainedTurnInput } from './schema.js'
import { parseTurn } from './schema.js'
import type { RetainedBeginTurnOptions, RetainedTurnRunner } from './turns.js'
import { RetainedSessionError } from './types.js'

export interface ParsedNativeContinuation {
  request: NativeContextContinuationRequest
  turn: NativeContextContinuationTurn
}

export interface NativeContinuationResult {
  outcome: AgentNativeContextContinuationResult
  status: 200 | 400 | 404 | 409 | 501 | 502
}

interface NativeContinuationOptions {
  store: SessionStore
  runs: RunRegistry
  state: RetainedSessionState
  turns: RetainedTurnRunner
  parseTurn?: (value: unknown) => RetainedTurnInput
}

type StoredNativeContinuation =
  | { status: 'pending'; actualBoundary?: NativeContextBoundaryProof }
  | { status: 'completed'; outcome: AgentNativeContextContinuationResult }

const NATIVE_CONTINUATION_KIND = 'native_continuation' as const

export function parseNativeContinuation(value: unknown): ParsedNativeContinuation {
  const body = recordValue(value)
  if (!body || Object.keys(body).some((key) => key !== 'request' && key !== 'turn')) {
    throw new RetainedSessionError(
      'native continuation requires request and turn objects',
      400,
      'invalid_request_error',
    )
  }
  const request = NativeContextContinuationRequestSchema.safeParse(body.request)
  const turn = NativeContextContinuationTurnSchema.safeParse(body.turn)
  if (!request.success || !turn.success) {
    throw new RetainedSessionError(
      'invalid native continuation request or turn',
      400,
      'invalid_request_error',
    )
  }
  if (nativeContextContinuationTurnDigest(turn.data) !== request.data.turnDigest) {
    throw new RetainedSessionError(
      'native continuation turnDigest does not match turn',
      400,
      'invalid_request_error',
    )
  }
  if (turn.data.prompt === undefined && (!turn.data.parts || turn.data.parts.length === 0)) {
    throw new RetainedSessionError(
      'native continuation turn requires a non-empty prompt or parts',
      400,
      'invalid_request_error',
    )
  }
  return { request: request.data, turn: turn.data }
}

export class RetainedNativeContinuation {
  private readonly store: SessionStore
  private readonly runs: RunRegistry
  private readonly state: RetainedSessionState
  private readonly turns: RetainedTurnRunner
  private readonly parseTurnInput: (value: unknown) => RetainedTurnInput
  private readonly inFlight = new Map<string, {
    callerId: string
    requestDigest: string
    sessionId: string
    runId: string
    promise: Promise<NativeContinuationResult>
  }>()

  constructor(options: NativeContinuationOptions) {
    this.store = options.store
    this.runs = options.runs
    this.state = options.state
    this.turns = options.turns
    this.parseTurnInput = options.parseTurn ?? parseTurn
  }

  async continue(
    sessionId: string,
    request: NativeContextContinuationRequest,
    turn: NativeContextContinuationTurn,
    options: { signal?: AbortSignal; callerId?: string } = {},
  ): Promise<NativeContinuationResult> {
    const runId = continuationRunId(request.operationId)
    const callerId = options.callerId ?? canonicalCandidateDigest('loopback')
    const existingFlight = this.inFlight.get(request.operationId)
    if (existingFlight) {
      if (
        existingFlight.callerId === callerId &&
        existingFlight.requestDigest === request.requestDigest &&
        existingFlight.sessionId === sessionId &&
        existingFlight.runId === runId
      ) {
        return existingFlight.promise
      }
      return this.conflict(request, sessionId, runId, existingFlight.requestDigest)
    }

    const existing = this.store.getRetainedControlOperation(request.operationId)
    if (existing) {
      const mismatch = this.operationMismatch(existing, request, sessionId, runId, callerId)
      if (mismatch) return this.conflict(request, sessionId, runId, existing.requestDigest)
      const recovered = await this.recoverExisting(existing.acknowledgement, request, turn, sessionId, runId)
      if (recovered) return recovered
    }

    const retained = this.store.getRetained(sessionId)
    if (retained && turn.model !== undefined && turn.model !== retained.model) {
      throw new RetainedSessionError(
        `native continuation cannot change retained model from ${JSON.stringify(retained.model)} to ${JSON.stringify(turn.model)}`,
        400,
        'invalid_request_error',
      )
    }

    const promise = Promise.resolve().then(() =>
      this.execute({
        sessionId,
        request,
        turn,
        runId,
        callerId,
        signal: options.signal,
      }),
    )
    this.inFlight.set(request.operationId, {
      callerId,
      requestDigest: request.requestDigest,
      sessionId,
      runId,
      promise,
    })
    try {
      return await promise
    } finally {
      if (this.inFlight.get(request.operationId)?.promise === promise) this.inFlight.delete(request.operationId)
    }
  }

  private async execute(input: {
    sessionId: string
    request: NativeContextContinuationRequest
    turn: NativeContextContinuationTurn
    runId: string
    callerId: string
    signal?: AbortSignal
  }): Promise<NativeContinuationResult> {
    const pending: StoredNativeContinuation = { status: 'pending' }
    let observedBoundary: NativeContextBoundaryProof | undefined
    try {
      const inserted = this.store.recordRetainedControlOperation({
        operationId: input.request.operationId,
        callerId: input.callerId,
        kind: NATIVE_CONTINUATION_KIND,
        runId: input.runId,
        sessionId: input.sessionId,
        requestDigest: input.request.requestDigest,
        acknowledgement: pending,
      })
      if (!inserted) {
        const existing = this.store.getRetainedControlOperation(input.request.operationId)
        if (!existing) return this.transportFailure(input.request, 'native continuation operation was not persisted')
        if (this.operationMismatch(existing, input.request, input.sessionId, input.runId, input.callerId)) {
          return this.conflict(input.request, input.sessionId, input.runId, existing.requestDigest)
        }
        const recovered = await this.recoverExisting(
          existing.acknowledgement,
          input.request,
          input.turn,
          input.sessionId,
          input.runId,
        )
        if (recovered) return recovered
        return this.transportFailure(input.request, 'native continuation operation has no recoverable state')
      }

      const preflight = this.preflight(input.sessionId, input.request)
      if (preflight) return this.settle(input.request, input.runId, preflight)

      let admitted: { run: { id: string; requestDigest: string } }
      try {
        admitted = await this.turns.beginTurn(
          input.sessionId,
          this.turnInput(input),
          this.beginOptions(input, proof => {
            observedBoundary = sourceRunBoundary(input.request.run, proof)
            if (!this.store.updateRetainedControlOperation(input.request.operationId, input.request.requestDigest, {
              status: 'pending',
              actualBoundary: observedBoundary,
            })) {
              throw new Error('native continuation boundary proof was not persisted before admission')
            }
          }),
        )
      } catch (error) {
        return this.settle(input.request, input.runId, this.failureForError(input, error))
      }
      if (admitted.run.id !== input.runId) {
        return this.settle(input.request, input.runId, this.transportFailure(
          input.request,
          'native continuation was admitted under a different run id',
        ).outcome)
      }

      try {
        await this.turns.waitForRun(input.runId)
      } catch (error) {
        const terminal = await this.acceptedIfDurable(input.sessionId, input.request, input.runId, observedBoundary)
        if (terminal) return this.settle(input.request, input.runId, terminal)
        return this.settle(input.request, input.runId, this.failureForError(input, error))
      }
      const outcome = await this.acceptedIfDurable(input.sessionId, input.request, input.runId, observedBoundary)
      return this.settle(
        input.request,
        input.runId,
        outcome ?? this.transportFailure(input.request, 'native continuation ended without a durable run result').outcome,
      )
    } catch (error) {
      return this.settle(
        input.request,
        input.runId,
        this.transportFailure(input.request, error instanceof Error ? error.message : String(error)).outcome,
      )
    }
  }

  private preflight(
    sessionId: string,
    request: NativeContextContinuationRequest,
  ): AgentNativeContextContinuationResult | null {
    let retained: RetainedSessionRecord
    try {
      retained = this.state.require(sessionId)
    } catch (error) {
      if (error instanceof RetainedSessionError && error.code === 'not_found_error') {
        return this.unknownSession(request, 'retained session does not exist')
      }
      throw error
    }
    if (request.run.sessionId !== sessionId) {
      return this.conflict(request, sessionId, continuationRunId(request.operationId), this.existingDigest(request, retained))
        .outcome
    }
    const admission = this.store.getRetainedRun(request.run.runId)
    if (
      !admission ||
      admission.sessionId !== sessionId ||
      admission.executionId !== request.run.executionId ||
      admission.requestDigest !== request.run.requestDigest ||
      admission.provider !== request.run.provider ||
      admission.environmentId !== request.run.environmentId ||
      retained.runId !== request.run.runId
    ) {
      return this.conflict(
        request,
        sessionId,
        continuationRunId(request.operationId),
        this.existingDigest(request, retained, admission?.requestDigest),
      ).outcome
    }
    if (retained.status === 'closed' || retained.status === 'cancelled' || retained.status === 'unknown') {
      return this.unknownSession(request, `retained session is ${retained.status}`)
    }
    try {
      assertRetainedBoundaryMatches(retained, request.expectedBoundary)
    } catch (error) {
      return this.failureForError({
        sessionId,
        request,
        runId: continuationRunId(request.operationId),
      }, error)
    }
    if (!this.runs.nativeSession(sessionId)) {
      return this.unknownSession(request, 'native session was lost across bridge restart')
    }
    return null
  }

  private turnInput(input: {
    sessionId: string
    request: NativeContextContinuationRequest
    turn: NativeContextContinuationTurn
    runId: string
  }): RetainedTurnInput {
    return this.parseTurnInput({
      ...(input.turn.prompt === undefined ? {} : { message: input.turn.prompt }),
      ...(input.turn.parts === undefined ? {} : { parts: input.turn.parts }),
      run_id: input.runId,
      execution_id: input.runId,
      provider: input.request.run.provider,
      environment_id: input.request.run.environmentId,
      ...(input.turn.context === undefined ? {} : { context: input.turn.context }),
      ...(input.turn.providerOptions === undefined ? {} : { provider_options: input.turn.providerOptions }),
    })
  }

  private beginOptions(input: {
    request: NativeContextContinuationRequest
    signal?: AbortSignal
  }, onBoundaryVerified: (proof: NativeContextBoundaryProof) => void): RetainedBeginTurnOptions {
    return {
      queue: true,
      ...(input.signal ? { signal: input.signal } : {}),
      expectedContextBoundary: input.request.expectedBoundary,
      onBoundaryVerified,
    }
  }

  private async recoverExisting(
    stored: Record<string, unknown>,
    request: NativeContextContinuationRequest,
    turn: NativeContextContinuationTurn,
    sessionId: string,
    runId: string,
  ): Promise<NativeContinuationResult | null> {
    const decoded = decodeStoredContinuation(stored)
    if (!decoded) return this.transportFailure(request, 'stored native continuation outcome is invalid')
    if (decoded.status === 'completed') return this.responseForReplay(decoded.outcome)

    const live = this.runs.get(runId)
    const durable = this.store.getRetainedRun(runId)
    if (!live && (!durable || !isTerminalSnapshot(durable.snapshot))) {
      return this.settle(request, runId, this.unknownSession(
        request,
        'the server restarted after native continuation admission; the operation will not be repeated',
      ))
    }
    if (live && !live.snapshot().terminal) {
      try {
        await this.turns.waitForRun(runId)
      } catch {
        // The durable snapshot below decides whether the result is recoverable.
      }
    }
    const outcome = await this.acceptedIfDurable(sessionId, request, runId, decoded.actualBoundary)
    if (outcome) {
      const settled = await this.settle(request, runId, outcome)
      return settled.outcome.acknowledgement.status === 'accepted'
        ? this.responseForReplay(settled.outcome)
        : settled
    }
    void turn
    return this.settle(request, runId, this.transportFailure(
      request,
      'native continuation was admitted but its terminal result is not durable',
    ).outcome)
  }

  private async acceptedIfDurable(
    sessionId: string,
    request: NativeContextContinuationRequest,
    runId: string,
    actualBoundary?: NativeContextBoundaryProof,
  ): Promise<AgentNativeContextContinuationResult | null> {
    if (!actualBoundary) return null
    const admission = this.store.getRetainedRun(runId)
    if (!admission || admission.sessionId !== sessionId) return null
    const live = this.runs.get(runId)
    const snapshot = live?.snapshot() ?? this.state.runSnapshot(runId)
    if (!snapshot || !snapshot.terminal || snapshot.status === 'unknown') return null

    const result = this.turnResult(sessionId, runId, snapshot, live)
    const controlRef = AgentExactRunControlRefSchema.parse({
      runId,
      provider: admission.provider,
      environmentId: admission.environmentId,
      sessionId,
      executionId: admission.executionId,
      requestDigest: admission.requestDigest,
    })
    const acknowledgement = {
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      status: 'accepted' as const,
      historyMessagesSent: 0,
      actualBoundary,
    }
    const outcome = AgentNativeContextContinuationResultSchema.parse({
      acknowledgement,
      result,
      controlRef,
    })
    if (!agentNativeContextContinuationResultMatchesRequest(request, outcome)) {
      throw new Error('native continuation result failed its exact Agent Interface binding')
    }
    return outcome
  }

  private turnResult(
    sessionId: string,
    runId: string,
    snapshot: { status: string; requestDigest: string; executionId?: string },
    live: Run | undefined,
  ): AgentTurnResult {
    const retained = this.store.retainedEventsAfterRun(sessionId, runId)
    const events = retained.map(item => environmentEvent(item.envelope.event))
    let text = ''
    const textParts = new Map<string, string>()
    let usage: TokenUsage | undefined
    for (const event of events) {
      const normalized = event.normalized
      const part = normalized?.type === 'message.part.updated'
        ? normalized.part
        : recordValue(event.data.part)
      if (recordValue(part)?.type === 'text' && typeof recordValue(part)?.text === 'string') {
        textParts.set(String(recordValue(part)!.id ?? textParts.size), String(recordValue(part)!.text))
        text = [...textParts.values()].join('')
      } else if (typeof event.data.finalText === 'string') {
        text = event.data.finalText
      } else if (typeof event.data.delta === 'string') {
        text += event.data.delta
      }
      usage = addTokenUsage(usage, event.usage)
    }
    const failure = live?.failure()
    return AgentTurnResultSchema.parse({
      text,
      success: snapshot.status === 'done',
      ...(snapshot.status === 'done'
        ? {}
        : { error: failure instanceof Error ? failure.message : `retained run ended with status ${snapshot.status}` }),
      sessionId,
      ...(usage ? { usage } : {}),
      metadata: {
        runId,
        executionId: snapshot.executionId ?? runId,
        requestDigest: snapshot.requestDigest,
        status: snapshot.status,
      },
      events,
    })
  }

  private async settle(
    request: NativeContextContinuationRequest,
    runId: string,
    outcome: AgentNativeContextContinuationResult,
  ): Promise<NativeContinuationResult> {
    const parsed = AgentNativeContextContinuationResultSchema.parse(outcome)
    try {
      this.store.updateRetainedControlOperation(request.operationId, request.requestDigest, {
        status: 'completed',
        outcome: parsed,
      })
    } catch (error) {
      return this.transportFailure(
        request,
        `native continuation outcome could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const stored = this.store.getRetainedControlOperation(request.operationId)
    const decoded = stored ? decodeStoredContinuation(stored.acknowledgement) : null
    if (!decoded || decoded.status !== 'completed') {
      return this.transportFailure(request, 'native continuation outcome disappeared after persistence')
    }
    void runId
    return this.responseForOutcome(decoded.outcome, decoded.outcome.acknowledgement.status === 'accepted')
  }

  private responseForReplay(outcome: AgentNativeContextContinuationResult): NativeContinuationResult {
    const parsed = AgentNativeContextContinuationResultSchema.parse(outcome)
    if (parsed.acknowledgement.status !== 'accepted') return this.responseForOutcome(parsed, false)
    const replayed = AgentNativeContextContinuationResultSchema.parse({
      ...parsed,
      acknowledgement: { ...parsed.acknowledgement, status: 'replayed' as const },
    })
    return this.responseForOutcome(replayed, true)
  }

  private responseForOutcome(
    outcome: AgentNativeContextContinuationResult,
    _replayed: boolean,
  ): NativeContinuationResult {
    const status = outcome.acknowledgement.status
    return {
      outcome,
      status: status === 'accepted' || status === 'replayed'
        ? 200
        : status === 'unknown_session'
          ? 404
          : status === 'unverified'
            ? 501
            : status === 'transport_failure'
              ? 502
              : 409,
    }
  }

  private failureForError(
    input: { sessionId: string; request: NativeContextContinuationRequest; runId: string },
    error: unknown,
  ): AgentNativeContextContinuationResult {
    if (error instanceof RetainedBoundaryError) {
      return error.failure === 'boundary_mismatch' && error.actualBoundary
        ? this.boundaryMismatch(input.request, sourceRunBoundary(input.request.run, error.actualBoundary))
        : this.unverified(input.request, error.message)
    }
    if (error instanceof RetainedSessionError) {
      if (error.code === 'run_identity_conflict') {
        return this.conflict(input.request, input.sessionId, input.runId, this.existingDigest(input.request, this.store.getRetained(input.sessionId))).outcome
      }
      if (error.code === 'unknown_session' || error.code === 'not_found_error') {
        return this.unknownSession(input.request, error.message)
      }
      if (error.code === 'capability_denied') return this.unverified(input.request, error.message)
    }
    return this.transportFailure(input.request, error instanceof Error ? error.message : String(error)).outcome
  }

  private operationMismatch(
    existing: { callerId: string; kind: string; sessionId: string; runId: string; requestDigest: string },
    request: NativeContextContinuationRequest,
    sessionId: string,
    runId: string,
    callerId: string,
  ): boolean {
    return existing.callerId !== callerId
      || existing.kind !== NATIVE_CONTINUATION_KIND
      || existing.sessionId !== sessionId
      || existing.runId !== runId
      || existing.requestDigest !== request.requestDigest
  }

  private conflict(
    request: NativeContextContinuationRequest,
    sessionId: string,
    runId: string,
    existingRequestDigest: string,
  ): NativeContinuationResult {
    const existing = ensureDifferentDigest(request.requestDigest, existingRequestDigest)
    return this.responseForOutcome(AgentNativeContextContinuationResultSchema.parse({
      acknowledgement: {
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        status: 'conflict',
        historyMessagesSent: 0,
        existingRequestDigest: existing,
        message: `native continuation is not bound to session ${JSON.stringify(sessionId)} and run ${JSON.stringify(runId)}`,
      },
    }), false)
  }

  private boundaryMismatch(
    request: NativeContextContinuationRequest,
    actualBoundary: NativeContextBoundaryProof,
  ): AgentNativeContextContinuationResult {
    return AgentNativeContextContinuationResultSchema.parse({
      acknowledgement: {
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        status: 'boundary_mismatch',
        historyMessagesSent: 0,
        actualBoundary,
        message: 'native continuation expected a different context boundary',
      },
    })
  }

  private unverified(request: NativeContextContinuationRequest, message: string): AgentNativeContextContinuationResult {
    return AgentNativeContextContinuationResultSchema.parse({
      acknowledgement: {
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        status: 'unverified',
        historyMessagesSent: 0,
        message,
      },
    })
  }

  private unknownSession(request: NativeContextContinuationRequest, message: string): AgentNativeContextContinuationResult {
    return AgentNativeContextContinuationResultSchema.parse({
      acknowledgement: {
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        status: 'unknown_session',
        historyMessagesSent: 0,
        message,
      },
    })
  }

  private transportFailure(request: NativeContextContinuationRequest, message: string): NativeContinuationResult {
    return this.responseForOutcome(AgentNativeContextContinuationResultSchema.parse({
      acknowledgement: {
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        status: 'transport_failure',
        historyMessagesSent: 0,
        message: message.slice(0, 4_000) || 'native continuation transport failed',
        retryable: true,
      },
    }), false)
  }

  private existingDigest(
    request: NativeContextContinuationRequest,
    retained: RetainedSessionRecord | null,
    admissionDigest?: string,
  ): string {
    const proof = retained?.contextBoundary
    const parsed = proof ? NativeContextBoundaryProofSchema.safeParse(proof) : null
    const candidate = parsed?.success
      ? parsed.data.requestDigest
      : admissionDigest ?? request.run.requestDigest
    return ensureDifferentDigest(request.requestDigest, candidate)
  }
}

function decodeStoredContinuation(value: Record<string, unknown>): StoredNativeContinuation | null {
  if (value.status === 'pending') {
    if (value.actualBoundary === undefined) return { status: 'pending' }
    const actualBoundary = NativeContextBoundaryProofSchema.safeParse(value.actualBoundary)
    return actualBoundary.success ? { status: 'pending', actualBoundary: actualBoundary.data } : null
  }
  if (value.status !== 'completed') return null
  const outcome = AgentNativeContextContinuationResultSchema.safeParse(value.outcome)
  return outcome.success ? { status: 'completed', outcome: outcome.data } : null
}

function continuationRunId(operationId: string): string {
  return `native-continuation:${canonicalCandidateDigest({ operationId })}`
}

function sourceRunBoundary(
  run: NativeContextContinuationRequest['run'],
  observed: NativeContextBoundaryProof,
): NativeContextBoundaryProof {
  return NativeContextBoundaryProofSchema.parse({
    ...run,
    boundary: observed.boundary,
    observedAt: observed.observedAt,
  })
}

function isTerminalSnapshot(value: unknown): boolean {
  return Boolean(recordValue(value)?.terminal === true && recordValue(value)?.status !== 'unknown')
}

function ensureDifferentDigest(requestDigest: string, candidate: string): `sha256:${string}` {
  const value = /^sha256:[a-f0-9]{64}$/u.test(candidate) ? candidate : canonicalCandidateDigest({ existing: candidate })
  return value === requestDigest
    ? canonicalCandidateDigest({ existing: candidate, request: 'different' })
    : value as `sha256:${string}`
}

function environmentEvent(event: { type: string; [key: string]: unknown }): AgentEnvironmentEvent {
  const raw = event.type === 'raw' ? event.event : undefined
  const rawRecord = recordValue(raw)
  if (rawRecord?.type === 'usage' && recordValue(rawRecord.usage)) {
    return rawRecord as unknown as AgentEnvironmentEvent
  }
  return {
    type: event.type,
    data: event,
    normalized: event as never,
    ...(event.type === 'raw' ? { providerEvent: raw } : {}),
  }
}

function addTokenUsage(current: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  if (!next) return current
  if (!current) return { ...next }
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    ...(current.totalTokens !== undefined || next.totalTokens !== undefined
      ? { totalTokens: (current.totalTokens ?? 0) + (next.totalTokens ?? 0) }
      : {}),
    ...(current.cacheReadInputTokens !== undefined || next.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: (current.cacheReadInputTokens ?? 0) + (next.cacheReadInputTokens ?? 0) }
      : {}),
    ...(current.cacheCreationInputTokens !== undefined || next.cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens: (current.cacheCreationInputTokens ?? 0) + (next.cacheCreationInputTokens ?? 0) }
      : {}),
    ...(current.reasoningTokens !== undefined || next.reasoningTokens !== undefined
      ? { reasoningTokens: (current.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0) }
      : {}),
    ...(current.cost !== undefined || next.cost !== undefined
      ? { cost: (current.cost ?? 0) + (next.cost ?? 0) }
      : {}),
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
