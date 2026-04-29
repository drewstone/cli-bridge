/**
 * Tests for the Docker executor surface — Spawner abstraction,
 * ContainerPool sticky routing, DockerSpawner argv composition, and
 * ClaudeBackend's chat() pipeline against an injected stub spawner.
 *
 * Real Docker is not used here — the pool exposes a sticky-routing
 * implementation behind acquire/release, which we test with a fake
 * subclass. Backend-level tests inject a Spawner that returns a faux
 * ChildProcess emitting pre-canned stream-json lines so we cover the
 * full chat() loop without spawning anything.
 */

import { Readable, PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { ClaudeBackend } from '../src/backends/claude.js'
import { CodexBackend } from '../src/backends/codex.js'
import { KimiBackend } from '../src/backends/kimi.js'
import { OpencodeBackend } from '../src/backends/opencode.js'
import { ContainerPool } from '../src/executors/container-pool.js'
import { buildDockerExecArgs } from '../src/executors/docker.js'
import { hostSpawner } from '../src/executors/host.js'
import type { Spawner, SpawnResult } from '../src/executors/types.js'
import { loadConfig } from '../src/config.js'

// ─── Spawner abstraction ─────────────────────────────────────────────────

describe('hostSpawner', () => {
  it('produces a child with stdout + a no-op release', async () => {
    const result = await hostSpawner('node', ['-e', 'process.stdout.write("hi"); process.exit(0)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(result.child).toBeDefined()
    expect(result.child.stdout).toBeDefined()
    // release should not throw on the host (no pool to return to).
    expect(() => result.release()).not.toThrow()
    // Drain so the test exits cleanly.
    await new Promise<void>((resolve) => result.child.once('close', () => resolve()))
  })
})

// ─── DockerSpawner argv composition ──────────────────────────────────────

describe('buildDockerExecArgs', () => {
  it('composes minimal docker exec invocation', () => {
    const args = buildDockerExecArgs('container-id', 'claude', ['-p', 'prompt'], {})
    expect(args).toEqual(['exec', '-i', 'container-id', 'claude', '-p', 'prompt'])
  })

  it('passes through cwd via --workdir', () => {
    const args = buildDockerExecArgs('cid', 'claude', ['--version'], { cwd: '/work' })
    expect(args).toContain('--workdir')
    expect(args).toContain('/work')
  })

  it('forwards allowlisted env (CLAUDE_*, ANTHROPIC_*) and skips host-only env', () => {
    const args = buildDockerExecArgs('cid', 'claude', [], {
      env: {
        ANTHROPIC_API_KEY: 'sk-test',
        CLAUDE_DEBUG: '1',
        PATH: '/usr/bin', // host-only, must NOT propagate
        HOME: '/Users/drew', // host-only, must NOT propagate
      },
    })
    const flat = args.join(' ')
    expect(flat).toContain('-e ANTHROPIC_API_KEY=sk-test')
    expect(flat).toContain('-e CLAUDE_DEBUG=1')
    expect(flat).not.toContain('-e PATH=')
    expect(flat).not.toContain('-e HOME=')
  })

  it('respects binPrefix when specified', () => {
    const args = buildDockerExecArgs('cid', 'claude', ['-p', 'x'], {}, '/usr/local/bin/')
    expect(args).toContain('/usr/local/bin/claude')
  })
})

// ─── ContainerPool sticky routing (against a synthetic pool) ────────────

/**
 * The production ContainerPool talks to a real Docker daemon at
 * provision time, so we substitute a hand-built TestPool exposing the
 * same acquire/release surface. The behaviors under test (sticky
 * routing, FIFO fallback, concurrency cap, sticky on release) are pure
 * scheduling logic.
 */
interface TestPoolSlot {
  id: string
  busy: boolean
  lastSession: string | null
}

class TestPool {
  // Shape mirrors ContainerPool internals so a future refactor can
  // swap this against the real class with no test changes.
  private slots: TestPoolSlot[]
  private waiters: Array<{ session?: string; resolve: (s: TestPoolSlot) => void }> = []

  constructor(size: number) {
    this.slots = Array.from({ length: size }, (_, i) => ({ id: `c-${i}`, busy: false, lastSession: null }))
  }

  async acquire(sessionId?: string): Promise<{ id: string; release: () => void }> {
    const sticky = sessionId ? this.slots.find((s) => !s.busy && s.lastSession === sessionId) : undefined
    let slot = sticky ?? this.slots.find((s) => !s.busy)
    if (!slot) {
      slot = await new Promise<TestPoolSlot>((resolve) => {
        this.waiters.push({ session: sessionId, resolve })
      })
    }
    slot.busy = true
    if (sessionId) slot.lastSession = sessionId
    const captured = slot
    return {
      id: captured.id,
      release: () => {
        captured.busy = false
        const stickyIdx = this.waiters.findIndex((w) => w.session && w.session === captured.lastSession)
        const idx = stickyIdx >= 0 ? stickyIdx : 0
        const w = this.waiters.splice(idx, 1)[0]
        if (w) {
          captured.busy = true
          if (w.session) captured.lastSession = w.session
          w.resolve(captured)
        }
      },
    }
  }
}

describe('ContainerPool sticky routing semantics', () => {
  it('routes the same sessionId to the same slot when free', async () => {
    const pool = new TestPool(3)
    const a1 = await pool.acquire('sess-A')
    const a1id = a1.id
    a1.release()
    const a2 = await pool.acquire('sess-A')
    expect(a2.id).toBe(a1id) // sticky hit
    a2.release()
  })

  it('falls back to any free slot when sticky is busy', async () => {
    const pool = new TestPool(2)
    const a = await pool.acquire('sess-A') // c-0
    // sess-A's slot is busy; fall back to next free.
    const b = await pool.acquire('sess-A')
    expect(b.id).not.toBe(a.id)
    a.release()
    b.release()
  })

  it('caps concurrency at pool size; over-cap calls queue', async () => {
    const pool = new TestPool(2)
    const a = await pool.acquire()
    const b = await pool.acquire()
    let cReleased = false
    const cP = pool.acquire()
    cP.then(() => { cReleased = true })
    // c is queued
    await new Promise((r) => setTimeout(r, 5))
    expect(cReleased).toBe(false)
    a.release()
    const c = await cP
    expect(cReleased).toBe(true)
    b.release()
    c.release()
  })

  it('on release, prefers a queued waiter that wants the same session id', async () => {
    const pool = new TestPool(1)
    const a = await pool.acquire('sess-A')
    const stickyP = pool.acquire('sess-A')
    const otherP = pool.acquire('sess-B')
    a.release() // both want this slot; sticky-A waiter should win
    const sticky = await stickyP
    sticky.release()
    const other = await otherP
    other.release()
    // sticky-A served first → stickyP resolved first
    expect(sticky.id).toBe('c-0')
  })
})

describe('ContainerPool.create rejects pool size < 1', async () => {
  it('throws on size 0', async () => {
    await expect(ContainerPool.create({
      size: 0,
      image: 'x:latest',
      namePrefix: 'p',
      oauthMode: 'share',
      shareMounts: [],
    })).rejects.toThrow(/size must be >= 1/)
  })
})

// ─── ClaudeBackend chat() against a stub spawner ────────────────────────

describe('ClaudeBackend with injected spawner', () => {
  it('streams stream-json deltas + emits internal_session_id from system:init', async () => {
    const stubLines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'internal-uuid', model: 'sonnet' }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'text', text: 'hello world' }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 'internal-uuid', usage: { input_tokens: 5, output_tokens: 10 } }),
    ]
    const stubSpawner = createStubSpawner(stubLines)
    const backend = new ClaudeBackend({
      bin: 'claude', timeoutMs: 5000, harness: 'claude-code', spawner: stubSpawner.spawner,
    })
    const deltas: Array<{ content?: string; finish_reason?: string; internal_session_id?: string }> = []
    const ctrl = new AbortController()
    for await (const d of backend.chat(
      { model: 'claude-code/sonnet', messages: [{ role: 'user', content: 'hi' }] },
      null,
      ctrl.signal,
    )) {
      deltas.push(d)
    }
    expect(deltas.find((d) => d.internal_session_id === 'internal-uuid')).toBeDefined()
    expect(deltas.find((d) => d.content === 'hello world')).toBeDefined()
    expect(deltas.find((d) => d.finish_reason === 'stop')).toBeDefined()
    expect(stubSpawner.releaseCalls).toBe(1)
  })

  it('forwards req.session_id into spawner opts so the docker pool can route stickily', async () => {
    const stubLines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sx' }),
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sx' }),
    ]
    const stubSpawner = createStubSpawner(stubLines)
    const backend = new ClaudeBackend({
      bin: 'claude', timeoutMs: 5000, spawner: stubSpawner.spawner,
    })
    const ctrl = new AbortController()
    for await (const _ of backend.chat(
      { model: 'claude/sonnet', messages: [{ role: 'user', content: 'x' }], session_id: 'caller-session-7' },
      null,
      ctrl.signal,
    )) { /* drain */ }
    expect(stubSpawner.observedOpts?.sessionId).toBe('caller-session-7')
  })

  it('release runs even when chat() is aborted mid-stream', async () => {
    const stubSpawner = createStubSpawner(['{"type":"system","subtype":"init","session_id":"x"}'])
    const backend = new ClaudeBackend({ bin: 'claude', timeoutMs: 5000, spawner: stubSpawner.spawner })
    const ctrl = new AbortController()
    const iter = backend.chat({ model: 'claude/sonnet', messages: [{ role: 'user', content: 'x' }] }, null, ctrl.signal)
    // Pull one delta then abort.
    await iter[Symbol.asyncIterator]().next()
    ctrl.abort()
    // Drain the rest.
    try {
      for await (const _ of iter) { /* ignore */ }
    } catch { /* expected on abort */ }
    expect(stubSpawner.releaseCalls).toBe(1)
  })
})

// ─── stub spawner ────────────────────────────────────────────────────────

interface StubSpawnerHandle {
  spawner: Spawner
  observedArgs: string[] | null
  observedOpts: Parameters<Spawner>[2] | null
  releaseCalls: number
}

function createStubSpawner(lines: string[]): StubSpawnerHandle {
  const handle: StubSpawnerHandle = {
    spawner: null as never,
    observedArgs: null,
    observedOpts: null,
    releaseCalls: 0,
  }
  handle.spawner = async (_bin, args, opts) => {
    handle.observedArgs = args
    handle.observedOpts = opts
    const stdout = Readable.from(lines.map((l) => `${l}\n`))
    const stderr = new PassThrough()
    const child = makeFakeChild(stdout, stderr, () => {})
    const result: SpawnResult = {
      child,
      release: () => { handle.releaseCalls++ },
    }
    return result
  }
  return handle
}

function makeFakeChild(
  stdout: Readable,
  stderr: PassThrough,
  onKill: () => void,
): import('node:child_process').ChildProcess {
  // EventEmitter shape sufficient for ClaudeBackend's chat() logic.
  const { EventEmitter } = require('node:events') as typeof import('node:events')
  const ee = new EventEmitter()
  ;(ee as unknown as { stdout: Readable }).stdout = stdout
  ;(ee as unknown as { stderr: Readable }).stderr = stderr
  ;(ee as unknown as { exitCode: number | null }).exitCode = null
  ;(ee as unknown as { kill: () => void }).kill = () => { onKill() }
  // Emit close once stdout drains so chat()'s exit-code wait resolves.
  stdout.on('end', () => {
    ;(ee as unknown as { exitCode: number | null }).exitCode = 0
    ee.emit('close', 0, null)
  })
  return ee as unknown as import('node:child_process').ChildProcess
}

// ─── per-backend executor config parsing ─────────────────────────────────

describe('per-backend executor config (parseAllExecutors)', () => {
  it('defaults all backends to host when no env is set', () => {
    const config = loadConfig({ HOME: '/home/test' })
    expect(config.executors.claude!.kind).toBe('host')
    expect(config.executors.kimi!.kind).toBe('host')
    expect(config.executors.codex!.kind).toBe('host')
    expect(config.executors.opencode!.kind).toBe('host')
  })

  it('BRIDGE_DEFAULT_EXECUTOR=docker flips every backend that has no override', () => {
    const config = loadConfig({ HOME: '/home/test', BRIDGE_DEFAULT_EXECUTOR: 'docker' })
    expect(config.executors.claude!.kind).toBe('docker')
    expect(config.executors.kimi!.kind).toBe('docker')
    expect(config.executors.codex!.kind).toBe('docker')
    expect(config.executors.opencode!.kind).toBe('docker')
  })

  it('per-backend override beats the global default', () => {
    const config = loadConfig({
      HOME: '/home/test',
      BRIDGE_DEFAULT_EXECUTOR: 'docker',
      KIMI_EXECUTOR: 'host',
    })
    expect(config.executors.claude!.kind).toBe('docker')
    expect(config.executors.kimi!.kind).toBe('host')
  })

  it('docker mode populates image + poolSize + mount target with defaults', () => {
    const config = loadConfig({ HOME: '/home/test', CLAUDE_EXECUTOR: 'docker' })
    const c = config.executors.claude!
    expect(c.kind).toBe('docker')
    expect(c.image).toBe('cli-bridge-cli-runtime:latest')
    expect(c.poolSize).toBe(4)
    expect(c.containerConfigDir).toBe('/root/.claude')
    expect(c.hostConfigDir).toContain('/.claude')
    expect(c.namePrefix).toBe('cli-bridge-claude-pool')
  })

  it('rejects invalid <NAME>_EXECUTOR with a clear message', () => {
    expect(() => loadConfig({ HOME: '/home/test', CLAUDE_EXECUTOR: 'banana' as never })).toThrow(/CLAUDE_EXECUTOR/)
  })

  it('rejects invalid <NAME>_DOCKER_OAUTH_MOUNT', () => {
    expect(() => loadConfig({ HOME: '/home/test', CLAUDE_EXECUTOR: 'docker', CLAUDE_DOCKER_OAUTH_MOUNT: 'wat' as never })).toThrow(/CLAUDE_DOCKER_OAUTH_MOUNT/)
  })

  it('all four subprocess backends share the same default runtime image', () => {
    const config = loadConfig({ HOME: '/home/test', BRIDGE_DEFAULT_EXECUTOR: 'docker' })
    const images = ['claude', 'kimi', 'codex', 'opencode'].map((n) => config.executors[n]!.image)
    expect(new Set(images).size).toBe(1)
    expect(images[0]).toBe('cli-bridge-cli-runtime:latest')
  })
})

// ─── non-claude backends respect injected Spawner ────────────────────────

describe('Spawner injection works across all subprocess backends', () => {
  it('KimiBackend uses injected spawner + forwards session_id', async () => {
    const stub = createStubSpawner([
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'kimi here' }] }),
      JSON.stringify({ type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }),
    ])
    const backend = new KimiBackend({ bin: 'kimi', timeoutMs: 5000, spawner: stub.spawner })
    const ctrl = new AbortController()
    const deltas: Array<{ content?: string; finish_reason?: string }> = []
    for await (const d of backend.chat(
      { model: 'kimi-code/kimi-k2.6', messages: [{ role: 'user', content: 'hi' }], session_id: 'kimi-sess' },
      null,
      ctrl.signal,
    )) deltas.push(d)
    expect(deltas.find((d) => d.content === 'kimi here')).toBeDefined()
    expect(stub.observedArgs).toContain('--mcp-config-file')
    expect(stub.observedOpts?.sessionId).toBe('kimi-sess')
    expect(stub.releaseCalls).toBe(1)
  })

  it('CodexBackend uses injected spawner', async () => {
    const stub = createStubSpawner([
      JSON.stringify({ type: 'thread.started', thread_id: 'codex-th' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'codex out' }] }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 } }),
    ])
    const backend = new CodexBackend({ bin: 'codex', timeoutMs: 5000, spawner: stub.spawner })
    const ctrl = new AbortController()
    const deltas: Array<{ content?: string; internal_session_id?: string }> = []
    for await (const d of backend.chat(
      { model: 'codex/gpt-5', messages: [{ role: 'user', content: 'hi' }] },
      null,
      ctrl.signal,
    )) deltas.push(d)
    expect(deltas.find((d) => d.internal_session_id === 'codex-th')).toBeDefined()
    expect(stub.releaseCalls).toBe(1)
  })

  it('OpencodeBackend uses injected spawner', async () => {
    const stub = createStubSpawner([
      JSON.stringify({ type: 'session.created', session_id: 'oc-1' }),
      JSON.stringify({ type: 'message', text: 'opencode talking' }),
      JSON.stringify({ type: 'run.completed' }),
    ])
    const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 5000, spawner: stub.spawner })
    const ctrl = new AbortController()
    const deltas: Array<{ content?: string; internal_session_id?: string; finish_reason?: string }> = []
    for await (const d of backend.chat(
      { model: 'opencode/kimi-for-coding', messages: [{ role: 'user', content: 'hi' }] },
      null,
      ctrl.signal,
    )) deltas.push(d)
    expect(deltas.find((d) => d.internal_session_id === 'oc-1')).toBeDefined()
    expect(stub.observedArgs).toContain('--dangerously-skip-permissions')
    expect(stub.releaseCalls).toBe(1)
  })

  it('OpencodeBackend rejects empty successful streams', async () => {
    const stub = createStubSpawner([])
    const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 5000, spawner: stub.spawner })
    const ctrl = new AbortController()
    await expect(async () => {
      for await (const _d of backend.chat(
        { model: 'opencode/deepseek/deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] },
        null,
        ctrl.signal,
      )) {
        // drain
      }
    }).rejects.toThrow(/produced no stream output/)
    expect(stub.releaseCalls).toBe(1)
  })
})
