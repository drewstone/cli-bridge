import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { AdmissionGate } from '../src/admission.js'
import { BackendRegistry } from '../src/backends/registry.js'
import type { Backend, BackendHealth, ChatDelta, ChatRequest } from '../src/backends/types.js'
import { BackendError } from '../src/backends/types.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { mountRuns } from '../src/routes/runs.js'
import { RunRegistry, type RunRegistryOptions } from '../src/runs/registry.js'
import { SessionStore, type SessionRecord } from '../src/sessions/store.js'

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
  constructor(private readonly delayMs = 0) { super() }

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
  mountChatCompletions(app, { registry, sessions, runs, ...(admission ? { admission } : {}) })
  mountRuns(app, { runs })
  return {
    app,
    runs,
    sessions,
    cleanup: () => {
      runs.clear()
      sessions.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function chatBody(runId: string, content = 'hello'): Record<string, unknown> {
  return {
    model: 'durable/test',
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
