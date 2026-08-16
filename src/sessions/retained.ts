/**
 * Public retained-session facade.
 *
 * Durable state, turn admission, provider control, interaction responses, and
 * event replay each have one owner in `./retained/`. This class only composes
 * those owners and keeps the stable module used by the server and callers.
 */

import {
  AgentEnvironmentCapabilitiesSchema,
  canonicalCandidateDigest,
  type AgentEnvironmentCapabilities,
} from '@tangle-network/agent-interface'
import type { Backend, NativeSessionBackend } from '../backends/types.js'
import type { BackendRegistry } from '../backends/registry.js'
import { boundedProbe, resolveHealthProbeTimeoutMs } from '../backends/health.js'
import {
  type RetainedSessionRecord,
  type RetainedSessionStatus,
  parseSafeRetainedMetadata,
  SessionIdentityConflictError,
  type SessionStore,
} from './store.js'
import { readyNativeBackend } from './retained/capabilities.js'
import { describeInputMaterial, inputPresenceMetadata, RetainedInputMaterialStore } from './retained/input-material.js'
import { RetainedSessionState } from './retained/state.js'
import {
  parseCancel,
  parseCreate,
  parseSteer,
  parseTurn,
  type RetainedCreateInput,
  type RetainedTurnInput,
} from './retained/schema.js'
import { RetainedControl } from './retained/control.js'
import { RetainedEvents } from './retained/events.js'
import { RetainedInteractions } from './retained/interactions.js'
import { TurnLanes } from './retained/turn-lane.js'
import { RetainedTurnRunner } from './retained/turns.js'
import {
  RetainedSessionError,
  type DurableRetainedRunSnapshot,
  type RetainedControlAcknowledgement,
  type RetainedSessionServiceOptions,
  type RetainedSessionView,
  type RetainedTurnResult,
} from './retained/types.js'

const DEFAULT_INPUT_QUEUE_MAX_DEPTH = 16
const DEFAULT_INPUT_QUEUE_TIMEOUT_MS = 30_000

export class RetainedSessionService {
  private readonly store: SessionStore
  private readonly registry: BackendRegistry
  private readonly runs: RetainedSessionServiceOptions['runs']
  private readonly healthProbeTimeoutMs: number
  private readonly state: RetainedSessionState
  private readonly inputMaterial: RetainedInputMaterialStore
  private readonly turns: RetainedTurnRunner
  private readonly control: RetainedControl
  private readonly events: RetainedEvents
  private readonly interactions: RetainedInteractions
  private readonly closures = new Set<string>()

  constructor(options: RetainedSessionServiceOptions) {
    this.store = options.store
    this.registry = options.registry
    this.runs = options.runs
    this.healthProbeTimeoutMs = options.healthProbeTimeoutMs ?? resolveHealthProbeTimeoutMs()
    const maxDepth =
      options.inputQueueMaxDepth ??
      parseNonNegativeEnv('BRIDGE_RETAINED_INPUT_MAX_QUEUE', DEFAULT_INPUT_QUEUE_MAX_DEPTH)
    const timeoutMs =
      options.inputQueueTimeoutMs ??
      parseNonNegativeEnv('BRIDGE_RETAINED_INPUT_QUEUE_TIMEOUT_MS', DEFAULT_INPUT_QUEUE_TIMEOUT_MS)
    assertQueueOption('input queue depth', maxDepth)
    assertQueueOption('input queue timeout', timeoutMs)
    if (!Number.isFinite(this.healthProbeTimeoutMs) || this.healthProbeTimeoutMs < 0) {
      throw new Error(`invalid retained health probe timeout: ${this.healthProbeTimeoutMs}`)
    }

    this.state = new RetainedSessionState(this.store, this.runs)
    this.inputMaterial = new RetainedInputMaterialStore()
    this.interactions = new RetainedInteractions(this.store, this.runs)
    this.turns = new RetainedTurnRunner({
      store: this.store,
      registry: this.registry,
      runs: this.runs,
      state: this.state,
      lanes: new TurnLanes(maxDepth, timeoutMs),
      inputMaterial: this.inputMaterial,
      isClosing: (id) => this.closures.has(id),
      denyUnrequestedInteraction: (input) => this.interactions.denyUnrequestedInteraction(input),
    })
    this.control = new RetainedControl(this.store, this.runs, this.state)
    this.events = new RetainedEvents(this.store, this.runs, this.state)
  }

  parseCreate(value: unknown): RetainedCreateInput {
    return parseCreate(value)
  }

  parseTurn(value: unknown): RetainedTurnInput {
    return parseTurn(value)
  }

  parseSteer(value: unknown): {
    operationId: string
    message: string
    run: Parameters<RetainedControl['steer']>[1]['run']
  } {
    return parseSteer(value)
  }

  parseCancel(value: unknown): Parameters<RetainedControl['cancel']>[2] {
    return parseCancel(value)
  }

  async capabilities(model: string, signal?: AbortSignal): Promise<AgentEnvironmentCapabilities> {
    const { capabilities } = await readyNativeBackend({
      registry: this.registry,
      model,
      healthProbeTimeoutMs: this.healthProbeTimeoutMs,
      signal,
    })
    return capabilities
  }

  async create(input: RetainedCreateInput, signal?: AbortSignal): Promise<RetainedSessionView> {
    if (!input.id && !input.session_id) {
      throw new RetainedSessionError(
        'retained-session creation requires a stable id or session_id',
        400,
        'invalid_request_error',
      )
    }
    const { backend, capabilities } = await readyNativeBackend({
      registry: this.registry,
      model: input.model,
      healthProbeTimeoutMs: this.healthProbeTimeoutMs,
      signal,
    })
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
    const material = describeInputMaterial(input)
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
      ...inputPresenceMetadata(material),
      mode,
    }
    let created: RetainedSessionRecord
    try {
      created = this.store.createRetained({
        id,
        createRequestDigest: canonicalCandidateDigest({
          ...input,
          interaction_policy: 'interactive',
        }),
        backend: backend.name,
        model: input.model,
        cwd: input.cwd ?? null,
        metadata,
        capabilities,
      })
    } catch (error) {
      if (
        error instanceof SessionIdentityConflictError ||
        (error instanceof Error &&
          (/already exists/u.test(error.message) ||
            /UNIQUE constraint failed: retained_sessions\.id/u.test(error.message)))
      ) {
        throw new RetainedSessionError(error.message, 409, 'session_identity_conflict')
      }
      throw error
    }
    this.inputMaterial.record(id, material)
    return this.state.view(created)
  }

  list(limit: number): RetainedSessionView[] {
    return this.store.listRetained(limit).map((record) => this.state.view(this.state.require(record.id)))
  }

  get(id: string): RetainedSessionView {
    return this.state.view(this.state.require(id))
  }

  beginTurn(
    id: string,
    input: RetainedTurnInput,
    options: { queue?: boolean; signal?: AbortSignal } = {},
  ): Promise<RetainedTurnResult> {
    return this.turns.beginTurn(id, input, options)
  }

  steer(
    id: string,
    input: Parameters<RetainedControl['steer']>[1],
    callerId: string,
  ): Promise<{ acknowledgement: RetainedControlAcknowledgement; status: number }> {
    return this.control.steer(id, input, callerId)
  }

  cancel(
    id: string,
    waitMs: number,
    request: Parameters<RetainedControl['cancel']>[2],
    callerId: string,
  ): Promise<{ acknowledgement: RetainedControlAcknowledgement; status: number }> {
    return this.control.cancel(id, waitMs, request, callerId)
  }

  detach(id: string): RetainedSessionView {
    return this.get(id)
  }

  async shutdown(timeoutMs = 5_000): Promise<void> {
    await this.turns.awaitFinalizations(timeoutMs)
  }

  async close(id: string): Promise<RetainedSessionView> {
    this.state.require(id)
    if (this.state.isAdmitting(id)) {
      throw new RetainedSessionError('a retained turn is being admitted', 409, 'active_run')
    }
    if (this.closures.has(id)) {
      throw new RetainedSessionError('retained session is already closing', 409, 'invalid_state')
    }
    this.closures.add(id)
    try {
      const control = this.runs.nativeSession(id)
      if (control && !control.run.snapshot().terminal) {
        throw new RetainedSessionError(
          'active retained runs must be cancelled before the session can close',
          409,
          'active_run',
        )
      }
      if (control) {
        try {
          if (!(await control.run.closeNativeControl(control.session))) {
            throw new RetainedSessionError('native session ownership changed before close', 409, 'invalid_state')
          }
        } catch (error) {
          if (error instanceof RetainedSessionError) throw error
          const latestControl = this.runs.nativeSession(id)
          const latest = this.store.getRetained(id)
          if (
            latestControl?.run === control.run &&
            latestControl.session === control.session &&
            latest?.runId === control.run.id &&
            latest.status !== 'closed' &&
            latest.status !== 'cancelled'
          ) {
            this.store.updateRetained(id, { status: 'unknown' })
          }
          throw new RetainedSessionError(
            `native session close failed: ${error instanceof Error ? error.message : String(error)}`,
            502,
            'close_failed',
          )
        }
      }
      if (this.state.require(id).status !== 'closed') this.store.updateRetained(id, { status: 'closed' })
      this.inputMaterial.forget(id)
      return this.get(id)
    } finally {
      this.closures.delete(id)
    }
  }

  transcript(id: string): Record<string, unknown> {
    return this.events.transcript(id)
  }

  assertReplayCursor(id: string, afterCursor: number): void {
    this.events.assertSessionCursor(id, afterCursor)
  }

  eventsForSession(
    id: string,
    afterCursor: number,
    signal: AbortSignal,
  ): AsyncIterable<import('./store.js').RetainedEventRecord> {
    return this.events.sessionEvents(id, afterCursor, signal)
  }

  assertRunReplayCursor(runId: string, afterSequence: number): void {
    this.events.assertRunCursor(runId, afterSequence)
  }

  runEvents(
    runId: string,
    afterSequence: number,
    signal: AbortSignal,
  ): AsyncIterable<import('./store.js').RetainedEventRecord> {
    return this.events.runEvents(runId, afterSequence, signal)
  }

  runSnapshot(runId: string): DurableRetainedRunSnapshot | null {
    return this.state.runSnapshot(runId)
  }

  respond(
    value: unknown,
    callerId: string,
    routeBinding?: { runId: string; interactionId: string },
  ): Promise<Awaited<ReturnType<RetainedInteractions['respond']>>> {
    return this.interactions.respond(value, callerId, routeBinding)
  }
}

function assertQueueOption(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid retained ${label}: ${value}`)
}

function parseNonNegativeEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

export { RetainedSessionError } from './retained/types.js'
export type {
  DurableRetainedRunSnapshot,
  RetainedControlAcknowledgement,
  RetainedSessionServiceOptions,
  RetainedSessionView,
  RetainedTurnResult,
} from './retained/types.js'
export type { RetainedCreateInput, RetainedTurnInput } from './retained/schema.js'
export { mountRetainedSessions } from './retained/http.js'
