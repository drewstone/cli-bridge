import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  agentRunCancellationRequestDigest,
  type AgentExactRunControlRef,
  type AgentRunCancellationRequest,
} from '@tangle-network/agent-interface'
import { AdmissionGate } from '../src/admission.js'
import { BackendRegistry } from '../src/backends/registry.js'
import type { Backend, BackendHealth, ChatDelta, ChatRequest } from '../src/backends/types.js'
import { BackendError } from '../src/backends/types.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { mountRuns } from '../src/routes/runs.js'
import { RunRegistry, type RunRegistryOptions } from '../src/runs/registry.js'
import { SessionStore, type SessionRecord } from '../src/sessions/store.js'
import { RETAINED_MAX_HTTP_BODY_BYTES } from '../src/sessions/retained/schema.js'
import { RetainedSessionService } from '../src/sessions/retained.js'

const CHAT_PATH = '/v1/chat/completions'

abstract class TestBackend implements Backend {
  constructor(readonly name = 'durable') {}

  matches(model: string): boolean {
    return model === this.name || model.startsWith(`${this.name}/`)
  }

  async health(): Promise<BackendHealth> {
    return { name: this.name, state: 'ready' }
  }

  abstract chat(
    req: ChatRequest,
    session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta>
}

class ReplayBackend extends TestBackend {
  calls = 0
  constructor(private readonly delayMs = 0, name = 'durable') { super(name) }

  async *chat(): AsyncIterable<ChatDelta> {
    this.calls += 1
    for (const content of ['one', 'two']) {
      if (this.delayMs > 0) await delay(this.delayMs)
      yield { content }
    }
    if (this.delayMs > 0) await delay(this.delayMs)
    yield {
      finish_reason: 'stop',
      usage: { input_tokens: 1, output_tokens: 2 },
    }
  }
}

class MetadataReplayBackend extends TestBackend {
  calls = 0

  async *chat(): AsyncIterable<ChatDelta> {
    this.calls += 1
    yield { internal_session_id: 'internal-session' }
    yield { content: 'visible' }
    yield { finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }
  }
}

class ProfileReceiptReplayBackend extends TestBackend {
  calls = 0

  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    this.calls += 1
    req.profile_materialization_receipt = {
      schema: 'cli-bridge.profile-materialization.v2',
      effectiveProfileDigest: `sha256:${'1'.repeat(64)}`,
      harness: 'pi',
      provider: 'tangle-router',
      model: req.model,
      reasoningEffort: { requested: 'ultracode', applied: 'xhigh' },
      workspacePlanDigest: `sha256:${'2'.repeat(64)}`,
      files: [{ path: 'AGENTS.md', mode: 0o644 }],
      unsupported: [],
    }
    yield { content: 'done' }
    yield { finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }
  }
}

class ProfileReceiptFailureBackend extends TestBackend {
  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    req.profile_materialization_receipt = {
      schema: 'cli-bridge.profile-materialization.v2',
      effectiveProfileDigest: `sha256:${'3'.repeat(64)}`,
      harness: 'pi',
      provider: 'tangle-router',
      model: req.model,
      reasoningEffort: { requested: 'ultracode', applied: 'xhigh' },
      workspacePlanDigest: `sha256:${'4'.repeat(64)}`,
      files: [],
      unsupported: [],
    }
    yield { content: 'accepted answer' }
    throw new BackendError('backend exited after accepted submission', 'upstream')
  }
}

class ControlledBackend extends TestBackend {
  calls = 0
  private finishRun!: () => void
  private readonly finishPromise = new Promise<void>((resolve) => {
    this.finishRun = resolve
  })

  async *chat(): AsyncIterable<ChatDelta> {
    this.calls += 1
    yield { content: 'started' }
    await this.finishPromise
    yield {
      finish_reason: 'stop',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }

  finish(): void {
    this.finishRun()
  }
}

class ControlledCancelBackend extends TestBackend {
  abortObserved = false
  private finishCancel!: () => void
  private readonly finishPromise = new Promise<void>((resolve) => {
    this.finishCancel = resolve
  })

  async *chat(
    _req: ChatRequest,
    _session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    yield { content: 'started' }
    await new Promise<void>((resolve) => {
      const onAbort = (): void => {
        this.abortObserved = true
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    await this.finishPromise
    throw new BackendError('cancelled by test', 'aborted')
  }

  finishCancellation(): void {
    this.finishCancel()
  }
}

class SerializedSessionBackend extends TestBackend {
  calls = 0
  active = 0
  maxActive = 0
  readonly observedInternalIds: Array<string | null> = []
  private readonly releases = new Map<number, () => void>()

  async *chat(
    _req: ChatRequest,
    session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    const call = ++this.calls
    this.observedInternalIds.push(session?.internalId ?? null)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)

    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          this.releases.delete(call)
          signal.removeEventListener('abort', onAbort)
        }
        const onAbort = (): void => {
          cleanup()
          reject(new BackendError('cancelled by test', 'aborted'))
        }
        this.releases.set(call, () => {
          cleanup()
          resolve()
        })
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
      yield { internal_session_id: `internal-${call}` }
      yield { content: `call-${call}` }
      yield {
        finish_reason: 'stop',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    } finally {
      this.active -= 1
    }
  }

  release(call: number): boolean {
    const release = this.releases.get(call)
    if (!release) return false
    release()
    return true
  }
}

class ChildProcessBackend extends TestBackend {
  child: ChildProcess | null = null
  abortObserved = false
  exited = false
  private childExit: Promise<void> | null = null

  async *chat(
    _req: ChatRequest,
    _session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    )
    this.child = child
    this.childExit = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', () => {
        this.exited = true
        resolve()
      })
    })
    yield { content: 'child-started' }
    await new Promise<void>((resolve) => {
      const onAbort = (): void => {
        this.abortObserved = true
        child.kill('SIGTERM')
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    await this.childExit
    throw new BackendError('child cancelled', 'aborted')
  }

  isAlive(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null
  }

  async forceCleanup(): Promise<void> {
    if (!this.child || !this.isAlive()) return
    this.child.kill('SIGKILL')
    if (this.childExit) {
      await Promise.race([this.childExit, delay(2_000)])
    }
  }
}

interface Fixture {
  app: Hono
  runs: RunRegistry
  sessions: SessionStore
  dir: string
  cleanup: () => void
}

function fixture(
  backend: Backend,
  opts: RunRegistryOptions = {},
  admission?: AdmissionGate,
): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-durable-runs-'))
  const sessions = new SessionStore(dir)
  const runs = new RunRegistry(opts)
  const registry = new BackendRegistry().register(backend)
  const app = new Hono()
  mountChatCompletions(app, { registry, sessions, retainedRuns: sessions, runs, ...(admission ? { admission } : {}) })
  mountRuns(app, { runs, retainedStore: sessions })
  return {
    app,
    runs,
    sessions,
    dir,
    cleanup: () => {
      runs.clear()
      sessions.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function chatBody(runId: string, content = 'hello', model = 'durable/test'): Record<string, unknown> {
  return {
    model,
    messages: [{ role: 'user', content }],
    stream: true,
    run_id: runId,
  }
}

async function postChat(app: Hono, body: object, headers: Record<string, string> = {}): Promise<Response> {
  return await app.request(CHAT_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function sseIds(text: string): number[] {
  return [...text.matchAll(/^id: (\d+)$/gmu)].map(match => Number(match[1]))
}

describe('durable run contract', () => {
  it.each([
    ['opencode', 'opencode/test'],
    ['claude-code', 'claude-code/test'],
    ['codex', 'codex/test'],
    ['kimi-code', 'kimi-code/test'],
  ])('retains exact coordinates through %s dispatch, status, replay, and cancel', async (backendName, model) => {
    const backend = new ReplayBackend(0, backendName)
    const ctx = fixture(backend)
    const runId = `exact-${backendName}-run`
    const exact = {
      provider: 'caller-provider',
      environment_id: `caller-environment-${backendName}`,
      session_id: `caller-session-${backendName}`,
      execution_id: `caller-execution-${backendName}`,
    }
    try {
      const dispatch = await postChat(ctx.app, { ...chatBody(runId, 'exact coordinates', model), ...exact })
      expect(dispatch.status).toBe(200)
      await dispatch.text()
      expect(dispatch.headers.get('x-run-id')).toBe(runId)
      expect(dispatch.headers.get('x-run-provider')).toBe(exact.provider)
      expect(dispatch.headers.get('x-run-environment-id')).toBe(exact.environment_id)
      expect(dispatch.headers.get('x-run-session-id')).toBe(exact.session_id)
      expect(dispatch.headers.get('x-run-execution-id')).toBe(exact.execution_id)
      const requestDigest = dispatch.headers.get('x-run-request-digest')
      expect(requestDigest).toMatch(/^sha256:/u)

      const status = await ctx.app.request(`/v1/runs/${runId}`)
      expect(status.status).toBe(200)
      expect(status.headers.get('x-run-request-digest')).toBe(requestDigest)
      expect(status.headers.get('x-run-provider')).toBe(exact.provider)
      expect(status.headers.get('x-run-environment-id')).toBe(exact.environment_id)
      expect(status.headers.get('x-run-session-id')).toBe(exact.session_id)
      expect(status.headers.get('x-run-execution-id')).toBe(exact.execution_id)
      const snapshot = await status.json() as {
        requestDigest: `sha256:${string}`
        provider: string
        environmentId: string
        sessionId: string
        executionId: string
      }
      expect(snapshot).toMatchObject({
        requestDigest,
        provider: exact.provider,
        environmentId: exact.environment_id,
        sessionId: exact.session_id,
        executionId: exact.execution_id,
      })

      const replay = await ctx.app.request(`/v1/runs/${runId}/events`, {
        headers: { 'Last-Event-ID': '0' },
      })
      expect(replay.status).toBe(200)
      expect(replay.headers.get('x-run-id')).toBe(runId)
      expect(replay.headers.get('x-run-provider')).toBe(exact.provider)
      expect(replay.headers.get('x-run-environment-id')).toBe(exact.environment_id)
      expect(replay.headers.get('x-run-session-id')).toBe(exact.session_id)
      expect(replay.headers.get('x-run-execution-id')).toBe(exact.execution_id)
      expect(await replay.text()).toContain('one')

      const run: AgentExactRunControlRef = {
        runId,
        provider: snapshot.provider,
        environmentId: snapshot.environmentId,
        sessionId: snapshot.sessionId,
        executionId: snapshot.executionId,
        requestDigest: snapshot.requestDigest,
      }
      const cancellation = cancellationRequest(`cancel-${backendName}`, run, 'test exact cancellation')
      const cancelled = await ctx.app.request(`/v1/runs/${runId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cancellation),
      })
      expect(cancelled.status).toBe(200)
      expect(cancelled.headers.get('x-run-provider')).toBe(exact.provider)
      await expect(cancelled.json()).resolves.toMatchObject({
        status: 'accepted',
        effect: 'not_live',
        run,
      })
      const replayedCancel = await ctx.app.request(`/v1/runs/${runId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cancellation),
      })
      expect(replayedCancel.status).toBe(200)
      await expect(replayedCancel.json()).resolves.toMatchObject({ status: 'replayed', effect: 'not_live' })
    } finally {
      ctx.cleanup()
    }
  })

  it('recovers a completed generic run and exact cancellation across store/process restart', async () => {
    const backend = new ReplayBackend(0)
    const first = fixture(backend)
    const runId = 'generic-restart-run'
    const exact = {
      provider: 'restart-provider',
      environment_id: 'restart-environment',
      session_id: 'restart-session',
      execution_id: 'restart-execution',
    }
    let restartedStore: SessionStore | null = null
    let restartedRuns: RunRegistry | null = null
    try {
      const body = { ...chatBody(runId, 'restart me', 'durable/test'), ...exact }
      const initial = await postChat(first.app, body)
      expect(initial.status).toBe(200)
      await initial.text()
      const requestDigest = initial.headers.get('x-run-request-digest')
      expect(requestDigest).toMatch(/^sha256:/u)
      expect(first.sessions.getRetainedRun(runId)).toMatchObject({
        owner: 'one-shot',
        requestDigest,
        snapshot: { status: 'done', terminal: true, lastSeq: 3 },
      })
      const persistedSnapshot = first.sessions.getRetainedRun(runId)!.snapshot as {
        requestDigest: `sha256:${string}`
        provider: string
        environmentId: string
        sessionId: string
        executionId: string
      }
      expect(first.sessions.retainedEventsAfterRun(exact.session_id, runId)).toHaveLength(3)

      first.runs.clear()
      first.sessions.close()

      restartedStore = new SessionStore(first.dir)
      restartedRuns = new RunRegistry()
      const restartedRegistry = new BackendRegistry().register(new ReplayBackend(0))
      const restartedService = new RetainedSessionService({
        store: restartedStore,
        registry: restartedRegistry,
        runs: restartedRuns,
      })
      const restarted = new Hono()
      mountChatCompletions(restarted, {
        registry: restartedRegistry,
        sessions: restartedStore,
        retainedRuns: restartedStore,
        runs: restartedRuns,
      })
      mountRuns(restarted, {
        runs: restartedRuns,
        retainedRuns: restartedService,
        retainedStore: restartedStore,
      })

      const replayed = await postChat(restarted, body)
      expect(replayed.status).toBe(200)
      expect(replayed.headers.get('x-run-id')).toBe(runId)
      expect(replayed.headers.get('x-run-request-digest')).toBe(requestDigest)
      expect(replayed.headers.get('x-run-provider')).toBe(exact.provider)
      expect(replayed.headers.get('x-run-environment-id')).toBe(exact.environment_id)
      expect(replayed.headers.get('x-run-session-id')).toBe(exact.session_id)
      expect(replayed.headers.get('x-run-execution-id')).toBe(exact.execution_id)
      const replayedText = await replayed.text()
      expect(replayedText).toContain('one')
      expect(replayedText).toContain('two')
      expect(restartedRuns.get(runId)).toBeUndefined()

      const status = await restarted.request(`/v1/runs/${runId}`)
      expect(status.status).toBe(200)
      expect(status.headers.get('x-run-request-digest')).toBe(requestDigest)
      await expect(status.json()).resolves.toMatchObject({ status: 'done', terminal: true })

      const events = await restarted.request(`/v1/runs/${runId}/events`, {
        headers: { 'Last-Event-ID': '0' },
      })
      expect(events.status).toBe(200)
      const eventsText = await events.text()
      expect(eventsText).toContain('one')
      expect(eventsText).toContain('data: [DONE]')
      expect(eventsText).not.toContain('event: raw')

      const cancellation = cancellationRequest(
        'restart-cancellation',
        {
          runId,
          requestDigest: persistedSnapshot.requestDigest,
          provider: persistedSnapshot.provider,
          environmentId: persistedSnapshot.environmentId,
          sessionId: persistedSnapshot.sessionId,
          executionId: persistedSnapshot.executionId,
        },
        'reconcile after restart',
      )
      const cancelled = await restarted.request(`/v1/runs/${runId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cancellation),
      })
      expect(cancelled.status).toBe(200)
      expect(cancelled.headers.get('x-run-id')).toBe(runId)
      expect(cancelled.headers.get('x-run-request-digest')).toBe(persistedSnapshot.requestDigest)
      expect(cancelled.headers.get('x-run-provider')).toBe(exact.provider)
      expect(cancelled.headers.get('x-run-environment-id')).toBe(exact.environment_id)
      expect(cancelled.headers.get('x-run-session-id')).toBe(exact.session_id)
      expect(cancelled.headers.get('x-run-execution-id')).toBe(exact.execution_id)
      await expect(cancelled.json()).resolves.toMatchObject({ status: 'accepted', effect: 'not_live' })

      const replayedCancellation = await restarted.request(`/v1/runs/${runId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cancellation),
      })
      expect(replayedCancellation.status).toBe(200)
      expect(replayedCancellation.headers.get('x-run-id')).toBe(runId)
      expect(replayedCancellation.headers.get('x-run-request-digest')).toBe(persistedSnapshot.requestDigest)
      expect(replayedCancellation.headers.get('x-run-provider')).toBe(exact.provider)
      expect(replayedCancellation.headers.get('x-run-environment-id')).toBe(exact.environment_id)
      expect(replayedCancellation.headers.get('x-run-session-id')).toBe(exact.session_id)
      expect(replayedCancellation.headers.get('x-run-execution-id')).toBe(exact.execution_id)
      await expect(replayedCancellation.json()).resolves.toMatchObject({ status: 'replayed', effect: 'not_live' })
    } finally {
      if (restartedRuns) restartedRuns.clear()
      if (restartedStore) restartedStore.close()
      rmSync(first.dir, { recursive: true, force: true })
    }
  })

  it('recovers a completed generic run across an actual server process restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-actual-restart-'))
    const runId = 'actual-process-restart-run'
    const exact = {
      provider: 'process-provider',
      environment_id: 'process-environment',
      session_id: 'process-session',
      execution_id: 'process-execution',
    }
    const body = { ...chatBody(runId, 'survive the process', 'durable/test'), ...exact, stream: false }
    let first: ChildServer | null = null
    let second: ChildServer | null = null
    try {
      first = await startChildServer(dir)
      const initial = await fetchChildChat(first.port, body)
      expect(initial.status).toBe(200)
      const requestDigest = initial.headers.get('x-run-request-digest')
      expect(requestDigest).toMatch(/^sha256:/u)
      await initial.text()
      await first.stop()
      first = null

      second = await startChildServer(dir)
      const replayed = await fetchChildChat(second.port, body)
      expect(replayed.status).toBe(200)
      expect(replayed.headers.get('x-run-request-digest')).toBe(requestDigest)
      expect(await replayed.text()).toContain('one')
      expect(await fetchChildStatus(second.port, runId)).toMatchObject({ status: 'done', terminal: true })

      const cancellation = cancellationRequest(
        'actual-process-restart-cancellation',
        {
          runId,
          requestDigest: requestDigest as `sha256:${string}`,
          provider: exact.provider,
          environmentId: exact.environment_id,
          sessionId: exact.session_id,
          executionId: exact.execution_id,
        },
        'reconcile after actual restart',
      )
      const cancelled = await fetchChildCancellation(second.port, runId, cancellation)
      expect(cancelled.status).toBe(200)
      expect(cancelled.headers.get('x-run-id')).toBe(runId)
      expect(cancelled.headers.get('x-run-request-digest')).toBe(requestDigest)
      expect(cancelled.headers.get('x-run-provider')).toBe(exact.provider)
      expect(cancelled.headers.get('x-run-environment-id')).toBe(exact.environment_id)
      expect(cancelled.headers.get('x-run-session-id')).toBe(exact.session_id)
      expect(cancelled.headers.get('x-run-execution-id')).toBe(exact.execution_id)
      await expect(cancelled.json()).resolves.toMatchObject({ status: 'accepted', effect: 'not_live' })

      const replayedCancellation = await fetchChildCancellation(second.port, runId, cancellation)
      expect(replayedCancellation.status).toBe(200)
      expect(replayedCancellation.headers.get('x-run-id')).toBe(runId)
      expect(replayedCancellation.headers.get('x-run-request-digest')).toBe(requestDigest)
      expect(replayedCancellation.headers.get('x-run-provider')).toBe(exact.provider)
      expect(replayedCancellation.headers.get('x-run-environment-id')).toBe(exact.environment_id)
      expect(replayedCancellation.headers.get('x-run-session-id')).toBe(exact.session_id)
      expect(replayedCancellation.headers.get('x-run-execution-id')).toBe(exact.execution_id)
      await expect(replayedCancellation.json()).resolves.toMatchObject({ status: 'replayed', effect: 'not_live' })
    } finally {
      if (second) await second.stop()
      if (first) await first.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('preserves a 227-character provider-owned environment id through admission and status headers', async () => {
    const backend = new ReplayBackend(0, 'opencode')
    const ctx = fixture(backend)
    const runId = 'long-environment-run'
    const environmentId = `cb1.${'e'.repeat(223)}`
    expect(environmentId).toHaveLength(227)
    try {
      const dispatch = await postChat(ctx.app, {
        ...chatBody(runId, 'long environment id', 'opencode/test'),
        provider: 'cli-bridge',
        environment_id: environmentId,
        session_id: 'long-environment-session',
        execution_id: 'long-environment-execution',
      })
      expect(dispatch.status).toBe(200)
      await dispatch.text()
      expect(dispatch.headers.get('x-run-environment-id')).toBe(environmentId)

      const status = await ctx.app.request(`/v1/runs/${runId}`)
      expect(status.status).toBe(200)
      expect(status.headers.get('x-run-environment-id')).toBe(environmentId)
      await expect(status.json()).resolves.toMatchObject({ environmentId })
    } finally {
      ctx.cleanup()
    }
  })

  it('preserves the Agent Interface 512-character run id and rejects every unsafe control byte', async () => {
    const backend = new ReplayBackend(0)
    const ctx = fixture(backend)
    const longRunId = `r${'x'.repeat(511)}`
    try {
      const dispatch = await postChat(ctx.app, { ...chatBody(longRunId), stream: false })
      expect(dispatch.status).toBe(200)
      expect(dispatch.headers.get('x-run-id')).toBe(longRunId)
      await dispatch.text()

      const status = await ctx.app.request(`/v1/runs/${encodeURIComponent(longRunId)}`)
      expect(status.status).toBe(200)
      expect(status.headers.get('x-run-id')).toBe(longRunId)

      for (const [field, value] of [
        ['run_id', `unsafe\u0001run`],
        ['session_id', `unsafe\u001frun`],
        ['provider', `unsafe\u007frun`],
        ['environment_id', `unsafe\u0085run`],
        ['execution_id', `unsafe\u0000run`],
      ] as const) {
        const response = await postChat(ctx.app, {
          ...chatBody(`unsafe-${field}`),
          ...(field !== 'run_id' ? {
            provider: 'safe-provider',
            environment_id: 'safe-environment',
            session_id: 'safe-session',
            execution_id: 'safe-execution',
          } : {}),
          [field]: value,
        })
        expect(response.status, field).toBe(400)
        expect(ctx.runs.get(`unsafe-${field}`)).toBeUndefined()
        expect(ctx.sessions.getRetainedRun(`unsafe-${field}`)).toBeNull()
      }
      expect(backend.calls).toBe(1)
    } finally {
      ctx.cleanup()
    }
  })

  it('rejects partial or unbound exact coordinates before durable admission', async () => {
    const backend = new ReplayBackend()
    const ctx = fixture(backend)
    try {
      const partial = await postChat(ctx.app, { ...chatBody('partial-coordinate'), provider: 'caller-provider' })
      expect(partial.status).toBe(400)
      expect(ctx.runs.size()).toBe(0)

      const noRunId = await postChat(ctx.app, {
        model: 'durable/test',
        messages: [{ role: 'user', content: 'missing run id' }],
        stream: true,
        session_id: 'caller-session',
        provider: 'caller-provider',
        environment_id: 'caller-environment',
        execution_id: 'caller-execution',
      })
      expect(noRunId.status).toBe(400)
      expect(ctx.runs.size()).toBe(0)

      const conflictingSession = await postChat(
        ctx.app,
        {
          ...chatBody('conflicting-session'),
          session_id: 'body-session',
          provider: 'caller-provider',
          environment_id: 'caller-environment',
          execution_id: 'caller-execution',
        },
        { 'X-Session-Id': 'header-session' },
      )
      expect(conflictingSession.status).toBe(400)
      expect(ctx.runs.size()).toBe(0)
    } finally {
      ctx.cleanup()
    }
  })

  it('rejects one-shot interaction controls before durable admission', async () => {
    const backend = new ReplayBackend()
    const ctx = fixture(backend)
    try {
      for (const [index, control] of [
        { interactions: { permission: true } },
        { interaction_policy: 'interactive' },
        { interactions: { question: false } },
      ].entries()) {
        const runId = `one-shot-interaction-${index}`
        const response = await postChat(ctx.app, { ...chatBody(runId), ...control })
        expect(response.status).toBe(501)
        await expect(response.json()).resolves.toMatchObject({
          error: {
            type: 'capability_denied',
            provider_dispatch: 'not_started',
          },
        })
        expect(ctx.runs.get(runId)).toBeUndefined()
      }
      expect(ctx.runs.size()).toBe(0)
      expect(backend.calls).toBe(0)
    } finally {
      ctx.cleanup()
    }
  })

  it('rejects a canonical commit envelope whose identity differs from the generated event', () => {
    const runs = new RunRegistry({ maxLifetimeMs: 0 })
    const run = runs.claim('canonical-envelope-identity', `sha256:${'a'.repeat(64)}`, {
      owner: 'retained',
      commitCanonicalEvent: () => ({
        runId: 'foreign-run',
        eventId: 'foreign-event',
        sequence: 99,
        cursor: 'foreign-cursor',
        receivedAt: new Date(0).toISOString(),
        event: { type: 'status', status: 'started' },
      }),
    }).run
    try {
      expect(() => run.appendCanonical({ event: { type: 'status', status: 'started' } }))
        .toThrow('canonical commit returned an envelope with identity')
      expect(run.snapshot().canonicalLastSeq).toBe(0)
    } finally {
      runs.clear()
    }
  })

  it('attaches identical racing retries to one backend job and one admission lease', async () => {
    const backend = new ControlledBackend()
    const admission = new AdmissionGate({
      maxActive: 1,
      maxQueue: 1,
      queueTimeoutMs: 1_000,
      reservedActive: 0,
      bulkQueueTimeoutMs: 1_000,
    })
    const ctx = fixture(backend, {}, admission)
    const body = chatBody('same-run')
    try {
      const [first, retry] = await Promise.all([
        postChat(ctx.app, body),
        postChat(ctx.app, body),
      ])
      const firstText = first.text()
      const retryText = retry.text()
      await waitFor(() => backend.calls === 1)

      expect(first.status).toBe(200)
      expect(retry.status).toBe(200)
      expect(backend.calls).toBe(1)
      expect(admission.snapshot()).toMatchObject({ active: 1, queued: 0 })

      backend.finish()
      await expect(Promise.all([firstText, retryText])).resolves.toHaveLength(2)
      await waitFor(() => admission.snapshot().active === 0)
      expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0 })
    } finally {
      backend.finish()
      ctx.cleanup()
    }
  })

  it('serializes distinct creators across the complete session state transition', async () => {
    const backend = new SerializedSessionBackend()
    const ctx = fixture(backend)
    const sessionId = 'shared-session'
    ctx.sessions.upsert({
      externalId: sessionId,
      backend: backend.name,
      internalId: 'base',
    })

    try {
      const first = await postChat(ctx.app, {
        ...chatBody('serialized-first'),
        session_id: sessionId,
      })
      const firstText = first.text()
      await waitFor(() => backend.calls === 1)

      const secondResponse = postChat(ctx.app, {
        ...chatBody('serialized-second'),
        session_id: sessionId,
      })
      await waitFor(() => ctx.runs.get('serialized-second') !== undefined)
      await delay(25)

      expect(backend.calls).toBe(1)
      expect(backend.active).toBe(1)
      expect(backend.maxActive).toBe(1)
      expect(backend.observedInternalIds).toEqual(['base'])

      expect(backend.release(1)).toBe(true)
      await firstText
      const second = await secondResponse
      const secondText = second.text()
      await waitFor(() => backend.calls === 2)

      expect(backend.maxActive).toBe(1)
      expect(backend.observedInternalIds).toEqual(['base', 'internal-1'])

      expect(backend.release(2)).toBe(true)
      await secondText
      expect(ctx.sessions.get(sessionId, backend.name)).toMatchObject({
        internalId: 'internal-2',
        turns: 3,
      })
    } finally {
      backend.release(1)
      backend.release(2)
      ctx.cleanup()
    }
  })

  it('attaches an identical retry before the session queue and removes a cancelled waiter', async () => {
    const backend = new SerializedSessionBackend()
    const ctx = fixture(backend)
    const sessionId = 'cancelled-waiter-session'
    ctx.sessions.upsert({
      externalId: sessionId,
      backend: backend.name,
      internalId: 'base',
    })

    try {
      const holder = await postChat(ctx.app, {
        ...chatBody('session-holder'),
        session_id: sessionId,
      })
      const holderText = holder.text()
      await waitFor(() => backend.calls === 1)

      const queuedBody = {
        ...chatBody('session-queued'),
        session_id: sessionId,
      }
      const queuedCreator = postChat(ctx.app, queuedBody)
      await waitFor(() => ctx.runs.get('session-queued') !== undefined)

      // If retries entered session serialization before RunRegistry attachment,
      // this response would remain blocked behind the holder as another creator.
      const retry = await Promise.race([
        postChat(ctx.app, queuedBody),
        delay(500).then(() => {
          throw new Error('identical retry waited on session serialization')
        }),
      ])
      const retryText = retry.text()
      await delay(25)
      expect(backend.calls).toBe(1)

      const cancelled = await ctx.app.request(
        '/v1/runs/session-queued/cancel?wait_ms=2000',
        { method: 'POST' },
      )
      expect(cancelled.status).toBe(200)
      await expect(cancelled.json()).resolves.toMatchObject({
        cancelled: true,
        terminal: true,
        run: { status: 'cancelled' },
      })

      const creatorResponse = await queuedCreator
      expect(creatorResponse.status).toBe(504)
      await retryText
      expect(backend.calls).toBe(1)

      expect(backend.release(1)).toBe(true)
      await holderText

      const successor = await postChat(ctx.app, {
        ...chatBody('session-successor'),
        session_id: sessionId,
      })
      const successorText = successor.text()
      await waitFor(() => backend.calls === 2)
      expect(backend.observedInternalIds).toEqual(['base', 'internal-1'])
      expect(backend.maxActive).toBe(1)

      expect(backend.release(2)).toBe(true)
      await successorText
      expect(ctx.sessions.get(sessionId, backend.name)).toMatchObject({
        internalId: 'internal-2',
        turns: 3,
      })
    } finally {
      backend.release(1)
      backend.release(2)
      ctx.cleanup()
    }
  })

  it('releases session ownership when setup fails before dispatch', async () => {
    const backend = new SerializedSessionBackend()
    const ctx = fixture(backend)
    const sessionId = 'setup-failure-session'

    try {
      const failed = await postChat(ctx.app, {
        ...chatBody('session-setup-failure'),
        session_id: sessionId,
        execution: { kind: 'sandbox' },
      })
      expect(failed.status).toBe(503)
      expect(backend.calls).toBe(0)

      const successor = await postChat(ctx.app, {
        ...chatBody('session-after-setup-failure'),
        session_id: sessionId,
        execution: { kind: 'host' },
      })
      const successorText = successor.text()
      await waitFor(() => backend.calls === 1)

      expect(backend.release(1)).toBe(true)
      await successorText
      expect(ctx.sessions.get(sessionId, backend.name)).toMatchObject({
        internalId: 'internal-1',
        turns: 1,
      })
    } finally {
      backend.release(1)
      ctx.cleanup()
    }
  })

  it('rejects a different request under the same run id with both digests', async () => {
    const backend = new ReplayBackend()
    const ctx = fixture(backend)
    try {
      const first = await postChat(ctx.app, chatBody('identity-conflict', 'first'))
      expect(first.status).toBe(200)
      await first.text()

      const conflict = await postChat(ctx.app, chatBody('identity-conflict', 'different'))
      expect(conflict.status).toBe(409)
      const body = await conflict.json() as {
        error: { type: string; expected_request_digest: string; received_request_digest: string }
      }
      expect(body.error.type).toBe('run_identity_conflict')
      expect(body.error.expected_request_digest).toMatch(/^sha256:[a-f0-9]{64}$/u)
      expect(body.error.received_request_digest).toMatch(/^sha256:[a-f0-9]{64}$/u)
      expect(body.error.expected_request_digest).not.toBe(body.error.received_request_digest)
      expect(backend.calls).toBe(1)
    } finally {
      ctx.cleanup()
    }
  })

  it('replays exactly after Last-Event-ID without duplicate dispatch, loss, or duplicate events', async () => {
    const backend = new ReplayBackend()
    const ctx = fixture(backend)
    const body = chatBody('exact-replay')
    try {
      const initial = await postChat(ctx.app, body)
      const initialText = await initial.text()
      const initialIds = sseIds(initialText)
      expect(initialIds).toEqual([1, 2, 3])

      const replay = await postChat(ctx.app, body, { 'Last-Event-ID': '1' })
      const replayText = await replay.text()
      const replayIds = sseIds(replayText)

      expect(replay.status).toBe(200)
      expect(replayIds).toEqual([2, 3])
      expect([initialIds[0], ...replayIds]).toEqual(initialIds)
      expect(new Set(replayIds).size).toBe(replayIds.length)
      expect(replayText).toContain('two')
      expect(replayText).not.toContain('"content":"one"')
      expect(backend.calls).toBe(1)
    } finally {
      ctx.cleanup()
    }
  })

  it('reconnects from run coordinates alone without replaying the dispatch request', async () => {
    const backend = new ReplayBackend(10)
    const ctx = fixture(backend)
    const runId = 'coordinate-reconnect'
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const initial = await postChat(ctx.app, chatBody(runId))
      reader = initial.body?.getReader()
      expect(reader).toBeDefined()
      await reader?.read()
      await reader?.cancel()
      await waitFor(() => ctx.runs.get(runId)?.snapshot().state === 'detached')

      const reconnect = await ctx.app.request(`/v1/runs/${runId}/events`, {
        headers: { 'Last-Event-ID': '0' },
      })
      const text = await reconnect.text()

      expect(reconnect.status).toBe(200)
      expect(sseIds(text)).toEqual([1, 2, 3])
      expect(text).toContain('one')
      expect(text).toContain('two')
      expect(backend.calls).toBe(1)
    } finally {
      await reader?.cancel()
      ctx.cleanup()
    }
  })

  it('replays and retains the exact profile acknowledgment for the run identity lifetime', async () => {
    const backend = new ProfileReceiptReplayBackend()
    const ctx = fixture(backend, {
      replayRetentionMs: 20,
      identityRetentionMs: 2_000,
    })
    const body = {
      ...chatBody('profile-receipt-replay'),
      model: 'durable/tangle-router/deepseek-v4-flash',
    }
    try {
      const initial = await postChat(ctx.app, body)
      const initialText = await initial.text()
      expect(initialText).toContain('cli-bridge.profile-materialization.v2')
      expect(initialText).toContain('"requested":"ultracode","applied":"xhigh"')

      const replay = await postChat(ctx.app, body, { 'Last-Event-ID': '1' })
      const replayText = await replay.text()
      expect(replayText).toContain('cli-bridge.profile-materialization.v2')
      expect(backend.calls).toBe(1)

      await waitFor(() => ctx.runs.get('profile-receipt-replay')?.snapshot().replay.expired === true)
      const state = await ctx.app.request('/v1/runs/profile-receipt-replay')
      await expect(state.json()).resolves.toMatchObject({
        requestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        profileMaterialization: {
          schema: 'cli-bridge.profile-materialization.v2',
          effectiveProfileDigest: `sha256:${'1'.repeat(64)}`,
          provider: 'tangle-router',
          model: 'durable/tangle-router/deepseek-v4-flash',
          reasoningEffort: { requested: 'ultracode', applied: 'xhigh' },
        },
      })
    } finally {
      ctx.cleanup()
    }
  })

  it('replays a profile receipt before a thrown terminal backend error', async () => {
    const backend = new ProfileReceiptFailureBackend()
    const ctx = fixture(backend)
    const runId = 'profile-receipt-terminal-error'
    const body = {
      ...chatBody(runId),
      model: 'durable/tangle-router/deepseek-v4-flash',
    }
    try {
      const response = await postChat(ctx.app, body)
      const text = await response.text()
      const receiptAt = text.indexOf('"profile_materialization"')
      const errorAt = text.indexOf('backend exited after accepted submission')

      expect(response.status).toBe(200)
      expect(receiptAt).toBeGreaterThan(-1)
      expect(errorAt).toBeGreaterThan(receiptAt)
      expect(text).toContain('data: [DONE]')
      expect(ctx.runs.get(runId)?.snapshot()).toMatchObject({
        status: 'error',
        terminal: true,
        profileMaterialization: {
          schema: 'cli-bridge.profile-materialization.v2',
          provider: 'tangle-router',
          model: 'durable/tangle-router/deepseek-v4-flash',
        },
      })
      expect(ctx.runs.get(runId)?.failure()).toMatchObject({
        message: 'backend exited after accepted submission',
      })
    } finally {
      ctx.cleanup()
    }
  })

  it('keeps replay ids contiguous across metadata-only deltas', async () => {
    const backend = new MetadataReplayBackend()
    const ctx = fixture(backend)
    const body = { ...chatBody('metadata-replay'), session_id: 'external-session' }
    try {
      const initial = await postChat(ctx.app, body)
      const initialText = await initial.text()
      expect(sseIds(initialText)).toEqual([1, 2, 3])
      expect(initialText).toContain('id: 1\n: bridge-metadata')

      const replay = await postChat(ctx.app, body, { 'Last-Event-ID': '1' })
      const replayText = await replay.text()
      expect(sseIds(replayText)).toEqual([2, 3])
      expect(replayText).toContain('visible')
      expect(backend.calls).toBe(1)
    } finally {
      ctx.cleanup()
    }
  })

  it('refuses ahead, rotated-out, and time-expired replay cursors', async () => {
    const backend = new ReplayBackend(2)
    const ctx = fixture(backend, {
      maxReplayDeltas: 2,
      replayRetentionMs: 20,
      identityRetentionMs: 2_000,
    })
    const body = chatBody('bounded-replay')
    try {
      const initial = await postChat(ctx.app, body)
      expect(initial.status).toBe(200)
      const initialText = await initial.text()
      expect(sseIds(initialText)).toEqual([1, 2, 3])

      const ahead = await postChat(ctx.app, body, { 'Last-Event-ID': '4' })
      expect(ahead.status).toBe(409)
      await expect(ahead.json()).resolves.toMatchObject({
        error: { type: 'invalid_replay_cursor', last_event_id: 3 },
      })

      const rotated = await postChat(ctx.app, body, { 'Last-Event-ID': '0' })
      expect(rotated.status).toBe(410)
      await expect(rotated.json()).resolves.toMatchObject({
        error: { type: 'expired_replay_cursor', first_available_event_id: 2 },
      })

      await waitFor(() => ctx.runs.get('bounded-replay')?.snapshot().replay.expired === true)
      const expired = await postChat(ctx.app, body, { 'Last-Event-ID': '3' })
      expect(expired.status).toBe(410)
      expect(backend.calls).toBe(1)
    } finally {
      ctx.cleanup()
    }
  })

  it('returns 202 while cancellation is pending and 200 only with terminal proof', async () => {
    const backend = new ControlledCancelBackend()
    const ctx = fixture(backend)
    const runId = 'cancel-proof'
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await postChat(ctx.app, chatBody(runId))
      reader = response.body?.getReader()
      expect(reader).toBeDefined()
      await reader?.read()
      await waitFor(() => ctx.runs.get(runId)?.snapshot().attachedReaders === 1)

      const pending = await ctx.app.request(`/v1/runs/${runId}/cancel`, { method: 'POST' })
      expect(pending.status).toBe(202)
      await expect(pending.json()).resolves.toMatchObject({
        cancelled: false,
        cancel_requested: true,
        terminal: false,
        run: { state: 'cancelling', status: 'running' },
      })
      expect(backend.abortObserved).toBe(true)

      backend.finishCancellation()
      const terminal = await ctx.app.request(`/v1/runs/${runId}/cancel?wait_ms=2000`, {
        method: 'POST',
      })
      expect(terminal.status).toBe(200)
      await expect(terminal.json()).resolves.toMatchObject({
        cancelled: true,
        cancel_requested: false,
        terminal: true,
        run: { state: 'terminal', status: 'cancelled' },
      })
    } finally {
      backend.finishCancellation()
      await reader?.cancel()
      ctx.cleanup()
    }
  })

  it('binds exact cancellation to one operation and replays its acknowledgement', async () => {
    const backend = new ControlledCancelBackend()
    const ctx = fixture(backend)
    const runId = 'exact-cancel'
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await postChat(ctx.app, chatBody(runId))
      reader = response.body?.getReader()
      await reader?.read()
      const snapshotResponse = await ctx.app.request(`/v1/runs/${runId}`)
      const snapshot = await snapshotResponse.json() as {
        requestDigest: `sha256:${string}`
        provider: string
        environmentId: string
        sessionId: string
        executionId: string
      }
      const run: AgentExactRunControlRef = {
        runId,
        provider: snapshot.provider,
        environmentId: snapshot.environmentId,
        sessionId: snapshot.sessionId,
        executionId: snapshot.executionId,
        requestDigest: snapshot.requestDigest,
      }
      const request = cancellationRequest('cancel-exact-operation', run, 'user requested stop')

      const unsafeCancellation = cancellationRequest(
        'cancel-unsafe-operation',
        { ...run, provider: 'unsafe\nprovider' },
        'must be rejected before headers',
      )
      const unsafe = await ctx.app.request(`/v1/runs/${runId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(unsafeCancellation),
      })
      expect(unsafe.status).toBe(400)
      expect(ctx.sessions.getRetainedControlOperation(unsafeCancellation.operationId)).toBeNull()

      const wrongCoordinates = cancellationRequest(
        'cancel-wrong-coordinates',
        { ...run, provider: 'foreign-provider' },
        'user requested stop',
      )
      const rejectedCoordinates = await ctx.app.request(`/v1/runs/${runId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(wrongCoordinates),
      })
      expect(rejectedCoordinates.status).toBe(409)
      await expect(rejectedCoordinates.json()).resolves.toMatchObject({
        error: { type: 'run_identity_conflict' },
      })
      expect(backend.abortObserved).toBe(false)

      const accepted = await ctx.app.request(`/v1/runs/${runId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      expect(accepted.status).toBe(202)
      await expect(accepted.json()).resolves.toMatchObject({
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        status: 'accepted',
        effect: 'cancel_requested',
        run,
      })

      const replayed = await ctx.app.request(`/v1/runs/${runId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      expect(replayed.status).toBe(202)
      await expect(replayed.json()).resolves.toMatchObject({
        status: 'replayed',
        effect: 'cancel_requested',
      })

      const wrongPath = await ctx.app.request('/v1/runs/another-run/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      expect(wrongPath.status).toBe(409)
      await expect(wrongPath.json()).resolves.toMatchObject({
        error: { message: 'cancellation run id does not match the request path' },
      })

      const changed = cancellationRequest(request.operationId, run, 'changed reason')
      const conflict = await ctx.app.request(`/v1/runs/${runId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changed),
      })
      expect(conflict.status).toBe(409)
      await expect(conflict.json()).resolves.toMatchObject({
        status: 'conflict',
        effect: 'unknown',
        existingRequestDigest: request.requestDigest,
      })
    } finally {
      backend.finishCancellation()
      await reader?.cancel()
      ctx.cleanup()
    }
  })

  it('detaches a cancelled socket reader without killing the child; explicit cancel kills it', async () => {
    const backend = new ChildProcessBackend()
    const ctx = fixture(backend)
    const runId = 'socket-detach'
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await postChat(ctx.app, chatBody(runId))
      reader = response.body?.getReader()
      expect(reader).toBeDefined()
      await reader?.read()
      await waitFor(() => backend.child !== null && ctx.runs.get(runId)?.snapshot().attachedReaders === 1)

      await reader?.cancel()
      await waitFor(() => ctx.runs.get(runId)?.snapshot().state === 'detached')

      expect(backend.abortObserved).toBe(false)
      expect(backend.isAlive()).toBe(true)
      const detached = await ctx.app.request(`/v1/runs/${runId}`)
      expect(detached.status).toBe(200)
      await expect(detached.json()).resolves.toMatchObject({
        state: 'detached',
        status: 'running',
        terminal: false,
        attachedReaders: 0,
      })

      const cancelled = await ctx.app.request(`/v1/runs/${runId}/cancel?wait_ms=2000`, {
        method: 'POST',
      })
      expect(cancelled.status).toBe(200)
      await expect(cancelled.json()).resolves.toMatchObject({
        cancelled: true,
        terminal: true,
        run: { state: 'terminal', status: 'cancelled' },
      })
      expect(backend.abortObserved).toBe(true)
      expect(backend.exited).toBe(true)
      expect(backend.isAlive()).toBe(false)
    } finally {
      await reader?.cancel()
      ctx.cleanup()
      await backend.forceCleanup()
    }
  })

  it('fails closed for unknown cancel and conflicting id/cursor aliases', async () => {
    const backend = new ReplayBackend()
    const ctx = fixture(backend)
    try {
      const unknown = await ctx.app.request('/v1/runs/unknown/cancel', { method: 'POST' })
      expect(unknown.status).toBe(404)

      const ids = await postChat(ctx.app, chatBody('body-id'), { 'X-Run-Id': 'header-id' })
      expect(ids.status).toBe(400)

      const cursor = await postChat(ctx.app, chatBody('bad-cursor'), {
        'Last-Event-ID': '1',
        'X-Last-Event-Id': '2',
      })
      expect(cursor.status).toBe(400)

      const nonStreamingZero = await postChat(
        ctx.app,
        { ...chatBody('nonstream-cursor'), stream: false },
        { 'Last-Event-ID': '0' },
      )
      expect(nonStreamingZero.status).toBe(400)
      expect(backend.calls).toBe(0)
    } finally {
      ctx.cleanup()
    }
  })

  it('bounds legacy cancellation bodies at the retained request limit', async () => {
    const ctx = fixture(new ReplayBackend())
    try {
      const body = JSON.stringify({ padding: 'x'.repeat(RETAINED_MAX_HTTP_BODY_BYTES) })
      const response = await ctx.app.request('/v1/runs/unknown/cancel', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
      })
      expect(response.status).toBe(413)
      await expect(response.json()).resolves.toMatchObject({ error: { type: 'request_too_large' } })
    } finally {
      ctx.cleanup()
    }
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(5)
  }
  throw new Error('waitFor timed out')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function cancellationRequest(
  operationId: string,
  run: AgentExactRunControlRef,
  reason: string,
): AgentRunCancellationRequest {
  const material = { operationId, run, reason }
  return { ...material, requestDigest: agentRunCancellationRequestDigest(material) }
}

interface ChildServer {
  port: number
  stop: () => Promise<void>
}

async function startChildServer(dataDir: string): Promise<ChildServer> {
  const entry = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'durable-run-server.ts')
  const child = spawn(
    process.execPath,
    ['--import', 'tsx/esm', entry],
    {
      cwd: join(dirname(entry), '..', '..'),
      env: {
        ...process.env,
        CLI_BRIDGE_TEST_DATA_DIR: dataDir,
        CLI_BRIDGE_TEST_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  const ready = new Promise<number>((resolve, reject) => {
    const onOutput = (chunk: Buffer): void => {
      output += chunk.toString()
      const match = output.match(/READY:(\d+)/u)
      if (match?.[1]) resolve(Number(match[1]))
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      reject(new Error(`durable test server exited before READY (${code ?? signal}): ${output}`))
    })
  })
  const port = await ready
  return {
    port,
    stop: () => stopChildServer(child),
  }
}

async function stopChildServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('timed out stopping durable test server'))
    }, 5_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function fetchChildChat(port: number, body: object): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}${CHAT_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function fetchChildStatus(port: number, runId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/runs/${encodeURIComponent(runId)}`)
  return await response.json() as Record<string, unknown>
}

async function fetchChildCancellation(
  port: number,
  runId: string,
  request: AgentRunCancellationRequest,
): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}/v1/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
}
