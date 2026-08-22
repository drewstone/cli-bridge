import { once } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { Hono } from 'hono'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { Backend, BackendHealth, ChatDelta, ChatRequest, NativeSession, NativeSessionBackend } from '../src/backends/types.js'
import type { SessionRecord, SessionStore } from '../src/sessions/store.js'
import { SessionStore as SqliteSessionStore } from '../src/sessions/store.js'
import { RunRegistry, RunShutdownTimeoutError } from '../src/runs/registry.js'
import { mountRuns } from '../src/routes/runs.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import {
  RetainedSessionService,
  mountRetainedSessions,
} from '../src/sessions/retained.js'
import {
  agentRunCancellationRequestDigest,
  AgentNativeContextContinuationResultSchema,
  agentNativeContextContinuationResultMatchesRequest,
  canonicalCandidateDigest,
  defineAgentProfileSecretRef,
  type InteractionBinding,
  type InteractionAcknowledgement,
  type InteractionRequest,
  type InteractionResponse,
  type InteractionResponseCommand,
  type AgentEnvironmentCapabilities,
  type NativeContextBoundaryProof,
  type NativeContextContinuationRequest,
} from '@tangle-network/agent-interface'
import {
  interactionResponseCommandDigest,
  nativeContextContinuationRequestDigest,
  nativeContextContinuationTurnDigest,
} from '@tangle-network/agent-interface'
import {
  createInteractionOperationSchema,
  MAX_ACKNOWLEDGED_INTERACTION_OPERATIONS,
  RetainedInteractionLedger,
} from '../src/sessions/retained/interaction-store.js'
import {
  RETAINED_MAX_HTTP_BODY_BYTES,
  RETAINED_MAX_TEXT_LENGTH,
} from '../src/sessions/retained/schema.js'
import { parseSafePublicRecord } from '../src/sessions/retained/contract.js'

const capabilities: AgentEnvironmentCapabilities = {
  profile: {
    namedProfiles: false,
    systemPrompt: { replace: true, append: true },
    instructions: true,
    tools: true,
    permissions: true,
    mcp: false,
    subagents: false,
    resources: { files: false, instructions: true },
    runtimeUpdate: false,
    validation: true,
  },
  streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
  retainedControl: {
    exactRunIdentity: true,
    resultIdentity: true,
    eventIdentity: true,
    cancellationIdempotency: true,
  },
  nativeContinuation: {
    atomicBoundary: true,
    requestIdempotency: true,
  },
  sessions: { continue: true, list: true, messages: true },
  interactions: {
    kinds: ['question', 'permission'],
    answerFieldTypes: ['text', 'boolean', 'select'],
    responseScopes: ['interaction'],
    secretAnswers: false,
    concurrentRequests: false,
    replay: true,
    responseIdempotency: true,
  },
  workspace: { read: true, write: true, exec: true, git: true, upload: false, download: false },
  branching: { checkpoint: false, fork: false },
  placement: true,
  usage: true,
  confidential: false,
}

const conditionListeners = new Set<() => void>()

function notifyConditionChanged(): void {
  for (const listener of [...conditionListeners]) listener()
}

class FakeNative implements NativeSession {
  readonly capabilities = capabilities
  private count = 0
  private released = false
  protected response: (() => void) | null = null
  private aborted = false
  responseCalls = 0
  closeCalls = 0
  readonly steers: string[] = []
  readonly prompts: string[] = []
  private latestSteer: string | null = null
  private closed = false
  private readonly closeListeners = new Set<(reason: Error) => void>()

  constructor(private readonly backendName = 'pi') {}

  providerSessionId(): string | null { return `${this.backendName}-fake-session` }

  isClosed(): boolean { return this.closed }

  onClose(listener: (reason: Error) => void): () => void {
    if (this.closed) {
      queueMicrotask(() => listener(new Error('fake native session closed')))
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  whenClosed(): Promise<void> {
    if (this.closed) return Promise.resolve()
    return new Promise(resolve => {
      const unsubscribe = this.onClose(() => {
        unsubscribe()
        resolve()
      })
    })
  }

  crash(reason = new Error('fake native process crashed')): void {
    if (this.closed) return
    this.closed = true
    for (const listener of [...this.closeListeners]) listener(reason)
    this.closeListeners.clear()
    notifyConditionChanged()
  }

  async *turn(prompt: string, signal: AbortSignal): AsyncIterable<unknown> {
    this.prompts.push(prompt)
    this.count += 1
    notifyConditionChanged()
    yield { type: 'session', id: `${this.backendName}-fake-session` }
    yield { type: 'agent_start' }
    yield { type: 'turn_start' }
    if (prompt === 'rich') {
      yield {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'reasoning' },
      }
      yield {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_start',
          contentIndex: 1,
          partial: { content: [{ type: 'toolCall', id: 'tool-1', name: 'read_file', arguments: { path: 'README.md' } }] },
        },
      }
      yield { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read_file', args: { path: 'README.md' } }
      yield { type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'read_file', args: { path: 'README.md' }, result: 'contents' }
      yield {
        type: 'plan',
        plan: { id: 'plan-1', revision: 1, title: 'Inspect', body: 'Read the file', submittedAt: '2026-08-02T00:00:00.000Z' },
      }
      yield {
        type: 'extension_ui_request',
        id: 'permission-rich',
        method: 'select',
        title: 'Permission: read_file [cli-bridge-marker:fake-rich]',
        options: ['allow_once', 'deny'],
      }
      await new Promise<void>((resolve, reject) => {
        this.response = resolve
        const onAbort = (): void => reject(new Error('aborted'))
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }
    if (prompt === 'uninstrumented') {
      yield { type: 'extension_ui_request', id: 'native-input', method: 'input', title: 'Question', message: 'Which file?' }
    }
    if (prompt === 'ask') {
      yield {
        type: 'extension_ui_request',
        id: 'ui-1',
        method: 'select',
        title: 'Permission: bash [cli-bridge-marker:fake-ask]',
        options: ['allow_once', 'deny'],
      }
      await new Promise<void>((resolve, reject) => {
        this.response = resolve
        const onAbort = (): void => reject(new Error('aborted'))
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }
    if (prompt === 'end-with-ask') {
      yield {
        type: 'extension_ui_request',
        id: 'ui-terminal',
        method: 'select',
        title: 'Permission: bash [cli-bridge-marker:fake-terminal]',
        options: ['allow_once', 'deny'],
      }
    }
    if (prompt === 'identity') yield { type: 'synthetic_observation', provider: this.backendName }
    if (this.aborted || signal.aborted) throw new Error('aborted')
    yield {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: this.latestSteer ? `steered-${this.latestSteer}` : `reply-${this.count}`,
      },
    }
    yield { type: 'turn_end', message: { usage: { input: 3, output: 2 } } }
    yield { type: 'agent_end' }
    yield { type: 'agent_settled' }
  }

  steer(prompt: string): Promise<void> {
    this.steers.push(prompt)
    this.latestSteer = prompt
    notifyConditionChanged()
    return Promise.resolve()
  }

  async abort(): Promise<void> {
    this.aborted = true
    notifyConditionChanged()
    this.response?.()
  }

  async respondToNativeInteraction(_id: string, response: Record<string, unknown>): Promise<void> {
    this.responseCalls += 1
    notifyConditionChanged()
    this.response?.()
  }

  async contextBoundary(input: {
    runId: string
    provider: string
    environmentId: string
    sessionId: string
    executionId: string
    requestDigest: string
  }): Promise<NativeContextBoundaryProof | null> {
    return {
      runId: input.runId,
      provider: input.provider,
      environmentId: input.environmentId,
      sessionId: input.sessionId,
      executionId: input.executionId,
      requestDigest: input.requestDigest as `sha256:${string}`,
      boundary: { kind: 'revision', revision: `fake:${this.count}` },
      observedAt: new Date().toISOString(),
    }
  }

  close(): Promise<void> {
    this.closeCalls += 1
    notifyConditionChanged()
    this.crash(new Error('fake native session closed'))
    return Promise.resolve()
  }

  release(): void { this.released = true }
}

class DeferredResponseNative extends FakeNative {
  private readonly responseReady: Promise<void>
  private releaseResponse!: () => void
  responseCompleted = false

  constructor() {
    super()
    this.responseReady = new Promise(resolve => { this.releaseResponse = resolve })
  }

  allowResponse(): void { this.releaseResponse() }

  override async respondToNativeInteraction(): Promise<void> {
    this.responseCalls += 1
    notifyConditionChanged()
    await this.responseReady
    this.responseCompleted = true
    this.response?.()
  }
}

class BeforeNativeResponseFailure extends FakeNative {
  override async respondToNativeInteraction(): Promise<void> {
    this.responseCalls += 1
    notifyConditionChanged()
    this.response?.()
    throw new Error('injected failure before native response effect')
  }
}

class AfterNativeResponseFailure extends FakeNative {
  effectCount = 0

  override async respondToNativeInteraction(): Promise<void> {
    this.responseCalls += 1
    this.effectCount += 1
    notifyConditionChanged()
    this.response?.()
    throw new Error('injected failure after native response effect')
  }
}

class CrashAfterNativeStore extends SqliteSessionStore {
  override recordInteractionEffect(
    operationId: string,
    requestDigest: string,
    responseDigest: string,
  ): ReturnType<SqliteSessionStore['recordInteractionEffect']> {
    void operationId
    void requestDigest
    void responseDigest
    throw new Error('injected crash after native response')
  }

  override markInteractionEffectUnknown(
    operationId: string,
    requestDigest: string,
    responseDigest: string,
    acknowledgement: Parameters<SqliteSessionStore['markInteractionEffectUnknown']>[3],
  ): ReturnType<SqliteSessionStore['markInteractionEffectUnknown']> {
    void operationId
    void requestDigest
    void responseDigest
    void acknowledgement
    throw new Error('injected process loss before unknown acknowledgement')
  }
}

class CrashAfterResolveStore extends SqliteSessionStore {
  override recordInteractionOperation(
    input: Parameters<SqliteSessionStore['recordInteractionOperation']>[0],
  ): ReturnType<SqliteSessionStore['recordInteractionOperation']> {
    if (input.acknowledgement.status === 'accepted') {
      throw new Error('injected crash after interaction resolve')
    }
    return super.recordInteractionOperation(input)
  }
}

class CrashAfterAcknowledgementStore extends SqliteSessionStore {
  private threw = false

  override recordInteractionOperation(
    input: Parameters<SqliteSessionStore['recordInteractionOperation']>[0],
  ): ReturnType<SqliteSessionStore['recordInteractionOperation']> {
    const result = super.recordInteractionOperation(input)
    if (!this.threw && input.acknowledgement.status === 'accepted') {
      this.threw = true
      throw new Error('injected crash after acknowledgement persistence')
    }
    return result
  }
}

class CrashBeforeNativeContinuationSettleStore extends SqliteSessionStore {
  private crashed = false

  override updateRetainedControlOperation(
    operationId: string,
    requestDigest: string,
    acknowledgement: Record<string, unknown>,
  ): ReturnType<SqliteSessionStore['updateRetainedControlOperation']> {
    if (!this.crashed && acknowledgement.status === 'completed') {
      this.crashed = true
      throw new Error('injected crash before native continuation settle')
    }
    return super.updateRetainedControlOperation(operationId, requestDigest, acknowledgement)
  }
}

class DeferredBoundaryNative extends FakeNative {
  private releaseBoundary!: () => void
  private signalBoundaryStarted!: () => void
  readonly boundaryStarted: Promise<void>
  private readonly boundaryReady: Promise<void>

  constructor() {
    super()
    this.boundaryStarted = new Promise(resolve => { this.signalBoundaryStarted = resolve })
    this.boundaryReady = new Promise(resolve => { this.releaseBoundary = resolve })
  }

  allowBoundary(): void { this.releaseBoundary() }

  override async contextBoundary(
    input: Parameters<NativeSession['contextBoundary']>[0],
  ): Promise<NativeContextBoundaryProof | null> {
    this.signalBoundaryStarted()
    await this.boundaryReady
    return await super.contextBoundary(input)
  }
}

class DeferredCloseNative extends FakeNative {
  private releaseClose!: () => void
  private signalCloseStarted!: () => void
  readonly closeStarted: Promise<void>
  private readonly closeReady: Promise<void>
  boundaryDuringCloseCalls = 0

  constructor() {
    super()
    this.closeStarted = new Promise(resolve => { this.signalCloseStarted = resolve })
    this.closeReady = new Promise(resolve => { this.releaseClose = resolve })
  }

  allowClose(): void { this.releaseClose() }

  override contextBoundary(
    input: Parameters<NativeSession['contextBoundary']>[0],
  ): Promise<NativeContextBoundaryProof | null> {
    if (this.closeCalls > 0 && !this.isClosed()) {
      this.boundaryDuringCloseCalls += 1
      return Promise.reject(new Error('boundary inspection overlapped native close'))
    }
    return super.contextBoundary(input)
  }

  override async close(): Promise<void> {
    this.closeCalls += 1
    notifyConditionChanged()
    this.signalCloseStarted()
    await this.closeReady
    this.crash(new Error('fake native session closed'))
  }
}

class CloseFailureContinuationNative extends FakeNative {
  private signalCloseStarted!: () => void
  private signalSecondTurnStarted!: () => void
  private releaseCloseFailure!: () => void
  private releaseSecondTurn!: () => void
  readonly closeStarted: Promise<void>
  readonly secondTurnStarted: Promise<void>
  private readonly closeFailureReady: Promise<void>
  private readonly secondTurnReady: Promise<void>
  private failedClose = false

  constructor() {
    super()
    this.closeStarted = new Promise(resolve => { this.signalCloseStarted = resolve })
    this.secondTurnStarted = new Promise(resolve => { this.signalSecondTurnStarted = resolve })
    this.closeFailureReady = new Promise(resolve => { this.releaseCloseFailure = resolve })
    this.secondTurnReady = new Promise(resolve => { this.releaseSecondTurn = resolve })
  }

  allowCloseFailure(): void { this.releaseCloseFailure() }

  allowSecondTurn(): void { this.releaseSecondTurn() }

  override async *turn(prompt: string, signal: AbortSignal): AsyncIterable<unknown> {
    if (this.prompts.length === 1) {
      this.signalSecondTurnStarted()
      await this.secondTurnReady
    }
    yield* super.turn(prompt, signal)
  }

  override async close(): Promise<void> {
    if (!this.failedClose) {
      this.failedClose = true
      this.closeCalls += 1
      notifyConditionChanged()
      this.signalCloseStarted()
      await this.closeFailureReady
      throw new Error('transient close failure')
    }
    return await super.close()
  }
}

class DeferredSecondTurnNative extends FakeNative {
  private signalSecondTurnStarted!: () => void
  private releaseSecondTurn!: () => void
  readonly secondTurnStarted: Promise<void>
  private readonly secondTurnReady: Promise<void>

  constructor() {
    super()
    this.secondTurnStarted = new Promise(resolve => { this.signalSecondTurnStarted = resolve })
    this.secondTurnReady = new Promise(resolve => { this.releaseSecondTurn = resolve })
  }

  allowSecondTurn(): void { this.releaseSecondTurn() }

  override async *turn(prompt: string, signal: AbortSignal): AsyncIterable<unknown> {
    if (this.prompts.length === 1) {
      this.signalSecondTurnStarted()
      await this.secondTurnReady
    }
    yield* super.turn(prompt, signal)
  }
}

class HangingNative extends FakeNative {
  override async *turn(_prompt: string, signal: AbortSignal): AsyncIterable<unknown> {
    yield { type: 'session', id: 'pi-hanging' }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(new Error('aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      void resolve
    })
  }
}

class NeverClosingNative extends FakeNative {
  override close(): Promise<void> { return new Promise(() => {}) }
}

class RejectingCloseNative extends FakeNative {
  override close(): Promise<void> {
    this.closeCalls += 1
    return Promise.reject(new Error('injected native cleanup failure'))
  }
}

class RejectingAbortNative extends FakeNative {
  override abort(): Promise<void> { return Promise.reject(new Error('injected native abort failure')) }
}

class RejectingAbortAndCloseNative extends RejectingCloseNative {
  override abort(): Promise<void> { return Promise.reject(new Error('injected native abort failure')) }
}

class FailOnceCloseNative extends FakeNative {
  override close(): Promise<void> {
    if (this.closeCalls === 0) {
      this.closeCalls += 1
      notifyConditionChanged()
      return Promise.reject(new Error('transient close failure'))
    }
    return super.close()
  }
}

class SyncThrowWhenClosedNative extends FakeNative {
  override whenClosed(): Promise<void> { throw new Error('synchronous whenClosed failure') }
}

class FailOnceUnexpectedCleanupNative extends FakeNative {
  whenClosedCalls = 0

  override whenClosed(): Promise<void> {
    this.whenClosedCalls += 1
    notifyConditionChanged()
    if (this.whenClosedCalls === 1) return Promise.reject(new Error('unexpected-close cleanup failed'))
    return super.whenClosed()
  }
}

class PrematureNative extends FakeNative {
  override async *turn(_prompt: string, _signal: AbortSignal): AsyncIterable<unknown> {
    yield { type: 'session', id: 'pi-premature' }
    yield {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' },
    }
  }
}

class UnverifiedNative extends FakeNative {
  override contextBoundary(): Promise<null> { return Promise.resolve(null) }
}

class FreshBoundaryNative extends FakeNative {
  private boundaryObservations = 0

  override async contextBoundary(
    input: Parameters<NativeSession['contextBoundary']>[0],
  ): Promise<NativeContextBoundaryProof | null> {
    const proof = await super.contextBoundary(input)
    if (!proof) return null
    this.boundaryObservations += 1
    return {
      ...proof,
      observedAt: new Date(Date.parse(proof.observedAt) + this.boundaryObservations).toISOString(),
    }
  }
}

class FakeNativeBackend implements NativeSessionBackend {
  readonly nativeModes = ['byob'] as const
  readonly natives: FakeNative[] = []
  readonly requests: ChatRequest[] = []
  constructor(
    private readonly makeNative: () => FakeNative = () => new FakeNative(),
    readonly name = 'pi',
  ) {}
  matches(model: string): boolean { return model === this.name || model.startsWith(`${this.name}/`) }
  nativeCapabilities(): AgentEnvironmentCapabilities { return capabilities }
  health(): Promise<BackendHealth> { return Promise.resolve({ name: this.name, state: 'ready' }) }
  async startNativeSession(req: ChatRequest): Promise<NativeSession> {
    req.profile_materialization_receipt = {
      schema: 'cli-bridge.profile-materialization.v2',
      effectiveProfileDigest: ('sha256:' + 'b'.repeat(64)) as `sha256:${string}`,
      harness: this.name,
      provider: null,
      model: req.model,
      reasoningEffort: { requested: null, applied: null },
      workspacePlanDigest: ('sha256:' + 'a'.repeat(64)) as `sha256:${string}`,
      files: [],
      unsupported: [],
    }
    this.requests.push(structuredClone(req))
    const native = this.makeNative()
    this.natives.push(native)
    return native
  }
  async *chat(_req: ChatRequest, _session: SessionRecord | null, _signal: AbortSignal): AsyncIterable<ChatDelta> {
    yield { content: 'one-shot', finish_reason: 'stop' }
  }
}

class DeferredStartNativeBackend extends FakeNativeBackend {
  private signalStart!: () => void
  private releaseStart!: () => void
  readonly startEntered: Promise<void>
  private readonly startReady: Promise<void>

  constructor(makeNative: () => FakeNative = () => new FakeNative()) {
    super(makeNative)
    this.startEntered = new Promise(resolve => { this.signalStart = resolve })
    this.startReady = new Promise(resolve => { this.releaseStart = resolve })
  }

  allowStart(): void { this.releaseStart() }

  override async startNativeSession(req: ChatRequest): Promise<NativeSession> {
    this.signalStart()
    await this.startReady
    return await super.startNativeSession(req)
  }
}

class NotReadyNativeBackend extends FakeNativeBackend {
  override health(): Promise<BackendHealth> {
    return Promise.resolve({ name: this.name, state: 'unavailable', detail: 'fake backend is still starting' })
  }
}

class HangingNativeBackend extends FakeNativeBackend {
  starts = 0
  active = 0
  aborts = 0

  override async health(signal?: AbortSignal): Promise<BackendHealth> {
    this.starts += 1
    this.active += 1
    notifyConditionChanged()
    return await new Promise(resolve => {
      const onAbort = (): void => {
        this.aborts += 1
        this.active -= 1
        notifyConditionChanged()
        resolve({ name: this.name, state: 'unavailable', detail: 'cancelled' })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }
}

class OneShotBackend implements Backend {
  constructor(readonly name = 'one-shot') {}
  matches(model: string): boolean { return model === this.name || model.startsWith(`${this.name}/`) }
  health(): Promise<BackendHealth> { return Promise.resolve({ name: this.name, state: 'ready' }) }
  async *chat(): AsyncIterable<ChatDelta> { yield { content: 'ok', finish_reason: 'stop' } }
}

function watchStoreMutations(store: SessionStore): void {
  const target = store as unknown as Record<string, (...args: never[]) => unknown>
  const methods = [
    'appendRetainedEvent',
    'beginInteractionOperation',
    'recordInteractionEffect',
    'recordInteractionOperation',
    'markInteractionEffectUnknown',
    'recordRetainedControlOperation',
    'updateRetainedControlOperation',
    'updateRetainedRun',
    'updateRetained',
  ] as const
  for (const name of methods) {
    const original = target[name]
    if (!original) throw new Error(`missing store mutation ${name}`)
    const bound = original.bind(store)
    target[name] = (...args): unknown => {
      const result = bound(...args)
      notifyConditionChanged()
      return result
    }
  }
}

function setup(
  backend: Backend,
  existingDir?: string,
  serviceOptions: {
    inputQueueMaxDepth?: number
    inputQueueTimeoutMs?: number
    healthProbeTimeoutMs?: number
  } = {},
  storeOverride?: SessionStore,
): {
  app: Hono
  service: RetainedSessionService
  store: SessionStore
  runs: RunRegistry
  dir: string
  unwatch(): void
} {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), 'cli-bridge-retained-'))
  const store = storeOverride ?? new SqliteSessionStore(dir)
  watchStoreMutations(store)
  const runs = new RunRegistry({ replayRetentionMs: 60_000, identityRetentionMs: 60_000 })
  const runUnsubscribes: Array<() => void> = []
  const claim = runs.claim.bind(runs)
  runs.claim = ((...args: Parameters<RunRegistry['claim']>) => {
    const result = claim(...args)
    runUnsubscribes.push(result.run.subscribeCanonical(notifyConditionChanged))
    notifyConditionChanged()
    return result
  }) as RunRegistry['claim']
  const registry = new (class {
    readonly backends = [backend]
    resolve(model: string): Backend | null { return this.backends.find(item => item.matches(model)) ?? null }
    byName(name: string): Backend | null { return this.backends.find(item => item.name === name) ?? null }
  })()
  const service = new RetainedSessionService({ store, registry: registry as never, runs, ...serviceOptions })
  const app = new Hono()
  mountRetainedSessions(app, service, { includeRunEvents: false })
  mountRuns(app, { runs, retainedRuns: service, retainedStore: store })
  mountChatCompletions(app, { registry: registry as never, sessions: store, retainedRuns: store, runs })
  return {
    app,
    service,
    store,
    runs,
    dir,
    unwatch(): void {
      for (const unsubscribe of runUnsubscribes.splice(0)) unsubscribe()
    },
  }
}

const cleanup = async (fixture: ReturnType<typeof setup>): Promise<void> => {
  await fixture.runs.shutdown(1_000)
  await fixture.service.shutdown(1_000).catch(() => {})
  fixture.unwatch()
  fixture.store.close()
  rmSync(fixture.dir, { recursive: true, force: true })
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>
}

function cancellationBody(
  fixture: ReturnType<typeof setup>,
  sessionId: string,
  operationId: string,
  reason?: string,
): string {
  const runId = fixture.store.getRetained(sessionId)?.runId
  if (!runId) throw new Error(`session ${sessionId} has no active run`)
  const admission = fixture.store.getRetainedRun(runId)
  if (!admission) throw new Error(`run ${runId} has no durable admission`)
  const material = {
    operationId,
      run: {
        runId,
        provider: admission.provider,
        environmentId: admission.environmentId,
        sessionId,
        executionId: admission.executionId,
        requestDigest: admission.requestDigest as `sha256:${string}`,
    },
    ...(reason ? { reason } : {}),
  }
  return JSON.stringify({
    ...material,
    requestDigest: agentRunCancellationRequestDigest(material),
  })
}

function steerRequest(
  fixture: ReturnType<typeof setup>,
  sessionId: string,
  operationId: string,
  message: string,
): { operationId: string; message: string; run: { runId: string; provider: string; environmentId: string; sessionId: string; executionId: string; requestDigest: `sha256:${string}` } } {
  const runId = fixture.store.getRetained(sessionId)?.runId
  if (!runId) throw new Error(`session ${sessionId} has no active run`)
  const admission = fixture.store.getRetainedRun(runId)
  const record = fixture.store.getRetained(sessionId)
  if (!admission || !record) throw new Error(`run ${runId} has no durable admission`)
  return {
    operationId,
    message,
    run: {
      runId,
      provider: admission.provider,
      environmentId: admission.environmentId,
      sessionId,
      executionId: admission.executionId,
      requestDigest: admission.requestDigest as `sha256:${string}`,
    },
  }
}

function turnBody(
  identity: string,
  input: Record<string, unknown>,
): string {
  return JSON.stringify({
    ...input,
    run_id: `run-${identity}`,
    execution_id: `execution-${identity}`,
  })
}

function nativeContinuationRequest(
  fixture: ReturnType<typeof setup>,
  sessionId: string,
  operationId: string,
  prompt: string,
  expectedBoundary?: NativeContextBoundaryProof,
  sourceRun?: NativeContextContinuationRequest['run'],
): { request: NativeContextContinuationRequest; turn: { prompt: string } } {
  const record = fixture.store.getRetained(sessionId)
  if (!record?.runId) throw new Error(`session ${sessionId} has no retained run`)
  const admission = fixture.store.getRetainedRun(record.runId)
  if (!admission) throw new Error(`run ${record.runId} has no durable admission`)
  const boundary = expectedBoundary ?? record.contextBoundary as NativeContextBoundaryProof
  const run = sourceRun ?? {
    runId: admission.runId,
    provider: admission.provider,
    environmentId: admission.environmentId,
    sessionId,
    executionId: admission.executionId,
    requestDigest: admission.requestDigest as `sha256:${string}`,
  }
  const turn = { prompt }
  const material = {
    operationId,
    turnDigest: nativeContextContinuationTurnDigest(turn),
    run,
    expectedBoundary: boundary,
  }
  const request = {
    ...material,
    requestDigest: nativeContextContinuationRequestDigest(material),
  }
  return {
    request,
    turn,
  }
}

function nativeContinuationRunId(operationId: string): string {
  return `native-continuation:${canonicalCandidateDigest({ operationId })}`
}

function nativeContinuationBody(input: ReturnType<typeof nativeContinuationRequest>): string {
  return JSON.stringify(input)
}

function successfulNativeOutcome(
  value: ReturnType<typeof AgentNativeContextContinuationResultSchema.parse>,
): Extract<ReturnType<typeof AgentNativeContextContinuationResultSchema.parse>, { result: unknown }> {
  if (!('result' in value) || !('controlRef' in value)) throw new Error('expected an accepted native continuation')
  return value
}

function interactionCommand(
  operationId: string,
  request: InteractionRequest,
  response: InteractionResponse,
  bindingOverrides: Partial<InteractionBinding> = {},
): InteractionResponseCommand {
  const binding: InteractionBinding = {
    ...request.binding,
    requestDigest: request.requestDigest,
    ...bindingOverrides,
  }
  return {
    operationId,
    binding,
    response,
    commandDigest: interactionResponseCommandDigest({ binding, response }),
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  if (predicate()) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      conditionListeners.delete(check)
      if (error) reject(error)
      else resolve()
    }
    const check = (): void => {
      try {
        if (predicate()) finish()
      } catch (error) {
        finish(error)
      }
    }
    conditionListeners.add(check)
    check()
  })
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
}

async function nextTimerTurn(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0))
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<[number | null, NodeJS.Signals | null]> {
  if (child.exitCode !== null || child.signalCode !== null) return [child.exitCode, child.signalCode]
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
  if (child.exitCode !== null || child.signalCode !== null) return [child.exitCode, child.signalCode]
  return await exited
}

async function stopChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): Promise<void> {
  const exited = waitForChildExit(child)
  if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  await exited
}

async function waitForChildOutput(child: ChildProcessWithoutNullStreams, marker: string): Promise<string> {
  let output = ''
  let errors = ''
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      child.stdout.off('data', onOutput)
      child.stderr.off('data', onErrorOutput)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onOutput = (chunk: Buffer): void => {
      output += chunk.toString()
      if (output.includes(marker)) finish()
    }
    const onErrorOutput = (chunk: Buffer): void => { errors += chunk.toString() }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`child exited before ${JSON.stringify(marker)}: code=${code} signal=${signal} output=${output} error=${errors}`))
    }
    const onError = (error: Error): void => { finish(error) }
    child.stdout.on('data', onOutput)
    child.stderr.on('data', onErrorOutput)
    child.once('exit', onExit)
    child.once('error', onError)
  })
  return output
}

describe('retained Agent Interface sessions', () => {
  let fixture: ReturnType<typeof setup> | null = null
  afterEach(async () => { if (fixture) await cleanup(fixture); fixture = null })

  it('reports retained capabilities for an exact model without creating a session', async () => {
    fixture = setup(new FakeNativeBackend())
    const response = await fixture.app.request('/v1/capabilities?model=pi%2Ftest')
    expect(response.status).toBe(200)
    expect(await json(response)).toMatchObject({
      streaming: { live: true, replay: true, detach: true },
      retainedControl: {
        exactRunIdentity: true,
        resultIdentity: true,
        eventIdentity: true,
        cancellationIdempotency: true,
      },
      sessions: { continue: true, list: true, messages: true },
    })
    expect(fixture.store.listRetained(10)).toEqual([])

    const missing = await fixture.app.request('/v1/capabilities')
    expect(missing.status).toBe(400)
  })

  it.each(['opencode', 'claude-code', 'codex', 'kimi-code'])('reports the generic durable capability contract for ready %s routes', async (backendName) => {
    fixture = setup(new OneShotBackend(backendName))
    const response = await fixture.app.request(`/v1/capabilities?model=${encodeURIComponent(`${backendName}/test`)}`)
    expect(response.status).toBe(200)
    const capabilities = await json(response)
    expect(capabilities).toMatchObject({
      profile: {
        namedProfiles: false,
        systemPrompt: { replace: true, append: true },
        instructions: true,
        tools: true,
        permissions: true,
        mcp: true,
        subagents: true,
        resources: {
          files: true,
          instructions: true,
          tools: true,
          skills: true,
          agents: true,
          commands: true,
        },
        modes: true,
        validation: true,
      },
      streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
      sessions: { continue: true, list: false, messages: false },
      retainedControl: {
        exactRunIdentity: true,
        resultIdentity: true,
        eventIdentity: true,
        cancellationIdempotency: true,
      },
      workspace: { read: false, write: false, exec: false, git: false, upload: false, download: false },
      branching: { checkpoint: false, fork: false },
      placement: true,
      usage: true,
      observation: {
        identity: true,
        lifecycle: true,
        endpoint: true,
        placement: true,
        resources: false,
        resourceUse: false,
        modelUsage: true,
        computeBilling: false,
        accountUsage: false,
      },
    })
    expect(capabilities).not.toHaveProperty('nativeContinuation')
    expect(capabilities).not.toHaveProperty('interactions')
  })

  it('refuses retained capability discovery and creation until native health is ready', async () => {
    fixture = setup(new NotReadyNativeBackend())
    const capabilitiesResponse = await fixture.app.request('/v1/capabilities?model=pi%2Ftest')
    expect(capabilitiesResponse.status).toBe(503)
    expect(await json(capabilitiesResponse)).toMatchObject({ error: { type: 'backend_not_ready' } })
    const createResponse = await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'not-ready', model: 'pi/test' }),
    })
    expect(createResponse.status).toBe(503)
    expect(await json(createResponse)).toMatchObject({ error: { type: 'backend_not_ready' } })
    expect(fixture.store.listRetained(10)).toEqual([])
  })

  it('bounds and shares retained readiness across capability and creation requests', async () => {
    const backend = new HangingNativeBackend()
    fixture = setup(backend, undefined, { healthProbeTimeoutMs: 25 })
    const responses = await Promise.all([
      fixture.app.request('/v1/capabilities?model=pi%2Ftest'),
      fixture.app.request('/v1/capabilities?model=pi%2Ftest'),
      fixture.app.request('/v1/sessions', {
        method: 'POST',
        body: JSON.stringify({ id: 'bounded-create', model: 'pi/test' }),
      }),
    ])

    expect(responses.map(response => response.status)).toEqual([503, 503, 503])
    expect(backend).toMatchObject({ starts: 1, active: 0, aborts: 1 })
    expect(fixture.store.listRetained(10)).toEqual([])
  })

  it('propagates caller cancellation into retained readiness', async () => {
    const backend = new HangingNativeBackend()
    fixture = setup(backend, undefined, { healthProbeTimeoutMs: 10_000 })
    const controller = new AbortController()
    const response = fixture.app.request('/v1/capabilities?model=pi%2Ftest', {
      signal: controller.signal,
    })
    await waitFor(() => backend.active === 1)
    controller.abort(new Error('caller disconnected'))

    expect((await response).status).toBe(503)
    expect(backend).toMatchObject({ starts: 1, active: 0, aborts: 1 })
  })

  it('rejects unsupported retained modes before creating durable state', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    for (const mode of ['hosted-safe', 'hosted-sandboxed']) {
      const response = await fixture.app.request('/v1/sessions', {
        method: 'POST',
        body: JSON.stringify({ id: `unsupported-${mode}`, model: 'pi/test', mode }),
      })
      expect(response.status).toBe(501)
      expect(await json(response)).toMatchObject({ error: { type: 'capability_denied' } })
    }
    expect(fixture.store.listRetained(10)).toEqual([])
    expect(backend.natives).toEqual([])
  })

  it('persists the exact create request digest for safe lost-response recovery', async () => {
    fixture = setup(new FakeNativeBackend())
    const request = { id: 'create-retry', model: 'pi/test', cwd: '/tmp/project' }
    const created = await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify(request),
    })
    expect(created.status).toBe(201)
    const expectedDigest = canonicalCandidateDigest({
      ...request,
      interaction_policy: 'interactive',
    })
    expect((await json(created)).create_request_digest).toBe(expectedDigest)
    expect(fixture.store.getRetained(request.id)?.createRequestDigest).toBe(expectedDigest)

    const changed = await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ ...request, cwd: '/tmp/other' }),
    })
    expect(changed.status).toBe(409)
    const recovered = await fixture.app.request(`/v1/sessions/${request.id}`)
    expect(recovered.status).toBe(200)
    expect((await json(recovered)).create_request_digest).toBe(expectedDigest)
  })

  it('carries a runtime attachment into the native spawn and keeps it out of create identity', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    const created = await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: 'attachment-create',
        model: 'pi/test',
        runtime_attachments: { mcp: { coordination: { transport: 'http', url: 'http://127.0.0.1:36827/mcp' } } },
      }),
    })
    expect(created.status).toBe(201)
    expect((await json(created)).create_request_digest).toBe(canonicalCandidateDigest({
      id: 'attachment-create',
      model: 'pi/test',
      interaction_policy: 'interactive',
    }))

    const turn = await fixture.app.request('/v1/sessions/attachment-create/turns', {
      method: 'POST',
      body: JSON.stringify({ message: 'work', run_id: 'attachment-turn' }),
    })
    expect(turn.status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('attachment-create')?.turns === 1)
    expect(backend.requests[0]?.runtime_attachments).toEqual({
      mcp: { coordination: { transport: 'http', url: 'http://127.0.0.1:36827/mcp' } },
    })
    expect(backend.requests[0]?.agent_profile).toBeUndefined()
  })

  it('rejects retained creates and turns that omit caller-owned retry identities', async () => {
    fixture = setup(new FakeNativeBackend())
    const missingSessionId = await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ model: 'pi/test' }),
    })
    expect(missingSessionId.status).toBe(400)

    expect((await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'identity-required', model: 'pi/test' }),
    })).status).toBe(201)
    const missingRunId = await fixture.app.request('/v1/sessions/identity-required/turns', {
      method: 'POST',
      body: JSON.stringify({ message: 'must be retry-safe' }),
    })
    expect(missingRunId.status).toBe(400)
    expect(fixture.store.getRetained('identity-required')?.runId).toBeNull()
  })

  it('admits only supported per-turn interaction kinds', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'interaction-posture', model: 'pi/test' }),
    })

    const unsupported = await fixture.app.request('/v1/sessions/interaction-posture/turns', {
      method: 'POST',
      body: turnBody('unsupported-interaction', {
        message: 'must fail before spawn',
        interactions: { plan: true },
      }),
    })
    expect(unsupported.status).toBe(400)
    expect(await json(unsupported)).toMatchObject({ error: { type: 'capability_denied' } })
    expect(backend.natives).toEqual([])

    const admitted = await fixture.app.request('/v1/sessions/interaction-posture/turns', {
      method: 'POST',
      body: turnBody('supported-interaction', {
        message: 'continue',
        interactions: { permission: true, question: false },
      }),
    })
    expect(admitted.status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('interaction-posture')?.turns === 1)
    expect(backend.natives).toHaveLength(1)
  })

  it('rejects a false-valued unsupported interaction declaration before native startup', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'false-interaction-posture', model: 'pi/test' }),
    })

    const response = await fixture.app.request('/v1/sessions/false-interaction-posture/turns', {
      method: 'POST',
      body: turnBody('false-unsupported-interaction', {
        message: 'must fail before spawn',
        interactions: { plan: false },
      }),
    })
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: { type: 'capability_denied' } })
    expect(backend.natives).toEqual([])
  })

  it('binds the exact interaction posture into retained turn identity', async () => {
    fixture = setup(new FakeNativeBackend())
    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'interaction-identity', model: 'pi/test' }),
    })
    const firstBody = {
      message: 'same prompt',
      run_id: 'interaction-identity-run',
      execution_id: 'interaction-identity-execution',
      interactions: { permission: true },
    }
    const first = await fixture.app.request('/v1/sessions/interaction-identity/turns', {
      method: 'POST',
      body: JSON.stringify(firstBody),
    })
    expect(first.status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('interaction-identity')?.turns === 1)

    const replay = await fixture.app.request('/v1/sessions/interaction-identity/turns', {
      method: 'POST',
      body: JSON.stringify(firstBody),
    })
    expect(replay.status).toBe(202)

    const changed = await fixture.app.request('/v1/sessions/interaction-identity/turns', {
      method: 'POST',
      body: JSON.stringify({ ...firstBody, interactions: { question: true } }),
    })
    expect(changed.status).toBe(409)
    expect(await json(changed)).toMatchObject({ error: { type: 'run_identity_conflict' } })
  })

  it('binds public provider and environment coordinates into retained turn identity', async () => {
    fixture = setup(new FakeNativeBackend())
    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'coordinate-identity', model: 'pi/test' }),
    })
    const firstBody = {
      message: 'same prompt',
      run_id: 'coordinate-identity-run',
      execution_id: 'coordinate-identity-execution',
      provider: 'agent-provider-cli-bridge',
      environment_id: 'environment-a',
    }
    const first = await fixture.app.request('/v1/sessions/coordinate-identity/turns', {
      method: 'POST',
      body: JSON.stringify(firstBody),
    })
    expect(first.status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('coordinate-identity')?.turns === 1)

    const continuation = await fixture.app.request('/v1/sessions/coordinate-identity/turns', {
      method: 'POST',
      body: JSON.stringify({
        ...firstBody,
        run_id: 'coordinate-identity-continuation-run',
        execution_id: 'coordinate-identity-continuation-execution',
      }),
    })
    expect(continuation.status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('coordinate-identity')?.turns === 2)
    expect(fixture.store.getRetained('coordinate-identity')?.contextBoundary).toMatchObject({
      provider: 'agent-provider-cli-bridge',
      environmentId: 'environment-a',
    })

    const changedProvider = await fixture.app.request('/v1/sessions/coordinate-identity/turns', {
      method: 'POST',
      body: JSON.stringify({ ...firstBody, provider: 'another-provider' }),
    })
    expect(changedProvider.status).toBe(409)
    expect(await json(changedProvider)).toMatchObject({ error: { type: 'run_identity_conflict' } })

    const changedEnvironment = await fixture.app.request('/v1/sessions/coordinate-identity/turns', {
      method: 'POST',
      body: JSON.stringify({ ...firstBody, environment_id: 'environment-b' }),
    })
    expect(changedEnvironment.status).toBe(409)
    expect(await json(changedEnvironment)).toMatchObject({ error: { type: 'run_identity_conflict' } })
  })

  it('shares run ownership across protocols with a durable one-shot collision admission', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    const oneShotRunId = 'cross-protocol-one-shot-first'
    const oneShot = await fixture.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'pi/test',
        messages: [{ role: 'user', content: 'one-shot first' }],
        run_id: oneShotRunId,
        stream: true,
      }),
    })
    expect(oneShot.status).toBe(200)
    await oneShot.text()

    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'cross-protocol-retained-second', model: 'pi/test' }),
    })
    const retainedCollision = await fixture.app.request('/v1/sessions/cross-protocol-retained-second/turns', {
      method: 'POST',
      body: JSON.stringify({
        message: 'retained collision',
        run_id: oneShotRunId,
        execution_id: 'cross-protocol-retained-second-execution',
      }),
    })
    expect(retainedCollision.status).toBe(409)
    expect(await json(retainedCollision)).toMatchObject({ error: { type: 'run_identity_conflict' } })
    expect(fixture.store.getRetainedRun(oneShotRunId)).toMatchObject({ owner: 'one-shot' })

    const replayedCollision = await fixture.app.request('/v1/sessions/cross-protocol-retained-second/turns', {
      method: 'POST',
      body: JSON.stringify({
        message: 'retained collision',
        run_id: oneShotRunId,
        execution_id: 'cross-protocol-retained-second-execution',
      }),
    })
    expect(replayedCollision.status).toBe(409)
    expect(await json(replayedCollision)).toMatchObject({ error: { type: 'run_identity_conflict' } })
    expect(backend.natives).toHaveLength(0)

    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'cross-protocol-retained-first', model: 'pi/test' }),
    })
    const retainedFirst = await fixture.app.request('/v1/sessions/cross-protocol-retained-first/turns', {
      method: 'POST',
      body: JSON.stringify({
        message: 'retained first',
        run_id: 'cross-protocol-retained-first-run',
        execution_id: 'cross-protocol-retained-first-execution',
      }),
    })
    expect(retainedFirst.status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('cross-protocol-retained-first')?.turns === 1)

    const oneShotCollision = await fixture.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'pi/test',
        messages: [{ role: 'user', content: 'one-shot collision' }],
        run_id: 'cross-protocol-retained-first-run',
        stream: true,
      }),
    })
    expect(oneShotCollision.status).toBe(409)
    expect(await json(oneShotCollision)).toMatchObject({ error: { type: 'run_identity_conflict' } })
    expect(fixture.store.getRetainedRun('cross-protocol-retained-first-run')).not.toBeNull()
  })

  it('publishes retained run coordinates in live and durable run snapshots', async () => {
    fixture = setup(new FakeNativeBackend())
    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'public-run-coordinates', model: 'pi/test' }),
    })
    const turn = await fixture.app.request('/v1/sessions/public-run-coordinates/turns', {
      method: 'POST',
      body: JSON.stringify({
        message: 'coordinates',
        run_id: 'public-run-coordinates-run',
        execution_id: 'public-run-coordinates-execution',
        provider: 'provider-exact',
        environment_id: 'environment-exact',
      }),
    })
    expect(turn.status).toBe(202)
    const turnBody = await json(turn)
    expect(turnBody.run).toMatchObject({ provider: 'provider-exact', environmentId: 'environment-exact' })
    await waitFor(() => fixture!.store.getRetained('public-run-coordinates')?.turns === 1)

    const live = await fixture.app.request('/v1/runs/public-run-coordinates-run')
    expect(live.status).toBe(200)
    expect(await json(live)).toMatchObject({
      id: 'public-run-coordinates-run',
      provider: 'provider-exact',
      environmentId: 'environment-exact',
    })

    fixture.runs.clear()
    const durable = await fixture.app.request('/v1/runs/public-run-coordinates-run')
    expect(durable.status).toBe(200)
    expect(await json(durable)).toMatchObject({
      id: 'public-run-coordinates-run',
      provider: 'provider-exact',
      environmentId: 'environment-exact',
    })
  })

  it('uses persisted non-default coordinates for steer and cancel after admission', async () => {
    const native = new HangingNative()
    fixture = setup(new FakeNativeBackend(() => native))
    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'coordinate-control', model: 'pi/test' }),
    })
    const turn = await fixture.app.request('/v1/sessions/coordinate-control/turns', {
      method: 'POST',
      body: JSON.stringify({
        message: 'hang',
        run_id: 'coordinate-control-run',
        execution_id: 'coordinate-control-execution',
        provider: 'sandbox-provider',
        environment_id: 'sandbox-environment',
      }),
    })
    expect(turn.status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('coordinate-control')?.status === 'running')
    const admission = fixture.store.getRetainedRun('coordinate-control-run')
    expect(admission).toMatchObject({ provider: 'sandbox-provider', environmentId: 'sandbox-environment' })

    const wrongCancel = JSON.parse(cancellationBody(fixture, 'coordinate-control', 'wrong-coordinate-cancel')) as Record<string, any>
    const wrongMaterial = {
      operationId: wrongCancel.operationId,
      run: { ...wrongCancel.run, provider: 'other-provider' },
    }
    wrongCancel.run = wrongMaterial.run
    wrongCancel.requestDigest = agentRunCancellationRequestDigest(wrongMaterial)
    const rejected = await fixture.app.request('/v1/sessions/coordinate-control/cancel', {
      method: 'POST',
      body: JSON.stringify(wrongCancel),
    })
    expect(rejected.status).toBe(409)
    expect(fixture.runs.get('coordinate-control-run')?.snapshot().terminal).toBe(false)

    const steer = await fixture.app.request('/v1/sessions/coordinate-control/steer', {
      method: 'POST',
      body: JSON.stringify(steerRequest(fixture, 'coordinate-control', 'coordinate-steer', 'continue')),
    })
    expect(steer.status).toBe(200)
    expect(native.steers).toEqual(['continue'])

    const cancelled = await fixture.app.request('/v1/sessions/coordinate-control/cancel?wait_ms=1000', {
      method: 'POST',
      body: cancellationBody(fixture, 'coordinate-control', 'coordinate-cancel'),
    })
    expect(cancelled.status).toBe(200)
    expect(await json(cancelled)).toMatchObject({ status: 'accepted', effect: 'cancelled' })
  })

  it('rejects both API orderings when one session id crosses session types', async () => {
    fixture = setup(new FakeNativeBackend())
    expect((await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'retained-first', model: 'pi/test' }),
    })).status).toBe(201)
    const legacyAfterRetained = await fixture.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'pi/test',
        messages: [{ role: 'user', content: 'must conflict' }],
        session_id: 'retained-first',
        run_id: 'legacy-after-retained',
      }),
    })
    expect(legacyAfterRetained.status).toBe(409)
    expect((await json(legacyAfterRetained)).error.type).toBe('session_identity_conflict')

    const legacyFirst = await fixture.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'pi/test',
        messages: [{ role: 'user', content: 'reserve legacy identity' }],
        session_id: 'legacy-first',
        run_id: 'legacy-first-run',
      }),
    })
    expect(legacyFirst.status).toBe(200)
    const retainedAfterLegacy = await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'legacy-first', model: 'pi/test' }),
    })
    expect(retainedAfterLegacy.status).toBe(409)
    expect((await json(retainedAfterLegacy)).error.type).toBe('session_identity_conflict')
  })

  it('fails at startup instead of synthesizing identities for an incompatible retained schema', () => {
    const dir = mkdtempSync(`${tmpdir()}/cli-bridge-old-retained-schema-`)
    try {
      const db = new Database(join(dir, 'sessions.sqlite'))
      db.exec(`
        CREATE TABLE retained_sessions (
          id TEXT PRIMARY KEY,
          create_request_digest TEXT,
          backend TEXT NOT NULL,
          model TEXT NOT NULL,
          cwd TEXT,
          turns INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          run_id TEXT,
          internal_id TEXT,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          capabilities_json TEXT NOT NULL,
          profile_receipt_json TEXT,
          context_boundary_json TEXT
        );
        CREATE TABLE retained_run_admissions (
          run_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          request_digest TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `)
      db.close()
      expect(() => new SqliteSessionStore(dir)).toThrow(/incompatible retained-session data schema/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a database with only a subset of the retained-session tables', () => {
    const dir = mkdtempSync(`${tmpdir()}/cli-bridge-partial-retained-schema-`)
    try {
      const db = new Database(join(dir, 'sessions.sqlite'))
      db.exec(`
        CREATE TABLE sessions (
          external_id TEXT NOT NULL,
          backend TEXT NOT NULL,
          internal_id TEXT NOT NULL,
          cwd TEXT,
          turns INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY (external_id, backend)
        );
      `)
      db.close()
      expect(() => new SqliteSessionStore(dir)).toThrow(/incompatible retained-session data schema/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('upgrades the released sessions-only database and reserves every legacy id', () => {
    const dir = mkdtempSync(`${tmpdir()}/cli-bridge-legacy-sessions-`)
    try {
      const db = new Database(join(dir, 'sessions.sqlite'))
      db.exec(`
        CREATE TABLE sessions (
          external_id TEXT NOT NULL,
          backend TEXT NOT NULL,
          internal_id TEXT NOT NULL,
          cwd TEXT,
          turns INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY (external_id, backend)
        );
        CREATE INDEX idx_sessions_last_used ON sessions(last_used_at);
        INSERT INTO sessions VALUES
          ('shared-id', 'claude-code', 'claude-thread', '/work', 2, 100, 200, '{}'),
          ('shared-id', 'codex', 'codex-thread', '/work', 1, 150, 250, '{}'),
          ('other-id', 'pi', 'pi-thread', NULL, 1, 300, 300, '{}');
      `)
      db.close()

      const store = new SqliteSessionStore(dir)
      expect(store.get('shared-id', 'claude-code')?.internalId).toBe('claude-thread')
      expect(() => store.claimSessionIdentity('shared-id', 'retained')).toThrow(/already owned by the legacy session API/)
      expect(() => store.claimSessionIdentity('other-id', 'retained')).toThrow(/already owned by the legacy session API/)
      store.claimSessionIdentity('fresh-retained', 'retained')
      store.close()

      const reopened = new SqliteSessionStore(dir)
      expect(reopened.get('shared-id', 'codex')?.internalId).toBe('codex-thread')
      expect(() => reopened.claimSessionIdentity('fresh-retained', 'legacy')).toThrow(/already owned by the retained session API/)
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('upgrades released interaction acknowledgements without losing retry identity', () => {
    const dir = mkdtempSync(`${tmpdir()}/cli-bridge-released-interactions-`)
    try {
      const created = new SqliteSessionStore(dir)
      created.close()
      const requestDigest = canonicalCandidateDigest('released-response-command')
      const binding: InteractionBinding = {
        runId: 'released-run',
        provider: 'cli-bridge',
        environmentId: 'released-environment',
        sessionId: 'released-session',
        executionId: 'released-execution',
        interactionId: 'released-interaction',
        requestDigest: canonicalCandidateDigest('released-interaction'),
      }
      const acknowledgement = {
        operationId: 'released-operation',
        binding,
        commandDigest: canonicalCandidateDigest('released-command'),
        status: 'accepted',
      }
      const db = new Database(join(dir, 'sessions.sqlite'))
      db.exec(`
        DROP TABLE interaction_operations;
        CREATE TABLE interaction_operations (
          operation_id TEXT PRIMARY KEY,
          caller_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          interaction_id TEXT NOT NULL,
          request_digest TEXT NOT NULL,
          acknowledgement_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `)
      db.prepare(
        `INSERT INTO interaction_operations
         (operation_id, caller_id, run_id, session_id, interaction_id, request_digest,
          acknowledgement_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        acknowledgement.operationId,
        'braid',
        binding.runId,
        binding.sessionId,
        binding.interactionId,
        requestDigest,
        JSON.stringify(acknowledgement),
        1,
      )
      db.close()

      const reopened = new SqliteSessionStore(dir)
      expect(reopened.beginInteractionOperation({
        operationId: acknowledgement.operationId,
        callerId: 'braid',
        runId: binding.runId,
        sessionId: binding.sessionId,
        interactionId: binding.interactionId,
        requestDigest,
        responseDigest: canonicalCandidateDigest('released-response'),
      })).toMatchObject({
        kind: 'replayed',
        operation: {
          phase: 'acknowledged',
          effectProof: {
            kind: 'released_acknowledgement',
            operationRequestDigest: requestDigest,
            recordedAt: 1,
          },
          acknowledgement: { status: 'accepted', binding },
        },
      })
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves canonical context and structured attachments instead of stripping them', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'strict-turn', model: 'pi/test' }),
    })
    const unsupported = await fixture.app.request('/v1/sessions/strict-turn/turns', {
      method: 'POST',
      body: JSON.stringify({ message: 'model override', model: 'pi/other', run_id: 'strict-model' }),
    })
    expect(unsupported.status).toBe(400)

    const response = await fixture.app.request('/v1/sessions/strict-turn/turns', {
      method: 'POST',
      body: JSON.stringify({
        parts: [
          { type: 'text', text: 'context' },
          { type: 'image', url: 'https://example.test/image.png' },
          { type: 'file', content: 'public bytes', filename: 'notes.txt' },
        ],
        context: { trace: true },
        provider_options: { temperature: 0.1 },
        run_id: 'strict-context',
      }),
    })
    expect(response.status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('strict-turn')?.turns === 1)
    expect(backend.requests[0]?.messages[0]?.content).toEqual([
      { type: 'text', text: 'context' },
      { type: 'image', url: 'https://example.test/image.png' },
      { type: 'file', content: 'public bytes', filename: 'notes.txt' },
    ])
    expect(backend.requests[0]?.metadata).toBeUndefined()
    expect(backend.requests[0]?.context).toEqual({ trace: true })
    expect(backend.requests[0]?.providerOptions).toEqual({ temperature: 0.1 })
  })

  it('keeps retained metadata, context, and provider options separate with deterministic precedence and digesting', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    const created = await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: 'separate-request-channels',
        model: 'pi/test',
        metadata: { collision: 'session-metadata', metadataOnly: true },
        context: { collision: 'session-context', contextOnly: true },
        provider_options: { collision: 'session-provider', providerOnly: true },
      }),
    })
    expect(created.status).toBe(201)

    const first = await fixture.app.request('/v1/sessions/separate-request-channels/turns', {
      method: 'POST',
      body: JSON.stringify({
        message: 'channel one',
        run_id: 'separate-request-channels-one',
        execution_id: 'separate-request-channels-execution-one',
        metadata: { collision: 'turn-metadata', turnMetadataOnly: true },
        context: { collision: 'turn-context', turnContextOnly: true },
        provider_options: { collision: 'turn-provider', turnProviderOnly: true },
      }),
    })
    expect(first.status).toBe(202)
    const firstBody = await json(first)
    await waitFor(() => fixture!.store.getRetained('separate-request-channels')?.turns === 1)
    expect(backend.requests[0]).toMatchObject({
      metadata: {
        collision: 'turn-metadata',
        metadataOnly: true,
        turnMetadataOnly: true,
      },
      context: {
        collision: 'turn-context',
        contextOnly: true,
        turnContextOnly: true,
      },
      providerOptions: {
        collision: 'turn-provider',
        providerOnly: true,
        turnProviderOnly: true,
      },
    })
    expect(backend.requests[0]?.metadata).not.toHaveProperty('contextOnly')
    expect(backend.requests[0]?.metadata).not.toHaveProperty('providerOnly')
    expect(backend.requests[0]?.context).not.toHaveProperty('metadataOnly')
    expect(backend.requests[0]?.providerOptions).not.toHaveProperty('metadataOnly')

    const second = await fixture.app.request('/v1/sessions/separate-request-channels/turns', {
      method: 'POST',
      body: JSON.stringify({
        message: 'channel two',
        run_id: 'separate-request-channels-two',
        execution_id: 'separate-request-channels-execution-two',
        metadata: { collision: 'turn-metadata', turnMetadataOnly: true },
        context: { collision: 'changed-context', turnContextOnly: true },
        provider_options: { collision: 'turn-provider', turnProviderOnly: true },
      }),
    })
    expect(second.status).toBe(202)
    const secondBody = await json(second)
    expect(secondBody.run.requestDigest).not.toBe(firstBody.run.requestDigest)
    await waitFor(() => fixture!.store.getRetained('separate-request-channels')?.turns === 2)
  })

  it('rejects oversized retained schema values and HTTP bodies before provider work', async () => {
    fixture = setup(new FakeNativeBackend())
    expect(() => fixture!.service.parseTurn({
      message: 'x'.repeat(RETAINED_MAX_TEXT_LENGTH + 1),
      run_id: 'oversized-message',
    })).toThrow()
    expect(() => fixture!.service.parseCreate({
      id: 'oversized-model',
      model: 'x'.repeat(513),
    })).toThrow()

    const response = await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: 'oversized-body',
        model: 'pi/test',
        agent_profile: { payload: 'x'.repeat(RETAINED_MAX_HTTP_BODY_BYTES) },
      }),
    })
    expect(response.status).toBe(413)
    expect(await json(response)).toMatchObject({ error: { type: 'request_too_large' } })
    expect(fixture.store.getRetained('oversized-body')).toBeNull()
  })

  it('requires the durable run digest before retained cancellation', async () => {
    fixture = setup(new FakeNativeBackend(() => new HangingNative()))
    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'cancel-without-digest', model: 'pi/test' }),
    })
    const turn = await fixture.app.request('/v1/sessions/cancel-without-digest/turns', {
      method: 'POST',
      body: JSON.stringify({
        message: 'hang',
        execution_id: 'public-cancel-without-digest',
        run_id: 'cancel-without-digest-run',
      }),
    })
    expect(turn.status).toBe(202)
    const material = {
      operationId: 'cancel-without-digest-operation',
      run: {
        runId: 'cancel-without-digest-run',
        provider: 'cli-bridge',
        environmentId: 'cli-bridge',
        sessionId: 'cancel-without-digest',
        executionId: 'public-cancel-without-digest',
        requestDigest: canonicalCandidateDigest({ orphan: true }),
      },
    }
    const response = await fixture.app.request('/v1/sessions/cancel-without-digest/cancel', {
      method: 'POST',
      body: JSON.stringify({
        ...material,
        requestDigest: agentRunCancellationRequestDigest(material),
      }),
    })
    expect(response.status).toBe(409)
    expect(fixture.runs.get('cancel-without-digest-run')?.snapshot().status).toBe('running')
  })

  it('refuses cancellation when no durable run admission owns the requested identity', async () => {
    fixture = setup(new FakeNativeBackend())
    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'orphan-cancel', model: 'pi/test' }),
    })
    const runRequestDigest = canonicalCandidateDigest({ orphan: true })
    const orphan = fixture.runs.claim('orphan-run', runRequestDigest, {
      sessionId: 'orphan-cancel',
      executionId: 'orphan-execution',
    }).run
    const material = {
      operationId: 'orphan-cancel-operation',
      run: {
        runId: 'orphan-run',
        provider: 'cli-bridge',
        environmentId: 'cli-bridge',
        sessionId: 'orphan-cancel',
        executionId: 'orphan-execution',
        requestDigest: runRequestDigest,
      },
    }
    const response = await fixture.app.request('/v1/sessions/orphan-cancel/cancel', {
      method: 'POST',
      body: JSON.stringify({
        ...material,
        requestDigest: agentRunCancellationRequestDigest(material),
      }),
    })
    expect(response.status).toBe(409)
    expect((await json(response)).status).toBe('conflict')
    expect(orphan.snapshot().status).toBe('running')
  })

  it('refuses cancellation from a different provider without touching the native run', async () => {
    const backend = new FakeNativeBackend(() => new HangingNative())
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'wrong-provider-cancel', model: 'pi/test' }),
    })
    await fixture.app.request('/v1/sessions/wrong-provider-cancel/turns', {
      method: 'POST',
      body: turnBody('wrong-provider-cancel', { message: 'hang' }),
    })
    await waitFor(() => fixture!.store.getRetained('wrong-provider-cancel')?.status === 'running')

    const exact = JSON.parse(cancellationBody(
      fixture,
      'wrong-provider-cancel',
      'wrong-provider-cancel-operation',
    )) as Record<string, any>
    const material = {
      operationId: exact.operationId,
      run: { ...exact.run, provider: 'pi' },
    }
    const response = await fixture.app.request('/v1/sessions/wrong-provider-cancel/cancel', {
      method: 'POST',
      body: JSON.stringify({
        ...material,
        requestDigest: agentRunCancellationRequestDigest(material),
      }),
    })

    expect(response.status).toBe(409)
    expect((await json(response)).status).toBe('conflict')
    expect(fixture.runs.get(exact.run.runId)?.snapshot().status).toBe('running')
  })

  it('marks a native stream that exhausts without an explicit terminal event as failed', async () => {
    fixture = setup(new FakeNativeBackend(() => new PrematureNative()))
    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'premature-stream', model: 'pi/test' }),
    })
    const turn = await fixture.app.request('/v1/sessions/premature-stream/turns', {
      method: 'POST',
      body: turnBody('premature-stream', { message: 'end early' }),
    })
    const runId = (await json(turn)).run.id as string
    await waitFor(() => fixture!.runs.get(runId)?.snapshot().terminal === true)
    expect(fixture.runs.get(runId)?.snapshot()).toMatchObject({ status: 'error', terminal: true })
    const finalEvent = fixture.store.retainedEventsAfter('premature-stream').at(-1)?.envelope.event
    expect(finalEvent).toMatchObject({
      type: 'status',
      status: 'failed',
      detail: 'native event stream ended without an explicit terminal status',
    })
    expect(fixture.store.getRetained('premature-stream')?.turns).toBe(0)
  })

  it('creates, runs two native turns, returns exact profile receipt, and replays canonical events without duplicates', async () => {
    fixture = setup(new FakeNativeBackend())
    const profile = { name: 'exact', prompt: { systemPrompt: 'be precise' }, metadata: { owner: 'test' } }
    const created = await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 's1', model: 'pi/test', agent_profile: profile }) })
    expect(created.status).toBe(201)
    const createdBody = await json(created)
    expect(createdBody.capabilities.sessions.continue).toBe(true)
    expect(createdBody.capabilities.nativeContinuation).toMatchObject({
      atomicBoundary: true,
      requestIdempotency: true,
    })
    expect(fixture.store.getRetained('s1')?.metadata.agent_profile).toEqual(profile)
    const listed = await fixture.app.request('/v1/sessions')
    expect(listed.status).toBe(200)
    expect((await json(listed)).data.map((item: { id: string }) => item.id)).toContain('s1')

    const first = await fixture.app.request('/v1/sessions/s1/turns', { method: 'POST', body: turnBody('s1-first', { message: 'first' }) })
    expect(first.status).toBe(202)
    const firstRunId = (await json(first)).run.id as string
    await waitFor(() => fixture!.store.getRetained('s1')?.turns === 1)
    const receipt = fixture.store.getRetained('s1')?.profileMaterializationReceipt
    expect(receipt).toMatchObject({ schema: 'cli-bridge.profile-materialization.v2', harness: 'pi' })

    const second = await fixture.app.request('/v1/sessions/s1/turns', { method: 'POST', body: turnBody('s1-second', { message: 'second', turn_id: 'turn-2' }) })
    expect(second.status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('s1')?.turns === 2)
    expect((fixture.store.listRetained(10)[0]?.contextBoundary as Record<string, unknown>)?.boundary).toMatchObject({ kind: 'revision' })
    expect((fixture.runs.get(firstRunId)?.nativeSession())).toBeNull()

    const stream = await fixture.app.request('/v1/sessions/s1/events')
    expect(stream.status).toBe(200)
    const text = await stream.text()
    const envelopes = [...text.matchAll(/data: (\{.*\})\r?\n/gu)].map(match => JSON.parse(match[1]!))
    expect(envelopes.length).toBeGreaterThan(0)
    expect(new Set(envelopes.map(item => item.eventId)).size).toBe(envelopes.length)
    expect(envelopes.some(item => item.event.type === 'message.part.updated')).toBe(true)
    expect(envelopes.some(item => item.event.type === 'raw' && item.event.event.type === 'usage')).toBe(true)
    const firstCursor = envelopes[0].cursor
    const replay = await fixture.app.request('/v1/sessions/s1/events', { headers: { 'Last-Event-ID': firstCursor } })
    const replayText = await replay.text()
    const replayEnvelopes = [...replayText.matchAll(/data: (\{.*\})\r?\n/gu)].map(match => JSON.parse(match[1]!))
    expect(replayEnvelopes.every(item => item.cursor > firstCursor)).toBe(true)
    expect(new Set(replayEnvelopes.map(item => item.eventId)).size).toBe(replayEnvelopes.length)
  })

  it('reapplies the exact retained profile and execution contract after restart', async () => {
    const original = setup(new FakeNativeBackend())
    fixture = original
    const profile = {
      harness: 'pi',
      model: { provider: 'isolated-test', default: 'restart-model' },
      prompt: { instructions: ['retain this profile'] },
    }
    const created = await original.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: 'restart-contract',
        model: 'pi/isolated-test/restart-model',
        agent_profile: profile,
        execution: { kind: 'host', timeoutMs: 777 },
        env: { BRIDGE_PUBLIC_VALUE: 'retained' },
        context: { session_context: 'default' },
        provider_options: { session_option: { temperature: 0.1 } },
        metadata: { caller_marker: 'durable' },
      }),
    })
    expect(created.status).toBe(201)
    expect(original.store.getRetained('restart-contract')).toMatchObject({
      model: 'pi/isolated-test/restart-model',
      metadata: {
        agent_profile: profile,
        execution: { kind: 'host', timeoutMs: 777 },
        env: { BRIDGE_PUBLIC_VALUE: 'retained' },
        context: { session_context: 'default' },
        provider_options: { session_option: { temperature: 0.1 } },
        caller_marker: 'durable',
      },
    })

    const dir = original.dir
    await original.runs.shutdown(1_000)
    await original.service.shutdown(1_000)
    original.unwatch()
    original.store.close()
    const restartedBackend = new FakeNativeBackend()
    fixture = setup(restartedBackend, dir)

    const first = await fixture.app.request('/v1/sessions/restart-contract/turns', {
      method: 'POST',
      body: turnBody('restart-interaction', { message: 'ask' }),
    })
    expect(first.status).toBe(202)
    await waitFor(() => fixture!.store.retainedEventsAfter('restart-contract').some(item => item.envelope.event.type === 'interaction'))
    expect(restartedBackend.requests[0]).toMatchObject({
      model: 'pi/isolated-test/restart-model',
      execution: { kind: 'host', timeoutMs: 777 },
      env: { BRIDGE_PUBLIC_VALUE: 'retained' },
      metadata: { caller_marker: 'durable' },
      context: { session_context: 'default' },
      providerOptions: { session_option: { temperature: 0.1 } },
      agent_profile: profile,
    })
    expect(restartedBackend.requests[0]?.metadata).not.toHaveProperty('session_context')
    expect(restartedBackend.requests[0]?.metadata).not.toHaveProperty('session_option')
    const interaction = fixture.store.retainedEventsAfter('restart-contract').find(item => item.envelope.event.type === 'interaction')!.envelope.event
    if (interaction.type !== 'interaction') throw new Error('restart interaction missing')
    const runId = interaction.request.binding.runId
    const response = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(interactionCommand('restart-answer', interaction.request, {
        id: interaction.request.id,
        outcome: 'accepted',
        data: { grant: ['allow_once'] },
      })),
    })
    expect(response.status).toBe(200)
    await waitFor(() => fixture!.store.getRetained('restart-contract')?.turns === 1)

    const second = await fixture.app.request('/v1/sessions/restart-contract/turns', {
      method: 'POST',
      body: turnBody('restart-parts', {
        parts: [
          { type: 'text', text: 'read these' },
          { type: 'file', filename: 'README.md', path: '/workspace/README.md' },
          { type: 'image', filename: 'diagram.png', url: 'https://example.test/diagram.png' },
        ],
      }),
    })
    expect(second.status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('restart-contract')?.turns === 2)
    expect(restartedBackend.natives[0]?.prompts[1]).toContain('[File: /workspace/README.md]')
    expect(restartedBackend.natives[0]?.prompts[1]).toContain('[Image: diagram.png]')
  })

  it('rejects retained sandbox coordinates before native Pi can start', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    const response = await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: 'retained-sandbox',
        model: 'pi',
        execution: {
          kind: 'sandbox',
          repoUrl: 'https://example.test/repo.git',
          gitRef: 'main',
        },
      }),
    })
    expect(response.status).toBe(501)
    expect(await json(response)).toMatchObject({ error: { type: 'capability_denied' } })
    expect(backend.natives).toHaveLength(0)
    expect(fixture.store.getRetained('retained-sandbox')).toBeNull()
  })

  it('marks an idle retained session unknown when its native child exits', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'idle-child-exit', model: 'pi/test' }),
    })
    await fixture.app.request('/v1/sessions/idle-child-exit/turns', {
      method: 'POST',
      body: turnBody('idle-child-exit-turn', { message: 'first' }),
    })
    await waitFor(() => fixture!.store.getRetained('idle-child-exit')?.turns === 1)
    backend.natives[0]!.crash()
    await waitFor(() => fixture!.store.getRetained('idle-child-exit')?.status === 'unknown')

    const status = await fixture.app.request('/v1/sessions/idle-child-exit')
    expect(status.status).toBe(200)
    expect((await json(status)).status).toBe('unknown')
    const next = await fixture.app.request('/v1/sessions/idle-child-exit/turns', {
      method: 'POST',
      body: turnBody('idle-child-exit-next', { message: 'do not restart silently' }),
    })
    expect(next.status).toBe(404)
    expect(await json(next)).toMatchObject({ error: { type: 'unknown_session' } })
    expect(backend.natives).toHaveLength(1)
  })

  it('surfaces finalization persistence failure as unknown and refuses continuation', async () => {
    fixture = setup(new FakeNativeBackend())
    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'persist-finalization', model: 'pi/test' }),
    })
    const originalUpdate = fixture.store.updateRetained.bind(fixture.store)
    let injected = false
    fixture.store.updateRetained = (id, patch) => {
      if (!injected && patch.status === 'idle') {
        injected = true
        throw new Error('injected durable finalization failure')
      }
      return originalUpdate(id, patch)
    }
    const turn = await fixture.app.request('/v1/sessions/persist-finalization/turns', {
      method: 'POST',
      body: turnBody('persist-finalization-turn', { message: 'finish once' }),
    })
    expect(turn.status).toBe(202)
    await waitFor(() => fixture!.service.get('persist-finalization').status === 'unknown')
    expect(injected).toBe(true)
    expect(fixture.service.get('persist-finalization').status).toBe('unknown')

    const next = await fixture.app.request('/v1/sessions/persist-finalization/turns', {
      method: 'POST',
      body: turnBody('persist-finalization-next', { message: 'must not continue' }),
    })
    expect(next.status).toBe(409)
    expect(await json(next)).toMatchObject({ error: { type: 'unknown_session' } })
  })

  it('reports unknown and publishes no substitute terminal event after a real SQLite terminal-write failure', async () => {
    fixture = setup(new FakeNativeBackend())
    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'terminal-commit-failure', model: 'pi/test' }),
    })
    const faultDb = new Database(join(fixture.dir, 'sessions.sqlite'))
    faultDb.exec(`
      CREATE TRIGGER reject_terminal_event
      BEFORE INSERT ON retained_events
      WHEN json_extract(NEW.event_json, '$.type') = 'status'
        AND json_extract(NEW.event_json, '$.status') IN ('completed', 'failed')
      BEGIN
        SELECT RAISE(FAIL, 'injected terminal event commit failure');
      END;
    `)
    faultDb.close()

    const turn = await fixture.app.request('/v1/sessions/terminal-commit-failure/turns', {
      method: 'POST',
      body: turnBody('terminal-commit-failure-run', { message: 'finish once' }),
    })
    const runId = (await json(turn)).run.id as string
    await waitFor(() => fixture!.runs.get(runId)?.snapshot().status === 'unknown')
    await waitFor(() => fixture!.store.getRetained('terminal-commit-failure')?.status === 'unknown')

    expect(fixture.runs.get(runId)?.snapshot()).toMatchObject({ status: 'unknown', terminal: true })
    expect(fixture.service.runSnapshot(runId)).toMatchObject({ status: 'unknown', terminal: true })
    const genericCancel = await fixture.app.request(`/v1/runs/${runId}/cancel`, { method: 'POST' })
    expect(genericCancel.status).toBe(200)
    expect(await json(genericCancel)).toMatchObject({
      cancelled: false,
      cancel_requested: false,
      terminal: true,
      run: { status: 'unknown' },
    })
    const events = fixture.store.retainedEventsAfter('terminal-commit-failure')
    expect(events.some(item => item.envelope.event.type === 'status'
      && (item.envelope.event.status === 'completed' || item.envelope.event.status === 'failed'))).toBe(false)

    const next = await fixture.app.request('/v1/sessions/terminal-commit-failure/turns', {
      method: 'POST',
      body: turnBody('terminal-commit-failure-next', { message: 'must not continue' }),
    })
    expect(next.status).toBe(404)
    expect(await json(next)).toMatchObject({ error: { type: 'unknown_session' } })

    const persistedDir = fixture.dir
    await fixture.runs.shutdown(1_000)
    await fixture.service.shutdown(1_000).catch(() => {})
    fixture.store.close()
    fixture = null
    const reopened = new SqliteSessionStore(persistedDir)
    expect(reopened.getRetained('terminal-commit-failure')?.status).toBe('unknown')
    expect(reopened.retainedEventsAfter('terminal-commit-failure').some(item => item.envelope.event.type === 'status'
      && (item.envelope.event.status === 'completed' || item.envelope.event.status === 'failed'))).toBe(false)
    reopened.close()
    rmSync(persistedDir, { recursive: true, force: true })
  })

  it('returns an unknown cancellation effect when withdrawing an interaction cannot be committed', async () => {
    fixture = setup(new FakeNativeBackend())
    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'cancel-commit-failure', model: 'pi/test' }),
    })
    const originalAppend = fixture.store.appendRetainedEvent.bind(fixture.store)
    let rejectedWithdrawals = 0
    fixture.store.appendRetainedEvent = (sessionId, input) => {
      if (input.event.type === 'interaction.cancel') {
        rejectedWithdrawals += 1
        throw new Error('injected interaction withdrawal commit failure')
      }
      return originalAppend(sessionId, input)
    }

    const turn = await fixture.app.request('/v1/sessions/cancel-commit-failure/turns', {
      method: 'POST',
      body: turnBody('cancel-commit-failure-run', { message: 'ask' }),
    })
    const runId = (await json(turn)).run.id as string
    await waitFor(() => fixture!.store.retainedEventsAfter('cancel-commit-failure')
      .some(item => item.envelope.event.type === 'interaction'))

    const cancel = await fixture.app.request('/v1/sessions/cancel-commit-failure/cancel?wait_ms=1000', {
      method: 'POST',
      body: cancellationBody(fixture, 'cancel-commit-failure', 'cancel-commit-failure-op'),
    })
    expect(cancel.status).toBe(502)
    expect(await json(cancel)).toMatchObject({ status: 'unknown', effect: 'unknown' })
    await waitFor(() => fixture!.runs.get(runId)?.snapshot().status === 'unknown')
    expect(rejectedWithdrawals).toBe(1)
    expect(fixture.store.getRetained('cancel-commit-failure')?.status).toBe('unknown')
    const events = fixture.store.retainedEventsAfter('cancel-commit-failure')
    expect(events.some(item => item.envelope.event.type === 'interaction.cancel')).toBe(false)
    expect(events.some(item => item.envelope.event.type === 'status'
      && (item.envelope.event.status === 'completed' || item.envelope.event.status === 'failed'))).toBe(false)
  })

  it('enforces the run shutdown deadline', async () => {
    const runs = new RunRegistry()
    const run = runs.claim('never-closes', 'sha256:' + 'a'.repeat(64)).run
    run.setNativeControl(new NeverClosingNative())
    await expect(runs.shutdown(20)).rejects.toBeInstanceOf(RunShutdownTimeoutError)
  })

  it('retains a failed disposal and retries the same child on later shutdown', async () => {
    const registry = new RunRegistry()
    const run = registry.claim('rejecting-cleanup', 'sha256:' + 'c'.repeat(64)).run
    const native = new FailOnceCloseNative()
    run.setNativeControl(native)
    await expect(registry.shutdown(1_000)).rejects.toThrow(/transient close failure/)
    expect(native.closeCalls).toBe(1)
    expect(native.isClosed()).toBe(false)
    await expect(registry.shutdown(1_000)).resolves.toBeUndefined()
    expect(native.closeCalls).toBe(2)
    expect(native.isClosed()).toBe(true)
  })

  it('does not drop ownership when every shutdown cleanup attempt fails', async () => {
    const registry = new RunRegistry()
    const run = registry.claim('permanent-cleanup', 'sha256:' + 'e'.repeat(64)).run
    const native = new RejectingCloseNative()
    run.setNativeControl(native)
    await expect(registry.shutdown(1_000)).rejects.toThrow(/injected native cleanup failure/)
    await expect(registry.shutdown(1_000)).rejects.toThrow(/injected native cleanup failure/)
    expect(native.closeCalls).toBe(2)
    expect(native.isClosed()).toBe(false)
  })

  it('treats a successful close as final even when native abort reports an error', async () => {
    const registry = new RunRegistry()
    const run = registry.claim('abort-close-wins', 'sha256:' + 'f'.repeat(64)).run
    const native = new RejectingAbortNative()
    run.setNativeControl(native)

    await expect(run.requestNativeCancellation()).resolves.toBe(true)
    expect(native.isClosed()).toBe(true)
    expect(run.nativeSession()).toBeNull()
    run.failCanonicalSetup(new Error('cancelled during test'))
    await expect(run.whenTerminal()).resolves.toMatchObject({ status: 'cancelled', terminal: true })
    await expect(registry.shutdown(1_000)).resolves.toBeUndefined()
  })

  it('never transfers a native child after cancellation cleanup failed', async () => {
    const run = new RunRegistry().claim('tainted-cancel', 'sha256:' + '1'.repeat(64)).run
    const native = new RejectingAbortAndCloseNative()
    run.setNativeControl(native)

    await expect(run.requestNativeCancellation()).rejects.toThrow(/abort and close both failed/)
    await expect(run.takeNativeControl(native)).resolves.toBe(false)
    expect(run.nativeSession()).toBe(native)
  })

  it('turns a synchronous whenClosed throw into an owned cleanup rejection', async () => {
    const run = new RunRegistry().claim('sync-when-closed', 'sha256:' + 'd'.repeat(64)).run
    const native = new SyncThrowWhenClosedNative()
    run.setNativeControl(native)
    expect(() => native.crash()).not.toThrow()
    await expect(run.dispose()).rejects.toThrow(/synchronous whenClosed failure/)
  })

  it('retains an unexpected-close cleanup failure for shutdown retry', async () => {
    const registry = new RunRegistry()
    const run = registry.claim('unexpected-close-retry', 'sha256:' + '9'.repeat(64)).run
    const native = new FailOnceUnexpectedCleanupNative()
    run.setNativeControl(native)

    native.crash(new Error('child exited unexpectedly'))
    await waitFor(() => native.whenClosedCalls === 1)
    await expect(registry.shutdown(1_000)).rejects.toThrow(/unexpected-close cleanup failed/)
    expect(native.closeCalls).toBe(0)

    await expect(registry.shutdown(1_000)).resolves.toBeUndefined()
    expect(native.closeCalls).toBe(1)
    expect(run.nativeSession()).toBeNull()
  })

  it('refuses every new run claim after shutdown admission closes', async () => {
    const registry = new RunRegistry()
    registry.closeAdmission()
    expect(() => registry.claim('late-run', 'sha256:' + '8'.repeat(64)))
      .toThrow(/run admission is closed/)
    await expect(registry.shutdown(1_000)).resolves.toBeUndefined()
  })

  it('keeps an expired run cleanup visible to shutdown after the run leaves the registry', async () => {
    const runs = new RunRegistry({ replayRetentionMs: 0, identityRetentionMs: 0 })
    const run = runs.claim('expired-never-closes', 'sha256:' + 'b'.repeat(64)).run
    run.setNativeControl(new NeverClosingNative())
    await run.pumpCanonical((async function* () {
      yield { event: { type: 'status' as const, status: 'completed' as const } }
    })())
    await nextTimerTurn()
    expect(runs.get('expired-never-closes')).toBeUndefined()

    await expect(runs.shutdown(20)).rejects.toBeInstanceOf(RunShutdownTimeoutError)
  })

  it('keeps public event and part identifiers valid for maximum-length caller run ids', async () => {
    fixture = setup(new FakeNativeBackend())
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'long-id', model: 'pi/test' }) })
    const runId = `r${'x'.repeat(511)}`
    const turn = await fixture.app.request('/v1/sessions/long-id/turns', {
      method: 'POST',
      body: JSON.stringify({ run_id: runId, execution_id: 'bounded-execution', message: 'bounded ids' }),
    })
    expect(turn.status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('long-id')?.turns === 1)
    const events = fixture.store.retainedEventsAfter('long-id').map(item => item.envelope)
    expect(events.every(event => event.runId.length <= 512 && event.eventId.length <= 512)).toBe(true)
    const parts = events.flatMap(event => event.event.type === 'message.part.updated' ? [event.event.part] : [])
    expect(parts.length).toBeGreaterThan(0)
    expect(parts.every(part => part.id.length <= 512 && part.sessionID.length <= 512 && part.messageID.length <= 512)).toBe(true)
  })

  it('maps reasoning, tool, plan, permission, usage, and terminal events through the public stream', async () => {
    fixture = setup(new FakeNativeBackend())
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'rich', model: 'pi/test' }) })
    const turn = await fixture.app.request('/v1/sessions/rich/turns', { method: 'POST', body: turnBody('rich', { message: 'rich' }) })
    expect(turn.status).toBe(202)
    const runId = (await json(turn)).run.id as string
    await waitFor(() => fixture!.store.retainedEventsAfter('rich').some(item => item.envelope.event.type === 'interaction'))
    const interaction = fixture.store.retainedEventsAfter('rich').find(item => item.envelope.event.type === 'interaction')!.envelope.event
    if (interaction.type !== 'interaction') throw new Error('test interaction missing')
    const response = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(interactionCommand('rich-answer', interaction.request, {
        id: interaction.request.id,
        outcome: 'accepted',
        data: { grant: ['allow_once'] },
      })),
    })
    expect(response.status).toBe(200)
    await waitFor(() => fixture!.store.getRetained('rich')?.turns === 1)
    const events = fixture.store.retainedEventsAfter('rich').map(item => item.envelope.event)
    expect(events.some(event => event.type === 'message.part.updated' && event.part.type === 'reasoning')).toBe(true)
    expect(events.some(event => event.type === 'message.part.updated' && event.part.type === 'tool')).toBe(true)
    expect(events.some(event => event.type === 'plan.submitted')).toBe(true)
    expect(events.some(event => event.type === 'interaction')).toBe(true)
    expect(events.some(event => event.type === 'raw' && isUsageRawEvent(event.event))).toBe(true)
    expect(events.some(event => event.type === 'status' && event.status === 'completed')).toBe(true)
  })

  it('does not advertise an uninstrumented native dialog as answerable', async () => {
    fixture = setup(new FakeNativeBackend())
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'uninstrumented', model: 'pi/test' }) })
    const turn = await fixture.app.request('/v1/sessions/uninstrumented/turns', {
      method: 'POST',
      body: turnBody('uninstrumented', { message: 'uninstrumented' }),
    })
    expect(turn.status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('uninstrumented')?.turns === 1)
    const events = fixture.store.retainedEventsAfter('uninstrumented').map(item => item.envelope.event)
    expect(events.some(event => event.type === 'interaction')).toBe(false)
    expect(events.some(event => event.type === 'warning' && event.code === 'unsupported_interaction')).toBe(true)
  })

  it('auto-denies an unrequested supported dialog through the durable response lane', async () => {
    const native = new FakeNative()
    fixture = setup(new FakeNativeBackend(() => native))
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'auto-deny', model: 'pi/test' }) })
    const turn = await fixture.app.request('/v1/sessions/auto-deny/turns', {
      method: 'POST',
      body: turnBody('auto-deny', { message: 'ask', interactions: { permission: false } }),
    })
    expect(turn.status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('auto-deny')?.turns === 1)
    const events = fixture.store.retainedEventsAfter('auto-deny').map(item => item.envelope.event)
    expect(events.some(event => event.type === 'interaction')).toBe(false)
    expect(events.some(event => event.type === 'warning' && event.code === 'interaction_not_requested')).toBe(true)
    expect(native.responseCalls).toBe(1)
  })

  it('persists an auto-denial unknown-effect tombstone and never retries the native effect', async () => {
    const native = new AfterNativeResponseFailure()
    fixture = setup(new FakeNativeBackend(() => native))
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'auto-deny-unknown', model: 'pi/test' }) })
    const turn = await fixture.app.request('/v1/sessions/auto-deny-unknown/turns', {
      method: 'POST',
      body: turnBody('auto-deny-unknown', { message: 'ask', interactions: { permission: false } }),
    })
    const runId = (await json(turn)).run.id as string
    const interactionId = `${runId}:interaction:ui-1`
    await waitFor(() => fixture!.store.findEffectUnknownInteraction(runId, 'auto-deny-unknown', interactionId) !== null)
    expect(fixture.store.findEffectUnknownInteraction(runId, 'auto-deny-unknown', interactionId)).toMatchObject({
      phase: 'effect_unknown',
    })
    expect(native.effectCount).toBe(1)
    expect(native.responseCalls).toBe(1)
  })

  it('keeps detach separate from explicit cancel', async () => {
    const backend = new FakeNativeBackend(() => new HangingNative())
    fixture = setup(backend)
    const created = await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 's2', model: 'pi/test' }) })
    expect(created.status).toBe(201)
    await fixture.app.request('/v1/sessions/s2/turns', { method: 'POST', body: turnBody('s2-hang', { message: 'hang' }) })
    await waitFor(() => fixture!.store.getRetained('s2')?.status === 'running')
    const detached = await fixture.app.request('/v1/sessions/s2/detach', { method: 'POST' })
    expect(detached.status).toBe(200)
    expect((await json(detached)).session.status).toBe('running')
    const cancelled = await fixture.app.request('/v1/sessions/s2/cancel?wait_ms=1000', { method: 'POST', body: cancellationBody(fixture, 's2', 'cancel-s2') })
    expect(cancelled.status).toBe(200)
    expect(await json(cancelled)).toMatchObject({ status: 'accepted', effect: 'cancelled' })
  })

  it('closes an idle session and releases its native child', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'close-idle', model: 'pi/test' }) })
    await fixture.app.request('/v1/sessions/close-idle/turns', { method: 'POST', body: turnBody('close-idle', { message: 'finish' }) })
    await waitFor(() => fixture!.store.getRetained('close-idle')?.turns === 1)
    const closed = await fixture.app.request('/v1/sessions/close-idle/close', { method: 'POST' })
    expect(closed.status).toBe(200)
    expect((await json(closed)).session.status).toBe('closed')
    expect(backend.natives[0]!.closeCalls).toBe(1)
    expect(fixture.runs.nativeSession('close-idle')).toBeNull()
  })

  it('keeps a concurrently closed session closed after delayed turn finalization', async () => {
    const native = new DeferredBoundaryNative()
    fixture = setup(new FakeNativeBackend(() => native))
    await fixture.app.request('/v1/sessions', {
      method: 'POST', body: JSON.stringify({ id: 'close-during-finalization', model: 'pi/test' }),
    })
    try {
      const turn = await fixture.app.request('/v1/sessions/close-during-finalization/turns', {
        method: 'POST', body: turnBody('close-during-finalization', { message: 'finish' }),
      })
      expect(turn.status).toBe(202)
      await native.boundaryStarted

      const closed = await fixture.app.request('/v1/sessions/close-during-finalization/close', { method: 'POST' })
      expect(closed.status).toBe(200)
      expect((await json(closed)).session.status).toBe('closed')

      native.allowBoundary()
      await waitFor(() => fixture!.store.getRetained('close-during-finalization')?.turns === 1)
      expect(fixture.store.getRetained('close-during-finalization')?.status).toBe('closed')
    } finally {
      native.allowBoundary()
    }
  })

  it('keeps a session unknown after its native child exits during delayed finalization', async () => {
    const native = new DeferredBoundaryNative()
    fixture = setup(new FakeNativeBackend(() => native))
    await fixture.app.request('/v1/sessions', {
      method: 'POST', body: JSON.stringify({ id: 'unknown-during-finalization', model: 'pi/test' }),
    })

    try {
      const turn = await fixture.app.request('/v1/sessions/unknown-during-finalization/turns', {
        method: 'POST', body: turnBody('unknown-during-finalization', { message: 'finish' }),
      })
      expect(turn.status).toBe(202)
      await native.boundaryStarted

      native.crash()
      await waitFor(() => fixture!.store.getRetained('unknown-during-finalization')?.status === 'unknown')
      native.allowBoundary()

      await waitFor(() => fixture!.store.getRetained('unknown-during-finalization')?.turns === 1)
      expect(fixture.store.getRetained('unknown-during-finalization')?.status).toBe('unknown')
    } finally {
      native.allowBoundary()
    }
  })

  it('lets close win a native ownership race without starting a continuation', async () => {
    const native = new DeferredCloseNative()
    fixture = setup(new FakeNativeBackend(() => native))
    await fixture.app.request('/v1/sessions', {
      method: 'POST', body: JSON.stringify({ id: 'close-transfer-race', model: 'pi/test' }),
    })
    await fixture.app.request('/v1/sessions/close-transfer-race/turns', {
      method: 'POST', body: turnBody('close-transfer-first', { message: 'first' }),
    })
    await waitFor(() => fixture!.store.getRetained('close-transfer-race')?.turns === 1)

    try {
      const closing = fixture.app.request('/v1/sessions/close-transfer-race/close', { method: 'POST' })
      await native.closeStarted
      const continuation = fixture.app.request('/v1/sessions/close-transfer-race/turns', {
        method: 'POST', body: turnBody('close-transfer-second', { message: 'second' }),
      })
      const continued = await continuation
      expect(continued.status).toBe(409)
      expect((await json(continued)).error.type).toBe('invalid_state')
      expect(native.boundaryDuringCloseCalls).toBe(0)

      native.allowClose()
      const closed = await closing
      expect(closed.status).toBe(200)
      expect(native.prompts).toEqual(['first'])
      expect(native.closeCalls).toBe(1)
      expect(fixture.store.getRetained('close-transfer-race')?.status).toBe('closed')
      expect(fixture.store.getRetainedRun('run-close-transfer-second')).toBeNull()
    } finally {
      native.allowClose()
    }
  })

  it('rejects close while a first turn owns startup before attaching its native child', async () => {
    const backend = new DeferredStartNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', {
      method: 'POST', body: JSON.stringify({ id: 'close-first-startup', model: 'pi/test' }),
    })

    try {
      const turn = fixture.app.request('/v1/sessions/close-first-startup/turns', {
        method: 'POST', body: turnBody('close-first-startup', { message: 'first' }),
      })
      await backend.startEntered
      expect(fixture.runs.nativeSession('close-first-startup')).toBeNull()
      const status = await fixture.app.request('/v1/sessions/close-first-startup')
      expect(status.status).toBe(200)
      expect((await json(status)).status).toBe('running')
      expect(fixture.store.getRetained('close-first-startup')?.status).toBe('running')

      const closed = await fixture.app.request('/v1/sessions/close-first-startup/close', { method: 'POST' })
      expect(closed.status).toBe(409)
      expect((await json(closed)).error.type).toBe('active_run')

      backend.allowStart()
      expect((await turn).status).toBe(202)
      await waitFor(() => fixture!.store.getRetained('close-first-startup')?.turns === 1)
      expect(fixture.store.getRetained('close-first-startup')?.status).toBe('idle')
    } finally {
      backend.allowStart()
    }
  })

  it('terminalizes a claimed run when initial run publication fails before startup', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', {
      method: 'POST', body: JSON.stringify({ id: 'run-publication-failure', model: 'pi/test' }),
    })
    const body = turnBody('run-publication-failure', { message: 'first' })
    const updateRetainedRun = fixture.store.updateRetainedRun.bind(fixture.store)
    let injected = false
    fixture.store.updateRetainedRun = ((...args: Parameters<typeof updateRetainedRun>) => {
      if (!injected) {
        injected = true
        throw new Error('injected run publication failure')
      }
      return updateRetainedRun(...args)
    }) as typeof fixture.store.updateRetainedRun

    const first = await fixture.app.request('/v1/sessions/run-publication-failure/turns', {
      method: 'POST', body,
    })
    fixture.store.updateRetainedRun = updateRetainedRun

    expect(first.status).toBeGreaterThanOrEqual(500)
    expect(backend.natives).toHaveLength(0)
    expect(fixture.runs.get('run-run-publication-failure')?.snapshot()).toMatchObject({
      status: 'error',
      terminal: true,
    })
    expect(fixture.store.getRetainedRun('run-run-publication-failure')?.snapshot).toMatchObject({
      status: 'error',
      terminal: true,
    })

    const retried = await fixture.app.request('/v1/sessions/run-publication-failure/turns', {
      method: 'POST', body,
    })
    expect(retried.status).toBe(202)
    expect(await json(retried)).toMatchObject({ run: { status: 'error', terminal: true } })
    expect(backend.natives).toHaveLength(0)
  })

  it('terminalizes a claimed run when session publication fails before startup', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', {
      method: 'POST', body: JSON.stringify({ id: 'session-publication-failure', model: 'pi/test' }),
    })
    const body = turnBody('session-publication-failure', { message: 'first' })
    const updateRetained = fixture.store.updateRetained.bind(fixture.store)
    let injected = false
    fixture.store.updateRetained = ((id, patch) => {
      if (!injected && patch.status === 'running' && patch.runId === 'run-session-publication-failure') {
        injected = true
        throw new Error('injected session publication failure')
      }
      return updateRetained(id, patch)
    }) as typeof fixture.store.updateRetained

    const first = await fixture.app.request('/v1/sessions/session-publication-failure/turns', {
      method: 'POST', body,
    })
    fixture.store.updateRetained = updateRetained

    expect(first.status).toBeGreaterThanOrEqual(500)
    expect(backend.natives).toHaveLength(0)
    expect(fixture.store.getRetainedRun('run-session-publication-failure')?.snapshot).toMatchObject({
      status: 'error',
      terminal: true,
    })

    const retried = await fixture.app.request('/v1/sessions/session-publication-failure/turns', {
      method: 'POST', body,
    })
    expect(retried.status).toBe(202)
    expect(await json(retried)).toMatchObject({ run: { status: 'error', terminal: true } })
    expect(backend.natives).toHaveLength(0)
  })

  it('waits for and closes a child that returns after run shutdown starts', async () => {
    const backend = new DeferredStartNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', {
      method: 'POST', body: JSON.stringify({ id: 'shutdown-first-startup', model: 'pi/test' }),
    })
    const runId = 'run-shutdown-first-startup'

    try {
      const turn = fixture.app.request('/v1/sessions/shutdown-first-startup/turns', {
        method: 'POST', body: turnBody('shutdown-first-startup', { message: 'first' }),
      })
      await backend.startEntered
      const run = fixture.runs.get(runId)
      if (!run) throw new Error('pending startup run is missing')

      const shuttingDown = fixture.runs.shutdown(1_000)
      await waitForAbort(run.signal)
      backend.allowStart()

      const [turned] = await Promise.all([turn, shuttingDown])
      expect(turned.status).toBe(409)
      expect((await json(turned)).error.type).toBe('cancelled')
      expect(backend.natives).toHaveLength(1)
      expect(backend.natives[0]!.closeCalls).toBe(1)
      expect(backend.natives[0]!.isClosed()).toBe(true)
    } finally {
      backend.allowStart()
    }
  })

  it('cancels a first turn while native startup is still pending', async () => {
    const backend = new DeferredStartNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', {
      method: 'POST', body: JSON.stringify({ id: 'cancel-first-startup', model: 'pi/test' }),
    })
    const runId = 'run-cancel-first-startup'

    try {
      const turn = fixture.app.request('/v1/sessions/cancel-first-startup/turns', {
        method: 'POST', body: turnBody('cancel-first-startup', { message: 'first' }),
      })
      await backend.startEntered
      const admission = fixture.store.getRetainedRun(runId)
      if (!admission) throw new Error('pending startup run admission is missing')
      const cancellation = {
        operationId: 'cancel-first-startup-operation',
        run: {
          runId,
          provider: 'cli-bridge' as const,
          environmentId: 'cli-bridge',
          sessionId: 'cancel-first-startup',
          executionId: admission.executionId,
          requestDigest: admission.requestDigest as `sha256:${string}`,
        },
      }
      const cancelling = fixture.app.request('/v1/sessions/cancel-first-startup/cancel?wait_ms=1000', {
        method: 'POST',
        body: JSON.stringify({
          ...cancellation,
          requestDigest: agentRunCancellationRequestDigest(cancellation),
        }),
      })
      await waitForAbort(fixture!.runs.get(runId)!.signal)

      backend.allowStart()
      const [turned, cancelled] = await Promise.all([turn, cancelling])
      expect(turned.status).toBe(409)
      expect((await json(turned)).error.type).toBe('cancelled')
      expect(cancelled.status).toBe(200)
      expect(await json(cancelled)).toMatchObject({ status: 'accepted', effect: 'cancelled' })
      expect(fixture.store.getRetained('cancel-first-startup')?.status).toBe('cancelled')
      expect(backend.natives[0]!.closeCalls).toBe(1)
    } finally {
      backend.allowStart()
    }
  })

  it('retains a late startup child when its first cancellation cleanup fails', async () => {
    const native = new FailOnceCloseNative()
    const backend = new DeferredStartNativeBackend(() => native)
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', {
      method: 'POST', body: JSON.stringify({ id: 'cancel-startup-close-failure', model: 'pi/test' }),
    })
    const runId = 'run-cancel-startup-close-failure'

    try {
      const turn = fixture.app.request('/v1/sessions/cancel-startup-close-failure/turns', {
        method: 'POST', body: turnBody('cancel-startup-close-failure', { message: 'first' }),
      })
      await backend.startEntered
      const cancelling = fixture.app.request('/v1/sessions/cancel-startup-close-failure/cancel?wait_ms=1000', {
        method: 'POST',
        body: cancellationBody(fixture, 'cancel-startup-close-failure', 'cancel-startup-close-failure-operation'),
      })
      await waitForAbort(fixture!.runs.get(runId)!.signal)

      backend.allowStart()
      const [turned, cancelled] = await Promise.all([turn, cancelling])
      expect(turned.status).toBe(502)
      expect((await json(turned)).error.type).toBe('close_failed')
      expect(cancelled.status).toBe(502)
      expect(await json(cancelled)).toMatchObject({ status: 'unknown', effect: 'unknown', retryable: false })
      expect(fixture.store.getRetained('cancel-startup-close-failure')?.status).toBe('unknown')
      expect(fixture.runs.nativeSession('cancel-startup-close-failure')?.session).toBe(native)
      expect(native.closeCalls).toBe(1)

      const closed = await fixture.app.request('/v1/sessions/cancel-startup-close-failure/close', { method: 'POST' })
      expect(closed.status).toBe(200)
      expect((await json(closed)).session.status).toBe('closed')
      expect(native.closeCalls).toBe(2)
      expect(fixture.runs.nativeSession('cancel-startup-close-failure')).toBeNull()
    } finally {
      backend.allowStart()
    }
  })

  it('rejects close while continuation ownership is between native runs', async () => {
    const native = new FakeNative()
    fixture = setup(new FakeNativeBackend(() => native))
    await fixture.app.request('/v1/sessions', {
      method: 'POST', body: JSON.stringify({ id: 'close-transfer-gap', model: 'pi/test' }),
    })
    await fixture.app.request('/v1/sessions/close-transfer-gap/turns', {
      method: 'POST', body: turnBody('close-transfer-gap-first', { message: 'first' }),
    })
    await waitFor(() => fixture!.store.getRetained('close-transfer-gap')?.turns === 1)

    const prior = fixture.runs.nativeSession('close-transfer-gap')
    if (!prior) throw new Error('first native run is missing')
    const takeNativeControl = prior.run.takeNativeControl.bind(prior.run)
    let signalTaken!: () => void
    let releaseTransfer!: () => void
    const taken = new Promise<void>(resolve => { signalTaken = resolve })
    const transferReady = new Promise<void>(resolve => { releaseTransfer = resolve })
    prior.run.takeNativeControl = async control => {
      signalTaken()
      await transferReady
      return await takeNativeControl(control)
    }

    try {
      const continuation = fixture.app.request('/v1/sessions/close-transfer-gap/turns', {
        method: 'POST', body: turnBody('close-transfer-gap-second', { message: 'second' }),
      })
      await taken
      expect(fixture.runs.nativeSession('close-transfer-gap')?.run.id).toBe('run-close-transfer-gap-first')
      const status = await fixture.app.request('/v1/sessions/close-transfer-gap')
      expect(status.status).toBe(200)
      expect(await json(status)).toMatchObject({
        status: 'running',
        run_id: 'run-close-transfer-gap-second',
        run: { id: 'run-close-transfer-gap-second', status: 'running' },
      })
      expect(fixture.store.getRetained('close-transfer-gap')?.status).toBe('running')

      const closed = await fixture.app.request('/v1/sessions/close-transfer-gap/close', { method: 'POST' })
      expect(closed.status).toBe(409)
      expect((await json(closed)).error.type).toBe('active_run')

      releaseTransfer()
      expect((await continuation).status).toBe(202)
      await waitFor(() => fixture!.store.getRetained('close-transfer-gap')?.turns === 2)
      expect(fixture.store.getRetained('close-transfer-gap')?.status).toBe('idle')
      expect(native.prompts).toEqual(['first', 'second'])
    } finally {
      releaseTransfer()
    }
  })

  it('closes a transferred child when shutdown starts during the ownership gap', async () => {
    const native = new FakeNative()
    fixture = setup(new FakeNativeBackend(() => native))
    await fixture.app.request('/v1/sessions', {
      method: 'POST', body: JSON.stringify({ id: 'shutdown-transfer-gap', model: 'pi/test' }),
    })
    await fixture.app.request('/v1/sessions/shutdown-transfer-gap/turns', {
      method: 'POST', body: turnBody('shutdown-transfer-first', { message: 'first' }),
    })
    await waitFor(() => fixture!.store.getRetained('shutdown-transfer-gap')?.turns === 1)

    const prior = fixture.runs.nativeSession('shutdown-transfer-gap')
    if (!prior) throw new Error('first native run is missing')
    const takeNativeControl = prior.run.takeNativeControl.bind(prior.run)
    let signalTaken!: () => void
    let releaseTransfer!: () => void
    const taken = new Promise<void>(resolve => { signalTaken = resolve })
    const transferReady = new Promise<void>(resolve => { releaseTransfer = resolve })
    prior.run.takeNativeControl = async control => {
      const accepted = await takeNativeControl(control)
      signalTaken()
      await transferReady
      return accepted
    }

    try {
      const continuation = fixture.app.request('/v1/sessions/shutdown-transfer-gap/turns', {
        method: 'POST', body: turnBody('shutdown-transfer-second', { message: 'second' }),
      })
      await taken
      const run = fixture.runs.get('run-shutdown-transfer-second')
      if (!run) throw new Error('continuation run is missing')
      expect(fixture.runs.nativeSession('shutdown-transfer-gap')).toBeNull()

      const shuttingDown = fixture.runs.shutdown(1_000)
      await waitForAbort(run.signal)
      releaseTransfer()

      const [continued] = await Promise.all([continuation, shuttingDown])
      expect(continued.status).toBe(409)
      expect((await json(continued)).error.type).toBe('cancelled')
      expect(native.closeCalls).toBe(1)
      expect(native.isClosed()).toBe(true)
    } finally {
      releaseTransfer()
    }
  })

  it('cancels and closes a continuation while native ownership is between runs', async () => {
    const native = new FakeNative()
    fixture = setup(new FakeNativeBackend(() => native))
    await fixture.app.request('/v1/sessions', {
      method: 'POST', body: JSON.stringify({ id: 'cancel-transfer-gap', model: 'pi/test' }),
    })
    await fixture.app.request('/v1/sessions/cancel-transfer-gap/turns', {
      method: 'POST', body: turnBody('cancel-transfer-gap-first', { message: 'first' }),
    })
    await waitFor(() => fixture!.store.getRetained('cancel-transfer-gap')?.turns === 1)

    const prior = fixture.runs.nativeSession('cancel-transfer-gap')
    if (!prior) throw new Error('first native run is missing')
    const takeNativeControl = prior.run.takeNativeControl.bind(prior.run)
    let signalTaken!: () => void
    let releaseTransfer!: () => void
    const taken = new Promise<void>(resolve => { signalTaken = resolve })
    const transferReady = new Promise<void>(resolve => { releaseTransfer = resolve })
    prior.run.takeNativeControl = async control => {
      const accepted = await takeNativeControl(control)
      signalTaken()
      await transferReady
      return accepted
    }

    try {
      const continuation = fixture.app.request('/v1/sessions/cancel-transfer-gap/turns', {
        method: 'POST', body: turnBody('cancel-transfer-gap-second', { message: 'second' }),
      })
      await taken
      expect(fixture.runs.nativeSession('cancel-transfer-gap')).toBeNull()
      expect(fixture.store.getRetained('cancel-transfer-gap')?.runId).toBe('run-cancel-transfer-gap-second')

      const cancelling = fixture.app.request('/v1/sessions/cancel-transfer-gap/cancel?wait_ms=1000', {
        method: 'POST',
        body: cancellationBody(fixture, 'cancel-transfer-gap', 'cancel-transfer-gap-operation'),
      })
      await waitForAbort(fixture!.runs.get('run-cancel-transfer-gap-second')!.signal)
      releaseTransfer()

      const [continued, cancelled] = await Promise.all([continuation, cancelling])
      expect(continued.status).toBe(409)
      expect((await json(continued)).error.type).toBe('cancelled')
      expect(cancelled.status).toBe(200)
      expect(await json(cancelled)).toMatchObject({ status: 'accepted', effect: 'cancelled' })
      expect(fixture.store.getRetained('cancel-transfer-gap')?.status).toBe('cancelled')
      expect(native.prompts).toEqual(['first'])
      expect(native.closeCalls).toBe(1)
    } finally {
      releaseTransfer()
    }
  })

  it('blocks continuation until a failed close has fully released ownership', async () => {
    const native = new CloseFailureContinuationNative()
    fixture = setup(new FakeNativeBackend(() => native))
    await fixture.app.request('/v1/sessions', {
      method: 'POST', body: JSON.stringify({ id: 'close-failure-continuation', model: 'pi/test' }),
    })
    await fixture.app.request('/v1/sessions/close-failure-continuation/turns', {
      method: 'POST', body: turnBody('close-failure-first', { message: 'first' }),
    })
    await waitFor(() => fixture!.store.getRetained('close-failure-continuation')?.turns === 1)

    try {
      const closing = fixture.app.request('/v1/sessions/close-failure-continuation/close', { method: 'POST' })
      await native.closeStarted
      const blocked = await fixture.app.request('/v1/sessions/close-failure-continuation/turns', {
        method: 'POST', body: turnBody('close-failure-second', { message: 'second' }),
      })
      expect(blocked.status).toBe(409)
      expect((await json(blocked)).error.type).toBe('invalid_state')

      native.allowCloseFailure()
      const closed = await closing
      expect(closed.status).toBe(502)
      expect((await json(closed)).error.type).toBe('close_failed')

      const continued = await fixture.app.request('/v1/sessions/close-failure-continuation/turns', {
        method: 'POST', body: turnBody('close-failure-second', { message: 'second' }),
      })
      expect(continued.status).toBe(202)
      await native.secondTurnStarted
      expect(fixture.store.getRetained('close-failure-continuation')).toMatchObject({
        status: 'running',
        runId: 'run-close-failure-second',
      })

      native.allowSecondTurn()
      await waitFor(() => fixture!.store.getRetained('close-failure-continuation')?.turns === 2)
      expect(fixture.store.getRetained('close-failure-continuation')?.status).toBe('idle')
      expect(native.prompts).toEqual(['first', 'second'])
    } finally {
      native.allowCloseFailure()
      native.allowSecondTurn()
    }
  })

  it('retains close ownership after a transient failure so the same close can retry', async () => {
    const backend = new FakeNativeBackend(() => new FailOnceCloseNative())
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', {
      method: 'POST', body: JSON.stringify({ id: 'close-retry', model: 'pi/test' }),
    })
    await fixture.app.request('/v1/sessions/close-retry/turns', {
      method: 'POST', body: turnBody('close-retry', { message: 'finish' }),
    })
    await waitFor(() => fixture!.store.getRetained('close-retry')?.turns === 1)

    const first = await fixture.app.request('/v1/sessions/close-retry/close', { method: 'POST' })
    expect(first.status).toBe(502)
    expect(fixture.runs.nativeSession('close-retry')?.session).toBe(backend.natives[0])

    const second = await fixture.app.request('/v1/sessions/close-retry/close', { method: 'POST' })
    expect(second.status).toBe(200)
    expect((await json(second)).session.status).toBe('closed')
    expect(backend.natives[0]!.closeCalls).toBe(2)
    expect(fixture.runs.nativeSession('close-retry')).toBeNull()
  })

  it('lets close retry after active cancellation cleanup fails', async () => {
    const native = new FailOnceCloseNative()
    fixture = setup(new FakeNativeBackend(() => native))
    await fixture.app.request('/v1/sessions', {
      method: 'POST', body: JSON.stringify({ id: 'cancel-close-retry', model: 'pi/test' }),
    })
    await fixture.app.request('/v1/sessions/cancel-close-retry/turns', {
      method: 'POST', body: turnBody('cancel-close-retry', { message: 'ask' }),
    })
    await waitFor(() => fixture!.store.retainedEventsAfter('cancel-close-retry')
      .some(item => item.envelope.event.type === 'interaction'))

    const cancelled = await fixture.app.request('/v1/sessions/cancel-close-retry/cancel?wait_ms=1000', {
      method: 'POST',
      body: cancellationBody(fixture, 'cancel-close-retry', 'cancel-close-retry-operation'),
    })
    expect(cancelled.status).toBe(502)
    expect(await json(cancelled)).toMatchObject({ status: 'unknown', effect: 'unknown' })
    expect(native.closeCalls).toBe(1)
    expect(native.isClosed()).toBe(false)
    expect(fixture.runs.nativeSession('cancel-close-retry')?.session).toBe(native)

    const closed = await fixture.app.request('/v1/sessions/cancel-close-retry/close', { method: 'POST' })
    expect(closed.status).toBe(200)
    expect((await json(closed)).session.status).toBe('closed')
    expect(native.closeCalls).toBe(2)
    expect(native.isClosed()).toBe(true)
    expect(fixture.runs.nativeSession('cancel-close-retry')).toBeNull()
  })

  it('does not reopen a closed session when its completed run is cancelled late', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', {
      method: 'POST', body: JSON.stringify({ id: 'late-cancel-closed', model: 'pi/test' }),
    })
    await fixture.app.request('/v1/sessions/late-cancel-closed/turns', {
      method: 'POST', body: turnBody('late-cancel-closed', { message: 'first' }),
    })
    await waitFor(() => fixture!.store.getRetained('late-cancel-closed')?.turns === 1)
    const lateCancellation = cancellationBody(fixture, 'late-cancel-closed', 'late-cancel-closed-operation')

    const closed = await fixture.app.request('/v1/sessions/late-cancel-closed/close', { method: 'POST' })
    expect(closed.status).toBe(200)
    const cancelled = await fixture.app.request('/v1/sessions/late-cancel-closed/cancel?wait_ms=1000', {
      method: 'POST', body: lateCancellation,
    })
    expect(cancelled.status).toBe(200)
    expect(fixture.store.getRetained('late-cancel-closed')?.status).toBe('closed')
    expect(backend.natives[0]!.closeCalls).toBe(1)
  })

  it('does not let a late cancellation for the prior run overwrite its continuation', async () => {
    const native = new DeferredSecondTurnNative()
    fixture = setup(new FakeNativeBackend(() => native))
    await fixture.app.request('/v1/sessions', {
      method: 'POST', body: JSON.stringify({ id: 'late-cancel-continuation', model: 'pi/test' }),
    })
    await fixture.app.request('/v1/sessions/late-cancel-continuation/turns', {
      method: 'POST', body: turnBody('late-cancel-prior', { message: 'first' }),
    })
    await waitFor(() => fixture!.store.getRetained('late-cancel-continuation')?.turns === 1)
    const priorCancellation = cancellationBody(fixture, 'late-cancel-continuation', 'late-cancel-prior-operation')

    try {
      const continuation = await fixture.app.request('/v1/sessions/late-cancel-continuation/turns', {
        method: 'POST', body: turnBody('late-cancel-current', { message: 'second' }),
      })
      expect(continuation.status).toBe(202)
      await native.secondTurnStarted
      expect(fixture.store.getRetained('late-cancel-continuation')).toMatchObject({
        status: 'running',
        runId: 'run-late-cancel-current',
      })

      const cancelled = await fixture.app.request('/v1/sessions/late-cancel-continuation/cancel?wait_ms=1000', {
        method: 'POST', body: priorCancellation,
      })
      expect(cancelled.status).toBe(200)
      expect(fixture.store.getRetained('late-cancel-continuation')).toMatchObject({
        status: 'running',
        runId: 'run-late-cancel-current',
      })

      native.allowSecondTurn()
      await waitFor(() => fixture!.store.getRetained('late-cancel-continuation')?.turns === 2)
      expect(fixture.store.getRetained('late-cancel-continuation')?.status).toBe('idle')
    } finally {
      native.allowSecondTurn()
    }
  })

  it('steers an active native run only through the advertised adapter control', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'steer', model: 'pi/test' }) })
    const turn = await fixture.app.request('/v1/sessions/steer/turns', { method: 'POST', body: turnBody('steer-ask', { message: 'ask' }) })
    expect(turn.status).toBe(202)
    await waitFor(() => fixture!.store.retainedEventsAfter('steer').some(item => item.envelope.event.type === 'interaction'))
    const steered = await fixture.app.request('/v1/sessions/steer/steer', { method: 'POST', body: JSON.stringify(steerRequest(fixture, 'steer', 'steer-request', 'use README.md')) })
    expect(steered.status).toBe(200)
    expect(backend.natives[0]!.steers).toEqual(['use README.md'])
    const interaction = fixture.store.retainedEventsAfter('steer').find(item => item.envelope.event.type === 'interaction')!.envelope.event
    if (interaction.type !== 'interaction') throw new Error('test interaction missing')
    const runId = interaction.request.id.split(':interaction:')[0]!
    const response = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(interactionCommand('steer-answer', interaction.request, {
        id: interaction.request.id,
        outcome: 'accepted',
        data: { grant: ['allow_once'] },
      })),
    })
    expect(response.status).toBe(200)
    await waitFor(() => fixture!.store.getRetained('steer')?.turns === 1)
    expect(fixture.store.retainedEventsAfter('steer').some(item => item.envelope.event.type === 'message.part.updated' && item.envelope.event.part.type === 'text' && item.envelope.event.part.text === 'steered-use README.md')).toBe(true)
  })

  it('rejects steering for a wrong durable run and for a run that is no longer live', async () => {
    const backend = new FakeNativeBackend(() => new HangingNative())
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'steer-binding', model: 'pi/test' }) })
    await fixture.app.request('/v1/sessions/steer-binding/turns', { method: 'POST', body: turnBody('steer-binding', { message: 'hang' }) })
    await waitFor(() => fixture!.store.getRetained('steer-binding')?.status === 'running')
    const exact = steerRequest(fixture, 'steer-binding', 'steer-wrong-run', 'do not send')
    const wrong = await fixture.app.request('/v1/sessions/steer-binding/steer', {
      method: 'POST',
      body: JSON.stringify({ ...exact, run: { ...exact.run, runId: 'wrong-run' } }),
    })
    expect(wrong.status).toBe(409)
    const wrongProvider = await fixture.app.request('/v1/sessions/steer-binding/steer', {
      method: 'POST',
      body: JSON.stringify({
        ...exact,
        operationId: 'steer-wrong-provider',
        run: { ...exact.run, provider: 'pi' },
      }),
    })
    expect(wrongProvider.status).toBe(409)
    expect(backend.natives[0]!.steers).toEqual([])

    const control = fixture.runs.nativeSession('steer-binding')
    if (!control) throw new Error('steer binding native control missing')
    control.run.requestNativeCancellation()
    await waitFor(() => control.run.snapshot().terminal)
    const noLongerLive = await fixture.app.request('/v1/sessions/steer-binding/steer', {
      method: 'POST',
      body: JSON.stringify({ ...exact, operationId: 'steer-no-longer-live' }),
    })
    expect(noLongerLive.status).toBe(404)
    expect(backend.natives[0]!.steers).toEqual([])
  })

  it('requires caller operation ids for retry-safe steering and cancellation', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'operation-id-required', model: 'pi/test' }) })
    const steer = await fixture.app.request('/v1/sessions/operation-id-required/steer', {
      method: 'POST',
      body: JSON.stringify({ message: 'missing operation id' }),
    })
    const cancel = await fixture.app.request('/v1/sessions/operation-id-required/cancel', { method: 'POST' })
    expect(steer.status).toBe(400)
    expect(cancel.status).toBe(400)
  })

  it('queues next-turn input behind an active native run and admits it after finalization', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'queued', model: 'pi/test' }) })
    const first = await fixture.app.request('/v1/sessions/queued/turns', { method: 'POST', body: turnBody('queued-first', { message: 'ask' }) })
    const firstBody = await json(first)
    const firstRunId = firstBody.run.id as string
    await waitFor(() => fixture!.store.retainedEventsAfter('queued').some(item => item.envelope.event.type === 'interaction'))
    const interaction = fixture.store.retainedEventsAfter('queued').find(item => item.envelope.event.type === 'interaction')!.envelope.event
    if (interaction.type !== 'interaction') throw new Error('test interaction missing')
    const queued = Promise.resolve(fixture.app.request('/v1/sessions/queued/input', { method: 'POST', body: turnBody('queued-second', { message: 'second' }) }))
    let admitted = false
    void queued.then(() => { admitted = true })
    await Promise.resolve()
    expect(admitted).toBe(false)
    const response = await fixture.app.request(`/v1/runs/${firstRunId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(interactionCommand('queued-answer', interaction.request, {
        id: interaction.request.id,
        outcome: 'accepted',
        data: { grant: ['allow_once'] },
      })),
    })
    expect(response.status).toBe(200)
    const second = await queued
    expect(second.status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('queued')?.turns === 2)
    expect(backend.natives).toHaveLength(1)
    expect(backend.natives[0]!.prompts).toEqual(['ask', 'second'])
  })

  it('rejects input overflow before creating a durable run admission', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend, undefined, { inputQueueMaxDepth: 1, inputQueueTimeoutMs: 1_000 })
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'queue-overflow', model: 'pi/test' }) })
    const first = await fixture.app.request('/v1/sessions/queue-overflow/turns', { method: 'POST', body: turnBody('queue-overflow-first', { message: 'ask' }) })
    const firstRunId = (await json(first)).run.id as string
    await waitFor(() => fixture!.store.retainedEventsAfter('queue-overflow').some(item => item.envelope.event.type === 'interaction'))
    const interaction = fixture.store.retainedEventsAfter('queue-overflow').find(item => item.envelope.event.type === 'interaction')!.envelope.event
    if (interaction.type !== 'interaction') throw new Error('queue overflow interaction missing')
    const queued = fixture.app.request('/v1/sessions/queue-overflow/input', { method: 'POST', body: turnBody('queue-overflow-second', { message: 'second' }) })
    await Promise.resolve()
    const overflow = await fixture.app.request('/v1/sessions/queue-overflow/input', { method: 'POST', body: turnBody('queue-overflow-third', { message: 'third' }) })
    expect(overflow.status).toBe(429)
    expect(await json(overflow)).toMatchObject({ error: { type: 'input_queue_full' } })
    expect(fixture.store.getRetainedRun('run-queue-overflow-third')).toBeNull()

    const firstResponse = await fixture.app.request(`/v1/runs/${firstRunId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(interactionCommand('queue-overflow-answer', interaction.request, {
        id: interaction.request.id,
        outcome: 'accepted',
        data: { grant: ['allow_once'] },
      })),
    })
    expect(firstResponse.status).toBe(200)
    expect((await queued).status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('queue-overflow')?.turns === 2)
  })

  it('times out queued input before turn admission and does not dispatch it', async () => {
    const backend = new FakeNativeBackend(() => new HangingNative())
    fixture = setup(backend, undefined, { inputQueueMaxDepth: 2, inputQueueTimeoutMs: 25 })
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'queue-timeout', model: 'pi/test' }) })
    await fixture.app.request('/v1/sessions/queue-timeout/turns', { method: 'POST', body: turnBody('queue-timeout-first', { message: 'hang' }) })
    await waitFor(() => fixture!.store.getRetained('queue-timeout')?.status === 'running')
    const queued = await fixture.app.request('/v1/sessions/queue-timeout/input', { method: 'POST', body: turnBody('queue-timeout-second', { message: 'second' }) })
    expect(queued.status).toBe(408)
    expect(await json(queued)).toMatchObject({ error: { type: 'input_queue_timeout' } })
    expect(fixture.store.getRetainedRun('run-queue-timeout-second')).toBeNull()
    const cancelled = await fixture.app.request('/v1/sessions/queue-timeout/cancel?wait_ms=1000', {
      method: 'POST',
      body: cancellationBody(fixture, 'queue-timeout', 'queue-timeout-cancel'),
    })
    expect(cancelled.status).toBe(200)
  })

  it('propagates caller cancellation through queued input waiting', async () => {
    const backend = new FakeNativeBackend(() => new HangingNative())
    fixture = setup(backend, undefined, { inputQueueMaxDepth: 2, inputQueueTimeoutMs: 1_000 })
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'queue-abort', model: 'pi/test' }) })
    await fixture.app.request('/v1/sessions/queue-abort/turns', { method: 'POST', body: turnBody('queue-abort-first', { message: 'hang' }) })
    await waitFor(() => fixture!.store.getRetained('queue-abort')?.status === 'running')
    const controller = new AbortController()
    const queued = fixture.service.beginTurn(
      'queue-abort',
      fixture.service.parseTurn(JSON.parse(turnBody('queue-abort-second', { message: 'second' }))),
      { queue: true, signal: controller.signal },
    )
    await Promise.resolve()
    controller.abort()
    await expect(queued).rejects.toMatchObject({ code: 'input_queue_aborted', status: 408 })
    expect(fixture.store.getRetainedRun('run-queue-abort-second')).toBeNull()
    const cancelled = await fixture.app.request('/v1/sessions/queue-abort/cancel?wait_ms=1000', {
      method: 'POST',
      body: cancellationBody(fixture, 'queue-abort', 'queue-abort-cancel'),
    })
    expect(cancelled.status).toBe(200)
  })

  it('does not let a later queued turn bypass an aborted middle request', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend, undefined, { inputQueueMaxDepth: 3, inputQueueTimeoutMs: 1_000 })
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'queue-middle-abort', model: 'pi/test' }) })
    await fixture.app.request('/v1/sessions/queue-middle-abort/turns', {
      method: 'POST',
      body: turnBody('queue-middle-first', { message: 'ask' }),
    })
    await waitFor(() => fixture!.store.retainedEventsAfter('queue-middle-abort').some(item => item.envelope.event.type === 'interaction'))

    const controller = new AbortController()
    const middle = fixture.service.beginTurn(
      'queue-middle-abort',
      fixture.service.parseTurn(JSON.parse(turnBody('queue-middle-second', { message: 'second' }))),
      { queue: true, signal: controller.signal },
    )
    const last = fixture.service.beginTurn(
      'queue-middle-abort',
      fixture.service.parseTurn(JSON.parse(turnBody('queue-middle-third', { message: 'third' }))),
      { queue: true },
    )
    await Promise.resolve()
    controller.abort()
    await expect(middle).rejects.toMatchObject({ code: 'input_queue_aborted', status: 408 })
    const premature = await Promise.race([
      last.then(() => 'resolved', () => 'rejected'),
      Promise.resolve<'waiting'>('waiting'),
    ])
    expect(premature).toBe('waiting')
    expect(fixture.store.getRetainedRun('run-queue-middle-third')).toBeNull()

    await backend.natives[0]!.respondToNativeInteraction('ui-1', { value: 'allow_once' })
    await expect(last).resolves.toMatchObject({ run: { id: 'run-queue-middle-third' } })
    await waitFor(() => fixture!.store.getRetained('queue-middle-abort')?.turns === 2)
    expect(backend.natives[0]!.prompts).toEqual(['ask', 'third'])
  })

  it('keeps a live HTTP stream open before the first turn and rejects an ahead cursor', async () => {
    fixture = setup(new FakeNativeBackend())
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'live', model: 'pi/test' }) })
    const live = await fixture.app.request('/v1/sessions/live/events')
    expect(live.status).toBe(200)
    const reader = live.body!.getReader()
    const firstChunk = reader.read()
    await fixture.app.request('/v1/sessions/live/turns', { method: 'POST', body: turnBody('live-first', { message: 'first' }) })
    const first = await firstChunk
    expect(new TextDecoder().decode(first.value)).toContain('event: status')
    await reader.cancel()

    const ahead = await fixture.app.request('/v1/sessions/live/events', { headers: { 'Last-Event-ID': '999' } })
    expect(ahead.status).toBe(409)
    expect((await json(ahead)).error.type).toBe('invalid_replay_cursor')
  })

  it('validates interaction bindings and makes the response operation idempotent', async () => {
    fixture = setup(new FakeNativeBackend())
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 's3', model: 'pi/test' }) })
    const turn = await fixture.app.request('/v1/sessions/s3/turns', {
      method: 'POST',
      body: turnBody('s3-ask', {
        message: 'ask',
        provider: 'agent-provider-cli-bridge',
        environment_id: 'sandbox-environment',
      }),
    })
    const runId = (await json(turn)).run.id as string
    await waitFor(() => fixture!.store.retainedEventsAfter('s3').some(item => item.envelope.event.type === 'interaction'))
    const interaction = fixture.store.retainedEventsAfter('s3').find(item => item.envelope.event.type === 'interaction')!.envelope.event
    if (interaction.type !== 'interaction') throw new Error('test interaction missing')
    expect(interaction.request.binding).toEqual({
      runId,
      provider: 'agent-provider-cli-bridge',
      environmentId: 'sandbox-environment',
      sessionId: 's3',
      executionId: 'execution-s3-ask',
      interactionId: interaction.request.id,
    })
    expect(interaction.request.answerSpec.fields).toEqual([
      expect.objectContaining({ type: 'select', name: 'grant' }),
    ])
    const acceptedResponse = {
      id: interaction.request.id,
      outcome: 'accepted' as const,
      data: { grant: ['allow_once'] },
    }
    const command = interactionCommand('op-1', interaction.request, acceptedResponse)
    const accepted = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, { method: 'POST', body: JSON.stringify(command) })
    expect(accepted.status).toBe(200)
    const acceptedBody = await json(accepted)
    expect(acceptedBody).toMatchObject({
      status: 'accepted',
      binding: {
        provider: 'agent-provider-cli-bridge',
        environmentId: 'sandbox-environment',
        runId,
        interactionId: interaction.request.id,
      },
    })
    expect(fixture.store.getInteractionOperation(command.operationId)?.acknowledgement?.binding).toEqual(command.binding)
    const retry = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, { method: 'POST', body: JSON.stringify(command) })
    expect(retry.status).toBe(200)
    expect(await json(retry)).toEqual(acceptedBody)
    const sameResponse = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(interactionCommand('op-same-response', interaction.request, acceptedResponse)),
    })
    expect(sameResponse.status).toBe(200)
    expect((await json(sameResponse)).status).toBe('already_resolved_same')
    const { sessionId: _sessionId, ...bindingWithoutSession } = command.binding
    const optionalSession = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify({ ...command, operationId: 'op-optional-session', binding: bindingWithoutSession }),
    })
    expect(optionalSession.status).toBe(400)
    const conflict = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(interactionCommand('op-1', interaction.request, {
        id: interaction.request.id,
        outcome: 'declined',
      })),
    })
    expect(conflict.status).toBe(409)
    const wrong = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(interactionCommand('op-wrong', interaction.request, acceptedResponse, { runId: 'wrong-run' })),
    })
    expect(wrong.status).toBe(409)
    expect((await json(wrong)).status).toBe('binding_mismatch')
    const wrongProvider = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(interactionCommand('op-wrong-provider', interaction.request, acceptedResponse, {
        provider: 'another-provider',
      })),
    })
    expect(wrongProvider.status).toBe(409)
    expect((await json(wrongProvider)).status).toBe('binding_mismatch')
    const wrongEnvironment = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(interactionCommand('op-wrong-environment', interaction.request, acceptedResponse, {
        environmentId: 'another-environment',
      })),
    })
    expect(wrongEnvironment.status).toBe(409)
    expect((await json(wrongEnvironment)).status).toBe('binding_mismatch')
  })

  it('records an unknown effect when native delivery fails before the effect', async () => {
    const native = new BeforeNativeResponseFailure()
    const backend = new FakeNativeBackend(() => native)
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'crash-before-native', model: 'pi/test' }) })
    const turn = await fixture.app.request('/v1/sessions/crash-before-native/turns', {
      method: 'POST',
      body: turnBody('crash-before-native-ask', { message: 'ask' }),
    })
    const runId = (await json(turn)).run.id as string
    await waitFor(() => fixture!.store.retainedEventsAfter('crash-before-native').some(item => item.envelope.event.type === 'interaction'))
    const interaction = fixture.store.retainedEventsAfter('crash-before-native').find(item => item.envelope.event.type === 'interaction')!.envelope.event
    if (interaction.type !== 'interaction') throw new Error('interaction missing')
    const command = interactionCommand('crash-before-native-operation', interaction.request, {
      id: interaction.request.id,
      outcome: 'accepted',
      data: { grant: ['allow_once'] },
    })

    const first = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(command),
    })
    expect(first.status).toBe(502)
    expect(await json(first)).toMatchObject({ status: 'transport_failure', retryable: false })
    expect(fixture.store.getInteractionOperation(command.operationId)).toMatchObject({
      phase: 'effect_unknown',
      acknowledgement: { status: 'transport_failure', retryable: false },
    })

    const retry = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(command),
    })
    expect(retry.status).toBe(502)
    expect(await json(retry)).toMatchObject({ status: 'transport_failure', retryable: false })
    expect(native.responseCalls).toBe(1)
  })

  it('closes an interaction after delivery throws and never repeats it for another operation', async () => {
    const native = new AfterNativeResponseFailure()
    fixture = setup(new FakeNativeBackend(() => native))
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'unknown-interaction', model: 'pi/test' }) })
    const turn = await fixture.app.request('/v1/sessions/unknown-interaction/turns', {
      method: 'POST',
      body: turnBody('unknown-interaction-ask', { message: 'ask' }),
    })
    const runId = (await json(turn)).run.id as string
    await waitFor(() => fixture!.store.retainedEventsAfter('unknown-interaction').some(item => item.envelope.event.type === 'interaction'))
    const interaction = fixture.store.retainedEventsAfter('unknown-interaction').find(item => item.envelope.event.type === 'interaction')!.envelope.event
    if (interaction.type !== 'interaction') throw new Error('interaction missing')
    const response = {
      id: interaction.request.id,
      outcome: 'accepted' as const,
      data: { grant: ['allow_once'] },
    }
    const firstCommand = interactionCommand('unknown-interaction-operation-a', interaction.request, response)
    const first = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(firstCommand),
    })
    expect(first.status).toBe(502)
    expect(await json(first)).toMatchObject({ status: 'transport_failure', retryable: false })
    expect(fixture.store.findEffectUnknownInteraction(runId, 'unknown-interaction', interaction.request.id)).toMatchObject({
      phase: 'effect_unknown',
      operationId: firstCommand.operationId,
    })

    const secondCommand = interactionCommand('unknown-interaction-operation-b', interaction.request, response)
    const second = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(secondCommand),
    })
    expect(second.status).toBe(502)
    expect(await json(second)).toMatchObject({
      status: 'transport_failure',
      retryable: false,
      message: 'response effect is unknown; this interaction is permanently closed and will not be repeated',
    })
    expect(native.effectCount).toBe(1)
    expect(native.responseCalls).toBe(1)
  })

  it('reconciles an intent after a crash following native delivery without rerunning it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-retained-crash-after-native-'))
    const native = new FakeNative()
    const backend = new FakeNativeBackend(() => native)
    const original = setup(backend, dir, {}, new CrashAfterNativeStore(dir))
    fixture = original
    await original.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'crash-after-native', model: 'pi/test' }) })
    const turn = await original.app.request('/v1/sessions/crash-after-native/turns', {
      method: 'POST',
      body: turnBody('crash-after-native-ask', { message: 'ask' }),
    })
    const runId = (await json(turn)).run.id as string
    await waitFor(() => original.store.retainedEventsAfter('crash-after-native').some(item => item.envelope.event.type === 'interaction'))
    const interaction = original.store.retainedEventsAfter('crash-after-native').find(item => item.envelope.event.type === 'interaction')!.envelope.event
    if (interaction.type !== 'interaction') throw new Error('interaction missing')
    const command = interactionCommand('crash-after-native-operation', interaction.request, {
      id: interaction.request.id,
      outcome: 'accepted',
      data: { grant: ['allow_once'] },
    })

    const first = await original.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(command),
    })
    expect(first.status).toBe(502)
    expect(await json(first)).toMatchObject({ status: 'transport_failure', retryable: false })
    expect(original.store.getInteractionOperation(command.operationId)).toMatchObject({ phase: 'intent', acknowledgement: null })

    await original.runs.shutdown(1_000)
    original.store.close()
    const restarted = setup(backend, dir)
    fixture = restarted
    const replay = await restarted.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(command),
    })
    expect(replay.status).toBe(502)
    expect(await json(replay)).toMatchObject({
      status: 'transport_failure',
      retryable: false,
      message: 'response delivery was interrupted before its native effect was proven; it will not be repeated',
    })
    expect(restarted.store.getInteractionOperation(command.operationId)).toMatchObject({ phase: 'effect_unknown' })
    expect(native.responseCalls).toBe(1)
  })

  it('survives a real SIGKILL after native effect start without repeating the effect', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-retained-sigkill-'))
    const effectPath = join(dir, 'native-effects.log')
    const operation = {
      operationId: 'sigkill-interaction-operation',
      callerId: 'sigkill-caller',
      runId: 'sigkill-run',
      sessionId: 'sigkill-session',
      interactionId: 'sigkill-interaction',
      requestDigest: 'sha256:' + 'a'.repeat(64),
      responseDigest: 'sha256:' + 'b'.repeat(64),
    }
    const childScript = `
      import { appendFileSync } from 'node:fs'
      import { SessionStore as SqliteSessionStore } from './src/sessions/store.ts'
      const [dir, effectPath] = process.argv.slice(1)
      const store = new SqliteSessionStore(dir)
      const operation = ${JSON.stringify(operation)}
      store.beginInteractionOperation(operation)
      process.stdout.write('intent\\n')
      appendFileSync(effectPath, 'native-effect\\n', { encoding: 'utf8', mode: 0o600 })
      process.stdout.write('effect\\n')
      process.stdin.resume()
    `
    let child: ChildProcessWithoutNullStreams | null = null
    try {
      child = spawn(
        process.execPath,
        ['--import', 'tsx/esm', '--input-type=module', '-e', childScript, dir, effectPath],
        { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
      )
      await waitForChildOutput(child, 'effect\n')
      const exited = waitForChildExit(child)
      child.kill('SIGKILL')
      const [code, signal] = await exited
      child = null
      expect(code).toBeNull()
      expect(signal).toBe('SIGKILL')
      expect(readFileSync(effectPath, 'utf8').trim().split('\n')).toEqual(['native-effect'])

      fixture = setup(new FakeNativeBackend(), dir)
      expect(fixture.store.getInteractionOperation(operation.operationId)).toMatchObject({
        phase: 'intent',
        effectProof: null,
        acknowledgement: null,
      })
      const requestDigest = operation.requestDigest as `sha256:${string}`
      const acknowledgement: InteractionAcknowledgement = {
        operationId: operation.operationId,
        binding: {
          runId: operation.runId,
          provider: 'agent-provider-cli-bridge',
          environmentId: 'environment-sigkill',
          sessionId: operation.sessionId,
          executionId: 'execution-sigkill',
          interactionId: operation.interactionId,
          requestDigest,
        },
        commandDigest: ('sha256:' + 'c'.repeat(64)) as `sha256:${string}`,
        status: 'transport_failure',
        message: 'the native effect became unknowable after process loss',
        retryable: false,
      }
      const unknown = fixture.store.markInteractionEffectUnknown(
        operation.operationId,
        operation.requestDigest,
        operation.responseDigest,
        acknowledgement,
      )
      expect(unknown).toMatchObject({
        phase: 'effect_unknown',
        acknowledgement: { status: 'transport_failure', retryable: false },
      })
      const replay = fixture.store.beginInteractionOperation(operation)
      expect(replay.kind).toBe('replayed')
      expect(replay.operation.phase).toBe('effect_unknown')
      expect(readFileSync(effectPath, 'utf8').trim().split('\n')).toEqual(['native-effect'])
    } finally {
      if (child) await stopChild(child, 'SIGKILL')
      if (!fixture) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replays a proven effect when acknowledgement persistence fails after resolve', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-retained-crash-after-resolve-'))
    const native = new FakeNative()
    const backend = new FakeNativeBackend(() => native)
    const original = setup(backend, dir, {}, new CrashAfterResolveStore(dir))
    fixture = original
    await original.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'crash-after-resolve', model: 'pi/test' }) })
    const turn = await original.app.request('/v1/sessions/crash-after-resolve/turns', {
      method: 'POST',
      body: turnBody('crash-after-resolve-ask', { message: 'ask' }),
    })
    const runId = (await json(turn)).run.id as string
    await waitFor(() => original.store.retainedEventsAfter('crash-after-resolve').some(item => item.envelope.event.type === 'interaction'))
    const interaction = original.store.retainedEventsAfter('crash-after-resolve').find(item => item.envelope.event.type === 'interaction')!.envelope.event
    if (interaction.type !== 'interaction') throw new Error('interaction missing')
    const command = interactionCommand('crash-after-resolve-operation', interaction.request, {
      id: interaction.request.id,
      outcome: 'accepted',
      data: { grant: ['allow_once'] },
    })

    const first = await original.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(command),
    })
    expect(first.status).toBe(502)
    expect(await json(first)).toMatchObject({ status: 'transport_failure', retryable: true })
    expect(original.store.getInteractionOperation(command.operationId)).toMatchObject({ phase: 'effect_proven', acknowledgement: null })
    expect(native.responseCalls).toBe(1)

    await original.runs.shutdown(1_000)
    original.store.close()
    const restarted = setup(backend, dir)
    fixture = restarted
    const replay = await restarted.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(command),
    })
    expect(replay.status).toBe(200)
    expect(await json(replay)).toMatchObject({ status: 'accepted', binding: { provider: 'cli-bridge' } })
    expect(restarted.store.getInteractionOperation(command.operationId)).toMatchObject({
      phase: 'acknowledged',
      acknowledgement: { status: 'accepted' },
    })
    expect(native.responseCalls).toBe(1)
  })

  it('replays the durable acknowledgement when the process dies after acknowledgement persistence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-retained-crash-after-ack-'))
    const native = new FakeNative()
    const backend = new FakeNativeBackend(() => native)
    const original = setup(backend, dir, {}, new CrashAfterAcknowledgementStore(dir))
    fixture = original
    await original.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'crash-after-ack', model: 'pi/test' }) })
    const turn = await original.app.request('/v1/sessions/crash-after-ack/turns', {
      method: 'POST',
      body: turnBody('crash-after-ack-ask', { message: 'ask' }),
    })
    const runId = (await json(turn)).run.id as string
    await waitFor(() => original.store.retainedEventsAfter('crash-after-ack').some(item => item.envelope.event.type === 'interaction'))
    const interaction = original.store.retainedEventsAfter('crash-after-ack').find(item => item.envelope.event.type === 'interaction')!.envelope.event
    if (interaction.type !== 'interaction') throw new Error('interaction missing')
    const command = interactionCommand('crash-after-ack-operation', interaction.request, {
      id: interaction.request.id,
      outcome: 'accepted',
      data: { grant: ['allow_once'] },
    })

    const first = await original.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(command),
    })
    expect(first.status).toBe(200)
    expect(await json(first)).toMatchObject({ status: 'accepted', binding: { provider: 'cli-bridge' } })
    expect(original.store.getInteractionOperation(command.operationId)).toMatchObject({ phase: 'acknowledged' })
    expect(native.responseCalls).toBe(1)

    await original.runs.shutdown(1_000)
    original.store.close()
    const restarted = setup(backend, dir)
    fixture = restarted
    const replay = await restarted.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(command),
    })
    expect(replay.status).toBe(200)
    expect(await json(replay)).toMatchObject({ status: 'accepted', binding: { provider: 'cli-bridge' } })
    expect(native.responseCalls).toBe(1)
  })

  it('allows only one distinct response operation to reach a pending interaction', async () => {
    const native = new DeferredResponseNative()
    const backend = new FakeNativeBackend(() => native)
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'concurrent', model: 'pi/test' }) })
    const turn = await fixture.app.request('/v1/sessions/concurrent/turns', { method: 'POST', body: turnBody('concurrent-ask', { message: 'ask' }) })
    const runId = (await json(turn)).run.id as string
    await waitFor(() => fixture!.store.retainedEventsAfter('concurrent').some(item => item.envelope.event.type === 'interaction'))
    const interaction = fixture.store.retainedEventsAfter('concurrent').find(item => item.envelope.event.type === 'interaction')!.envelope.event
    if (interaction.type !== 'interaction') throw new Error('test interaction missing')
    const responseBody = {
      id: interaction.request.id,
      outcome: 'accepted' as const,
      data: { grant: ['allow_once'] },
    }
    const first = fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(interactionCommand('concurrent-first', interaction.request, responseBody)),
    })
    await waitFor(() => native.responseCalls === 1)
    const contenders = await Promise.all(Array.from({ length: 19 }, (_, index) => fixture!.app.request(
      `/v1/runs/${runId}/interactions/${interaction.request.id}/respond`,
      {
        method: 'POST',
        body: JSON.stringify(interactionCommand(`concurrent-${index + 2}`, interaction.request, responseBody)),
      },
    )))
    expect(contenders.every(response => response.status === 409)).toBe(true)
    expect((await Promise.all(contenders.map(response => json(response)))).every(body => body.status === 'already_resolved_different')).toBe(true)
    native.allowResponse()
    expect((await first).status).toBe(200)
    expect(native.responseCalls).toBe(1)
  })

  it('cancels an outstanding interaction and makes a later response stale', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 's-cancel', model: 'pi/test' }) })
    const turn = await fixture.app.request('/v1/sessions/s-cancel/turns', { method: 'POST', body: turnBody('s-cancel-ask', { message: 'ask' }) })
    const runId = (await json(turn)).run.id as string
    await waitFor(() => fixture!.store.retainedEventsAfter('s-cancel').some(item => item.envelope.event.type === 'interaction'))
    const interaction = fixture.store.retainedEventsAfter('s-cancel').find(item => item.envelope.event.type === 'interaction')!.envelope.event
    if (interaction.type !== 'interaction') throw new Error('test interaction missing')
    const cancelled = await fixture.app.request('/v1/sessions/s-cancel/cancel?wait_ms=1000', { method: 'POST', body: cancellationBody(fixture, 's-cancel', 'cancel-s-cancel') })
    expect(cancelled.status).toBe(200)
    expect(await json(cancelled)).toMatchObject({ status: 'accepted', effect: 'cancelled' })
    expect(backend.natives[0]!.closeCalls).toBe(1)
    expect(fixture.store.retainedEventsAfter('s-cancel').some(item => item.envelope.event.type === 'interaction.cancel')).toBe(true)
    const response = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(interactionCommand('stale-response', interaction.request, {
        id: interaction.request.id,
        outcome: 'accepted',
        data: { grant: ['allow_once'] },
      })),
    })
    expect(response.status).toBe(409)
    expect((await json(response)).status).toBe('cancelled')
    expect(backend.natives[0]!.responseCalls).toBe(0)
  })

  it('serializes response versus cancellation and never records a retryable transport failure', async () => {
    const native = new DeferredResponseNative()
    const backend = new FakeNativeBackend(() => native)
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'race', model: 'pi/test' }) })
    const turn = await fixture.app.request('/v1/sessions/race/turns', { method: 'POST', body: turnBody('race-ask', { message: 'ask' }) })
    const runId = (await json(turn)).run.id as string
    await waitFor(() => fixture!.store.retainedEventsAfter('race').some(item => item.envelope.event.type === 'interaction'))
    const interaction = fixture.store.retainedEventsAfter('race').find(item => item.envelope.event.type === 'interaction')!.envelope.event
    if (interaction.type !== 'interaction') throw new Error('test interaction missing')
    const response = fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(interactionCommand('race-response', interaction.request, {
        id: interaction.request.id,
        outcome: 'accepted',
        data: { grant: ['allow_once'] },
      })),
    })
    await waitFor(() => native.responseCalls === 1)
    const cancelBody = cancellationBody(fixture, 'race', 'race-cancel')
    const cancel = await fixture.app.request('/v1/sessions/race/cancel?wait_ms=0', {
      method: 'POST',
      body: cancelBody,
    })
    expect(cancel.status).toBe(202)
    native.allowResponse()
    const responseResult = await response
    expect(responseResult.status).toBe(200)
    expect((await json(responseResult)).status).toBe('accepted')
    expect(native.responseCompleted).toBe(true)
    await waitFor(() => fixture!.store.getRetainedControlOperation('race-cancel')?.acknowledgement.status === 'cancelled')
    const retry = await fixture.app.request('/v1/sessions/race/cancel?wait_ms=1000', {
      method: 'POST',
      body: cancelBody,
    })
    expect(retry.status).toBe(200)
    expect(await json(retry)).toMatchObject({ status: 'accepted', effect: 'cancelled' })
    expect(fixture.store.getInteractionOperation('race-response')?.acknowledgement?.status).toBe('accepted')
    expect(fixture.store.getInteractionOperation('race-response')?.acknowledgement?.retryable).toBeUndefined()
  })

  it('cancels an interaction when the native run ends without an answer', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'terminal-ask', model: 'pi/test' }) })
    const turn = await fixture.app.request('/v1/sessions/terminal-ask/turns', { method: 'POST', body: turnBody('terminal-ask', { message: 'end-with-ask' }) })
    const runId = (await json(turn)).run.id as string
    await waitFor(() => fixture!.store.getRetained('terminal-ask')?.turns === 1)
    const interaction = fixture.store.retainedEventsAfter('terminal-ask').find(item => item.envelope.event.type === 'interaction')!.envelope.event
    if (interaction.type !== 'interaction') throw new Error('test interaction missing')
    const terminalEvents = fixture.store.retainedEventsAfter('terminal-ask')
    const cancelIndex = terminalEvents.findIndex(item => item.envelope.event.type === 'interaction.cancel')
    const terminalIndex = terminalEvents.findIndex(item => item.envelope.event.type === 'status' && item.envelope.event.status === 'completed')
    expect(cancelIndex).toBeGreaterThanOrEqual(0)
    expect(terminalIndex).toBeGreaterThan(cancelIndex)
    expect(terminalEvents.at(-1)?.envelope.event).toMatchObject({ type: 'status', status: 'completed' })
    const response = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify(interactionCommand('terminal-stale', interaction.request, {
        id: interaction.request.id,
        outcome: 'accepted',
        data: { grant: ['allow_once'] },
      })),
    })
    expect(response.status).toBe(409)
    expect((await json(response)).status).toBe('cancelled')
    expect(backend.natives[0]!.responseCalls).toBe(0)
  })

  it('preserves typed profile secret references across restart without storing credential material', async () => {
    const original = setup(new FakeNativeBackend())
    fixture = original
    const secretRef = defineAgentProfileSecretRef('provider-credential', 'bearer')
    const profile = {
      harness: 'pi',
      prompt: { instructions: ['The harmless API_KEY=abc example is documentation, not credential material.'] },
      mcp: {
        local: {
          command: 'echo',
          env: { FOO_TOKEN: secretRef },
        },
        remote: {
          transport: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: secretRef },
        },
      },
    }
    const created = await original.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'secret-ref-profile', model: 'pi/test', agent_profile: profile }),
    })
    expect(created.status).toBe(201)
    const stored = original.store.getRetained('secret-ref-profile')?.metadata.agent_profile
    expect(stored).toEqual(profile)
    expect(JSON.stringify(stored)).toContain('"kind":"secret-ref"')
    expect(JSON.stringify(stored)).not.toContain('super-secret')

    const dir = original.dir
    await original.runs.shutdown(1_000)
    await original.service.shutdown(1_000)
    original.unwatch()
    original.store.close()
    fixture = setup(new FakeNativeBackend(), dir)

    const restored = fixture.store.getRetained('secret-ref-profile')?.metadata.agent_profile
    expect(restored).toEqual(profile)
    expect(JSON.stringify(restored)).toContain('"kind":"secret-ref"')
    expect(JSON.stringify(restored)).not.toContain('super-secret')
  })

  it('preserves typed retained MCP secret references through restart without generic key rejection', async () => {
    const original = setup(new FakeNativeBackend())
    fixture = original
    const secretRef = defineAgentProfileSecretRef('mcp-runtime-credential', 'bearer')
    const mcp = {
      mcpServers: {
        remote: {
          type: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: secretRef },
        },
      },
    }
    const created = await original.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'secret-ref-mcp', model: 'pi/test', mcp }),
    })
    expect(created.status).toBe(201)

    const dir = original.dir
    await original.runs.shutdown(1_000)
    await original.service.shutdown(1_000)
    original.unwatch()
    original.store.close()
    const restartedBackend = new FakeNativeBackend()
    fixture = setup(restartedBackend, dir)

    const turn = await fixture.app.request('/v1/sessions/secret-ref-mcp/turns', {
      method: 'POST',
      body: turnBody('secret-ref-mcp-turn', { message: 'use the retained MCP config' }),
    })
    expect(turn.status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('secret-ref-mcp')?.turns === 1)
    expect(restartedBackend.requests[0]?.mcp).toEqual(mcp)
    expect(JSON.stringify(restartedBackend.requests[0]?.mcp)).toContain('mcp-runtime-credential')
    expect(JSON.stringify(restartedBackend.requests[0]?.mcp)).not.toContain('super-secret')
  })

  it('rejects raw credential keys in open Agent Profile surfaces', async () => {
    fixture = setup(new FakeNativeBackend())
    const unsafeProfiles: unknown[] = [
      { metadata: { apiKey: 'abc' } },
      { model: { metadata: { apiKey: 'abc' } } },
      { subagents: { helper: { metadata: { apiKey: 'abc' } } } },
      { modes: { review: { metadata: { apiKey: 'abc' } } } },
      {
        mcp: {
          remote: {
            transport: 'http',
            url: 'https://example.test/mcp',
            metadata: { Authorization: 'abc' },
          },
        },
      },
      {
        mcp: {
          local: {
            command: 'echo',
            env: { API_KEY: { kind: 'public', value: 'abc' } },
          },
        },
      },
      {
        mcp: {
          local: {
            command: 'echo',
            env: { FOO_TOKEN: 'abc' },
          },
        },
      },
      {
        mcp: {
          remote: {
            transport: 'http',
            url: 'https://example.test/mcp',
            headers: { Authorization: { kind: 'public', value: 'Bearer abc' } },
          },
        },
      },
      {
        mcp: {
          remote: {
            transport: 'http',
            url: 'https://example.test/mcp',
            headers: { Authorization: 'Bearer abc' },
          },
        },
      },
      { metadata: { note: 'Bearer abc' } },
      { extensions: { provider: { note: 'token=abc' } } },
      { extensions: { provider: { apiKey: 'abc' } } },
    ]

    for (const [index, agentProfile] of unsafeProfiles.entries()) {
      const id = `unsafe-profile-open-${index}`
      const response = await fixture.app.request('/v1/sessions', {
        method: 'POST',
        body: JSON.stringify({ id, model: 'pi/test', agent_profile: agentProfile }),
      })
      expect(response.status).toBe(400)
      expect(fixture.store.getRetained(id)).toBeNull()
    }
  })

  it('reports restart loss as unknown and denies non-native one-shot backends', async () => {
    const backend = new FakeNativeBackend(() => new HangingNative())
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 's4', model: 'pi/test' }) })
    await fixture.app.request('/v1/sessions/s4/turns', { method: 'POST', body: turnBody('s4-in-flight', { message: 'in-flight' }) })
    await waitFor(() => fixture!.store.getRetained('s4')?.status === 'running')
    const restarted = new RetainedSessionService({ store: fixture.store, registry: (fixture as any).registry ?? ({ resolve: () => null, byName: () => null } as never), runs: new RunRegistry() })
    expect(restarted.get('s4').status).toBe('unknown')
    const next = await restarted.beginTurn('s4', {
      message: 'must not create fresh context',
      run_id: 's4-after-restart',
      execution_id: 's4-after-restart-execution',
    }).catch(error => error)
    expect(next.code).toBe('unknown_session')

    const denied = setup(new OneShotBackend())
    expect((await denied.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'one-shot-denied', model: 'one-shot' }) })).status).toBe(501)
    await cleanup(denied)
  })

  it('rejects unsafe retained metadata before it reaches SQLite', async () => {
    fixture = setup(new FakeNativeBackend())
    const safe = await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: 'safe-metadata',
        model: 'pi/test',
        metadata: { label: 'review', description: 'bounded', tags: ['one', 'two'], client: 'test-suite' },
      }),
    })
    expect(safe.status).toBe(201)
    expect(fixture.store.getRetained('safe-metadata')?.metadata).toEqual({
      label: 'review',
      description: 'bounded',
      tags: ['one', 'two'],
      client: 'test-suite',
      mode: 'byob',
    })

    const unsafe = [
      { agent_profile: { prompt: { systemPrompt: 'raw' } } },
      { mcp: { mcpServers: { secret: { command: 'cat' } } } },
      { credentials: { token: 'raw' } },
      { api_key: 'raw' },
      { apiKey: 'abc' },
      { nested: { apiKey: 'abc' } },
      { nested: { Authorization: 'abc' } },
      { context: { apiKey: 'abc' } },
      { provider_options: { token: 'abc' } },
      { mcp: { mcpServers: { server: { headers: { Authorization: 'abc' } } } } },
      { label: 'Bearer should-not-persist' },
      { label: 'token=raw-secret' },
    ]
    for (const [index, metadata] of unsafe.entries()) {
      const response = await fixture.app.request('/v1/sessions', {
        method: 'POST',
        body: JSON.stringify({ id: `unsafe-${index}`, model: 'pi/test', metadata }),
      })
      expect(response.status).toBe(400)
      expect(fixture.store.getRetained(`unsafe-${index}`)).toBeNull()
    }
    for (const [label, value] of [
      ['context', { trace: { apiKey: 'abc' } }],
      ['provider_options', { nested: { token: 'abc' } }],
      ['mcp', { mcpServers: { server: { headers: { Authorization: 'abc' } } } }],
    ] as const) {
      expect(() => parseSafePublicRecord(value, `retained ${label}`)).toThrow()
    }
    const unsafeDurableFields = [
      ['context', { trace: { apiKey: 'abc' } }],
      ['provider_options', { nested: { token: 'abc' } }],
      ['mcp', { mcpServers: { server: { headers: { Authorization: 'abc' } } } }],
    ] as const
    for (const [index, [field, value]] of unsafeDurableFields.entries()) {
      const response = await fixture.app.request('/v1/sessions', {
        method: 'POST',
        body: JSON.stringify({ id: `unsafe-durable-${index}`, model: 'pi/test', [field]: value }),
      })
      expect(response.status).toBe(400)
      expect(fixture.store.getRetained(`unsafe-durable-${index}`)).toBeNull()
    }
    const legacy = fixture.store.remember({
      externalId: 'legacy-unsafe-env',
      backend: 'pi',
      model: 'pi/test',
      metadata: { env: { API_KEY: 'abc', PATH: '/tmp/attacker' } },
    })
    expect(legacy.metadata.env).toBeUndefined()
  })

  it('labels retained synthetic events with the actual backend identity', async () => {
    fixture = setup(new FakeNativeBackend(() => new FakeNative('synthetic'), 'synthetic'))
    const created = await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'synthetic-session', model: 'synthetic/test' }),
    })
    expect(created.status).toBe(201)
    const turn = await fixture.app.request('/v1/sessions/synthetic-session/turns', {
      method: 'POST',
      body: turnBody('synthetic-identity', { message: 'identity' }),
    })
    expect(turn.status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('synthetic-session')?.turns === 1)
    const raw = fixture.store.retainedEventsAfter('synthetic-session').find(item =>
      item.envelope.event.type === 'raw' && recordEventType(item.envelope.event.event) === 'synthetic_observation')
    expect(raw?.envelope.event).toMatchObject({ type: 'raw', backend: 'synthetic' })
  })

  it('persists an unverified continuation boundary and refuses a later native turn', async () => {
    fixture = setup(new FakeNativeBackend(() => new UnverifiedNative()))
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'unverified', model: 'pi/test' }) })
    const first = await fixture.app.request('/v1/sessions/unverified/turns', { method: 'POST', body: turnBody('unverified-first', { message: 'first' }) })
    expect(first.status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('unverified')?.turns === 1)
    expect(fixture.store.getRetained('unverified')?.contextBoundary).toEqual({ status: 'unverified', reason: 'pi native state did not expose a verifiable revision' })
    const second = await fixture.app.request('/v1/sessions/unverified/turns', { method: 'POST', body: turnBody('unverified-second', { message: 'second' }) })
    expect(second.status).toBe(501)
    expect((await json(second)).error.type).toBe('capability_denied')
  })

  it('accepts native continuation with the exact boundary and supports sequential native continuation turns', async () => {
    const backend = new FakeNativeBackend(() => new FreshBoundaryNative())
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'native-accepted', model: 'pi/test' }) })
    await fixture.app.request('/v1/sessions/native-accepted/turns', {
      method: 'POST',
      body: turnBody('native-accepted-first', { message: 'first' }),
    })
    await waitFor(() => fixture!.store.getRetained('native-accepted')?.turns === 1)
    const expectedBoundary = fixture.store.getRetained('native-accepted')?.contextBoundary as NativeContextBoundaryProof
    const input = nativeContinuationRequest(
      fixture,
      'native-accepted',
      'o'.repeat(512),
      'second',
      expectedBoundary,
    )
    const response = await fixture.app.request('/v1/sessions/native-accepted/continue', {
      method: 'POST',
      body: nativeContinuationBody(input),
    })
    expect(response.status).toBe(200)
    const outcome = successfulNativeOutcome(AgentNativeContextContinuationResultSchema.parse(await json(response)))
    const actualBoundary = outcome.acknowledgement.actualBoundary
    if (!actualBoundary) throw new Error('accepted continuation did not report its observed source boundary')
    expect(outcome.acknowledgement).toMatchObject({
      operationId: input.request.operationId,
      requestDigest: input.request.requestDigest,
      status: 'accepted',
      historyMessagesSent: 0,
    })
    expect(actualBoundary).toMatchObject({
      ...input.request.run,
      boundary: expectedBoundary.boundary,
    })
    expect(Date.parse(actualBoundary.observedAt)).toBeGreaterThan(Date.parse(expectedBoundary.observedAt))
    expect(outcome.result).toMatchObject({ text: 'reply-2', success: true, sessionId: 'native-accepted' })
    expect(outcome.result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 })
    expect(outcome.controlRef).toMatchObject({
      runId: nativeContinuationRunId(input.request.operationId),
      provider: expectedBoundary.provider,
      environmentId: expectedBoundary.environmentId,
      sessionId: 'native-accepted',
    })
    expect(outcome.controlRef.runId.length).toBeLessThanOrEqual(512)
    expect(agentNativeContextContinuationResultMatchesRequest(input.request, outcome)).toBe(true)
    expect(fixture.store.getRetained('native-accepted')?.contextBoundary).not.toEqual(expectedBoundary)

    const nextBoundary = fixture.store.getRetained('native-accepted')?.contextBoundary as NativeContextBoundaryProof
    const secondInput = nativeContinuationRequest(
      fixture,
      'native-accepted',
      'native-accepted-second-operation',
      'third',
      nextBoundary,
      outcome.controlRef,
    )
    const secondResponse = await fixture.app.request('/v1/sessions/native-accepted/continue', {
      method: 'POST',
      body: nativeContinuationBody(secondInput),
    })
    expect(secondResponse.status).toBe(200)
    const secondOutcome = successfulNativeOutcome(
      AgentNativeContextContinuationResultSchema.parse(await json(secondResponse)),
    )
    expect(secondOutcome.acknowledgement.status).toBe('accepted')
    expect(secondOutcome.result).toMatchObject({ text: 'reply-3', success: true, sessionId: 'native-accepted' })
    expect(secondOutcome.controlRef.runId).toBe(nativeContinuationRunId(secondInput.request.operationId))
    expect(agentNativeContextContinuationResultMatchesRequest(secondInput.request, secondOutcome)).toBe(true)
    expect(backend.natives[0]!.prompts).toEqual(['first', 'second', 'third'])
  })

  it('rejects an empty native continuation before dispatch', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'native-empty', model: 'pi/test' }),
    })
    await fixture.app.request('/v1/sessions/native-empty/turns', {
      method: 'POST',
      body: turnBody('native-empty-first', { message: 'first' }),
    })
    await waitFor(() => fixture!.store.getRetained('native-empty')?.turns === 1)
    const boundary = fixture.store.getRetained('native-empty')?.contextBoundary as NativeContextBoundaryProof
    const input = nativeContinuationRequest(
      fixture,
      'native-empty',
      'native-empty-operation',
      '',
      boundary,
    )

    const response = await fixture.app.request('/v1/sessions/native-empty/continue', {
      method: 'POST',
      body: nativeContinuationBody(input),
    })

    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ error: { type: 'invalid_request_error' } })
    expect(backend.natives[0]!.prompts).toEqual(['first'])
  })

  it('replays an accepted native continuation and conflicts on changed operation bytes', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'native-replay', model: 'pi/test' }) })
    await fixture.app.request('/v1/sessions/native-replay/turns', {
      method: 'POST',
      body: turnBody('native-replay-first', { message: 'first' }),
    })
    await waitFor(() => fixture!.store.getRetained('native-replay')?.turns === 1)
    const expectedBoundary = fixture.store.getRetained('native-replay')?.contextBoundary as NativeContextBoundaryProof
    const input = nativeContinuationRequest(fixture, 'native-replay', 'native-replay-operation', 'second', expectedBoundary)
    const first = await fixture.app.request('/v1/sessions/native-replay/continue', {
      method: 'POST',
      body: nativeContinuationBody(input),
    })
    const replay = await fixture.app.request('/v1/sessions/native-replay/continue', {
      method: 'POST',
      body: nativeContinuationBody(input),
    })
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    const firstOutcome = successfulNativeOutcome(AgentNativeContextContinuationResultSchema.parse(await json(first)))
    const replayOutcome = successfulNativeOutcome(AgentNativeContextContinuationResultSchema.parse(await json(replay)))
    expect(replayOutcome.acknowledgement.status).toBe('replayed')
    expect(replayOutcome.result).toEqual(firstOutcome.result)
    expect(replayOutcome.controlRef).toEqual(firstOutcome.controlRef)

    const otherCaller = await fixture.app.request('/v1/sessions/native-replay/continue', {
      method: 'POST',
      headers: { authorization: 'other-caller' },
      body: nativeContinuationBody(input),
    })
    expect(otherCaller.status).toBe(409)
    expect(await json(otherCaller)).toMatchObject({ acknowledgement: { status: 'conflict' } })

    const changed = nativeContinuationRequest(
      fixture,
      'native-replay',
      'native-replay-operation',
      'changed',
      expectedBoundary,
      input.request.run,
    )
    const conflict = await fixture.app.request('/v1/sessions/native-replay/continue', {
      method: 'POST',
      body: nativeContinuationBody(changed),
    })
    expect(conflict.status).toBe(409)
    expect(await json(conflict)).toMatchObject({
      acknowledgement: {
        operationId: input.request.operationId,
        requestDigest: changed.request.requestDigest,
        status: 'conflict',
        existingRequestDigest: input.request.requestDigest,
      },
    })
    expect(backend.natives[0]!.prompts).toEqual(['first', 'second'])
  })

  it('rejects a stale native boundary before dispatching another native turn', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'native-stale', model: 'pi/test' }) })
    await fixture.app.request('/v1/sessions/native-stale/turns', {
      method: 'POST',
      body: turnBody('native-stale-first', { message: 'first' }),
    })
    await waitFor(() => fixture!.store.getRetained('native-stale')?.turns === 1)
    const current = fixture.store.getRetained('native-stale')?.contextBoundary as NativeContextBoundaryProof
    const stale = {
      ...current,
      boundary: { kind: 'revision' as const, revision: 'stale-boundary' },
    }
    const input = nativeContinuationRequest(fixture, 'native-stale', 'native-stale-operation', 'second', stale)
    const response = await fixture.app.request('/v1/sessions/native-stale/continue', {
      method: 'POST',
      body: nativeContinuationBody(input),
    })
    expect(response.status).toBe(409)
    expect(await json(response)).toMatchObject({
      acknowledgement: {
        status: 'boundary_mismatch',
        actualBoundary: current,
      },
    })
    expect(backend.natives[0]!.prompts).toEqual(['first'])
  })

  it('returns unverified when the retained proof cannot be verified', async () => {
    const backend = new FakeNativeBackend(() => new UnverifiedNative())
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'native-unverified', model: 'pi/test' }) })
    await fixture.app.request('/v1/sessions/native-unverified/turns', {
      method: 'POST',
      body: turnBody('native-unverified-first', { message: 'first' }),
    })
    await waitFor(() => fixture!.store.getRetained('native-unverified')?.turns === 1)
    const record = fixture.store.getRetained('native-unverified')!
    const admission = fixture.store.getRetainedRun(record.runId!)!
    const candidateProof: NativeContextBoundaryProof = {
      runId: admission.runId,
      provider: admission.provider,
      environmentId: admission.environmentId,
      sessionId: record.id,
      executionId: admission.executionId,
      requestDigest: admission.requestDigest as `sha256:${string}`,
      boundary: { kind: 'revision', revision: 'candidate' },
      observedAt: new Date().toISOString(),
    }
    const input = nativeContinuationRequest(
      fixture,
      'native-unverified',
      'native-unverified-operation',
      'second',
      candidateProof,
    )
    const response = await fixture.app.request('/v1/sessions/native-unverified/continue', {
      method: 'POST',
      body: nativeContinuationBody(input),
    })
    expect(response.status).toBe(501)
    expect(await json(response)).toMatchObject({ acknowledgement: { status: 'unverified' } })
    expect(backend.natives[0]!.prompts).toEqual(['first'])
  })

  it('rejects a native continuation whose run belongs to another session', async () => {
    const backend = new FakeNativeBackend()
    fixture = setup(backend)
    for (const id of ['native-binding-a', 'native-binding-b']) {
      await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id, model: 'pi/test' }) })
      await fixture.app.request(`/v1/sessions/${id}/turns`, {
        method: 'POST',
        body: turnBody(`${id}-first`, { message: 'first' }),
      })
      await waitFor(() => fixture!.store.getRetained(id)?.turns === 1)
    }
    const input = nativeContinuationRequest(fixture, 'native-binding-b', 'native-binding-operation', 'second')
    const response = await fixture.app.request('/v1/sessions/native-binding-a/continue', {
      method: 'POST',
      body: nativeContinuationBody(input),
    })
    expect(response.status).toBe(409)
    expect(await json(response)).toMatchObject({ acknowledgement: { status: 'conflict' } })
    expect(backend.natives.map(native => native.prompts)).toEqual([['first'], ['first']])
  })

  it('replays a completed native continuation after reopening the durable store', async () => {
    const original = setup(new FakeNativeBackend())
    fixture = original
    await original.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'native-restart', model: 'pi/test' }) })
    await original.app.request('/v1/sessions/native-restart/turns', {
      method: 'POST',
      body: turnBody('native-restart-first', { message: 'first' }),
    })
    await waitFor(() => original.store.getRetained('native-restart')?.turns === 1)
    const expectedBoundary = original.store.getRetained('native-restart')?.contextBoundary as NativeContextBoundaryProof
    const input = nativeContinuationRequest(original, 'native-restart', 'native-restart-operation', 'second', expectedBoundary)
    const accepted = await original.app.request('/v1/sessions/native-restart/continue', {
      method: 'POST',
      body: nativeContinuationBody(input),
    })
    expect(accepted.status).toBe(200)
    const acceptedOutcome = successfulNativeOutcome(AgentNativeContextContinuationResultSchema.parse(await json(accepted)))
    const dir = original.dir
    await original.runs.shutdown(1_000)
    await original.service.shutdown(1_000)
    original.unwatch()
    original.store.close()

    const restartedBackend = new FakeNativeBackend()
    fixture = setup(restartedBackend, dir)
    const replay = await fixture.app.request('/v1/sessions/native-restart/continue', {
      method: 'POST',
      body: nativeContinuationBody(input),
    })
    expect(replay.status).toBe(200)
    const replayOutcome = successfulNativeOutcome(AgentNativeContextContinuationResultSchema.parse(await json(replay)))
    expect(replayOutcome.acknowledgement.status).toBe('replayed')
    expect(replayOutcome.result).toEqual(acceptedOutcome.result)
    expect(replayOutcome.controlRef).toEqual(acceptedOutcome.controlRef)
    expect(restartedBackend.natives).toEqual([])
  })

  it('settles a pending native continuation after restart without dispatching it again', async () => {
    const original = setup(new FakeNativeBackend())
    fixture = original
    await original.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'native-pending', model: 'pi/test' }) })
    await original.app.request('/v1/sessions/native-pending/turns', {
      method: 'POST',
      body: turnBody('native-pending-first', { message: 'first' }),
    })
    await waitFor(() => original.store.getRetained('native-pending')?.turns === 1)
    const expectedBoundary = original.store.getRetained('native-pending')?.contextBoundary as NativeContextBoundaryProof
    const input = nativeContinuationRequest(original, 'native-pending', 'native-pending-operation', 'second', expectedBoundary)
    expect(original.store.recordRetainedControlOperation({
      operationId: input.request.operationId,
      callerId: canonicalCandidateDigest('loopback'),
      kind: 'native_continuation',
      runId: nativeContinuationRunId(input.request.operationId),
      sessionId: 'native-pending',
      requestDigest: input.request.requestDigest,
      acknowledgement: { status: 'pending' },
    })).toBe(true)

    const dir = original.dir
    await original.runs.shutdown(1_000)
    await original.service.shutdown(1_000)
    original.unwatch()
    original.store.close()

    const restartedBackend = new FakeNativeBackend()
    fixture = setup(restartedBackend, dir)
    const response = await fixture.app.request('/v1/sessions/native-pending/continue', {
      method: 'POST',
      body: nativeContinuationBody(input),
    })
    expect(response.status).toBe(404)
    expect(await json(response)).toMatchObject({ acknowledgement: { status: 'unknown_session' } })
    expect(fixture.store.getRetainedControlOperation(input.request.operationId)?.acknowledgement).toMatchObject({
      status: 'completed',
      outcome: { acknowledgement: { status: 'unknown_session' } },
    })
    expect(restartedBackend.natives).toEqual([])
  })

  it('reconstructs a terminal native continuation after a settle-window crash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-native-crash-window-'))
    const store = new CrashBeforeNativeContinuationSettleStore(dir)
    const original = setup(new FakeNativeBackend(), dir, {}, store)
    fixture = original
    await original.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'native-crash-window', model: 'pi/test' }) })
    await original.app.request('/v1/sessions/native-crash-window/turns', {
      method: 'POST',
      body: turnBody('native-crash-window-first', { message: 'first' }),
    })
    await waitFor(() => original.store.getRetained('native-crash-window')?.turns === 1)
    const expectedBoundary = original.store.getRetained('native-crash-window')?.contextBoundary as NativeContextBoundaryProof
    const input = nativeContinuationRequest(
      original,
      'native-crash-window',
      'native-crash-window-operation',
      'second',
      expectedBoundary,
    )
    const failed = await original.app.request('/v1/sessions/native-crash-window/continue', {
      method: 'POST',
      body: nativeContinuationBody(input),
    })
    expect(failed.status).toBe(502)
    expect(await json(failed)).toMatchObject({ acknowledgement: { status: 'transport_failure' } })
    const pending = original.store.getRetainedControlOperation(input.request.operationId)
    expect(pending?.acknowledgement).toMatchObject({
      status: 'pending',
      actualBoundary: {
        ...input.request.run,
        boundary: expectedBoundary.boundary,
      },
    })
    expect(original.store.getRetainedRun(nativeContinuationRunId(input.request.operationId))?.snapshot).toMatchObject({
      terminal: true,
      status: 'done',
    })

    const restartDir = original.dir
    await original.runs.shutdown(1_000)
    await original.service.shutdown(1_000)
    original.unwatch()
    original.store.close()

    const restartedBackend = new FakeNativeBackend()
    fixture = setup(restartedBackend, restartDir)
    const replay = await fixture.app.request('/v1/sessions/native-crash-window/continue', {
      method: 'POST',
      body: nativeContinuationBody(input),
    })
    expect(replay.status).toBe(200)
    const replayOutcome = successfulNativeOutcome(AgentNativeContextContinuationResultSchema.parse(await json(replay)))
    expect(replayOutcome.acknowledgement.status).toBe('replayed')
    expect(replayOutcome.result).toMatchObject({ text: 'reply-2', success: true })
    expect(fixture.store.getRetainedControlOperation(input.request.operationId)?.acknowledgement).toMatchObject({
      status: 'completed',
      outcome: { acknowledgement: { status: 'accepted' } },
    })
    expect(restartedBackend.natives).toEqual([])
  })

  it('retries steer and cancel by durable operation id without repeating native effects', async () => {
    const backend = new FakeNativeBackend(() => new HangingNative())
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'idempotent', model: 'pi/test' }) })
    await fixture.app.request('/v1/sessions/idempotent/turns', { method: 'POST', body: turnBody('idempotent-hang', { message: 'hang' }) })
    await waitFor(() => fixture!.store.getRetained('idempotent')?.status === 'running')

    const steerBody = JSON.stringify(steerRequest(fixture, 'idempotent', 'steer-op-1', 'continue carefully'))
    const [steerA, steerB] = await Promise.all([
      fixture.app.request('/v1/sessions/idempotent/steer', { method: 'POST', body: steerBody }),
      fixture.app.request('/v1/sessions/idempotent/steer', { method: 'POST', body: steerBody }),
    ])
    expect(steerA.status).toBe(200)
    expect(steerB.status).toBe(200)
    expect(backend.natives[0]!.steers).toEqual(['continue carefully'])
    expect(fixture.store.getRetainedControlOperation('steer-op-1')?.acknowledgement).toMatchObject({ status: 'accepted' })

    const cancelBody = cancellationBody(fixture, 'idempotent', 'cancel-op-1')
    const cancelled = await fixture.app.request('/v1/sessions/idempotent/cancel?wait_ms=1000', { method: 'POST', body: cancelBody })
    const retried = await fixture.app.request('/v1/sessions/idempotent/cancel?wait_ms=1000', { method: 'POST', body: cancelBody })
    expect(cancelled.status).toBe(200)
    expect(retried.status).toBe(200)
    expect(await json(retried)).toEqual(await json(cancelled))
    expect(backend.natives[0]!.closeCalls).toBe(1)
  })

  it('recovers a lost turn response after service restart without dispatching the run twice', async () => {
    const backend = new FakeNativeBackend(() => new HangingNative())
    const original = setup(backend)
    fixture = original
    await original.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'restart-turn', model: 'pi/test' }),
    })
    const request = {
      message: 'hang',
      turn_id: 'turn-restart',
      execution_id: 'public-execution-restart',
      run_id: 'run-restart',
    }
    const first = await original.app.request('/v1/sessions/restart-turn/turns', {
      method: 'POST',
      body: JSON.stringify(request),
    })
    expect(first.status).toBe(202)
    await waitFor(() => original.store.getRetained('restart-turn')?.status === 'running')
    expect(backend.natives).toHaveLength(1)

    const restarted = setup(backend, original.dir)
    fixture = restarted
    try {
      const replay = await restarted.app.request('/v1/sessions/restart-turn/turns', {
        method: 'POST',
        body: JSON.stringify(request),
      })
      expect(replay.status).toBe(202)
      expect(await json(replay)).toMatchObject({
        run: {
          id: 'run-restart',
          executionId: 'public-execution-restart',
          status: 'unknown',
          terminal: false,
        },
        session: { id: 'restart-turn', status: 'unknown' },
      })
      const status = await restarted.app.request('/v1/runs/run-restart')
      expect(status.status).toBe(200)
      expect(await json(status)).toMatchObject({
        id: 'run-restart',
        executionId: 'public-execution-restart',
        status: 'unknown',
        terminal: false,
        sessionId: 'restart-turn',
      })
      const session = await restarted.app.request('/v1/sessions/restart-turn')
      expect(await json(session)).toMatchObject({
        run: {
          id: 'run-restart',
          executionId: 'public-execution-restart',
        },
      })
      expect(backend.natives).toHaveLength(1)

      const conflict = await restarted.app.request('/v1/sessions/restart-turn/turns', {
        method: 'POST',
        body: JSON.stringify({ ...request, message: 'changed' }),
      })
      expect(conflict.status).toBe(409)
      expect((await json(conflict)).error.type).toBe('run_identity_conflict')
      expect(backend.natives).toHaveLength(1)
    } finally {
      await original.runs.shutdown(1_000)
      original.store.close()
    }
  })

  it('replays exact cancellation after restart and rejects changed operation reuse', async () => {
    const backend = new FakeNativeBackend(() => new HangingNative())
    const original = setup(backend)
    fixture = original
    await original.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'restart-cancel', model: 'pi/test' }),
    })
    await original.app.request('/v1/sessions/restart-cancel/turns', {
      method: 'POST',
      body: JSON.stringify({ message: 'hang', turn_id: 'restart-cancel-turn', run_id: 'restart-cancel-run' }),
    })
    await waitFor(() => original.store.getRetained('restart-cancel')?.status === 'running')
    const requestBody = cancellationBody(original, 'restart-cancel', 'restart-cancel-op')
    const first = await original.app.request('/v1/sessions/restart-cancel/cancel?wait_ms=1000', {
      method: 'POST',
      body: requestBody,
    })
    expect(first.status).toBe(200)
    const firstAcknowledgement = await json(first)
    expect(firstAcknowledgement).toMatchObject({ status: 'accepted', effect: 'cancelled' })

    const restarted = setup(backend, original.dir)
    fixture = restarted
    try {
      const replay = await restarted.app.request('/v1/sessions/restart-cancel/cancel?wait_ms=1000', {
        method: 'POST',
        body: requestBody,
      })
      expect(replay.status).toBe(200)
      expect(await json(replay)).toEqual(firstAcknowledgement)

      const changedBody = cancellationBody(
        restarted,
        'restart-cancel',
        'restart-cancel-op',
        'changed reason',
      )
      const changed = await restarted.app.request('/v1/sessions/restart-cancel/cancel?wait_ms=1000', {
        method: 'POST',
        body: changedBody,
      })
      expect(changed.status).toBe(409)
      expect(await json(changed)).toMatchObject({
        requestDigest: JSON.parse(changedBody).requestDigest,
        status: 'conflict',
        effect: 'unknown',
      })
      expect(backend.natives).toHaveLength(1)
      expect(backend.natives[0]!.closeCalls).toBe(1)
    } finally {
      await original.runs.shutdown(1_000)
      original.store.close()
    }
  })

  it('reconciles admitted steer and cancel operations after restart without repeating unknown effects', async () => {
    const backend = new FakeNativeBackend(() => new HangingNative())
    fixture = setup(backend)
    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'pending-control', model: 'pi/test' }),
    })
    const turn = await fixture.app.request('/v1/sessions/pending-control/turns', {
      method: 'POST',
      body: turnBody('pending-control-hang', { message: 'hang' }),
    })
    const runId = (await json(turn)).run.id as string
    await waitFor(() => fixture!.store.getRetained('pending-control')?.status === 'running')

    const callerId = canonicalCandidateDigest('loopback')
    const operationId = 'pending-steer-after-restart'
    const runReference = steerRequest(fixture, 'pending-control', operationId, 'do not repeat me').run
    const requestDigest = canonicalCandidateDigest({
      callerId,
      kind: 'steer',
      sessionId: 'pending-control',
      run: runReference,
      prompt: 'do not repeat me',
    })
    fixture.store.recordRetainedControlOperation({
      operationId,
      callerId,
      kind: 'steer',
      runId: runReference.runId,
      sessionId: 'pending-control',
      requestDigest,
      acknowledgement: {
        operationId,
        kind: 'steer',
        sessionId: 'pending-control',
        runId,
        status: 'pending',
      },
    })

    const response = await fixture.app.request('/v1/sessions/pending-control/steer', {
      method: 'POST',
      body: JSON.stringify({ operationId, message: 'do not repeat me', run: runReference }),
    })
    expect(response.status).toBe(502)
    expect(await json(response)).toMatchObject({
      operationId,
      status: 'effect_unknown',
      retryable: false,
    })
    expect(backend.natives[0]!.steers).toEqual([])
    expect(fixture.store.getRetainedControlOperation(operationId)?.acknowledgement).toMatchObject({
      status: 'effect_unknown',
    })

    const cancelOperationId = 'pending-cancel-after-restart'
    const cancelRequest = JSON.parse(cancellationBody(
      fixture,
      'pending-control',
      cancelOperationId,
    ))
    const cancelRequestDigest = canonicalCandidateDigest({
      callerId,
      kind: 'cancel',
      request: cancelRequest,
    })
    fixture.store.recordRetainedControlOperation({
      operationId: cancelOperationId,
      callerId,
      kind: 'cancel',
      runId,
      sessionId: 'pending-control',
      requestDigest: cancelRequestDigest,
      acknowledgement: {
        operationId: cancelOperationId,
        kind: 'cancel',
        sessionId: 'pending-control',
        runId,
        status: 'pending',
      },
    })

    const cancelResponse = await fixture.app.request('/v1/sessions/pending-control/cancel', {
      method: 'POST',
      body: JSON.stringify(cancelRequest),
    })
    expect(cancelResponse.status).toBe(502)
    expect(await json(cancelResponse)).toMatchObject({
      operationId: cancelOperationId,
      status: 'unknown',
      effect: 'unknown',
      retryable: false,
    })
    expect(backend.natives[0]!.closeCalls).toBe(0)
    expect(fixture.store.getRetainedControlOperation(cancelOperationId)?.acknowledgement).toMatchObject({
      status: 'effect_unknown',
    })
  })

  it('serves a completed run from its own sequence cursor', async () => {
    fixture = setup(new FakeNativeBackend())
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'run-events', model: 'pi/test' }) })
    const turn = await fixture.app.request('/v1/sessions/run-events/turns', { method: 'POST', body: JSON.stringify({ message: 'first', run_id: 'run-events-1', execution_id: 'run-events-execution-1' }) })
    const runId = (await json(turn)).run.id as string
    await waitFor(() => fixture!.store.getRetained('run-events')?.turns === 1)
    const response = await fixture.app.request(`/v1/runs/${runId}/events`)
    expect(response.status).toBe(200)
    const body = await response.text()
    const events = [...body.matchAll(/data: (\{.*\})\r?\n/gu)].map(match => JSON.parse(match[1]!))
    expect(events.length).toBeGreaterThan(0)
    expect(events.every(event => event.runId === runId)).toBe(true)
    expect(events.map(event => event.sequence)).toEqual([...events].map(event => event.sequence).sort((a, b) => a - b))
    expect(response.headers.get('x-last-event-id')).toBe(String(Math.max(...events.map(event => event.sequence))))
    const replay = await fixture.app.request(`/v1/runs/${runId}/events`, { headers: { 'Last-Event-ID': String(events[0].sequence) } })
    expect(replay.status).toBe(200)
    const replayBody = await replay.text()
    expect([...replayBody.matchAll(/data: (\{.*\})\r?\n/gu)].map(match => JSON.parse(match[1]!).sequence).every(sequence => sequence > events[0].sequence)).toBe(true)
  })

  it('streams an active retained run from the canonical event log without legacy DONE', async () => {
    fixture = setup(new FakeNativeBackend(() => new HangingNative()))
    await fixture.app.request('/v1/sessions', { method: 'POST', body: JSON.stringify({ id: 'active-run-events', model: 'pi/test' }) })
    const turn = await fixture.app.request('/v1/sessions/active-run-events/turns', {
      method: 'POST',
      body: JSON.stringify({ message: 'hang', run_id: 'active-run-events-run', execution_id: 'active-run-events-execution' }),
    })
    expect(turn.status).toBe(202)
    await waitFor(() => fixture!.store.getRetained('active-run-events')?.status === 'running')
    const runId = (await json(turn)).run.id as string
    const stream = await fixture.app.request(`/v1/runs/${runId}/events`)
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()
    const decoder = new TextDecoder()
    let body = ''
    let cancelled = false
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      body += decoder.decode(chunk.value, { stream: true })
      if (!cancelled && body.includes('event: status')) {
        cancelled = true
        const response = await fixture.app.request(`/v1/sessions/active-run-events/cancel?wait_ms=1000`, {
          method: 'POST',
          body: cancellationBody(fixture, 'active-run-events', 'active-run-events-cancel'),
        })
        expect(response.status).toBe(200)
      }
    }
    expect(cancelled).toBe(true)
    expect(body).toContain(`"runId":"${runId}"`)
    expect(body).toContain('event: status')
    expect(body).not.toContain('data: [DONE]')
  })

  it('prunes acknowledged interaction records but preserves unknown-effect tombstones', () => {
    const db = new Database(':memory:')
    createInteractionOperationSchema(db)
    const ledger = new RetainedInteractionLedger(db)
    const unknownBinding: InteractionBinding = {
      requestDigest: canonicalCandidateDigest('unknown-request'),
      runId: 'bounded-run',
      provider: 'provider',
      environmentId: 'environment',
      sessionId: 'bounded-session',
      executionId: 'bounded-execution',
      interactionId: 'unknown-interaction',
    }
    const unknownCommandDigest = interactionResponseCommandDigest({
      binding: unknownBinding,
      response: { id: unknownBinding.interactionId, outcome: 'cancelled' },
    })
    const unknownOperation = {
      operationId: 'unknown-effect-operation',
      callerId: 'test-caller',
      runId: unknownBinding.runId,
      sessionId: unknownBinding.sessionId,
      interactionId: unknownBinding.interactionId,
      requestDigest: canonicalCandidateDigest('unknown-operation-request'),
      responseDigest: canonicalCandidateDigest('unknown-response'),
    }
    ledger.beginInteractionOperation(unknownOperation)
    ledger.markInteractionEffectUnknown(
      unknownOperation.operationId,
      unknownOperation.requestDigest,
      unknownOperation.responseDigest,
      {
        operationId: unknownOperation.operationId,
        binding: unknownBinding,
        commandDigest: unknownCommandDigest,
        status: 'transport_failure',
        message: 'native effect is unknown',
        retryable: false,
      },
    )

    for (let index = 0; index <= MAX_ACKNOWLEDGED_INTERACTION_OPERATIONS; index += 1) {
      const binding: InteractionBinding = {
        requestDigest: canonicalCandidateDigest({ kind: 'ack-request', index }),
        runId: 'bounded-run',
        provider: 'provider',
        environmentId: 'environment',
        sessionId: 'bounded-session',
        executionId: 'bounded-execution',
        interactionId: `ack-${index}`,
      }
      ledger.recordInteractionOperation({
        operationId: `ack-operation-${index}`,
        callerId: 'test-caller',
        runId: binding.runId,
        sessionId: binding.sessionId,
        interactionId: binding.interactionId,
        requestDigest: canonicalCandidateDigest({ kind: 'ack-operation', index }),
        responseDigest: canonicalCandidateDigest({ kind: 'ack-response', index }),
        acknowledgement: {
          operationId: `ack-operation-${index}`,
          binding,
          commandDigest: canonicalCandidateDigest({ kind: 'ack-command', index }),
          status: 'unknown_run',
          message: 'run is unknown',
        },
      })
    }

    const counts = db.prepare(
      "SELECT phase, COUNT(*) AS count FROM interaction_operations GROUP BY phase",
    ).all() as Array<{ phase: string; count: number }>
    const acknowledged = counts.find(row => row.phase === 'acknowledged')?.count ?? 0
    expect(acknowledged).toBeLessThanOrEqual(MAX_ACKNOWLEDGED_INTERACTION_OPERATIONS)
    expect(ledger.findEffectUnknownInteraction(
      unknownBinding.runId,
      unknownBinding.sessionId,
      unknownBinding.interactionId,
    )).toMatchObject({ operationId: unknownOperation.operationId, phase: 'effect_unknown' })
    db.close()
  })
})

describe('retained chat deltas', () => {
  it('keeps ChatDelta.reasoning on the persisted retained_events row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-retained-reasoning-'))
    try {
      const store = new SqliteSessionStore(dir)
      store.createRetained({
        id: 'reasoning-session',
        createRequestDigest: 'sha256:reasoning-create',
        backend: 'pi',
        model: 'pi/tangle-router/openrouter/stealth/ox-alpha',
        capabilities,
      })
      store.appendRetainedDelta('reasoning-session', {
        runId: 'bridge-run-reasoning',
        sequence: 1,
        delta: { model: 'stealth/ox-alpha', reasoning: 'the model thinking out loud' },
      })
      store.appendRetainedDelta('reasoning-session', {
        runId: 'bridge-run-reasoning',
        sequence: 2,
        delta: { content: 'the answer' },
      })

      // Re-open from disk: the JSON round trip through event_json must keep
      // the reasoning key, interleaved before the content row.
      const reopened = new SqliteSessionStore(dir)
      const events = reopened.retainedEventsAfter('reasoning-session').map(item => item.envelope.event)
      expect(events).toEqual([
        {
          type: 'raw',
          backend: 'cli-bridge.chat',
          event: { model: 'stealth/ox-alpha', reasoning: 'the model thinking out loud' },
        },
        {
          type: 'raw',
          backend: 'cli-bridge.chat',
          event: { content: 'the answer' },
        },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function isUsageRawEvent(value: unknown): boolean {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { type?: unknown }).type === 'usage'
}

function recordEventType(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' ? type : undefined
}
