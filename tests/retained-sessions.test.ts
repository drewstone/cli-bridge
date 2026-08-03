import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
  canonicalCandidateDigest,
  type AgentEnvironmentCapabilities,
  type NativeContextBoundaryProof,
} from '@tangle-network/agent-interface'

const capabilities: AgentEnvironmentCapabilities = {
  profile: {
    namedProfiles: false,
    systemPrompt: true,
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
  }

  async *turn(prompt: string, signal: AbortSignal): AsyncIterable<unknown> {
    this.prompts.push(prompt)
    this.count += 1
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
    return Promise.resolve()
  }

  async abort(): Promise<void> {
    this.aborted = true
    this.response?.()
  }

  async respondToNativeInteraction(_id: string, response: Record<string, unknown>): Promise<void> {
    this.responseCalls += 1
    this.response?.()
  }

  async contextBoundary(input: { runId: string; environmentId: string; sessionId: string }): Promise<NativeContextBoundaryProof | null> {
    return {
      runId: input.runId,
      provider: this.backendName,
      environmentId: input.environmentId,
      sessionId: input.sessionId,
      boundary: { kind: 'revision', revision: `fake:${this.count}` },
      observedAt: new Date().toISOString(),
    }
  }

  close(): Promise<void> {
    this.closeCalls += 1
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
    await this.responseReady
    this.responseCompleted = true
    this.response?.()
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
    input: { runId: string; environmentId: string; sessionId: string },
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
    input: { runId: string; environmentId: string; sessionId: string },
  ): Promise<NativeContextBoundaryProof | null> {
    if (this.closeCalls > 0 && !this.isClosed()) {
      this.boundaryDuringCloseCalls += 1
      return Promise.reject(new Error('boundary inspection overlapped native close'))
    }
    return super.contextBoundary(input)
  }

  override async close(): Promise<void> {
    this.closeCalls += 1
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

class FakeNativeBackend implements NativeSessionBackend {
  readonly nativeModes = ['byob'] as const
  readonly natives: FakeNative[] = []
  constructor(
    private readonly makeNative: () => FakeNative = () => new FakeNative(),
    readonly name = 'pi',
  ) {}
  matches(model: string): boolean { return model === this.name || model.startsWith(`${this.name}/`) }
  nativeCapabilities(): AgentEnvironmentCapabilities { return capabilities }
  health(): Promise<BackendHealth> { return Promise.resolve({ name: this.name, state: 'ready' }) }
  async startNativeSession(req: ChatRequest): Promise<NativeSession> {
    req.profile_materialization_receipt = {
      schema: 'cli-bridge.profile-materialization.v1',
      harness: this.name,
      workspacePlanDigest: 'sha256:' + 'a'.repeat(64),
      files: [],
      unsupported: [],
    }
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
    return await new Promise(resolve => {
      const onAbort = (): void => {
        this.aborts += 1
        this.active -= 1
        resolve({ name: this.name, state: 'unavailable', detail: 'cancelled' })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }
}

class OneShotBackend implements Backend {
  readonly name = 'one-shot'
  matches(model: string): boolean { return model === this.name }
  health(): Promise<BackendHealth> { return Promise.resolve({ name: this.name, state: 'ready' }) }
  async *chat(): AsyncIterable<ChatDelta> { yield { content: 'ok', finish_reason: 'stop' } }
}

function setup(
  backend: Backend,
  existingDir?: string,
  serviceOptions: {
    inputQueueMaxDepth?: number
    inputQueueTimeoutMs?: number
    healthProbeTimeoutMs?: number
  } = {},
): { app: Hono; service: RetainedSessionService; store: SessionStore; runs: RunRegistry; dir: string } {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), 'cli-bridge-retained-'))
  const store = new SqliteSessionStore(dir)
  const runs = new RunRegistry({ replayRetentionMs: 60_000, identityRetentionMs: 60_000 })
  const registry = new (class {
    readonly backends = [backend]
    resolve(model: string): Backend | null { return this.backends.find(item => item.matches(model)) ?? null }
    byName(name: string): Backend | null { return this.backends.find(item => item.name === name) ?? null }
  })()
  const service = new RetainedSessionService({ store, registry: registry as never, runs, ...serviceOptions })
  const app = new Hono()
  mountRetainedSessions(app, service)
  mountRuns(app, { runs, retainedRuns: service })
  mountChatCompletions(app, { registry: registry as never, sessions: store, runs })
  return { app, service, store, runs, dir }
}

const cleanup = async (fixture: ReturnType<typeof setup>): Promise<void> => {
  await fixture.runs.shutdown(1_000)
  await fixture.service.shutdown(1_000).catch(() => {})
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
        provider: 'cli-bridge',
        environmentId: 'cli-bridge',
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
      provider: 'cli-bridge',
      environmentId: 'cli-bridge',
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

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for retained run')
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
    const expectedDigest = canonicalCandidateDigest(request)
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

  it('rejects turn fields and attachments the native text channel cannot preserve', async () => {
    fixture = setup(new FakeNativeBackend())
    await fixture.app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'strict-turn', model: 'pi/test' }),
    })
    for (const body of [
      { message: 'model override', model: 'pi/other', run_id: 'strict-model' },
      { message: 'context', context: { trace: true }, run_id: 'strict-context' },
      { parts: [{ type: 'image', url: 'https://example.test/image.png' }], run_id: 'strict-image' },
      { parts: [{ type: 'file', content: 'secret bytes' }], run_id: 'strict-file' },
    ]) {
      const response = await fixture.app.request('/v1/sessions/strict-turn/turns', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
    expect(fixture.store.getRetained('strict-turn')?.runId).toBeNull()
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
      },
    }
    const response = await fixture.app.request('/v1/sessions/cancel-without-digest/cancel', {
      method: 'POST',
      body: JSON.stringify({
        ...material,
        requestDigest: agentRunCancellationRequestDigest(material),
      }),
    })
    expect(response.status).toBe(400)
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
    expect(createdBody.capabilities.nativeContinuation).toBeUndefined()
    expect(fixture.store.getRetained('s1')?.metadata.agent_profile).toBeUndefined()
    expect(fixture.store.getRetained('s1')?.metadata.retained_input_presence).toEqual({ agent_profile: true })
    const listed = await fixture.app.request('/v1/sessions')
    expect(listed.status).toBe(200)
    expect((await json(listed)).data.map((item: { id: string }) => item.id)).toContain('s1')

    const first = await fixture.app.request('/v1/sessions/s1/turns', { method: 'POST', body: turnBody('s1-first', { message: 'first' }) })
    expect(first.status).toBe(202)
    const firstRunId = (await json(first)).run.id as string
    await waitFor(() => fixture!.store.getRetained('s1')?.turns === 1)
    const receipt = fixture.store.getRetained('s1')?.profileMaterializationReceipt
    expect(receipt).toMatchObject({ schema: 'cli-bridge.profile-materialization.v1', harness: 'pi' })

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
    expect(genericCancel.status).toBe(502)
    expect(await json(genericCancel)).toMatchObject({
      cancelled: false,
      terminal: true,
      effect_unknown: true,
      retryable: false,
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
    await waitFor(() => runs.get('expired-never-closes') === undefined)

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
      body: JSON.stringify({
        operationId: 'rich-answer',
        binding: { runId, environmentId: 'cli-bridge', sessionId: 'rich', interactionId: interaction.request.id },
        response: { id: interaction.request.id, outcome: 'accepted', data: { grant: ['allow_once'] } },
      }),
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
      await waitFor(() => run.signal.aborted)
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
      await waitFor(() => fixture!.runs.get(runId)?.signal.aborted === true)

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
      await waitFor(() => fixture!.runs.get(runId)?.signal.aborted === true)

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
      await waitFor(() => run.signal.aborted)
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
      await waitFor(() => fixture!.runs.get('run-cancel-transfer-gap-second')?.signal.aborted === true)
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
      body: JSON.stringify({
        operationId: 'steer-answer',
        binding: { runId, environmentId: 'cli-bridge', sessionId: 'steer', interactionId: interaction.request.id },
        response: { id: interaction.request.id, outcome: 'accepted', data: { grant: ['allow_once'] } },
      }),
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
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(admitted).toBe(false)
    const response = await fixture.app.request(`/v1/runs/${firstRunId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify({
        operationId: 'queued-answer',
        binding: { runId: firstRunId, environmentId: 'cli-bridge', sessionId: 'queued', interactionId: interaction.request.id },
        response: { id: interaction.request.id, outcome: 'accepted', data: { grant: ['allow_once'] } },
      }),
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
    await new Promise(resolve => setTimeout(resolve, 10))
    const overflow = await fixture.app.request('/v1/sessions/queue-overflow/input', { method: 'POST', body: turnBody('queue-overflow-third', { message: 'third' }) })
    expect(overflow.status).toBe(429)
    expect(await json(overflow)).toMatchObject({ error: { type: 'input_queue_full' } })
    expect(fixture.store.getRetainedRun('run-queue-overflow-third')).toBeNull()

    const firstResponse = await fixture.app.request(`/v1/runs/${firstRunId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify({
        operationId: 'queue-overflow-answer',
        binding: { runId: firstRunId, environmentId: 'cli-bridge', sessionId: 'queue-overflow', interactionId: interaction.request.id },
        response: { id: interaction.request.id, outcome: 'accepted', data: { grant: ['allow_once'] } },
      }),
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
    await new Promise(resolve => setTimeout(resolve, 10))
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
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort()
    await expect(middle).rejects.toMatchObject({ code: 'input_queue_aborted', status: 408 })
    const premature = await Promise.race([
      last.then(() => 'resolved', () => 'rejected'),
      new Promise<'waiting'>(resolve => setTimeout(() => resolve('waiting'), 30)),
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
    const turn = await fixture.app.request('/v1/sessions/s3/turns', { method: 'POST', body: turnBody('s3-ask', { message: 'ask' }) })
    const runId = (await json(turn)).run.id as string
    await waitFor(() => fixture!.store.retainedEventsAfter('s3').some(item => item.envelope.event.type === 'interaction'))
    const interaction = fixture.store.retainedEventsAfter('s3').find(item => item.envelope.event.type === 'interaction')!.envelope.event
    if (interaction.type !== 'interaction') throw new Error('test interaction missing')
    const command = {
      operationId: 'op-1',
      binding: { runId, environmentId: 'cli-bridge', sessionId: 's3', interactionId: interaction.request.id },
      response: { id: interaction.request.id, outcome: 'accepted', data: { grant: ['allow_once'] } },
    }
    const accepted = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, { method: 'POST', body: JSON.stringify(command) })
    expect(accepted.status).toBe(200)
    const acceptedBody = await json(accepted)
    expect(acceptedBody.status).toBe('accepted')
    const retry = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, { method: 'POST', body: JSON.stringify(command) })
    expect(retry.status).toBe(200)
    expect(await json(retry)).toEqual(acceptedBody)
    const sameResponse = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, { method: 'POST', body: JSON.stringify({ ...command, operationId: 'op-same-response' }) })
    expect(sameResponse.status).toBe(200)
    expect((await json(sameResponse)).status).toBe('already_resolved_same')
    const { sessionId: _sessionId, ...bindingWithoutSession } = command.binding
    const optionalSession = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify({ ...command, operationId: 'op-optional-session', binding: bindingWithoutSession }),
    })
    expect(optionalSession.status).toBe(200)
    expect((await json(optionalSession)).status).toBe('already_resolved_same')
    const conflict = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, { method: 'POST', body: JSON.stringify({ ...command, response: { ...command.response, outcome: 'declined' } }) })
    expect(conflict.status).toBe(409)
    const wrong = await fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, { method: 'POST', body: JSON.stringify({ ...command, operationId: 'op-wrong', binding: { ...command.binding, runId: 'wrong-run' } }) })
    expect(wrong.status).toBe(409)
    expect((await json(wrong)).status).toBe('binding_mismatch')
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
    const binding = { runId, environmentId: 'cli-bridge', sessionId: 'concurrent', interactionId: interaction.request.id }
    const responseBody = { id: interaction.request.id, outcome: 'accepted', data: { grant: ['allow_once'] } }
    const first = fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify({ operationId: 'concurrent-first', binding, response: responseBody }),
    })
    await waitFor(() => native.responseCalls === 1)
    const contenders = await Promise.all(Array.from({ length: 19 }, (_, index) => fixture!.app.request(
      `/v1/runs/${runId}/interactions/${interaction.request.id}/respond`,
      {
        method: 'POST',
        body: JSON.stringify({ operationId: `concurrent-${index + 2}`, binding, response: responseBody }),
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
      body: JSON.stringify({
        operationId: 'stale-response',
        binding: { runId, environmentId: 'cli-bridge', sessionId: 's-cancel', interactionId: interaction.request.id },
        response: { id: interaction.request.id, outcome: 'accepted', data: { grant: ['allow_once'] } },
      }),
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
    const binding = { runId, environmentId: 'cli-bridge', sessionId: 'race', interactionId: interaction.request.id }
    const response = fixture.app.request(`/v1/runs/${runId}/interactions/${interaction.request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify({ operationId: 'race-response', binding, response: { id: interaction.request.id, outcome: 'accepted', data: { grant: ['allow_once'] } } }),
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
    expect(fixture.store.getInteractionOperation('race-response')?.acknowledgement.status).toBe('accepted')
    expect(fixture.store.getInteractionOperation('race-response')?.acknowledgement.retryable).toBeUndefined()
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
      body: JSON.stringify({
        operationId: 'terminal-stale',
        binding: { runId, environmentId: 'cli-bridge', sessionId: 'terminal-ask', interactionId: interaction.request.id },
        response: { id: interaction.request.id, outcome: 'accepted', data: { grant: ['allow_once'] } },
      }),
    })
    expect(response.status).toBe(409)
    expect((await json(response)).status).toBe('cancelled')
    expect(backend.natives[0]!.responseCalls).toBe(0)
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
      interaction_policy: 'interactive',
    })

    const unsafe = [
      { agent_profile: { prompt: { systemPrompt: 'raw' } } },
      { mcp: { mcpServers: { secret: { command: 'cat' } } } },
      { credentials: { token: 'raw' } },
      { api_key: 'raw' },
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
    const replay = await fixture.app.request(`/v1/runs/${runId}/events`, { headers: { 'Last-Event-ID': String(events[0].sequence) } })
    expect(replay.status).toBe(200)
    const replayBody = await replay.text()
    expect([...replayBody.matchAll(/data: (\{.*\})\r?\n/gu)].map(match => JSON.parse(match[1]!).sequence).every(sequence => sequence > events[0].sequence)).toBe(true)
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
