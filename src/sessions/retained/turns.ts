/**
 * Admission and execution of one retained turn.
 *
 * The order here is the contract. The durable run admission is claimed before
 * any provider process starts, the exact run owner is published before the
 * first asynchronous step, and a continuation only proceeds after the native
 * child re-proves its context boundary. A turn that cannot complete every one
 * of those steps leaves the session in a state a caller can act on rather than
 * a plausible-looking one.
 */

import {
  canonicalCandidateDigest,
  normalizeInputParts,
  type NativeContextBoundaryProof,
  type InteractionRequest,
  type RequestedInteractions,
} from '@tangle-network/agent-interface'
import type { BackendRegistry } from '../../backends/registry.js'
import type { ChatRequest, NativeSession } from '../../backends/types.js'
import { RunAdmissionClosedError, RunIdentityConflictError, type RunRegistry } from '../../runs/registry.js'
import type { RetainedSessionRecord, SessionStore } from '../store.js'
import { admittedTurnInteractions, isNativeBackend } from './capabilities.js'
import { assertRetainedBoundaryMatches, verifyRetainedBoundary } from './context-boundary.js'
import { canonicalTurn } from './native-turn.js'
import { retainedRunSnapshot, unknownRunSnapshot, type RetainedSessionState } from './state.js'
import { renderTurnInput, type RetainedTurnInput } from './schema.js'
import {
  parseSafeCallerMetadata,
  parseSafeRetainedMcp,
  parseSafePublicRecord,
  parseSafeRetainedEnv,
  retainedExecutionSchema,
  retainedPublicRecordSchema,
  snapshotRetainedAgentProfile,
  type RetainedExecution,
} from './contract.js'
import { commitCompletedTurn, recoverFailedTurnAdmission } from './turn-commit.js'
import type { TurnLaneOptions, TurnLanes } from './turn-lane.js'
import { ENVIRONMENT_ID, RetainedSessionError, type RetainedTurnResult } from './types.js'

export interface RetainedTurnRunnerOptions {
  store: SessionStore
  registry: BackendRegistry
  runs: RunRegistry
  state: RetainedSessionState
  lanes: TurnLanes
  isClosing: (id: string) => boolean
  denyUnrequestedInteraction: (input: {
    run: import('../../runs/registry.js').Run
    request: InteractionRequest
    nativeId: string
  }) => Promise<void>
}

export interface RetainedBeginTurnOptions extends TurnLaneOptions {
  /** Native continuation callers must compare this inside the turn owner. */
  expectedContextBoundary?: NativeContextBoundaryProof
  /** Report the source proof observed during the same native handoff check. */
  onBoundaryVerified?: (proof: NativeContextBoundaryProof) => void
}

export class RetainedTurnRunner {
  private readonly store: SessionStore
  private readonly registry: BackendRegistry
  private readonly runs: RunRegistry
  private readonly state: RetainedSessionState
  private readonly lanes: TurnLanes
  private readonly isClosing: (id: string) => boolean
  private readonly denyUnrequestedInteraction: RetainedTurnRunnerOptions['denyUnrequestedInteraction']
  /** In-flight durable commits, keyed by run id. */
  private readonly finalizations = new Map<string, Promise<void>>()

  constructor(options: RetainedTurnRunnerOptions) {
    this.store = options.store
    this.registry = options.registry
    this.runs = options.runs
    this.state = options.state
    this.lanes = options.lanes
    this.isClosing = options.isClosing
    this.denyUnrequestedInteraction = options.denyUnrequestedInteraction
  }

  async beginTurn(id: string, input: RetainedTurnInput, options: RetainedBeginTurnOptions = {}): Promise<RetainedTurnResult> {
    if (!input.run_id) {
      throw new RetainedSessionError('retained turns require a stable run_id', 400, 'invalid_request_error')
    }
    this.state.require(id)
    const control = this.runs.nativeSession(id)
    if (!options.queue && ((control && !control.run.snapshot().terminal) || this.lanes.isActive(id))) {
      throw new RetainedSessionError(
        'a turn is already active; use the steering endpoint for active-run input',
        409,
        'active_run',
      )
    }
    const ticket = await this.lanes.acquire(id, options)
    let admitted = false
    try {
      // These check-and-claim operations intentionally contain no await. A
      // close therefore cannot observe the session between turn ownership and
      // native-child attachment, including during a continuation handoff.
      if (this.isClosing(id)) {
        throw new RetainedSessionError('retained session is closing', 409, 'invalid_state')
      }
      this.state.beginAdmission(id)
      admitted = true
      const result = await this.beginTurnNow(id, input, options)
      const run = this.runs.get(result.run.id)
      if (!run) {
        ticket.release()
      } else {
        ticket.releaseAfter(
          (run.snapshot().terminal ? Promise.resolve() : run.whenTerminal()).then(
            () => this.finalizations.get(run.id) ?? Promise.resolve(),
          ),
        )
      }
      return result
    } catch (error) {
      ticket.release()
      throw error
    } finally {
      if (admitted) this.state.endAdmission(id)
    }
  }

  /** Wait for the owned native turn and its durable session finalization. */
  async waitForRun(runId: string): Promise<void> {
    const run = this.runs.get(runId)
    if (!run) throw new RetainedSessionError(`retained run ${JSON.stringify(runId)} is unknown`, 404, 'unknown_session')
    await run.whenTerminal()
    await (this.finalizations.get(runId) ?? Promise.resolve())
  }

  /** Wait for every in-flight durable commit, or report which ones hung. */
  async awaitFinalizations(timeoutMs: number): Promise<void> {
    const pending = [...this.finalizations.values()]
    if (pending.length === 0) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`timed out after ${timeoutMs}ms waiting for ${pending.length} retained finalization(s)`)),
        timeoutMs,
      )
      timer.unref?.()
    })
    try {
      const settled = await Promise.race([Promise.allSettled(pending), timeout])
      const failure = settled.find((item) => item.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async beginTurnNow(
    id: string,
    input: RetainedTurnInput,
    options: RetainedBeginTurnOptions,
  ): Promise<RetainedTurnResult> {
    const retained = this.state.require(id)
    if (retained.status === 'closed' || retained.status === 'cancelled') {
      throw new RetainedSessionError(
        `retained session ${JSON.stringify(id)} is ${retained.status}`,
        409,
        'invalid_state',
      )
    }
    if (options.expectedContextBoundary) assertRetainedBoundaryMatches(retained, options.expectedContextBoundary)
    const prompt = renderTurnInput(input)
    const config = this.requestConfig(retained, input)
    if (config.execution?.kind === 'sandbox') {
      throw new RetainedSessionError(
        'retained native sessions cannot execute in a sandbox; use /v1/chat/completions for sandbox execution',
        501,
        'capability_denied',
      )
    }
    const runId = input.run_id!
    const executionId = input.execution_id ?? input.turn_id ?? runId
    const interactions = admittedTurnInteractions(retained.capabilities, input.interactions)
    const providerName = input.provider ?? ENVIRONMENT_ID
    const environmentId = input.environment_id ?? ENVIRONMENT_ID
    const requestDigest = canonicalCandidateDigest({
      sessionId: id,
      runId,
      executionId,
      provider: providerName,
      environmentId,
      model: retained.model,
      input: normalizeInputParts({ message: input.message, parts: input.parts }),
      interactions,
      turnId: input.turn_id ?? null,
      execution: config.execution ?? null,
      env: config.env ?? null,
      profile: config.profile ?? null,
      mcp: config.mcp ?? null,
      context: config.context ?? null,
      providerOptions: config.providerOptions ?? null,
      metadata: config.metadata,
    })
    if (retained.runId && this.state.hasFinalizationFailure(retained.runId)) {
      throw new RetainedSessionError(
        `native session ${JSON.stringify(id)} has an uncommitted prior turn; its continuation is unknown`,
        409,
        'unknown_session',
      )
    }
    try {
      this.runs.assertAvailable(runId, requestDigest, 'retained')
    } catch (error) {
      if (error instanceof RunIdentityConflictError) {
        throw new RetainedSessionError(error.message, 409, 'run_identity_conflict')
      }
      if (error instanceof RunAdmissionClosedError) {
        throw new RetainedSessionError(error.message, 503, error.code)
      }
      throw error
    }
    const replayed = this.replayedRunAdmission(retained, runId, executionId, providerName, environmentId, requestDigest)
    if (replayed) return replayed
    const existingControl = this.runs.nativeSession(id)
    if (existingControl && !existingControl.run.snapshot().terminal) {
      throw new RetainedSessionError(
        'a turn is already active; use the steering endpoint for active-run input',
        409,
        'active_run',
      )
    }
    if (!existingControl && (retained.turns > 0 || retained.status === 'running' || retained.status === 'unknown')) {
      this.store.updateRetained(id, { status: 'unknown' })
      throw new RetainedSessionError(
        `native session ${JSON.stringify(id)} was lost across bridge restart; its continuation is unknown`,
        404,
        'unknown_session',
      )
    }
    const backend = this.registry.byName(retained.backend)
    if (!backend || !isNativeBackend(backend)) {
      throw new RetainedSessionError(
        `backend ${JSON.stringify(retained.backend)} no longer advertises native sessions`,
        501,
        'capability_denied',
      )
    }
    const existingNative = existingControl?.session ?? null
    if (existingControl && existingNative) {
      const inspected = await existingControl.run.inspectNativeControl(existingNative, async (native) => {
        const proof = await verifyRetainedBoundary(native, retained, runId, {
          provider: providerName,
          environmentId,
          executionId,
          requestDigest,
        })
        options.onBoundaryVerified?.(proof)
      })
      if (!inspected) {
        throw new RetainedSessionError('native session ownership changed before continuation', 409, 'invalid_state')
      }
    }
    let claim: ReturnType<RunRegistry['claim']>
    try {
      claim = this.runs.claim(runId, requestDigest, {
        owner: 'retained',
        sessionId: id,
        executionId,
        provider: providerName,
        environmentId,
        commitCanonicalEvent: (event) =>
          this.store.appendRetainedEvent(id, {
            runId: event.runId,
            eventId: event.eventId,
            sequence: event.sequence,
            ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
            receivedAt: event.receivedAt,
            event: event.event,
          }).envelope,
        onNativeControlLost: ({ reason }) => {
          this.state.recordUnexpectedNativeClose(id, runId, requestDigest, reason)
        },
      })
    } catch (error) {
      if (error instanceof RunIdentityConflictError) {
        throw new RetainedSessionError(error.message, 409, 'run_identity_conflict')
      }
      if (error instanceof RunAdmissionClosedError) {
        throw new RetainedSessionError(error.message, 503, error.code)
      }
      throw error
    }
    let durableClaim: ReturnType<SessionStore['claimRetainedRun']>
    try {
      durableClaim = this.store.claimRetainedRun({
        runId,
        sessionId: id,
        executionId,
        requestDigest,
        provider: providerName,
        environmentId,
        snapshot: unknownRunSnapshot(runId, executionId, requestDigest, id, {
          provider: providerName,
          environmentId,
        }),
      })
    } catch (error) {
      if (claim.created) this.runs.releaseClaim(runId, claim.run)
      throw error
    }
    if (durableClaim.kind === 'conflict') {
      if (claim.created) this.runs.releaseClaim(runId, claim.run)
      throw new RetainedSessionError(
        `run ${JSON.stringify(runId)} is already bound to a different request`,
        409,
        'run_identity_conflict',
      )
    }
    if (durableClaim.kind === 'replayed') {
      if (claim.created) this.runs.releaseClaim(runId, claim.run)
      return this.replayedRunAdmission(retained, runId, executionId, providerName, environmentId, requestDigest)!
    }
    const run = claim.run
    if (!claim.created) {
      this.store.updateRetainedRun(runId, requestDigest, run.snapshot())
      return {
        session: this.state.require(id),
        run: run.snapshot(),
        contextBoundary: this.state.require(id).contextBoundary,
      }
    }
    let releaseNativeAttachment: (() => void) | null = null
    let native: NativeSession | null = existingNative
    let nativeOwnedByRun = false
    try {
      // Publish the exact run owner before the first asynchronous startup or
      // transfer step. If either write fails, the catch below terminalizes the
      // in-memory claim before any provider process can be started.
      this.store.updateRetainedRun(runId, requestDigest, run.snapshot())
      this.store.updateRetained(id, { status: 'running', runId })
      releaseNativeAttachment = run.reserveNativeControlAttachment()
      const request = this.requestFor(retained, input, prompt, interactions, config)
      try {
        if (!native) {
          native = await backend.startNativeSession(request, sessionRecordFor(retained), run.signal)
          run.setNativeControl(native)
          nativeOwnedByRun = true
        } else {
          if (!existingControl) {
            throw new RetainedSessionError(
              'native session ownership disappeared before continuation',
              409,
              'invalid_state',
            )
          }
          if (!(await existingControl.run.takeNativeControl(native))) {
            throw new RetainedSessionError('native session ownership changed before continuation', 409, 'invalid_state')
          }
          run.setNativeControl(native)
          nativeOwnedByRun = true
        }
      } finally {
        releaseNativeAttachment?.()
        releaseNativeAttachment = null
      }
      if (run.signal.aborted) {
        throw new RetainedSessionError(
          'retained turn was cancelled during native startup or transfer',
          409,
          'cancelled',
        )
      }
      this.store.updateRetained(id, {
        status: 'running',
        runId,
        ...(native.providerSessionId() ? { internalId: native.providerSessionId() } : {}),
        ...(request.profile_materialization_receipt
          ? {
              profileMaterializationReceipt: request.profile_materialization_receipt as unknown as Record<
                string,
                unknown
              >,
            }
          : {}),
      })
      const settledNative = native
      const pump = run.pumpCanonical(
        canonicalTurn({
          native: settledNative,
          run,
          sessionId: id,
          prompt,
          backendName: retained.backend,
          providerName,
          environmentId,
          interactions,
          onUnrequestedInteraction: (interaction) => this.denyUnrequestedInteraction(interaction),
          onProviderSessionId: (providerSessionId) => this.store.updateRetained(id, { internalId: providerSessionId }),
        }),
      )
      const finalization = pump
        .then(() =>
          commitCompletedTurn({
            store: this.store,
            sessionId: id,
            runId,
            requestDigest,
            backend: retained.backend,
            provider: providerName,
            environmentId,
            run,
            native: settledNative,
          }),
        )
        .catch((error) => {
          const failure = error instanceof Error ? error : new Error(String(error))
          this.state.recordFinalizationFailure(runId, failure)
          this.state.markUnknown(id, runId, requestDigest, run)
          console.error(`[cli-bridge] retained run ${runId} finalization was not durably committed:`, failure)
          throw failure
        })
      this.finalizations.set(runId, finalization)
      void finalization.then(
        () => {
          if (this.finalizations.get(runId) === finalization) this.finalizations.delete(runId)
        },
        () => {
          if (this.finalizations.get(runId) === finalization) this.finalizations.delete(runId)
        },
      )
    } catch (error) {
      releaseNativeAttachment?.()
      return recoverFailedTurnAdmission({
        store: this.store,
        sessionId: id,
        runId,
        requestDigest,
        run,
        error,
        nativeOwnedByRun,
        priorTurns: retained.turns,
      })
    }
    const updated = this.state.require(id)
    return { session: updated, run: run.snapshot(), contextBoundary: updated.contextBoundary }
  }

  private replayedRunAdmission(
    retained: RetainedSessionRecord,
    runId: string,
    executionId: string,
    providerName: string,
    environmentId: string,
    requestDigest: string,
  ): RetainedTurnResult | null {
    const admission = this.store.getRetainedRun(runId)
    if (!admission) return null
    if (
      admission.sessionId !== retained.id ||
      admission.executionId !== executionId ||
      admission.requestDigest !== requestDigest ||
      admission.provider !== providerName ||
      admission.environmentId !== environmentId
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
      const session = this.state.require(retained.id)
      return { session, run: snapshot, contextBoundary: session.contextBoundary }
    }
    const coordinates = { provider: admission.provider, environmentId: admission.environmentId }
    const persisted = retainedRunSnapshot(
      admission.snapshot,
      runId,
      admission.executionId,
      requestDigest,
      retained.id,
      coordinates,
    )
    const snapshot = persisted.terminal
      ? persisted
      : unknownRunSnapshot(runId, admission.executionId, requestDigest, retained.id, coordinates)
    if (!persisted.terminal) {
      this.store.updateRetainedRun(runId, requestDigest, snapshot)
      this.store.updateRetained(retained.id, { status: 'unknown', runId })
    }
    const session = this.state.require(retained.id)
    return { session, run: snapshot, contextBoundary: session.contextBoundary }
  }

  private requestFor(
    record: RetainedSessionRecord,
    input: RetainedTurnInput,
    prompt: string,
    interactions: RequestedInteractions,
    config: RetainedRequestConfig,
  ): ChatRequest {
    const mode = record.metadata.mode
    return {
      model: record.model,
      messages: [{
        role: 'user',
        content: input.parts ? normalizeInputParts({ message: input.message, parts: input.parts }) : prompt,
      }],
      session_id: record.id,
      interaction_policy: 'interactive',
      interactions,
      ...(record.cwd ? { cwd: record.cwd } : {}),
      ...(typeof mode === 'string' ? { mode: mode as ChatRequest['mode'] } : {}),
      ...(config.execution ? { execution: config.execution as ChatRequest['execution'] } : {}),
      ...(config.env ? { env: config.env } : {}),
      ...(config.context ? { context: config.context } : {}),
      ...(config.providerOptions ? { providerOptions: config.providerOptions } : {}),
      ...(config.profile !== undefined ? { agent_profile: config.profile as ChatRequest['agent_profile'] } : {}),
      ...(config.mcp ? { mcp: config.mcp as ChatRequest['mcp'] } : {}),
      ...(Object.keys(config.metadata).length > 0 ? { metadata: config.metadata } : {}),
    }
  }

  private requestConfig(record: RetainedSessionRecord, input: RetainedTurnInput): RetainedRequestConfig {
    let profile = record.metadata.agent_profile
    let mcp = record.metadata.mcp
    if (record.metadata.mcp !== undefined) {
      try {
        mcp = parseSafeRetainedMcp(record.metadata.mcp)
      } catch (error) {
        throw new RetainedSessionError(
          error instanceof Error ? error.message : String(error),
          409,
          'unknown_session',
        )
      }
    }
    if (record.metadata.agent_profile !== undefined) {
      try {
        profile = snapshotRetainedAgentProfile(record.metadata.agent_profile)
      } catch (error) {
        throw new RetainedSessionError(
          error instanceof Error ? error.message : String(error),
          409,
          'unknown_session',
        )
      }
    }
    const execution = parseRetainedExecution(input.execution ?? record.metadata.execution)
    let env: Record<string, string> | undefined
    try {
      const rawEnv = input.env ?? record.metadata.env
      env = rawEnv === undefined ? undefined : parseSafeRetainedEnv(rawEnv)
    } catch (error) {
      throw new RetainedSessionError(
        error instanceof Error ? error.message : String(error),
        409,
        'unknown_session',
      )
    }
    let inputMetadata: Record<string, unknown>
    let inputContext: Record<string, unknown>
    let inputProviderOptions: Record<string, unknown>
    try {
      inputMetadata = parseSafeCallerMetadata(input.metadata)
      inputContext = input.context === undefined ? {} : parseSafePublicRecord(input.context, 'retained context')
      inputProviderOptions = input.provider_options === undefined
        ? {}
        : parseSafePublicRecord(input.provider_options, 'retained provider options')
    } catch (error) {
      throw new RetainedSessionError(
        error instanceof Error ? error.message : String(error),
        400,
        'invalid_request_error',
      )
    }
    const persistedMetadata = record.metadata.metadata === undefined
      ? {}
      : parsePersistedRecord(record.metadata.metadata, 'retained metadata')
    const persistedContext = record.metadata.context === undefined
      ? {}
      : parsePersistedRecord(record.metadata.context, 'retained context')
    const persistedProviderOptions = record.metadata.provider_options === undefined
      ? {}
      : parsePersistedRecord(record.metadata.provider_options, 'retained provider options')
    const context = { ...persistedContext, ...inputContext }
    const providerOptions = { ...persistedProviderOptions, ...inputProviderOptions }
    const metadata = {
      ...objectRecord(record.metadata, new Set([
        'mode',
        'execution',
        'env',
        'agent_profile',
        'mcp',
        'metadata',
        'context',
        'provider_options',
      ])),
      ...(persistedMetadata && typeof persistedMetadata === 'object' && !Array.isArray(persistedMetadata) ? persistedMetadata : {}),
      ...inputMetadata,
    }
    return {
      ...(execution ? { execution } : {}),
      ...(env ? { env } : {}),
      ...(Object.keys(context).length > 0 ? { context } : {}),
      ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
      ...(profile !== undefined ? { profile } : {}),
      ...(mcp && typeof mcp === 'object' ? { mcp: mcp as Record<string, unknown> } : {}),
      metadata,
    }
  }
}

interface RetainedRequestConfig {
  execution?: RetainedExecution
  env?: Record<string, string>
  context?: Record<string, unknown>
  providerOptions?: Record<string, unknown>
  profile?: unknown
  mcp?: Record<string, unknown>
  metadata: Record<string, unknown>
}

function parseRetainedExecution(value: unknown): RetainedExecution | undefined {
  if (value === undefined) return undefined
  const parsed = retainedExecutionSchema.safeParse(value)
  if (!parsed.success) {
    throw new RetainedSessionError(
      'retained execution configuration is no longer supported by this bridge',
      409,
      'unknown_session',
    )
  }
  return parsed.data
}

function parsePersistedRecord(value: unknown, label: string): Record<string, unknown> {
  try {
    return parseSafePublicRecord(value, label)
  } catch (error) {
    throw new RetainedSessionError(
      error instanceof Error ? error.message : String(error),
      409,
      'unknown_session',
    )
  }
}

function objectRecord(value: Record<string, unknown>, excluded: Set<string>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (excluded.has(key)) continue
    if (retainedPublicRecordSchema.safeParse({ [key]: item }).success) result[key] = item
  }
  return result
}

function sessionRecordFor(record: RetainedSessionRecord): {
  externalId: string
  backend: string
  internalId: string
  cwd: string | null
  turns: number
  createdAt: number
  lastUsedAt: number
  metadata: Record<string, unknown>
} {
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
