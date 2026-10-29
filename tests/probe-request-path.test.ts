import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { versionHealth } from '../src/backends/health.js'
import { OpencodeBackend } from '../src/backends/opencode.js'
import { BackendRegistry } from '../src/backends/registry.js'
import type { Backend, BackendHealth, ChatDelta, ChatRequest } from '../src/backends/types.js'
import { ExecutorConfigurationError, type SpawnOpts, type Spawner } from '../src/executors/types.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { mountHealth } from '../src/routes/health.js'
import { mountRuns } from '../src/routes/runs.js'
import { RunRegistry } from '../src/runs/registry.js'
import { SessionStore, type SessionRecord } from '../src/sessions/store.js'

/**
 * A health check that does not exercise the request path is not a health check.
 *
 * The three findings this file encodes are all the same shape: the preflight is a
 * LIST, and what is on the list is one slot, one mount kind, one caller shape.
 * The list cannot be completed by adding items to it, because the probe takes a
 * path no request can take:
 *
 *   `versionHealth` spawns `<bin> --version` with NO cwd, so
 *   `assertDockerWorkspaceCwd` returns early and the workspace assertion every
 *   real request hits is skipped; the executor's own `resolveCwd` policy is never
 *   called at all; and `--version` is credential-independent, so a pool holding
 *   no credentials answers `ready`.
 *
 * Measured on this host against af03d59 (main), before this file passed:
 *
 *   :3414, per-slot volumes containing no auth.json
 *     GET  /health                          -> 200 {"status":"ok",
 *                                              "state":"ready","version":"1.18.9"}
 *     POST /v1/chat/completions             -> 502 {"message":"opencode: opencode error"}
 *     startup log: WARNING ... auth.json does not exist ... (stdout only)
 *     startup log: "preflight ok on 2 slot(s) — image, credential mounts, ...
 *                   all verified in-slot"   (two lines after the warning)
 *
 *   :3402, a run cancelled 3 s in (opencode.ts yields a bare terminal error
 *   delta on abort rather than throwing, so the registry's throw-path fix never
 *   sees it)
 *     POST /v1/chat/completions             -> 200
 *       {"choices":[{"message":{"content":""},"finish_reason":"error"}]}
 *       — no `error` key anywhere in the body
 *     stream: true                          -> one frame,
 *       {"choices":[{"delta":{},"finish_reason":"error"}]}, then [DONE]
 *       — no `data: {"error":…}` frame at all
 *
 * A benchmark harness scores that second one 0.000 and cannot tell it from "the
 * model answered nothing".
 */


// ─── helpers ─────────────────────────────────────────────────────────────

function childExiting(code: number, stdoutText: string, stderrText = ''): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  const stderr = new PassThrough()
  ;(child as unknown as { stdout: Readable }).stdout = Readable.from(stdoutText ? [stdoutText] : [])
  ;(child as unknown as { stderr: PassThrough }).stderr = stderr
  ;(child as unknown as { stdin: PassThrough }).stdin = new PassThrough()
  ;(child as unknown as { pid: number }).pid = 5150
  ;(child as unknown as { kill: () => boolean }).kill = () => true
  setImmediate(() => {
    if (stderrText) stderr.write(stderrText)
    stderr.end()
    child.emit('close', code)
  })
  return child
}

/**
 * A child whose `exitCode` starts null. `readProcessLines` treats a non-null
 * exitCode as "already closed" and stops before reading a line, so a fake with
 * `exitCode: undefined` silently delivers no events.
 */
class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  exitCode: number | null = null
  kill(): boolean { return true }
}

/** A spawner that records every SpawnOpts it was handed. */
function recordingSpawner(over: Partial<Spawner> = {}): Spawner & { calls: SpawnOpts[] } {
  const calls: SpawnOpts[] = []
  const spawner = (async (_bin: string, _args: string[], opts: SpawnOpts) => {
    calls.push(opts)
    return { child: childExiting(0, '1.18.9\n'), release: () => {} }
  }) as Spawner & { calls: SpawnOpts[] }
  spawner.calls = calls
  Object.assign(spawner, over)
  return spawner
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
/** A real host directory, so the workspace marker round-trip has somewhere to go. */
function tempDir(prefix = 'cli-bridge-probe-ws-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

interface HealthFixture {
  app: Hono
  cleanup: () => void
}

function healthApp(backend: Backend): HealthFixture {
  const registry = new BackendRegistry().register(backend)
  const app = new Hono()
  mountHealth(app, { registry }, { cacheMs: 0 })
  return { app, cleanup: () => {} }
}

abstract class YieldBackend implements Backend {
  readonly name = 'durable'
  matches(model: string): boolean { return model === this.name || model.startsWith(`${this.name}/`) }
  async health(): Promise<BackendHealth> { return { name: this.name, state: 'ready' } }
  abstract chat(
    req: ChatRequest,
    session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta>
}

/**
 * The opencode shape: a terminal failure that is YIELDED, not thrown. The
 * registry's catch block never runs, so nothing records the failure and nothing
 * attaches a reason.
 */
class YieldsBareErrorBackend extends YieldBackend {
  constructor(private readonly before: ChatDelta[] = [], private readonly reason: ChatDelta['finish_reason'] = 'error') {
    super()
  }
  async *chat(): AsyncIterable<ChatDelta> {
    for (const delta of this.before) yield delta
    yield { finish_reason: this.reason }
  }
}

interface ChatFixture {
  app: Hono
  runs: RunRegistry
  cleanup: () => void
}

function chatApp(backend: Backend): ChatFixture {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-probe-path-'))
  const sessions = new SessionStore(dir)
  const runs = new RunRegistry()
  const registry = new BackendRegistry().register(backend)
  const app = new Hono()
  mountChatCompletions(app, { registry, sessions, runs })
  mountRuns(app, { runs })
  return {
    app,
    runs,
    cleanup: () => {
      runs.clear()
      sessions.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function postChat(app: Hono, body: object, headers: Record<string, string> = {}): Promise<Response> {
  return await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

// ─── the shape: the probe takes the request path ──────────────────────────

describe('a terminal error delta carries its reason, however the backend produced it', () => {
  it('records the run failure for a YIELDED error, not only a thrown one', async () => {
    const runs = new RunRegistry()
    try {
      const { run } = runs.claim('yielded', 'digest')
      await run.pump((async function* () { yield { finish_reason: 'error' as const } })())
      const snapshot = run.snapshot()
      expect(snapshot.status).toBe('error')
      // `failure()` is what the route turns into a real HTTP status. Left
      // undefined, the reader has nothing to report and answers 200.
      expect(run.failure()).toBeDefined()
    } finally {
      runs.clear()
    }
  })

  it('non-streaming: a yielded failure is not a 200 with an empty message', async () => {
    const { app, cleanup } = chatApp(new YieldsBareErrorBackend())
    try {
      const res = await postChat(app, { model: 'durable/test', messages: [{ role: 'user', content: 'hi' }] })
      const body = await res.json() as {
        error?: { message?: string; type?: string }
        choices?: Array<{ message?: { content?: string } }>
      }
      expect(res.status).not.toBe(200)
      expect(body.error?.message ?? '').not.toBe('')
      expect(body.error?.type ?? '').not.toBe('')
    } finally {
      cleanup()
    }
  })

  it('streaming: a yielded failure produces an error frame, not a bare finish marker', async () => {
    const { app, cleanup } = chatApp(new YieldsBareErrorBackend())
    try {
      const res = await postChat(app, {
        model: 'durable/test',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      })
      const text = await res.text()
      const errorFrames = text
        .split('\n')
        .filter((line) => line.startsWith('data: {"error"'))
      expect(errorFrames.length).toBe(1)
      const parsed = JSON.parse(errorFrames[0]!.slice('data: '.length)) as { error: { message: string; type: string } }
      expect(parsed.error.message).not.toBe('')
      expect(parsed.error.type).not.toBe('')
    } finally {
      cleanup()
    }
  })

  it('a reconnecting reader replays the same reason', async () => {
    const { app, cleanup } = chatApp(new YieldsBareErrorBackend([{ content: 'partial' }]))
    try {
      const first = await postChat(app, {
        model: 'durable/test',
        stream: true,
        run_id: 'replay-reason',
        messages: [{ role: 'user', content: 'hi' }],
      })
      await first.text()
      const again = await postChat(app, {
        model: 'durable/test',
        stream: true,
        run_id: 'replay-reason',
        messages: [{ role: 'user', content: 'hi' }],
      }, { 'Last-Event-ID': '1' })
      const text = await again.text()
      expect(text).toContain('data: {"error"')
    } finally {
      cleanup()
    }
  })

  it('keeps partial output and still carries the reason in the body', async () => {
    const { app, cleanup } = chatApp(new YieldsBareErrorBackend([{ content: 'half an answer' }]))
    try {
      const res = await postChat(app, { model: 'durable/test', messages: [{ role: 'user', content: 'hi' }] })
      expect(res.status).toBe(200)
      const body = await res.json() as {
        error?: { message?: string }
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
      }
      expect(body.choices?.[0]?.message?.content).toBe('half an answer')
      expect(body.error?.message ?? '').not.toBe('')
    } finally {
      cleanup()
    }
  })

  it('a yielded timeout is a reason too', async () => {
    const { app, cleanup } = chatApp(new YieldsBareErrorBackend([], 'timeout'))
    try {
      const res = await postChat(app, { model: 'durable/test', messages: [{ role: 'user', content: 'hi' }] })
      const body = await res.json() as { error?: { message?: string; type?: string } }
      expect(res.status).not.toBe(200)
      expect(body.error?.message ?? '').toMatch(/timed out|timeout/i)
    } finally {
      cleanup()
    }
  })
})

describe('a backend that KNOWS the reason attaches it', () => {
  it('opencode carries the error event text on the terminal delta', async () => {
    const events: Array<Record<string, unknown>> = [
      { type: 'session.created', session: { id: 'ses_1' } },
      { type: 'error', message: 'provider rejected the model' },
      { type: 'session.completed' },
    ]
    const spawner = (async () => {
      const child = new FakeChild()
      queueMicrotask(() => {
        for (const line of events) child.stdout.write(`${JSON.stringify(line)}\n`)
        child.stdout.end()
        child.stderr.end()
        setTimeout(() => { child.exitCode = 0; child.emit('close', 0) }, 10)
      })
      return { child: child as never, release: () => {}, spawnError: () => null }
    }) as unknown as Spawner
    const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 5_000, spawner })
    const deltas: ChatDelta[] = []
    for await (const delta of backend.chat(
      { model: 'opencode/test', messages: [{ role: 'user', content: 'hi' }] } as ChatRequest,
      null,
      new AbortController().signal,
    )) {
      deltas.push(delta)
    }
    const terminal = deltas.find((d) => d.finish_reason !== undefined)
    expect(terminal?.finish_reason).toBe('error')
    expect(terminal?.error?.message ?? '').toContain('provider rejected the model')
  })
})

// ─── finding 2: credentials are a readiness verdict, not a log line ───────
