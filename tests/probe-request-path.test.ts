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
import { assertDockerWorkspaceCwd, createDockerSpawner } from '../src/executors/docker.js'
import type { ContainerPool } from '../src/executors/container-pool.js'
import type { DockerCli, DockerCliResult } from '../src/executors/docker-cli.js'
import {
  buildCommandFor,
  preflightDockerSlot,
  type DockerPreflightTarget,
} from '../src/executors/docker-preflight.js'
import { ExecutorConfigurationError, type SpawnOpts, type Spawner } from '../src/executors/types.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { mountHealth } from '../src/routes/health.js'
import { mountRuns } from '../src/routes/runs.js'
import { RunRegistry } from '../src/runs/registry.js'
import { SessionStore, type SessionRecord } from '../src/sessions/store.js'

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

const ok = (stdout = ''): DockerCliResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string, code = 1): DockerCliResult => ({ code, stdout: '', stderr })

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

function preflightTarget(over: Partial<DockerPreflightTarget> = {}): DockerPreflightTarget {
  return {
    backend: 'opencode',
    envPrefix: 'OPENCODE',
    image: 'cli-bridge-cli-runtime:latest',
    bin: 'opencode',
    containerHome: '/root',
    workspaceRoot: tempDir(),
    mounts: [{
      source: 'cli-bridge-pool-oauth1-0',
      target: '/root/.local/share/opencode',
      kind: 'volume',
      credentialFile: 'auth.json',
    }],
    buildCommand: buildCommandFor('cli-bridge-cli-runtime:latest'),
    ...over,
  }
}

/**
 * A docker CLI in which every probe succeeds EXCEPT the credential file, which
 * is absent. That is this host's real misconfiguration: the mount exists, is
 * readable and writable, holds files — and holds no auth.json.
 */
function cliWithoutCredentials(seen: string[] = []): DockerCli {
  return async (args) => {
    const line = args.join(' ')
    seen.push(line)
    // The one thing that is absent. Everything else about the mount is fine —
    // which is exactly why "the directory is not empty" passed on it.
    if (line.includes('auth.json')) return fail('')
    if (args[0] === 'exec' && args.includes('--version')) return ok('1.18.9\n')
    // The workspace bind is proven by a marker round-trip: the container path
    // equals the host path, so reading the host file IS the mount working.
    if (args.includes('cat')) {
      const path = args[args.length - 1]!
      try { return ok(readFileSync(path, 'utf8')) } catch { return fail('No such file or directory') }
    }
    return ok('ok\n')
  }
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

describe('the readiness probe traverses the request path', () => {
  it('refuses when the executor cwd policy a request would hit refuses', async () => {
    // A real request calls `resolveSpawnerCwd(spawner, undefined)`, which asks the
    // executor. The probe skipped that call entirely by passing no cwd, so the one
    // assertion every request crosses was the one the probe never reached.
    const spawner = recordingSpawner({
      resolveCwd: () => {
        throw new ExecutorConfigurationError(
          'opencode runs on a Docker executor with no workspace mounted; set OPENCODE_DOCKER_WORKSPACE_ROOT',
        )
      },
    })
    const health = await versionHealth('opencode', 'opencode', spawner)
    expect(health.state).not.toBe('ready')
    expect(health.detail ?? '').toMatch(/OPENCODE_DOCKER_WORKSPACE_ROOT/)
  })

  it('spawns the probe in the directory a cwd-less request resolves to', async () => {
    const spawner = recordingSpawner({ resolveCwd: (cwd) => cwd ?? '/workspace/opencode' })
    const health = await versionHealth('opencode', 'opencode', spawner)
    expect(health.state).toBe('ready')
    // The probe must run `--version` where a request would run, not in the
    // image's own WORKDIR: a workspace bind that vanished after startup is
    // otherwise invisible to /health while every request fails with exit 127.
    expect(spawner.calls.map((c) => c.cwd)).toContain('/workspace/opencode')
  })

  it('reports an executor readiness finding instead of ready', async () => {
    const spawner = recordingSpawner({
      probeRequestPath: async () => ({
        cwd: '/workspace/opencode',
        findings: [{
          check: 'auth-mount-credentials',
          detail: '/root/.local/share/opencode/auth.json does not exist, so opencode has NO credentials',
          remedy: 'run `docker exec -it <slot> opencode auth login` inside the pool container',
        }],
      }),
    } as unknown as Partial<Spawner>)
    const health = await versionHealth('opencode', 'opencode', spawner)
    expect(health.state).not.toBe('ready')
    expect(health.detail ?? '').toMatch(/auth\.json does not exist/)
    // The remedy has to travel with the observation, or the caller has a symptom
    // and no action.
    expect(health.detail ?? '').toMatch(/auth login/)
  })

  it('/health answers 503 and names the cause when the request path is not ready', async () => {
    const backend: Backend = {
      name: 'opencode',
      matches: () => true,
      health: async () => await versionHealth('opencode', 'opencode', recordingSpawner({
        probeRequestPath: async () => ({
          cwd: '/workspace/opencode',
          findings: [{
            check: 'auth-mount-credentials',
            detail: '/root/.local/share/opencode/auth.json does not exist, so opencode has NO credentials',
            remedy: 'run `docker exec -it <slot> opencode auth login` inside the pool container',
          }],
        }),
      } as unknown as Partial<Spawner>)),
      chat: async function* () { yield { finish_reason: 'stop' as const } },
    }
    const { app, cleanup } = healthApp(backend)
    try {
      const res = await app.request('/health')
      expect(res.status).toBe(503)
      const body = await res.json() as { status: string; backends: Array<{ state: string; detail?: string }> }
      expect(body.status).toBe('degraded')
      expect(body.backends[0]?.state).not.toBe('ready')
      expect(body.backends[0]?.detail ?? '').toMatch(/auth\.json/)
    } finally {
      cleanup()
    }
  })

  it('the docker executor probes a REAL slot, at that slot own mounts', async () => {
    // Probing slot 0's volumes for every slot is evidence about one slot while
    // traffic goes to all of them, so the probe must name the slot it acquired.
    let acquires = 0
    let releases = 0
    const pool = {
      acquire: async () => {
        acquires += 1
        return { containerId: 'container-slot-1', slotIndex: 1, release: () => { releases += 1 } }
      },
      reportContainerUnusable: async () => {},
      recycleHeldSlot: async () => {},
    } as unknown as ContainerPool
    const seen: string[] = []
    const workspaceRoot = tempDir()
    const spawner = createDockerSpawner({
      pool,
      backend: 'opencode',
      envPrefix: 'OPENCODE',
      workspaceRoot,
      cli: cliWithoutCredentials(seen),
      preflightTarget: (slotIndex: number) => preflightTarget({
        workspaceRoot,
        mounts: [{
          source: `cli-bridge-pool-oauth1-${slotIndex}`,
          target: '/root/.local/share/opencode',
          kind: 'volume',
          credentialFile: 'auth.json',
        }],
      }),
    } as never)

    expect(typeof (spawner as { probeRequestPath?: unknown }).probeRequestPath).toBe('function')
    const readiness = await (spawner as unknown as {
      probeRequestPath: () => Promise<{ cwd?: string; findings: Array<{ detail: string; remedy: string }> }>
    }).probeRequestPath()

    expect(acquires).toBe(1)
    expect(releases).toBe(1)
    // A cwd-less request runs in the workspace root, so the probe must too.
    expect(readiness.cwd).toBe(workspaceRoot)
    expect(readiness.findings.length).toBeGreaterThan(0)
    const detail = readiness.findings.map((f) => `${f.detail} ${f.remedy}`).join(' ')
    expect(detail).toMatch(/auth\.json/)
    expect(detail).toMatch(/cli-bridge-pool-oauth1-1/)
    expect(seen.join(' ')).toContain('container-slot-1')
  })
})

// ─── finding 1: a yielded failure carries a machine-readable reason ───────

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
    const events = [
      '{"type":"session.created","session":{"id":"ses_1"}}',
      '{"type":"error","message":"provider rejected the model"}',
      '{"type":"session.completed"}',
      '',
    ].join('\n')
    const spawner = (async () => ({
      child: childExiting(0, events),
      release: () => {},
    })) as unknown as Spawner
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

describe('the credential predicate is "can this mount authenticate"', () => {
  it('makes a missing credential file a request-path finding, for a VOLUME', async () => {
    const findings = await preflightDockerSlot(
      preflightTarget(),
      'container-slot-0',
      cliWithoutCredentials(),
      [],
      { scope: 'request-path' } as never,
    )
    const text = findings.map((f) => `${f.check} ${f.detail} ${f.remedy}`).join('\n')
    expect(findings.length).toBeGreaterThan(0)
    expect(text).toMatch(/auth\.json/)
    expect(text).toMatch(/auth login/)
  })

  it('makes a missing credential file a request-path finding, for a BIND too', async () => {
    const findings = await preflightDockerSlot(
      preflightTarget({
        mounts: [{
          source: '/home/drew/.local/share/opencode',
          target: '/root/.local/share/opencode',
          kind: 'bind',
          credentialFile: 'auth.json',
        }],
      }),
      'container-slot-0',
      cliWithoutCredentials(),
      [],
      { scope: 'request-path' } as never,
    )
    expect(findings.map((f) => f.detail).join('\n')).toMatch(/auth\.json/)
  })

  it('startup still only warns, so a first login can happen inside the pool', async () => {
    const warnings: string[] = []
    const findings = await preflightDockerSlot(
      preflightTarget(),
      'container-slot-0',
      cliWithoutCredentials(),
      warnings,
      { scope: 'credentials' },
    )
    expect(findings).toEqual([])
    expect(warnings.join('\n')).toMatch(/auth\.json/)
  })
})

// ─── finding 3: the remedy has to be one the operator can perform ─────────

describe('a workspace refusal names the real cause and a performable remedy', () => {
  it('does not tell the caller to do something the request cannot express', () => {
    let message = ''
    try {
      assertDockerWorkspaceCwd(undefined, '/home/drew/code/cli-bridge-preflight', {
        backend: 'opencode',
        envPrefix: 'OPENCODE',
      })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).not.toBe('')
    // The cwd may have been resolved by the bridge rather than sent by the
    // caller, so "send requests without a cwd" is both an accusation and,
    // through the HTTP API, unperformable.
    expect(message).not.toMatch(/send requests without a cwd/)
    expect(message).toMatch(/OPENCODE_DOCKER_WORKSPACE_ROOT/)
    // The second remedy an operator actually has.
    expect(message).toMatch(/OPENCODE_EXECUTOR=host/)
  })

  it('an outside-the-root refusal still offers the cwd-less route, which now works', () => {
    let message = ''
    try {
      assertDockerWorkspaceCwd('/workspace/opencode', '/etc', { backend: 'opencode', envPrefix: 'OPENCODE' })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/outside/)
    expect(message).toMatch(/OPENCODE_DOCKER_WORKSPACE_ROOT/)
    expect(message).toMatch(/OPENCODE_EXECUTOR=host/)
  })
})
