import { streamSSE } from 'hono/streaming'
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { BackendRegistry } from '../backends/registry.js'
import type { Backend, ChatRequest, NativeSession, NativeSessionBackend } from '../backends/types.js'
import { BackendError } from '../backends/types.js'
import {
  AgentEnvironmentCapabilitiesSchema,
  AgentRunControlRefSchema,
  AgentRunCancellationAcknowledgementSchema,
  AgentRunCancellationRequestSchema,
  DurablePlanSchema,
  NativeContextBoundaryProofSchema,
  type AgentEnvironmentCapabilities,
  type AgentRunControlRef,
  type AgentEnvironmentEvent,
  type AgentRunCancellationAcknowledgement,
  type AgentRunCancellationRequest,
  type DurablePlan,
  type NativeContextBoundaryProof,
  type InteractionAcknowledgement,
  InteractionRequestSchema,
  InteractionResponseCommandSchema,
  type InteractionResponse,
  type InteractionRequest,
  type InteractionResponseCommand,
  canonicalCandidateDigest,
  canonicalCandidateJson,
  normalizeInputParts,
  renderInputPartsAsText,
  agentRunCancellationAcknowledgementMatchesRequest,
  validateInteractionResponse,
  permissionAnswerSpec,
  type Part,
  type ToolState,
  type StreamEvent,
} from '@tangle-network/agent-interface'
import type { Run, RunRegistry, RunSnapshot } from '../runs/registry.js'
import { RunIdentityConflictError, RunInteractionCancelledError, RunReplayCursorError } from '../runs/registry.js'
import { piPermissionPublicTitle, piPermissionTokenFromTitle } from '../backends/pi-interaction.js'
import { boundedProbe, resolveHealthProbeTimeoutMs } from '../backends/health.js'
import {
  type RetainedEventRecord,
  type RetainedSessionRecord,
  type RetainedSessionStatus,
  parseSafeRetainedMetadata,
  SessionIdentityConflictError,
  type SessionStore,
} from './store.js'

// Retained resource and caller run ids use the public stable-id contract.
// URL-safe routing is handled by the HTTP client through path escaping; the
// contract itself does not add a private ASCII-only restriction.
const idSchema = z.string().min(1).max(512).refine(value => value.trim() === value, 'identifier cannot have outer whitespace')
const createSchema = z.strictObject({
  id: idSchema.optional(),
  session_id: idSchema.optional(),
  model: z.string().min(1),
  cwd: z.string().optional(),
  mode: z.enum(['byob', 'hosted-safe', 'hosted-sandboxed']).optional(),
  interaction_policy: z.enum(['interactive', 'unattended-deny', 'unattended-allow']).optional(),
  agent_profile: z.unknown().optional(),
  mcp: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
const retainedTextPartSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string().min(1),
})
const turnSchema = z.strictObject({
  message: z.string().min(1).optional(),
  parts: z.array(retainedTextPartSchema).min(1).optional(),
  turn_id: idSchema.optional(),
  execution_id: idSchema.optional(),
  run_id: idSchema.optional(),
})
const steerSchema = z.strictObject({
  operationId: idSchema,
  run: z.unknown(),
  message: z.string().min(1),
})
const ENVIRONMENT_ID = 'cli-bridge'
const NATIVE_BOUNDARY_TIMEOUT_MS = 5_000
const DEFAULT_INPUT_QUEUE_MAX_DEPTH = 16
const DEFAULT_INPUT_QUEUE_TIMEOUT_MS = 30_000

export type RetainedCreateInput = z.infer<typeof createSchema>
export type RetainedTurnInput = z.infer<typeof turnSchema>

export type RetainedControlAcknowledgement = {
  operationId: string
  kind: 'steer' | 'cancel'
  sessionId: string
  runId: string
  status: 'accepted' | 'cancelled' | 'already_terminal' | 'pending' | 'unknown_run' | 'capability_denied' | 'conflict' | 'effect_unknown'
  message?: string
  retryable?: false
}

export class RetainedSessionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'RetainedSessionError'
  }
}

class SteerAdmissionLostError extends Error {
  constructor() {
    super('the exact retained run changed before steering was sent')
    this.name = 'SteerAdmissionLostError'
  }
}

export interface RetainedTurnResult {
  session: RetainedSessionRecord
  run: DurableRetainedRunSnapshot
  contextBoundary: Record<string, unknown> | null
}

export type DurableRetainedRunSnapshot =
  | RunSnapshot
  | {
      readonly id: string
      readonly executionId: string
      readonly requestDigest: string
      readonly status: 'unknown'
      readonly state: 'detached'
      readonly terminal: false
      readonly sessionId: string
    }

export interface RetainedSessionView {
  id: string
  object: 'session'
  create_request_digest: string
  backend: string
  model: string
  status: RetainedSessionStatus
  run_id: string | null
  internal_session_id: string | null
  turns: number
  created_at: string
  updated_at: string
  capabilities: AgentEnvironmentCapabilities
  profile_materialization_receipt: Record<string, unknown> | null
  context_boundary: Record<string, unknown> | null
  run?: DurableRetainedRunSnapshot
}

export interface RetainedSessionServiceOptions {
  store: SessionStore
  registry: BackendRegistry
  runs: RunRegistry
  inputQueueMaxDepth?: number
  inputQueueTimeoutMs?: number
  healthProbeTimeoutMs?: number
}

interface BeginTurnOptions {
  queue?: boolean
  signal?: AbortSignal
}

interface TurnLane {
  tail: Promise<void>
  queued: number
}

interface RetainedInputMaterial {
  hasAgentProfile: boolean
  agentProfile?: unknown
  hasMcp: boolean
  mcp?: unknown
}

export class RetainedSessionService {
  private readonly store: SessionStore
  private readonly registry: BackendRegistry
  private readonly runs: RunRegistry
  private readonly inputQueueMaxDepth: number
  private readonly inputQueueTimeoutMs: number
  private readonly healthProbeTimeoutMs: number
  private readonly interactionResponseInFlight = new Map<string, {
    requestDigest: string
    promise: Promise<{ acknowledgement: InteractionAcknowledgement; status: number }>
  }>()
  private readonly controlInFlight = new Map<string, {
    requestDigest: string
    promise: Promise<{ acknowledgement: RetainedControlAcknowledgement; status: number }>
  }>()
  private readonly turnLanes = new Map<string, TurnLane>()
  private readonly runFinalization = new Map<string, Promise<void>>()
  private readonly runFinalizationFailures = new Map<string, Error>()
  /** Profile/MCP values are live child inputs, not durable session metadata. */
  private readonly retainedInputMaterial = new Map<string, RetainedInputMaterial>()

  constructor(options: RetainedSessionServiceOptions) {
    this.store = options.store
    this.registry = options.registry
    this.runs = options.runs
    this.inputQueueMaxDepth = options.inputQueueMaxDepth ?? parseNonNegativeEnv('BRIDGE_RETAINED_INPUT_MAX_QUEUE', DEFAULT_INPUT_QUEUE_MAX_DEPTH)
    this.inputQueueTimeoutMs = options.inputQueueTimeoutMs ?? parseNonNegativeEnv('BRIDGE_RETAINED_INPUT_QUEUE_TIMEOUT_MS', DEFAULT_INPUT_QUEUE_TIMEOUT_MS)
    this.healthProbeTimeoutMs = options.healthProbeTimeoutMs ?? resolveHealthProbeTimeoutMs()
    if (!Number.isSafeInteger(this.inputQueueMaxDepth) || this.inputQueueMaxDepth < 0) {
      throw new Error(`invalid retained input queue depth: ${this.inputQueueMaxDepth}`)
    }
    if (!Number.isSafeInteger(this.inputQueueTimeoutMs) || this.inputQueueTimeoutMs < 0) {
      throw new Error(`invalid retained input queue timeout: ${this.inputQueueTimeoutMs}`)
    }
    if (!Number.isFinite(this.healthProbeTimeoutMs) || this.healthProbeTimeoutMs < 0) {
      throw new Error(`invalid retained health probe timeout: ${this.healthProbeTimeoutMs}`)
    }
  }

  parseCreate(value: unknown): RetainedCreateInput {
    const parsed = createSchema.safeParse(value)
    if (!parsed.success) throw new RetainedSessionError('invalid retained-session creation request', 400, 'invalid_request_error')
    if (parsed.data.id && parsed.data.session_id && parsed.data.id !== parsed.data.session_id) {
      throw new RetainedSessionError('id and session_id must match when both are supplied', 400, 'invalid_request_error')
    }
    if (!parsed.data.id && !parsed.data.session_id) {
      throw new RetainedSessionError(
        'retained-session creation requires a stable id or session_id',
        400,
        'invalid_request_error',
      )
    }
    return parsed.data
  }

  parseTurn(value: unknown): RetainedTurnInput {
    const parsed = turnSchema.safeParse(value)
    if (!parsed.success) throw new RetainedSessionError('invalid retained-session turn request', 400, 'invalid_request_error')
    if (!parsed.data.message && (!parsed.data.parts || parsed.data.parts.length === 0)) {
      throw new RetainedSessionError('turn requires a non-empty message or parts', 400, 'invalid_request_error')
    }
    if (!parsed.data.run_id) {
      throw new RetainedSessionError(
        'retained turns require a stable run_id',
        400,
        'invalid_request_error',
      )
    }
    return parsed.data
  }

  parseSteer(value: unknown): { operationId: string; message: string; run: AgentRunControlRef } {
    const parsed = steerSchema.safeParse(value)
    const run = parsed.success ? AgentRunControlRefSchema.safeParse(parsed.data.run) : null
    if (
      !parsed.success
      || !run?.success
      || !run.data.sessionId
      || !run.data.executionId
      || !run.data.requestDigest
    ) {
      throw new RetainedSessionError(
        'steer requires operationId, message, and an exact run reference with sessionId, executionId, and requestDigest',
        400,
        'invalid_request_error',
      )
    }
    return { operationId: parsed.data.operationId, message: parsed.data.message, run: run.data }
  }

  parseCancel(value: unknown): AgentRunCancellationRequest {
    const parsed = AgentRunCancellationRequestSchema.safeParse(value)
    if (!parsed.success) throw new RetainedSessionError('cancel requires an exact digest-bound run request', 400, 'invalid_request_error')
    if (!parsed.data.run.requestDigest) {
      throw new RetainedSessionError(
        'retained cancellation requires the admitted run request digest',
        400,
        'invalid_request_error',
      )
    }
    return parsed.data
  }

  async capabilities(model: string, signal?: AbortSignal): Promise<AgentEnvironmentCapabilities> {
    const { capabilities } = await this.readyNativeBackend(model, signal)
    return capabilities
  }

  private async readyNativeBackend(
    model: string,
    signal?: AbortSignal,
  ): Promise<{ backend: NativeSessionBackend; capabilities: AgentEnvironmentCapabilities }> {
    const backend = this.registry.resolve(model)
    if (!backend) {
      throw new RetainedSessionError(
        `no backend matches model ${JSON.stringify(model)}`,
        404,
        'not_found_error',
      )
    }
    if (!isNativeBackend(backend)) {
      throw new RetainedSessionError(
        `backend ${JSON.stringify(backend.name)} does not prove native retained-session support`,
        501,
        'capability_denied',
      )
    }
    const health: Awaited<ReturnType<Backend['health']>> = await boundedProbe(
      backend,
      this.healthProbeTimeoutMs,
      signal,
    )
    if (health.state !== 'ready') {
      throw new RetainedSessionError(
        `backend ${JSON.stringify(backend.name)} is not ready: ${health.detail ?? health.state}`,
        503,
        'backend_not_ready',
      )
    }
    const validated = AgentEnvironmentCapabilitiesSchema.safeParse(nativeCapabilities(backend))
    if (!validated.success) {
      throw new RetainedSessionError(
        'backend advertised invalid Agent Interface capabilities',
        500,
        'server_error',
      )
    }
    const capabilities = validated.data as AgentEnvironmentCapabilities
    assertRetainedCapabilities(capabilities, backend.name)
    return { backend, capabilities }
  }

  async create(input: RetainedCreateInput, signal?: AbortSignal): Promise<RetainedSessionView> {
    if (!input.id && !input.session_id) {
      throw new RetainedSessionError(
        'retained-session creation requires a stable id or session_id',
        400,
        'invalid_request_error',
      )
    }
    const { backend, capabilities } = await this.readyNativeBackend(input.model, signal)
    const mode = input.mode ?? 'byob'
    if (!backend.nativeModes.includes(mode)) {
      throw new RetainedSessionError(
        `backend ${JSON.stringify(backend.name)} does not support retained sessions in mode ${JSON.stringify(mode)}`,
        501,
        'capability_denied',
      )
    }
    if (input.interaction_policy && input.interaction_policy !== 'interactive') {
      throw new RetainedSessionError(
        'unattended policies are one-shot profile policies; retained sessions require interactive approval',
        400,
        'capability_denied',
      )
    }
    const id = input.id ?? input.session_id!
    const inputMaterial: RetainedInputMaterial = {
      hasAgentProfile: input.agent_profile !== undefined,
      ...(input.agent_profile !== undefined ? { agentProfile: input.agent_profile } : {}),
      hasMcp: input.mcp !== undefined,
      ...(input.mcp !== undefined ? { mcp: input.mcp } : {}),
    }
    let callerMetadata: Record<string, unknown>
    try {
      callerMetadata = parseSafeRetainedMetadata(input.metadata)
    } catch (error) {
      throw new RetainedSessionError(
        error instanceof Error ? error.message : String(error),
        400,
        'invalid_request_error',
      )
    }
    const metadata: Record<string, unknown> = {
      ...callerMetadata,
      ...(inputMaterial.hasAgentProfile || inputMaterial.hasMcp
        ? {
            retained_input_presence: {
              ...(inputMaterial.hasAgentProfile ? { agent_profile: true } : {}),
              ...(inputMaterial.hasMcp ? { mcp: true } : {}),
            },
          }
        : {}),
      mode,
      interaction_policy: input.interaction_policy ?? 'interactive',
    }
    let created: RetainedSessionRecord
    try {
      created = this.store.createRetained({
        id,
        createRequestDigest: canonicalCandidateDigest(input),
        backend: backend.name,
        model: input.model,
        cwd: input.cwd ?? null,
        metadata,
        capabilities,
      })
    } catch (error) {
      if (
        error instanceof SessionIdentityConflictError
        || (error instanceof Error && (/already exists/u.test(error.message) || /UNIQUE constraint failed: retained_sessions\.id/u.test(error.message)))
      ) {
        throw new RetainedSessionError(error.message, 409, 'session_identity_conflict')
      }
      throw error
    }
    this.retainedInputMaterial.set(id, inputMaterial)
    return this.view(created)
  }

  list(limit: number): RetainedSessionView[] {
    return this.store.listRetained(limit).map(record => this.view(this.require(record.id)))
  }

  get(id: string): RetainedSessionView {
    const record = this.require(id)
    return this.view(record)
  }

  async beginTurn(id: string, input: RetainedTurnInput, options: BeginTurnOptions = {}): Promise<RetainedTurnResult> {
    if (!input.run_id) {
      throw new RetainedSessionError('retained turns require a stable run_id', 400, 'invalid_request_error')
    }
    this.require(id)
    const control = this.runs.nativeSession(id)
    const existingLane = this.turnLanes.get(id)
    if (!options.queue && ((control && !control.run.snapshot().terminal) || existingLane)) {
      throw new RetainedSessionError('a turn is already active; use the steering endpoint for active-run input', 409, 'active_run')
    }
    if (options.queue && existingLane && existingLane.queued >= this.inputQueueMaxDepth) {
      throw new RetainedSessionError(
        `retained session ${JSON.stringify(id)} input queue is full at depth ${this.inputQueueMaxDepth}`,
        429,
        'input_queue_full',
      )
    }
    const predecessor = existingLane?.tail ?? Promise.resolve()
    const lane = existingLane ?? { tail: Promise.resolve(), queued: 0 }
    if (existingLane && options.queue) lane.queued += 1
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    lane.tail = current
    this.turnLanes.set(id, lane)
    let waiting = Boolean(existingLane)
    try {
      if (waiting) {
        await waitForTurnLane(predecessor, options.signal, this.inputQueueTimeoutMs)
        lane.queued -= 1
        waiting = false
      } else if (options.signal?.aborted) {
        throw new RetainedSessionError('retained input was cancelled before turn admission', 408, 'input_queue_aborted')
      }
      if (options.signal?.aborted) {
        throw new RetainedSessionError('retained input was cancelled before turn admission', 408, 'input_queue_aborted')
      }
    } catch (error) {
      if (waiting) {
        lane.queued -= 1
        if (lane.tail === current) lane.tail = predecessor
        void predecessor.then(release, release)
      } else {
        release()
      }
      if (this.turnLanes.get(id) === lane && lane.tail === current) {
        this.turnLanes.delete(id)
      }
      throw error
    }
    let releaseScheduled = false
    try {
      const result = await this.beginTurnNow(id, input)
      const run = this.runs.get(result.run.id)
      if (!run || run.snapshot().terminal) {
        release()
      } else {
        releaseScheduled = true
        void run.whenTerminal()
          .then(() => this.runFinalization.get(run.id) ?? Promise.resolve())
          .then(release, release)
      }
      return result
    } catch (error) {
      release()
      throw error
    } finally {
      if (!releaseScheduled && this.turnLanes.get(id) === lane && lane.tail === current) this.turnLanes.delete(id)
      if (releaseScheduled) {
        void current.then(() => {
          if (this.turnLanes.get(id) === lane && lane.tail === current) this.turnLanes.delete(id)
        })
      }
    }
  }

  private async beginTurnNow(id: string, input: RetainedTurnInput): Promise<RetainedTurnResult> {
    const retained = this.require(id)
    if (retained.status === 'closed' || retained.status === 'cancelled') {
      throw new RetainedSessionError(`retained session ${JSON.stringify(id)} is ${retained.status}`, 409, 'invalid_state')
    }
    const prompt = renderTurnInput(input)
    const runId = input.run_id!
    const executionId = input.execution_id ?? input.turn_id ?? runId
    const requestDigest = canonicalCandidateDigest({
      sessionId: id,
      runId,
      executionId,
      model: retained.model,
      input: normalizeInputParts({ message: input.message, parts: input.parts }),
      turnId: input.turn_id ?? null,
    })
    if (retained.runId && this.runFinalizationFailures.has(retained.runId)) {
      throw new RetainedSessionError(
        `native session ${JSON.stringify(id)} has an uncommitted prior turn; its continuation is unknown`,
        409,
        'unknown_session',
      )
    }
    const replayed = this.replayedRunAdmission(retained, runId, executionId, requestDigest)
    if (replayed) return replayed
    const existingControl = this.runs.nativeSession(id)
    if (existingControl && !existingControl.run.snapshot().terminal) {
      throw new RetainedSessionError('a turn is already active; use the steering endpoint for active-run input', 409, 'active_run')
    }
    if (!existingControl && (retained.turns > 0 || retained.status === 'running' || retained.status === 'unknown')) {
      this.store.updateRetained(id, { status: 'unknown' })
      throw new RetainedSessionError(
        `native session ${JSON.stringify(id)} was lost across bridge restart; its continuation is unknown`,
        404,
        'unknown_session',
      )
    }
    const presence = recordValue(retained.metadata.retained_input_presence)
    const material = this.retainedInputMaterial.get(id)
    if ((presence?.agent_profile === true || presence?.mcp === true) && !material && !existingControl) {
      this.store.updateRetained(id, { status: 'unknown' })
      throw new RetainedSessionError(
        `native session ${JSON.stringify(id)} lost its exact profile inputs across bridge restart`,
        404,
        'unknown_session',
      )
    }

    const backend = this.registry.byName(retained.backend)
    if (!backend || !isNativeBackend(backend)) {
      throw new RetainedSessionError(`backend ${JSON.stringify(retained.backend)} no longer advertises native sessions`, 501, 'capability_denied')
    }
    const existingNative = existingControl?.session ?? null
    if (existingControl && existingNative) {
      await this.verifyRetainedBoundary(existingNative, retained, runId)
    }
    const durableClaim = this.store.claimRetainedRun({
      runId,
      sessionId: id,
      executionId,
      requestDigest,
      snapshot: unknownRunSnapshot(runId, executionId, requestDigest, id),
    })
    if (durableClaim.kind === 'conflict') {
      throw new RetainedSessionError(
        `run ${JSON.stringify(runId)} is already bound to a different request`,
        409,
        'run_identity_conflict',
      )
    }
    if (durableClaim.kind === 'replayed') {
      return this.replayedRunAdmission(retained, runId, executionId, requestDigest)!
    }
    let claim: ReturnType<RunRegistry['claim']>
    try {
      claim = this.runs.claim(runId, requestDigest, {
        sessionId: id,
        executionId,
        commitCanonicalEvent: event => this.store.appendRetainedEvent(id, {
          runId: event.runId,
          eventId: event.eventId,
          sequence: event.sequence,
          ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
          receivedAt: event.receivedAt,
          event: event.event,
        }).envelope,
        onNativeControlLost: ({ reason }) => {
          this.recordUnexpectedNativeClose(id, runId, requestDigest, reason)
        },
      })
    } catch (error) {
      if (error instanceof RunIdentityConflictError) {
        throw new RetainedSessionError(error.message, 409, 'run_identity_conflict')
      }
      throw error
    }
    const run = claim.run
    this.store.updateRetainedRun(runId, requestDigest, run.snapshot())
    if (!claim.created) {
      return {
        session: this.require(id),
        run: run.snapshot(),
        contextBoundary: this.require(id).contextBoundary,
      }
    }

    let native: NativeSession | null = existingNative
    const request = this.requestFor(retained, prompt)
    try {
      if (!native) {
        native = await backend.startNativeSession(request, this.sessionRecord(retained), run.signal)
        // The native child now owns the materialized profile/MCP state. Keep
        // no duplicate credential-bearing input in the bridge process after
        // the first spawn; a lost child is not eligible for silent restart.
        this.retainedInputMaterial.delete(id)
      } else if (existingControl) {
        existingControl.run.takeNativeControl(native)
      }
      run.setNativeControl(native)
      this.store.updateRetained(id, {
        status: 'running',
        runId,
        ...(native.providerSessionId() ? { internalId: native.providerSessionId() } : {}),
        ...(request.profile_materialization_receipt
          ? { profileMaterializationReceipt: request.profile_materialization_receipt as unknown as Record<string, unknown> }
          : {}),
      })
      const pump = run.pumpCanonical(this.canonicalTurn(native, run, id, prompt, retained.backend))
      const finalization = pump
        .then(async () => {
          const snapshot = run.snapshot()
          this.store.updateRetainedRun(runId, requestDigest, snapshot)
          const current = this.store.getRetained(id)
          if (!current || current.runId !== runId) return
          let boundary = current.contextBoundary
          if (snapshot.status === 'done') {
            const proof = await observeNativeBoundary(native!, { runId, environmentId: ENVIRONMENT_ID, sessionId: id })
            const parsedProof = proof ? NativeContextBoundaryProofSchema.safeParse(proof) : null
            boundary = parsedProof?.success
              && parsedProof.data.runId === runId
              && parsedProof.data.provider === retained.backend
              && parsedProof.data.environmentId === ENVIRONMENT_ID
              && parsedProof.data.sessionId === id
              ? parsedProof.data as unknown as Record<string, unknown>
              : { status: 'unverified', reason: `${retained.backend} native state did not expose a verifiable revision` }
          }
          this.store.updateRetained(id, {
            status: snapshot.status === 'cancelled' ? 'cancelled' : snapshot.status === 'done' ? 'idle' : 'unknown',
            turns: snapshot.status === 'done' ? current.turns + 1 : current.turns,
            internalId: native!.providerSessionId() ?? current.internalId,
            contextBoundary: boundary,
          })
        })
        .catch(error => {
          const failure = error instanceof Error ? error : new Error(String(error))
          this.runFinalizationFailures.set(runId, failure)
          this.markRetainedUnknown(id, runId, requestDigest, run)
          console.error(`[cli-bridge] retained run ${runId} finalization was not durably committed:`, failure)
          throw failure
        })
      this.runFinalization.set(runId, finalization)
      void finalization.then(() => {
        if (this.runFinalization.get(runId) === finalization) this.runFinalization.delete(runId)
      }, () => {
        if (this.runFinalization.get(runId) === finalization) this.runFinalization.delete(runId)
      })
    } catch (error) {
      run.failCanonicalSetup(error)
      this.store.updateRetainedRun(runId, requestDigest, run.snapshot())
      await native?.close().catch(() => {})
      this.retainedInputMaterial.delete(id)
      this.store.updateRetained(id, {
        status: native ? 'unknown' : retained.turns > 0 ? 'idle' : 'created',
        runId,
      })
      throw error
    }
    const updated = this.require(id)
    return { session: updated, run: run.snapshot(), contextBoundary: updated.contextBoundary }
  }

  private replayedRunAdmission(
    retained: RetainedSessionRecord,
    runId: string,
    executionId: string,
    requestDigest: string,
  ): RetainedTurnResult | null {
    const admission = this.store.getRetainedRun(runId)
    if (!admission) return null
    if (
      admission.sessionId !== retained.id
      || admission.executionId !== executionId
      || admission.requestDigest !== requestDigest
    ) {
      throw new RetainedSessionError(
        `run ${JSON.stringify(runId)} is already bound to a different request`,
        409,
        'run_identity_conflict',
      )
    }
    const live = this.runs.get(runId)
    if (live) {
      const snapshot = live.snapshot()
      if (snapshot.requestDigest !== requestDigest || snapshot.sessionId !== retained.id) {
        throw new RetainedSessionError(
          `run ${JSON.stringify(runId)} is already bound to a different request`,
          409,
          'run_identity_conflict',
        )
      }
      this.store.updateRetainedRun(runId, requestDigest, snapshot)
      const session = this.require(retained.id)
      return { session, run: snapshot, contextBoundary: session.contextBoundary }
    }
    const persisted = retainedRunSnapshot(
      admission.snapshot,
      runId,
      admission.executionId,
      requestDigest,
      retained.id,
    )
    const snapshot = persisted.terminal
      ? persisted
      : unknownRunSnapshot(runId, admission.executionId, requestDigest, retained.id)
    if (!persisted.terminal) {
      this.store.updateRetainedRun(runId, requestDigest, snapshot)
      this.store.updateRetained(retained.id, { status: 'unknown', runId })
    }
    const session = this.require(retained.id)
    return { session, run: snapshot, contextBoundary: session.contextBoundary }
  }

  async steer(
    id: string,
    input: { operationId: string; message: string; run: AgentRunControlRef },
    callerId: string,
  ): Promise<{ acknowledgement: RetainedControlAcknowledgement; status: number }> {
    const record = this.require(id)
    const runId = input.run.runId
    const admission = this.store.getRetainedRun(runId)
    if (
      input.run.provider !== ENVIRONMENT_ID
      || input.run.environmentId !== ENVIRONMENT_ID
      || input.run.sessionId !== id
      || !admission
      || admission.sessionId !== id
      || admission.executionId !== input.run.executionId
      || admission.requestDigest !== input.run.requestDigest
    ) {
      return { acknowledgement: controlConflict(input.operationId, 'steer', id, runId), status: 409 }
    }
    const requestDigest = canonicalCandidateDigest({ callerId, kind: 'steer', sessionId: id, run: input.run, prompt: input.message })
    const inFlight = this.controlInFlight.get(input.operationId)
    if (inFlight) {
      if (inFlight.requestDigest === requestDigest) return inFlight.promise
      return { acknowledgement: controlConflict(input.operationId, 'steer', id, runId), status: 409 }
    }
    const existing = this.existingControlAcknowledgement(input.operationId, requestDigest, 'steer', id, runId)
    if (existing) return existing
    const promise = this.executeSteer({ id, prompt: input.message, operationId: input.operationId, callerId, runRef: input.run, requestDigest })
    this.controlInFlight.set(input.operationId, { requestDigest, promise })
    try { return await promise } finally {
      if (this.controlInFlight.get(input.operationId)?.promise === promise) this.controlInFlight.delete(input.operationId)
    }
  }

  async cancel(
    id: string,
    waitMs: number,
    request: AgentRunCancellationRequest,
    callerId: string,
  ): Promise<{ acknowledgement: RetainedControlAcknowledgement; status: number }> {
    const operationId = request.operationId
    const requestedRunId = request.run.runId
    this.require(id)
    const runId = requestedRunId
    const admission = runId ? this.store.getRetainedRun(runId) : null
    if (
      request.run.provider !== ENVIRONMENT_ID
      || request.run.environmentId !== ENVIRONMENT_ID
      || request.run.sessionId !== id
      || !admission
      || admission.executionId !== request.run.executionId
      || (
        admission.sessionId !== id
        || admission.requestDigest !== request.run.requestDigest
      )
    ) {
      return { acknowledgement: controlConflict(operationId, 'cancel', id, runId), status: 409 }
    }
    const requestDigest = canonicalCandidateDigest({ callerId, kind: 'cancel', request })
    const inFlight = this.controlInFlight.get(operationId)
    if (inFlight) {
      if (inFlight.requestDigest === requestDigest) return inFlight.promise
      return { acknowledgement: controlConflict(operationId, 'cancel', id, runId), status: 409 }
    }
    const existing = this.existingControlAcknowledgement(operationId, requestDigest, 'cancel', id, runId)
    if (existing) return existing
    const promise = this.executeCancel({ id, operationId, callerId, runId, requestDigest, waitMs })
    this.controlInFlight.set(operationId, { requestDigest, promise })
    try { return await promise } finally {
      if (this.controlInFlight.get(operationId)?.promise === promise) this.controlInFlight.delete(operationId)
    }
  }

  private existingControlAcknowledgement(
    operationId: string,
    requestDigest: string,
    kind: 'steer' | 'cancel',
    sessionId: string,
    runId: string,
  ): { acknowledgement: RetainedControlAcknowledgement; status: number } | null {
    const existing = this.store.getRetainedControlOperation(operationId)
    if (!existing) return null
    if (existing.requestDigest !== requestDigest || existing.kind !== kind || existing.sessionId !== sessionId || existing.runId !== runId) {
      return { acknowledgement: controlConflict(operationId, kind, sessionId, runId), status: 409 }
    }
    const persisted = existing.acknowledgement as RetainedControlAcknowledgement
    if (persisted.status === 'pending') {
      const control = this.runs.nativeSession(sessionId)
      const snapshot = control?.run.id === runId
        ? control.run.snapshot()
        : this.runSnapshot(runId)
      const acknowledgement: RetainedControlAcknowledgement = kind === 'cancel' && snapshot?.terminal
        ? {
            ...persisted,
            status: snapshot.status === 'unknown'
              ? 'effect_unknown'
              : snapshot.status === 'cancelled' ? 'cancelled' : 'already_terminal',
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
  }): Promise<{ acknowledgement: RetainedControlAcknowledgement; status: number }> {
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
      const acknowledgement: RetainedControlAcknowledgement = { ...pending, status: this.durableSteerRefMatches(input.id, input.runRef) ? 'unknown_run' : 'conflict', message: this.durableSteerRefMatches(input.id, input.runRef) ? 'active run is unknown' : 'run reference is not the durable admission for this session', retryable: false }
      this.store.updateRetainedControlOperation(input.operationId, input.requestDigest, acknowledgement)
      return { acknowledgement, status: acknowledgement.status === 'unknown_run' ? 404 : 409 }
    }
    try {
      await control.run.withNativeControl(async native => {
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
        status: error instanceof RunInteractionCancelledError ? 'cancelled' : error instanceof SteerAdmissionLostError ? 'conflict' : 'effect_unknown',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      }
      this.store.updateRetainedControlOperation(input.operationId, input.requestDigest, acknowledgement)
      return { acknowledgement, status: error instanceof RunInteractionCancelledError || error instanceof SteerAdmissionLostError ? 409 : 502 }
    }
  }

  private durableSteerRefMatches(id: string, ref: AgentRunControlRef): boolean {
    const record = this.store.getRetained(id)
    const admission = this.store.getRetainedRun(ref.runId)
    return Boolean(
      record
      && ref.provider === ENVIRONMENT_ID
      && ref.environmentId === ENVIRONMENT_ID
      && ref.sessionId === id
      && ref.executionId
      && ref.requestDigest
      && admission
      && admission.sessionId === id
      && admission.executionId === ref.executionId
      && admission.requestDigest === ref.requestDigest,
    )
  }

  private exactSteerControl(id: string, ref: AgentRunControlRef): { run: Run; session: NativeSession } | null {
    if (!this.durableSteerRefMatches(id, ref)) return null
    const control = this.runs.nativeSession(id)
    if (!control || control.run.id !== ref.runId || control.run.snapshot().terminal || !control.session.steer) return null
    const snapshot = control.run.snapshot()
    if (
      snapshot.sessionId !== id
      || snapshot.executionId !== ref.executionId
      || snapshot.requestDigest !== ref.requestDigest
    ) return null
    return control
  }

  private async executeCancel(input: {
    id: string
    operationId: string
    callerId: string
    runId: string
    requestDigest: string
    waitMs: number
  }): Promise<{ acknowledgement: RetainedControlAcknowledgement; status: number }> {
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
    const control = this.runs.nativeSession(input.id)
    if (!control || control.run.id !== input.runId) {
      const durable = this.runSnapshot(input.runId)
      const status = durable?.status === 'unknown'
        ? 'effect_unknown'
        : durable?.terminal
          ? durable.status === 'cancelled' ? 'cancelled' : 'already_terminal'
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
      if ((status === 'unknown_run' || status === 'effect_unknown') && this.store.getRetained(input.id)?.runId === input.runId) {
        this.store.updateRetained(input.id, { status: 'unknown' })
      }
      return { acknowledgement, status: status === 'unknown_run' ? 404 : status === 'effect_unknown' ? 502 : 200 }
    }
    const cancellation = control.run.requestNativeCancellation()
    if (input.waitMs > 0 && !control.run.snapshot().terminal) {
      try {
        await Promise.race([
          cancellation.then(async () => { await control.run.whenTerminal() }),
          new Promise<void>(resolve => setTimeout(resolve, input.waitMs)),
        ])
      } catch (error) {
        const acknowledgement: RetainedControlAcknowledgement = {
          ...pending,
          status: 'effect_unknown',
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        }
        this.store.updateRetainedControlOperation(input.operationId, input.requestDigest, acknowledgement)
        this.store.updateRetained(input.id, { status: 'unknown' })
        return { acknowledgement, status: 502 }
      }
    }
    const snapshot = control.run.snapshot()
    this.store.updateRetainedRun(input.runId, snapshot.requestDigest, snapshot)
    const status = snapshot.status === 'unknown'
      ? 'effect_unknown'
      : snapshot.status === 'cancelled'
        ? 'cancelled'
        : snapshot.terminal ? 'already_terminal' : 'pending'
    const acknowledgement: RetainedControlAcknowledgement = {
      ...pending,
      status,
      ...(status === 'already_terminal' ? { message: `run ended with status ${snapshot.status}` } : {}),
      ...(status === 'effect_unknown' ? { message: 'the cancellation effect is unknown', retryable: false } : {}),
    }
    this.store.updateRetainedControlOperation(input.operationId, input.requestDigest, acknowledgement)
    this.store.updateRetained(input.id, {
      status: snapshot.status === 'cancelled' ? 'cancelled' : snapshot.status === 'done' ? 'idle' : snapshot.terminal ? 'unknown' : 'running',
    })
    if (status === 'pending') {
      void cancellation.then(async () => control.run.whenTerminal()).then(() => {
        const settled = control.run.snapshot()
        this.store.updateRetainedRun(input.runId, settled.requestDigest, settled)
        const terminalAcknowledgement: RetainedControlAcknowledgement = {
          ...pending,
          status: settled.status === 'unknown' ? 'effect_unknown' : settled.status === 'cancelled' ? 'cancelled' : 'already_terminal',
          ...(settled.status === 'unknown'
            ? { message: 'the cancellation effect is unknown', retryable: false }
            : settled.status !== 'cancelled' ? { message: `run ended with status ${settled.status}` } : {}),
        }
        this.store.updateRetainedControlOperation(input.operationId, input.requestDigest, terminalAcknowledgement)
        if (settled.status === 'unknown') this.store.updateRetained(input.id, { status: 'unknown' })
      }).catch(error => {
        const unknown: RetainedControlAcknowledgement = {
          ...pending,
          status: 'effect_unknown',
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        }
        this.store.updateRetainedControlOperation(input.operationId, input.requestDigest, unknown)
        this.store.updateRetained(input.id, { status: 'unknown' })
      })
    }
    return { acknowledgement, status: status === 'pending' ? 202 : status === 'effect_unknown' ? 502 : 200 }
  }

  detach(id: string): RetainedSessionView {
    return this.get(id)
  }

  async shutdown(timeoutMs = 5_000): Promise<void> {
    const pending = [...this.runFinalization.values()]
    if (pending.length === 0) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${pending.length} retained finalization(s)`)),
        timeoutMs,
      )
      timer.unref?.()
    })
    try {
      const settled = await Promise.race([Promise.allSettled(pending), timeout])
      const failure = settled.find(item => item.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async close(id: string): Promise<RetainedSessionView> {
    const record = this.require(id)
    const control = this.runs.nativeSession(id)
    if (control && !control.run.snapshot().terminal) {
      throw new RetainedSessionError('active retained runs must be cancelled before the session can close', 409, 'active_run')
    }
    if (control) {
      try {
        if (!await control.run.closeNativeControl(control.session)) {
          throw new RetainedSessionError('native session ownership changed before close', 409, 'invalid_state')
        }
      } catch (error) {
        if (error instanceof RetainedSessionError) throw error
        this.store.updateRetained(id, { status: 'unknown' })
        throw new RetainedSessionError(
          `native session close failed: ${error instanceof Error ? error.message : String(error)}`,
          502,
          'close_failed',
        )
      }
    }
    if (record.status !== 'closed') this.store.updateRetained(id, { status: 'closed' })
    this.retainedInputMaterial.delete(id)
    return this.get(id)
  }

  transcript(id: string): Record<string, unknown> {
    this.require(id)
    const events = this.store.retainedEventsAfter(id)
    const messages = new Map<string, { id: string; role: 'assistant'; parts: Part[] }>()
    const interactions: InteractionRequest[] = []
    const usage: unknown[] = []
    for (const item of events) {
      const event = item.envelope.event
      if (event.type === 'message.part.updated') {
        const messageId = event.part.messageID
        const message = messages.get(messageId) ?? { id: messageId, role: 'assistant', parts: [] }
        const index = message.parts.findIndex(part => part.id === event.part.id)
        if (index >= 0) message.parts[index] = event.part
        else message.parts.push(event.part)
        messages.set(messageId, message)
      } else if (event.type === 'interaction') {
        interactions.push(event.request)
      } else if (event.type === 'raw' && isUsageEvent(event.event)) {
        usage.push(event.event)
      }
    }
    return {
      session_id: id,
      messages: [...messages.values()],
      interactions,
      usage,
      event_count: events.length,
      last_event_id: this.store.latestRetainedEvent(id)?.envelope.cursor ?? null,
    }
  }

  assertReplayCursor(id: string, afterCursor: number): void {
    this.require(id)
    const latest = this.store.latestRetainedEvent(id)
    const latestCursor = latest ? Number(latest.envelope.cursor ?? latest.sessionSequence) : 0
    if (afterCursor > latestCursor) {
      throw new RetainedSessionError(
        `replay cursor ${afterCursor} is ahead of the latest retained cursor ${latestCursor}`,
        409,
        'invalid_replay_cursor',
      )
    }
  }

  async *events(id: string, afterCursor: number, signal: AbortSignal): AsyncIterable<RetainedEventRecord> {
    this.assertReplayCursor(id, afterCursor)
    // Session replay uses the session cursor and includes every retained run;
    // the active run is only the notification source, not a run filter.
    yield* this.streamRetainedEvents({ sessionId: id, afterCursor, runId: null, signal })
  }

  assertRunReplayCursor(runId: string, afterSequence: number): void {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RetainedSessionError('run replay cursor must be a non-negative integer', 400, 'invalid_replay_cursor')
    }
    const control = this.runs.get(runId)
    const durable = this.store.retainedRun(runId)
    if (!control && !durable) throw new RetainedSessionError('run is unknown after process loss', 404, 'unknown_run')
    const latest = durable?.lastSequence ?? control?.snapshot().canonicalLastSeq ?? 0
    if (afterSequence > latest) {
      throw new RetainedSessionError(
        `replay cursor ${afterSequence} is ahead of run ${JSON.stringify(runId)} at ${latest}`,
        409,
        'invalid_replay_cursor',
      )
    }
  }

  async *runEvents(runId: string, afterSequence: number, signal: AbortSignal): AsyncIterable<RetainedEventRecord> {
    this.assertRunReplayCursor(runId, afterSequence)
    const control = this.runs.get(runId)
    const durable = this.store.retainedRun(runId)
    const sessionId = control?.sessionId ?? durable?.sessionId
    if (!sessionId) throw new RetainedSessionError('run has no retained session binding', 404, 'unknown_run')
    yield* this.streamRetainedEvents({ sessionId, afterCursor: afterSequence, runId, signal, runCursor: true })
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
    )
    return persisted.terminal
      ? persisted
      : unknownRunSnapshot(
          admission.runId,
          admission.executionId,
          admission.requestDigest,
          admission.sessionId,
        )
  }

  private async *streamRetainedEvents(input: {
    sessionId: string
    afterCursor: number
    runId: string | null
    signal: AbortSignal
    runCursor?: boolean
  }): AsyncGenerator<RetainedEventRecord> {
    let cursor = input.afterCursor
    const seen = new Set<string>()
    const live: Array<{ seq: number; envelope: RetainedEventRecord['envelope'] }> = []
    let wake: (() => void) | null = null
    let unsubscribe: (() => void) | null = null
    const control = input.runId ? this.runs.get(input.runId) : this.runs.nativeSession(input.sessionId)?.run
    if (control && (!input.runId || control.id === input.runId)) {
      unsubscribe = control.subscribeCanonical(event => {
        live.push({ seq: event.seq, envelope: event.envelope })
        wake?.()
      })
    }
    try {
      while (!input.signal.aborted) {
        let progressed = false
        const durable = input.runCursor
          ? this.store.retainedEventsAfterRun(input.sessionId, input.runId!, cursor)
          : this.store.retainedEventsAfter(input.sessionId, cursor)
        for (const event of durable) {
          if (input.signal.aborted) return
          const eventCursor = input.runCursor ? event.envelope.sequence : Number(event.envelope.cursor ?? event.sessionSequence)
          if (eventCursor <= cursor || seen.has(event.envelope.eventId)) continue
          if (input.runId && event.envelope.runId !== input.runId) continue
          seen.add(event.envelope.eventId)
          cursor = eventCursor
          progressed = true
          yield event
        }

        // A live notification is only a wake-up. Re-read SQLite by cursor and
        // dedupe by event id; the notification cannot expose an uncommitted or
        // duplicate event and a commit between reads cannot create a gap.
        if (live.length > 0) {
          live.length = 0
          continue
        }
        const reread = input.runCursor
          ? this.store.retainedEventsAfterRun(input.sessionId, input.runId!, cursor)
          : this.store.retainedEventsAfter(input.sessionId, cursor)
        for (const event of reread) {
          const eventCursor = input.runCursor ? event.envelope.sequence : Number(event.envelope.cursor ?? event.sessionSequence)
          if (eventCursor <= cursor || seen.has(event.envelope.eventId)) continue
          if (input.runId && event.envelope.runId !== input.runId) continue
          seen.add(event.envelope.eventId)
          cursor = eventCursor
          progressed = true
          yield event
        }
        if (progressed) continue

        const active = input.runId ? this.runs.get(input.runId) : this.runs.nativeSession(input.sessionId)?.run
        if (!active || active.snapshot().terminal) {
          const final = input.runCursor
            ? this.store.retainedEventsAfterRun(input.sessionId, input.runId!, cursor)
            : this.store.retainedEventsAfter(input.sessionId, cursor)
          if (final.length === 0) {
            const current = this.store.getRetained(input.sessionId)
            const hasHistory = this.store.latestRetainedEvent(input.sessionId) !== null
            if (!input.runId && !hasHistory && (current?.status === 'created' || current?.status === 'idle' || current?.status === 'running')) {
              await waitForEventPoll(input.signal, 50)
              continue
            }
            return
          }
          continue
        }
        await waitForEventNotification(input.signal, () => {
          if (live.length > 0) return true
          wake = null
          return false
        }, resolve => { wake = resolve })
      }
    } finally {
      unsubscribe?.()
      const notify = wake as (() => void) | null
      notify?.()
    }
  }

  async respond(value: unknown, callerId: string, routeBinding?: { runId: string; interactionId: string }): Promise<{ acknowledgement: InteractionAcknowledgement; status: number }> {
    const parsed = InteractionResponseCommandSchema.safeParse(value)
    if (!parsed.success) {
      const operationId = readOperationId(value)
      const binding = readBinding(value)
      const acknowledgement = invalidAcknowledgement(operationId, binding, parsed.error.issues[0]?.message ?? 'invalid interaction response command')
      return { acknowledgement, status: 400 }
    }
    const command = parsed.data
    if (routeBinding && (command.binding.runId !== routeBinding.runId || command.binding.interactionId !== routeBinding.interactionId)) {
      return {
        acknowledgement: {
          operationId: command.operationId,
          binding: command.binding,
          status: 'binding_mismatch',
          message: 'interaction URL does not match the command binding',
        },
        status: 409,
      }
    }
    const requestDigest = canonicalCandidateDigest({ callerId, command })
    const existing = this.store.getInteractionOperation(command.operationId)
    if (existing) {
      if (existing.requestDigest === requestDigest) return { acknowledgement: existing.acknowledgement, status: statusForAcknowledgement(existing.acknowledgement) }
      const conflict: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding: command.binding,
        status: 'already_resolved_different',
        message: 'operation id was already used with a different caller or response body',
      }
      return { acknowledgement: conflict, status: 409 }
    }

    const inFlight = this.interactionResponseInFlight.get(command.operationId)
    if (inFlight) {
      if (inFlight.requestDigest === requestDigest) return inFlight.promise
      return {
        acknowledgement: {
          operationId: command.operationId,
          binding: command.binding,
          status: 'already_resolved_different',
          message: 'operation id is already being processed with a different caller or response body',
        },
        status: 409,
      }
    }

    const promise = this.resolveInteractionResponse(command, callerId, requestDigest)
    this.interactionResponseInFlight.set(command.operationId, { requestDigest, promise })
    try {
      return await promise
    } finally {
      const current = this.interactionResponseInFlight.get(command.operationId)
      if (current?.promise === promise) this.interactionResponseInFlight.delete(command.operationId)
    }
  }

  private async resolveInteractionResponse(
    command: InteractionResponseCommand,
    callerId: string,
    requestDigest: string,
  ): Promise<{ acknowledgement: InteractionAcknowledgement; status: number }> {
    const binding = command.binding
    const run = this.runs.get(binding.runId)
    const record = binding.sessionId
      ? this.store.getRetained(binding.sessionId)
      : run?.sessionId
        ? this.store.getRetained(run.sessionId)
        : null
    if (!record || binding.environmentId !== ENVIRONMENT_ID || (binding.sessionId !== undefined && binding.sessionId !== record.id) || !run || run.sessionId !== record.id) {
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        status: run ? 'binding_mismatch' : 'unknown_run',
        message: run ? 'interaction binding does not match the retained session' : 'run is unknown after process loss',
      }
      this.store.recordInteractionOperation({ operationId: command.operationId, callerId, runId: binding.runId, sessionId: binding.sessionId ?? '', interactionId: binding.interactionId, requestDigest, acknowledgement })
      return { acknowledgement, status: run ? 409 : 404 }
    }
    const pending = run.interaction(binding.interactionId)
    if (!pending) {
      const resolvedDigest = run.resolvedInteractionDigest(binding.interactionId)
      const status = resolvedDigest
        ? resolvedDigest === canonicalCandidateDigest(command.response) ? 'already_resolved_same' : 'already_resolved_different'
        : run.interactionWasCancelled(binding.interactionId)
          ? 'cancelled'
          : run.interactionIsResolving(binding.interactionId)
            ? 'already_resolved_different'
          : 'unknown_interaction'
      const acknowledgement: InteractionAcknowledgement = { operationId: command.operationId, binding, status, message: 'interaction is no longer outstanding' }
      this.store.recordInteractionOperation({ operationId: command.operationId, callerId, runId: binding.runId, sessionId: record.id, interactionId: binding.interactionId, requestDigest, acknowledgement })
      return { acknowledgement, status: status === 'unknown_interaction' ? 404 : status === 'already_resolved_same' ? 200 : 409 }
    }
    const validation = validateInteractionResponse(pending.request, command.response)
    if (!validation.ok) {
      const acknowledgement: InteractionAcknowledgement = { operationId: command.operationId, binding, status: 'invalid_response', message: validation.errors.join('; ') }
      this.store.recordInteractionOperation({ operationId: command.operationId, callerId, runId: binding.runId, sessionId: record.id, interactionId: binding.interactionId, requestDigest, acknowledgement })
      return { acknowledgement, status: 400 }
    }
    const claimed = run.claimInteraction(binding.interactionId)
    if (!claimed) {
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        status: run.interactionWasCancelled(binding.interactionId) ? 'cancelled' : 'already_resolved_different',
        message: 'another response is already resolving this interaction',
      }
      this.store.recordInteractionOperation({ operationId: command.operationId, callerId, runId: binding.runId, sessionId: record.id, interactionId: binding.interactionId, requestDigest, acknowledgement })
      return { acknowledgement, status: 409 }
    }
    try {
      await run.withNativeControl(async native => {
        await native.respondToNativeInteraction(
          claimed.nativeId,
          nativeResponseFor(claimed.request, command.response),
        )
        run.resolveInteraction(binding.interactionId, canonicalCandidateDigest(command.response))
      })
      const acknowledgement: InteractionAcknowledgement = { operationId: command.operationId, binding, status: 'accepted' }
      this.store.recordInteractionOperation({ operationId: command.operationId, callerId, runId: binding.runId, sessionId: record.id, interactionId: binding.interactionId, requestDigest, acknowledgement })
      return { acknowledgement, status: 200 }
    } catch (error) {
      run.releaseInteractionClaim(binding.interactionId)
      if (error instanceof RunInteractionCancelledError || run.interactionWasCancelled(binding.interactionId) || run.isCancelling()) {
        const acknowledgement: InteractionAcknowledgement = {
          operationId: command.operationId,
          binding,
          status: 'cancelled',
          message: 'interaction was cancelled before its response became effective',
        }
        this.store.recordInteractionOperation({ operationId: command.operationId, callerId, runId: binding.runId, sessionId: record.id, interactionId: binding.interactionId, requestDigest, acknowledgement })
        return { acknowledgement, status: 409 }
      }
      const acknowledgement: InteractionAcknowledgement = {
        operationId: command.operationId,
        binding,
        status: 'transport_failure',
        message: `response effect was not proven and will not be repeated: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
      }
      this.store.recordInteractionOperation({ operationId: command.operationId, callerId, runId: binding.runId, sessionId: record.id, interactionId: binding.interactionId, requestDigest, acknowledgement })
      return { acknowledgement, status: 502 }
    }
  }

  private require(id: string): RetainedSessionRecord {
    let record = this.store.getRetained(id)
    if (!record) throw new RetainedSessionError('retained session not found', 404, 'not_found_error')
    if (
      record.runId
      && this.runFinalizationFailures.has(record.runId)
      && record.status !== 'closed'
      && record.status !== 'cancelled'
    ) {
      try {
        this.store.updateRetained(id, { status: 'unknown' })
        record = this.store.getRetained(id) ?? { ...record, status: 'unknown' }
      } catch {
        record = { ...record, status: 'unknown' }
      }
    }
    if ((record.status === 'running' || (record.status === 'idle' && record.turns > 0)) && !this.runs.nativeSession(id)) {
      this.store.updateRetained(id, { status: 'unknown' })
      record = this.store.getRetained(id)!
    }
    return record
  }

  private view(record: RetainedSessionRecord): RetainedSessionView {
    const control = this.runs.nativeSession(record.id)
    const run = control?.run.snapshot()
      ?? (record.runId ? this.runSnapshot(record.runId) : null)
    const runStatus = run?.status
    const status = record.status === 'closed'
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

  private requestFor(record: RetainedSessionRecord, prompt: string): ChatRequest {
    const material = this.retainedInputMaterial.get(record.id)
    const profile = material?.hasAgentProfile ? material.agentProfile : undefined
    const mcp = material?.hasMcp ? material.mcp : undefined
    const policy = record.metadata.interaction_policy
    const mode = record.metadata.mode
    return {
      model: record.model,
      messages: [{ role: 'user', content: prompt }],
      session_id: record.id,
      ...(record.cwd ? { cwd: record.cwd } : {}),
      ...(typeof mode === 'string' ? { mode: mode as ChatRequest['mode'] } : {}),
      ...(profile !== undefined ? { agent_profile: profile as ChatRequest['agent_profile'] } : {}),
      ...(mcp && typeof mcp === 'object' ? { mcp: mcp as ChatRequest['mcp'] } : {}),
      ...(typeof policy === 'string' ? { interaction_policy: policy as ChatRequest['interaction_policy'] } : {}),
    }
  }

  private recordUnexpectedNativeClose(
    sessionId: string,
    runId: string,
    requestDigest: string,
    reason: Error,
  ): void {
    const run = this.runs.get(runId)
    if (run) this.markRetainedUnknown(sessionId, runId, requestDigest, run)
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

  private markRetainedUnknown(
    sessionId: string,
    runId: string,
    requestDigest: string,
    run: Run,
  ): void {
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

  private async verifyRetainedBoundary(native: NativeSession, record: RetainedSessionRecord, runId: string): Promise<void> {
    const expected = record.contextBoundary
    const parsedExpected = expected ? NativeContextBoundaryProofSchema.safeParse(expected) : null
    if (!parsedExpected?.success
      || !record.runId
      || parsedExpected.data.runId !== record.runId
      || parsedExpected.data.provider !== record.backend
      || parsedExpected.data.environmentId !== ENVIRONMENT_ID
      || parsedExpected.data.sessionId !== record.id) {
      throw new RetainedSessionError(
        'retained turn is unverified; the provider boundary must be proven before another turn',
        501,
        'capability_denied',
      )
    }
    const observed = await observeNativeBoundary(native, { runId, environmentId: ENVIRONMENT_ID, sessionId: record.id })
    const parsedObserved = observed ? NativeContextBoundaryProofSchema.safeParse(observed) : null
    if (!parsedObserved?.success
      || parsedObserved.data.runId !== runId
      || parsedObserved.data.provider !== record.backend
      || parsedObserved.data.environmentId !== ENVIRONMENT_ID
      || parsedObserved.data.sessionId !== record.id
      || canonicalCandidateJson(parsedObserved.data.boundary) !== canonicalCandidateJson(parsedExpected.data.boundary)) {
      throw new RetainedSessionError(
        'retained turn boundary changed or could not be verified',
        409,
        'context_boundary_mismatch',
      )
    }
  }

  private sessionRecord(record: RetainedSessionRecord): { externalId: string; backend: string; internalId: string; cwd: string | null; turns: number; createdAt: number; lastUsedAt: number; metadata: Record<string, unknown> } {
    return {
      externalId: record.id,
      backend: record.backend,
      internalId: record.internalId ?? '',
      cwd: record.cwd,
      turns: record.turns,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      metadata: record.metadata,
    }
  }

  private async *canonicalTurn(
    native: NativeSession,
    run: Run,
    sessionId: string,
    prompt: string,
    backendName: string,
  ): AsyncIterable<{ event: StreamEvent }> {
    yield { event: { type: 'status', status: 'started' } }
    const text = new Map<number, string>()
    const reasoning = new Map<number, string>()
    const toolParts = new Map<string, Part>()
    let nextContentIndex = 0
    let lastTurnFailure: string | null = null
    try {
      for await (const raw of native.turn(prompt, run.signal)) {
        const event = recordValue(raw)
        if (!event) {
          yield { event: { type: 'raw', backend: backendName, event: raw } }
          continue
        }
        const type = String(event.type ?? '')
        if (type === 'session') {
          if (typeof event.id === 'string') this.store.updateRetained(sessionId, { internalId: event.id })
          if (typeof event.id === 'string') yield { event: { type: 'session.updated', sessionId: boundedRuntimeId(event.id), time: { updated: Date.now() } } }
          continue
        }
        if (type === 'agent_start') { yield { event: { type: 'status', status: 'started' } }; continue }
        if (type === 'turn_start') { yield { event: { type: 'status', status: 'processing' } }; continue }
        if (type === 'message_update') {
          const messageEvent = recordValue(event.assistantMessageEvent)
          if (!messageEvent) { yield { event: { type: 'raw', backend: backendName, event: raw } }; continue }
          const messageType = String(messageEvent.type ?? '').replace(/-/g, '_')
          const index = numberValue(messageEvent.contentIndex ?? messageEvent.content_index) ?? nextContentIndex
          nextContentIndex = Math.max(nextContentIndex, index + 1)
          const delta = typeof messageEvent.delta === 'string' ? messageEvent.delta : ''
          if (messageType === 'text_start' || messageType === 'text_delta' || messageType === 'text_end') {
            const current = `${text.get(index) ?? ''}${messageType === 'text_delta' ? delta : messageType === 'text_start' ? '' : ''}`
            text.set(index, current)
            yield { event: textEvent(sessionId, run.id, index, current, messageType === 'text_delta' ? delta : undefined) }
            continue
          }
          if (messageType === 'thinking_start' || messageType === 'thinking_delta' || messageType === 'thinking_end') {
            const current = `${reasoning.get(index) ?? ''}${messageType === 'thinking_delta' ? delta : ''}`
            reasoning.set(index, current)
            yield { event: reasoningEvent(sessionId, run.id, index, current, messageType === 'thinking_delta' ? delta : undefined) }
            continue
          }
          if (messageType.includes('toolcall') || messageType.includes('tool_call')) {
            const tool = toolFromNative(messageEvent)
            if (tool) {
              const part = toolPart(sessionId, run.id, tool.id, tool.name, tool.args, 'pending')
              toolParts.set(tool.id, part)
              yield { event: { type: 'message.part.updated', part } }
            }
            continue
          }
          yield { event: { type: 'raw', backend: backendName, event: raw } }
          continue
        }
        if (type === 'tool_execution_start' || type === 'tool_execution_update' || type === 'tool_execution_end') {
          const tool = toolFromNative(event)
          if (tool) {
            const status = type === 'tool_execution_start' ? 'running' : type === 'tool_execution_end' ? (event.isError ? 'error' : 'completed') : 'running'
            const part = toolPart(sessionId, run.id, tool.id, tool.name, tool.args, status, event)
            toolParts.set(tool.id, part)
            yield { event: { type: 'message.part.updated', part } }
          } else yield { event: { type: 'raw', backend: backendName, event: raw } }
          continue
        }
        if (type === 'extension_ui_request') {
          const interaction = interactionFromPi(run, event)
          if (interaction) {
            run.registerInteraction({ request: interaction.request, nativeId: interaction.nativeId })
            yield { event: { type: 'interaction', request: interaction.request } }
          } else if (isFireAndForgetUi(event)) {
            yield { event: { type: 'raw', backend: backendName, event: raw } }
          } else {
            yield { event: { type: 'warning', code: 'unsupported_interaction', message: 'Pi emitted an interaction shape cli-bridge cannot answer safely' } }
          }
          continue
        }
        if (type === 'turn_end') {
          lastTurnFailure = nativeTurnFailure(event.message)
          const usage = usageFromPi(event)
          if (usage) yield { event: { type: 'raw', backend: backendName, event: usageEnvironmentEvent(usage) } }
          yield { event: { type: 'model-processing', phase: 'generating' } }
          continue
        }
        if (type === 'plan' || type === 'plan_submitted') {
          const plan = recordValue(event.plan)
          const parsedPlan = durablePlanFromNative(plan)
          if (parsedPlan) {
            yield { event: { type: 'plan.submitted', plan: parsedPlan } }
          } else yield { event: { type: 'raw', backend: backendName, event: raw } }
          continue
        }
        if (type === 'error' || event.error) {
          lastTurnFailure = String(event.message ?? recordValue(event.error)?.message ?? 'pi error')
          yield { event: { type: 'raw', backend: backendName, event: raw } }
          continue
        }
        if (type === 'agent_end') {
          // Pi may retry or compact after this low-level boundary. Keep the
          // provider record, but wait for agent_settled before publishing a
          // canonical terminal status.
          yield { event: { type: 'raw', backend: backendName, event: raw } }
          continue
        }
        if (type === 'agent_settled') {
          yield {
            event: {
              type: 'status',
              status: lastTurnFailure ? 'failed' : 'completed',
              ...(lastTurnFailure ? { detail: lastTurnFailure } : {}),
            },
          }
          continue
        }
        yield { event: { type: 'raw', backend: backendName, event: raw } }
      }
    } catch (error) {
      if (!run.signal.aborted) yield { event: { type: 'status', status: 'failed', detail: error instanceof Error ? error.message : String(error) } }
      throw error
    }
  }
}

export function mountRetainedSessions(app: Hono, service: RetainedSessionService): void {
  app.get('/v1/capabilities', async c => {
    const model = c.req.query('model')
    if (!model) {
      return c.json(
        { error: { message: 'model query parameter is required', type: 'invalid_request_error' } },
        400,
      )
    }
    try {
      return c.json(await service.capabilities(model, c.req.raw.signal))
    } catch (error) {
      return retainedError(c, error)
    }
  })

  app.post('/v1/sessions', async c => {
    try {
      const body = await c.req.json()
      return c.json(await service.create(service.parseCreate(body), c.req.raw.signal), 201)
    } catch (error) {
      return retainedError(c, error)
    }
  })

  app.get('/v1/sessions', c => {
    const limit = parseLimit(c.req.query('limit'))
    return c.json({ object: 'list', data: service.list(limit) })
  })

  app.get('/v1/sessions/:id', c => {
    try { return c.json(service.get(c.req.param('id'))) } catch (error) { return retainedError(c, error) }
  })

  app.post('/v1/sessions/:id/turns', async c => {
    try {
      const result = await service.beginTurn(c.req.param('id'), service.parseTurn(await c.req.json()), { signal: c.req.raw.signal })
      return c.json({ session: service.get(c.req.param('id')), run: result.run, context_boundary: result.contextBoundary }, 202)
    } catch (error) { return retainedError(c, error) }
  })

  app.post('/v1/sessions/:id/input', async c => {
    try {
      const result = await service.beginTurn(c.req.param('id'), service.parseTurn(await c.req.json()), { queue: true, signal: c.req.raw.signal })
      return c.json({ session: service.get(c.req.param('id')), run: result.run, context_boundary: result.contextBoundary }, 202)
    } catch (error) { return retainedError(c, error) }
  })

  app.get('/v1/sessions/:id/events', async c => {
    const cursor = parseCursor(c.req.header('last-event-id') ?? c.req.query('cursor'))
    if (!cursor.ok) return c.json({ error: { message: cursor.message, type: 'invalid_replay_cursor' } }, 400)
    try {
      service.assertReplayCursor(c.req.param('id'), cursor.value)
    } catch (error) {
      return retainedError(c, error)
    }
    const controller = new AbortController()
    return streamSSE(c, async stream => {
      stream.onAbort(() => controller.abort())
      try {
        for await (const item of service.events(c.req.param('id'), cursor.value, controller.signal)) {
          await stream.writeSSE({
            id: item.envelope.cursor,
            event: item.envelope.event.type,
            data: JSON.stringify(item.envelope),
          })
        }
      } catch (error) {
        if (!controller.signal.aborted) await stream.writeSSE({ event: 'error', data: JSON.stringify(errorBody(error)) })
      }
    })
  })

  app.get('/v1/runs/:runId/events', async c => {
    const cursor = parseCursor(c.req.header('last-event-id') ?? c.req.query('cursor'))
    if (!cursor.ok) return c.json({ error: { message: cursor.message, type: 'invalid_replay_cursor' } }, 400)
    try {
      service.assertRunReplayCursor(c.req.param('runId'), cursor.value)
    } catch (error) {
      return retainedError(c, error)
    }
    const controller = new AbortController()
    return streamSSE(c, async stream => {
      stream.onAbort(() => controller.abort())
      try {
        for await (const item of service.runEvents(c.req.param('runId'), cursor.value, controller.signal)) {
          await stream.writeSSE({
            id: String(item.envelope.sequence),
            event: item.envelope.event.type,
            data: JSON.stringify(item.envelope),
          })
        }
      } catch (error) {
        if (!controller.signal.aborted) await stream.writeSSE({ event: 'error', data: JSON.stringify(errorBody(error)) })
      }
    })
  })

  app.get('/v1/sessions/:id/transcript', c => {
    try { return c.json(service.transcript(c.req.param('id'))) } catch (error) { return retainedError(c, error) }
  })

  app.get('/v1/sessions/:id/status', c => {
    try { return c.json(service.get(c.req.param('id'))) } catch (error) { return retainedError(c, error) }
  })

  app.post('/v1/sessions/:id/steer', async c => {
    try {
      const body = service.parseSteer(await c.req.json())
      const caller = canonicalCandidateDigest(c.req.header('authorization') ?? 'loopback')
      const result = await service.steer(c.req.param('id'), body, caller)
      return c.json(result.acknowledgement, result.status as 200 | 400 | 404 | 409 | 501 | 502)
    } catch (error) { return retainedError(c, error) }
  })

  app.post('/v1/sessions/:id/cancel', async c => {
    try {
      const wait = parseWaitMs(c.req.query('wait_ms'))
      if (!wait.ok) throw new RetainedSessionError(wait.message, 400, 'invalid_request_error')
      let raw: unknown
      try { raw = await c.req.json() } catch { raw = undefined }
      const body = service.parseCancel(raw)
      const caller = canonicalCandidateDigest(c.req.header('authorization') ?? 'loopback')
      const result = await service.cancel(
        c.req.param('id'),
        wait.value,
        body,
        caller,
      )
      return c.json(
        retainedCancellationAcknowledgement(body, result.acknowledgement),
        result.status as 200 | 400 | 404 | 409 | 501 | 502,
      )
    } catch (error) { return retainedError(c, error) }
  })

  app.post('/v1/sessions/:id/detach', c => {
    try { return c.json({ detached: true, session: service.detach(c.req.param('id')) }) } catch (error) { return retainedError(c, error) }
  })

  app.post('/v1/sessions/:id/close', async c => {
    try { return c.json({ closed: true, session: await service.close(c.req.param('id')) }) } catch (error) { return retainedError(c, error) }
  })

  app.post('/v1/runs/:runId/interactions/:interactionId/respond', async c => {
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: { message: 'invalid JSON body', type: 'invalid_request_error' } }, 400) }
    const caller = canonicalCandidateDigest(c.req.header('authorization') ?? 'loopback')
    const result = await service.respond(body, caller, {
      runId: c.req.param('runId'),
      interactionId: c.req.param('interactionId'),
    })
    return c.json(result.acknowledgement, result.status as 200 | 400 | 404 | 409 | 502)
  })
}

function retainedCancellationAcknowledgement(
  request: AgentRunCancellationRequest,
  internal: RetainedControlAcknowledgement,
): AgentRunCancellationAcknowledgement {
  const outcome = internal.status === 'cancelled'
    ? { status: 'accepted' as const, effect: 'cancelled' as const }
    : internal.status === 'already_terminal'
      ? { status: 'accepted' as const, effect: 'not_live' as const }
      : internal.status === 'accepted' || internal.status === 'pending'
        ? { status: 'accepted' as const, effect: 'cancel_requested' as const }
        : internal.status === 'conflict'
          ? { status: 'conflict' as const, effect: 'unknown' as const }
          : { status: 'unknown' as const, effect: 'unknown' as const }
  const acknowledgement = AgentRunCancellationAcknowledgementSchema.parse({
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    run: request.run,
    ...outcome,
    ...(internal.message ? { message: internal.message } : {}),
    ...(internal.retryable !== undefined ? { retryable: internal.retryable } : {}),
  })
  if (!agentRunCancellationAcknowledgementMatchesRequest(request, acknowledgement)) {
    throw new RetainedSessionError(
      'retained cancellation acknowledgement changed its exact request binding',
      500,
      'server_error',
    )
  }
  return acknowledgement
}

function unknownRunSnapshot(
  runId: string,
  executionId: string,
  requestDigest: string,
  sessionId: string,
): DurableRetainedRunSnapshot {
  return {
    id: runId,
    executionId,
    requestDigest,
    status: 'unknown',
    state: 'detached',
    terminal: false,
    sessionId,
  }
}

function retainedRunSnapshot(
  input: unknown,
  runId: string,
  executionId: string,
  requestDigest: string,
  sessionId: string,
): DurableRetainedRunSnapshot {
  const value = recordValue(input)
  if (
    !value
    || value.id !== runId
    || value.executionId !== executionId
    || value.requestDigest !== requestDigest
    || value.sessionId !== sessionId
    || !['running', 'done', 'error', 'cancelled', 'unknown'].includes(String(value.status))
    || typeof value.terminal !== 'boolean'
  ) {
    throw new RetainedSessionError(
      `retained run ${JSON.stringify(runId)} has an invalid durable admission`,
      500,
      'server_error',
    )
  }
  if (value.status === 'unknown') {
    return unknownRunSnapshot(runId, executionId, requestDigest, sessionId)
  }
  return structuredClone(value) as unknown as RunSnapshot
}

function isNativeBackend(backend: Backend): backend is NativeSessionBackend {
  return 'startNativeSession' in backend && typeof (backend as { startNativeSession?: unknown }).startNativeSession === 'function'
}

function nativeCapabilities(backend: NativeSessionBackend): AgentEnvironmentCapabilities {
  if (!backend.nativeCapabilities) throw new RetainedSessionError(`backend ${JSON.stringify(backend.name)} did not publish native capabilities`, 501, 'capability_denied')
  return backend.nativeCapabilities()
}

async function observeNativeBoundary(
  native: NativeSession,
  input: { runId: string; environmentId: string; sessionId: string },
): Promise<NativeContextBoundaryProof | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), NATIVE_BOUNDARY_TIMEOUT_MS)
    timer.unref?.()
  })
  try {
    let request: Promise<NativeContextBoundaryProof | null>
    try {
      request = Promise.resolve(native.contextBoundary(input)).catch(() => null)
    } catch {
      return null
    }
    return await Promise.race([request, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function assertRetainedCapabilities(capabilities: AgentEnvironmentCapabilities, backendName: string): void {
  if (
    !capabilities.streaming.live
    || !capabilities.streaming.replay
    || !capabilities.streaming.detach
    || !capabilities.streaming.turnIdempotency
    || capabilities.retainedControl?.exactRunIdentity !== true
    || capabilities.retainedControl.resultIdentity !== true
    || capabilities.retainedControl.eventIdentity !== true
    || capabilities.retainedControl.cancellationIdempotency !== true
    || !capabilities.sessions.continue
    || !capabilities.sessions.list
    || !capabilities.sessions.messages
  ) {
    throw new RetainedSessionError(
      `backend ${JSON.stringify(backendName)} does not advertise the complete retained-session contract`,
      501,
      'capability_denied',
    )
  }
}

function renderTurnInput(input: RetainedTurnInput): string {
  return renderInputPartsAsText(normalizeInputParts({
    message: input.message,
    parts: input.parts,
  }))
}

function textEvent(sessionId: string, runId: string, index: number, text: string, delta?: string): StreamEvent {
  const messageID = boundedRuntimeId(`${runId}:message:${index}`)
  return {
    type: 'message.part.updated',
    part: { id: boundedRuntimeId(`${runId}:message:${index}:text`), sessionID: boundedRuntimeId(sessionId), messageID, type: 'text', text },
    ...(delta !== undefined ? { delta } : {}),
  }
}

function reasoningEvent(sessionId: string, runId: string, index: number, text: string, delta?: string): StreamEvent {
  const messageID = boundedRuntimeId(`${runId}:message:${index}`)
  return {
    type: 'message.part.updated',
    part: { id: boundedRuntimeId(`${runId}:message:${index}:reasoning`), sessionID: boundedRuntimeId(sessionId), messageID, type: 'reasoning', text },
    ...(delta !== undefined ? { delta } : {}),
  }
}

function toolPart(
  sessionId: string,
  runId: string,
  id: string,
  name: string,
  args: Record<string, unknown>,
  status: 'pending' | 'running' | 'completed' | 'error',
  event?: Record<string, unknown>,
): Part {
  const input = args
  const now = Date.now()
  let state: ToolState
  if (status === 'pending') {
    state = { status: 'pending', input }
  } else if (status === 'running') {
    state = { status: 'running', input, time: { start: now } }
  } else if (status === 'completed') {
    state = { status: 'completed', input, output: event?.result ?? event?.output ?? null, time: { start: now, end: now } }
  } else {
    state = { status: 'error', input, error: String(event?.error ?? event?.result ?? 'tool failed'), output: event?.result, time: { start: now, end: now } }
  }
  return {
    id: boundedRuntimeId(`${runId}:tool:${id}`),
    sessionID: boundedRuntimeId(sessionId),
    messageID: boundedRuntimeId(`${runId}:message:tools`),
    type: 'tool',
    callID: boundedRuntimeId(id),
    tool: boundedRuntimeId(name),
    state,
  }
}

function toolFromNative(event: Record<string, unknown>): { id: string; name: string; args: Record<string, unknown> } | null {
  const nested = recordValue(event.toolCall)
    ?? recordValue(event.tool_call)
    ?? recordValue(event.partial)
    ?? recordValue(event.content)
    ?? event
  const nestedContent = Array.isArray(nested.content) ? recordValue(nested.content[0]) : null
  const candidate = nestedContent ?? nested
  const id = stringValue(
    event.toolCallId
    ?? event.toolCallID
    ?? event.tool_call_id
    ?? candidate.id
    ?? candidate.callID
    ?? candidate.toolCallId,
  )
  const name = stringValue(event.toolName ?? event.tool_name ?? candidate.name ?? candidate.tool)
  if (!id || !name) return null
  const rawArgs = event.args
    ?? event.input
    ?? event.arguments
    ?? candidate.args
    ?? candidate.arguments
    ?? candidate.input
    ?? {}
  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs) as unknown
      return { id, name, args: recordValue(parsed) ?? { raw: rawArgs } }
    } catch { return { id, name, args: { raw: rawArgs } } }
  }
  return { id, name, args: recordValue(rawArgs) ?? {} }
}

function interactionFromPi(run: Run, event: Record<string, unknown>): { request: InteractionRequest; nativeId: string } | null {
  const nativeId = stringValue(event.id)
  const method = stringValue(event.method)
  if (!nativeId || method !== 'select') return null
  const title = stringValue(event.title)
  if (!title || !piPermissionTokenFromTitle(title)) return null
  const request: InteractionRequest = {
    id: boundedRuntimeId(`${run.id}:interaction:${nativeId}`),
    kind: 'permission',
    title: piPermissionPublicTitle(title),
    ...(stringValue(event.message) ? { body: stringValue(event.message)! } : {}),
    answerSpec: permissionAnswerSpec(),
    responseScopes: ['interaction'],
  }
  const parsed = InteractionRequestSchema.safeParse(request)
  return parsed.success ? { request: parsed.data, nativeId } : null
}

function nativeResponseFor(request: InteractionRequest, response: InteractionResponse): Record<string, unknown> {
  if (response.outcome !== 'accepted') return { cancelled: true }
  const field = request.answerSpec.fields[0]
  const value = response.data?.[field?.name ?? 'value']
  if (field?.type === 'boolean') return { confirmed: value === true }
  if (field?.type === 'select') return { value: Array.isArray(value) ? value[0] : value }
  return { value }
}

function isFireAndForgetUi(event: Record<string, unknown>): boolean {
  return ['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'].includes(String(event.method ?? ''))
}

function usageFromPi(event: Record<string, unknown>): Record<string, number> | null {
  const message = recordValue(event.message)
  const usage = recordValue(event.usage) ?? recordValue(message?.usage)
  if (!usage) return null
  const result: Record<string, number> = {}
  for (const [key, target] of [['input', 'inputTokens'], ['output', 'outputTokens'], ['cacheRead', 'cacheReadInputTokens'], ['cacheWrite', 'cacheCreationInputTokens'], ['reasoning', 'reasoningTokens'], ['cost', 'cost']] as const) {
    const value = usage[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[target] = value
  }
  if (typeof result.inputTokens !== 'number' || typeof result.outputTokens !== 'number') return null
  return result
}

function nativeTurnFailure(message: unknown): string | null {
  const value = recordValue(message)
  if (!value) return null
  const stopReason = typeof value.stopReason === 'string' ? value.stopReason : undefined
  const errorMessage = typeof value.errorMessage === 'string' ? value.errorMessage.trim() : ''
  if (stopReason !== 'error' && errorMessage === '') return null
  return errorMessage !== '' ? errorMessage : `stopReason=${stopReason ?? 'error'}`
}

function durablePlanFromNative(value: Record<string, unknown> | null): DurablePlan | null {
  const parsed = DurablePlanSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function usageEnvironmentEvent(usage: Record<string, number>): AgentEnvironmentEvent {
  return { type: 'usage', data: {}, usage: usage as AgentEnvironmentEvent['usage'] }
}

function isUsageEvent(value: unknown): value is AgentEnvironmentEvent {
  const record = recordValue(value)
  if (record?.type !== 'usage') return false
  const data = recordValue(record.data)
  return recordValue(record.usage) !== null || recordValue(data?.usage) !== null
}

function boundedRuntimeId(candidate: string): string {
  const trimmed = candidate.trim()
  if (trimmed.length > 0 && trimmed.length <= 512) return trimmed
  return `id:${canonicalCandidateDigest(candidate).slice('sha256:'.length)}`
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function parseLimit(raw: string | undefined): number {
  const value = Number.parseInt(raw ?? '50', 10)
  return Number.isSafeInteger(value) ? Math.min(Math.max(value, 1), 500) : 50
}

function parseNonNegativeEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

async function waitForTurnLane(
  predecessor: Promise<void>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  if (signal?.aborted) {
    throw new RetainedSessionError('retained input was cancelled while waiting for turn admission', 408, 'input_queue_aborted')
  }
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onAbort = (): void => finish(() => reject(new RetainedSessionError(
      'retained input was cancelled while waiting for turn admission',
      408,
      'input_queue_aborted',
    )))
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish(() => reject(new RetainedSessionError(
      `retained input waited more than ${timeoutMs}ms for turn admission`,
      408,
      'input_queue_timeout',
    ))), timeoutMs)
    timer.unref?.()
    predecessor.then(
      () => finish(resolve),
      error => finish(() => reject(error)),
    )
  })
}

function parseCursor(raw: string | undefined): { ok: true; value: number } | { ok: false; message: string } {
  if (raw === undefined || raw === '') return { ok: true, value: 0 }
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) return { ok: false, message: 'replay cursor must be a non-negative integer' }
  const value = Number(raw)
  return Number.isSafeInteger(value) ? { ok: true, value } : { ok: false, message: 'replay cursor is too large' }
}

function parseWaitMs(raw: string | undefined): { ok: true; value: number } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, value: 0 }
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) return { ok: false, message: 'wait_ms must be a non-negative integer' }
  const value = Number(raw)
  return Number.isSafeInteger(value) && value <= 30_000
    ? { ok: true, value }
    : { ok: false, message: 'wait_ms must be at most 30000' }
}

async function waitForEventPoll(signal: AbortSignal, waitMs: number): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout>
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = (): void => {
      finish()
    }
    timer = setTimeout(finish, waitMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function waitForEventNotification(
  signal: AbortSignal,
  ready: () => boolean,
  register: (resolve: () => void) => void,
): Promise<void> {
  if (signal.aborted || ready()) return
  await new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
    register(finish)
    // A run can finish without a canonical notification (for example when
    // startup fails), so the periodic reread is the final safety net.
    timer = setTimeout(finish, 50)
    timer.unref?.()
    if (ready()) finish()
  })
}

function controlConflict(
  operationId: string,
  kind: 'steer' | 'cancel',
  sessionId: string,
  runId: string,
): RetainedControlAcknowledgement {
  return {
    operationId,
    kind,
    sessionId,
    runId,
    status: 'conflict',
    message: 'operation id was already used with a different caller or request',
    retryable: false,
  }
}

function statusForControlAcknowledgement(acknowledgement: RetainedControlAcknowledgement): number {
  if (acknowledgement.status === 'unknown_run') return 404
  if (acknowledgement.status === 'capability_denied') return 501
  if (acknowledgement.status === 'effect_unknown') return 502
  if (acknowledgement.status === 'conflict') return 409
  if (acknowledgement.status === 'pending') return 202
  return 200
}

function statusForAcknowledgement(acknowledgement: InteractionAcknowledgement): number {
  if (acknowledgement.status === 'unknown_run' || acknowledgement.status === 'unknown_interaction') return 404
  if (acknowledgement.status === 'invalid_response') return 400
  if (acknowledgement.status === 'transport_failure') return 502
  if (acknowledgement.status === 'already_resolved_different' || acknowledgement.status === 'binding_mismatch' || acknowledgement.status === 'cancelled' || acknowledgement.status === 'expired') return 409
  return 200
}

function readOperationId(value: unknown): string {
  return stringValue(recordValue(value)?.operationId) ?? 'invalid-operation'
}

function readBinding(value: unknown): { runId: string; environmentId: string; interactionId: string; sessionId?: string } {
  const binding = recordValue(recordValue(value)?.binding)
  return {
    runId: stringValue(binding?.runId) ?? 'unknown-run',
    environmentId: stringValue(binding?.environmentId) ?? ENVIRONMENT_ID,
    interactionId: stringValue(binding?.interactionId) ?? 'unknown-interaction',
    ...(stringValue(binding?.sessionId) ? { sessionId: stringValue(binding?.sessionId)! } : {}),
  }
}

function invalidAcknowledgement(
  operationId: string,
  binding: { runId: string; environmentId: string; interactionId: string; sessionId?: string },
  message: string,
): InteractionAcknowledgement {
  return { operationId, binding, status: 'invalid_response', message }
}

function retainedError(c: Context, error: unknown): Response {
  const body = errorBody(error)
  const status = error instanceof RetainedSessionError
    ? error.status
    : error instanceof BackendError
      ? error.code === 'capability_denied' || error.code === 'not_configured' ? 501 : error.code === 'parse_error' ? 400 : 502
      : 500
  return c.json({ error: body }, status as 400 | 408 | 409 | 429 | 500 | 501 | 502 | 503)
}

function errorBody(error: unknown): { message: string; type: string } {
  if (error instanceof RetainedSessionError) return { message: error.message, type: error.code }
  if (error instanceof BackendError) return { message: error.message, type: error.code }
  if (error instanceof Error) return { message: error.message, type: 'server_error' }
  return { message: String(error), type: 'server_error' }
}
