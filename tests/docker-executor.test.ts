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
import { hostSpawner, sanitizeHostEnv } from '../src/executors/host.js'
import { killTree } from '../src/executors/process-tree.js'
import type { Spawner, SpawnResult } from '../src/executors/types.js'
import { loadConfig } from '../src/config.js'
import { writeStdinPayload } from '../src/backends/stdin-payload.js'

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

  // Regression: pre-fix, hostSpawner used the default attached-group
  // spawn. SIGTERM to the direct child did not reach grand-children
  // (claude/kimi/opencode each fork tool sub-processes), so on client
  // abort we leaked entire process trees that survived as PPID=1
  // orphans. Spawning with `detached: true` makes the child the leader
  // of its own pgid; killTree then signals the negative pgid and the
  // whole tree dies as a unit. This invariant must hold or every
  // SIGTERM leaks grand-children again.
  it('spawns each child as its own process-group leader (pgid == pid) so the whole tree is signalable', async () => {
    const result = await hostSpawner('node', ['-e', 'setInterval(() => {}, 10)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      const pid = result.child.pid
      expect(pid).toBeDefined()
      // process.getpgid isn't exposed in Node's TypeScript surface
      // consistently — read /proc/<pid>/stat directly. Format from
      // proc(5): pid (comm) state ppid pgrp ...
      const { readFileSync } = await import('node:fs')
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.match(/\d+ \([^)]+\) \S+ (\d+) (\d+)/)
      expect(fields).not.toBeNull()
      const pgid = Number(fields![2])
      expect(pgid).toBe(pid)
    } finally {
      await killTree(result.child)
      result.release()
    }
  })

  it('keeps spawned host env below OS arg/env limits', () => {
    const env = sanitizeHostEnv({
      HOME: '/home/drew',
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-test',
      OPENCODE_CONFIG: '/tmp/opencode.json',
      GH_TOKEN: 'ghp_test',
      HUGE_SESSION_BLOB: 'x'.repeat(1024 * 1024),
      npm_config_user_agent: 'pnpm/test',
    })

    expect(env).toEqual({
      HOME: '/home/drew',
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-test',
      OPENCODE_CONFIG: '/tmp/opencode.json',
      GH_TOKEN: 'ghp_test',
    })
  })
})

// ─── killTree process-group teardown ─────────────────────────────────────

/**
 * killTree must reap the WHOLE process group, not just the direct
 * child. Production-evidence regression: 9+ orphan `opencode run`
 * processes (PPID=1, etime > 24h) accumulated because the bridge sent
 * SIGTERM only to the direct child; opencode's tool/MCP forks survived
 * and were reparented to init. Tests pin the contract.
 */
describe('killTree', () => {
  it('kills the entire process group, including grandchildren', async () => {
    // hostSpawner uses detached:true, so the spawned node becomes a
    // pgrp leader. Its child (default attached) inherits that pgid.
    // Signaling -pgid reaches both. Print grandchild pid to stdout so
    // the test can verify it died after killTree returns.
    const parent = await hostSpawner('node', [
      '-e',
      [
        'const { spawn } = require("node:child_process");',
        'const g = spawn("node", ["-e", "setInterval(() => {}, 100)"]);',
        'process.stdout.write(String(g.pid) + "\\n");',
        'setInterval(() => {}, 100);',
      ].join(''),
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      const grandchildPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('grandchild pid never reported')), 5_000)
        let buf = ''
        parent.child.stdout?.on('data', (b) => {
          buf += b.toString()
          const m = buf.match(/(\d+)/)
          if (m) {
            clearTimeout(timer)
            resolve(Number(m[1]))
          }
        })
      })
      expect(grandchildPid).toBeGreaterThan(0)
      expect(processExists(grandchildPid)).toBe(true)

      const started = Date.now()
      await killTree(parent.child, { gracefulMs: 250 })
      const elapsed = Date.now() - started

      // SIGKILL after grace window — must return within a few seconds
      // even though the grandchild is in setInterval forever.
      expect(elapsed).toBeLessThan(5_000)

      // Give the OS one scheduler tick to reap the processes.
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      expect(parent.child.exitCode !== null || parent.child.signalCode !== null).toBe(true)
      expect(processExists(grandchildPid)).toBe(false)
    } finally {
      parent.release()
    }
  })

  it('is idempotent — calling twice does not throw', async () => {
    const result = await hostSpawner('node', ['-e', 'setInterval(() => {}, 50)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await killTree(result.child)
    await expect(killTree(result.child)).resolves.toBeUndefined()
    result.release()
  })
})

function processExists(pid: number): boolean {
  try {
    // Signal 0 doesn't deliver but does check the pid exists + we have
    // permission. ESRCH = not found.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ─── writeStdinPayload NDJSON shape selector ─────────────────────────────

/**
 * Direct unit tests for the shared stdin helper. The wire shape is
 * load-bearing — Claude Code CLI requires the wrapped envelope, Kimi
 * CLI 1.44.0 requires the flat shape, and getting it wrong silently
 * produces zero output (verified live 2026-05). These tests lock the
 * contract independent of any backend.
 */
describe('writeStdinPayload', () => {
  function collectLines(): { stdin: PassThrough; lines: () => string[] } {
    const stdin = new PassThrough()
    const chunks: string[] = []
    stdin.on('data', (b: Buffer | string) => {
      chunks.push(typeof b === 'string' ? b : b.toString('utf8'))
    })
    return {
      stdin,
      lines: () => chunks.join('').trim().split('\n').filter((l) => l.length > 0),
    }
  }

  it('defaults to claude-wrapped envelope when no format is passed', async () => {
    const cap = collectLines()
    const result = await writeStdinPayload(cap.stdin, [{ role: 'user', content: 'hello' }])
    expect(result.ok).toBe(true)
    const parsed = cap.lines().map((l) => JSON.parse(l))
    expect(parsed).toEqual([{ type: 'user', message: { role: 'user', content: 'hello' } }])
  })

  it("format:'claude' produces the wrapped envelope", async () => {
    const cap = collectLines()
    const result = await writeStdinPayload(
      cap.stdin,
      [{ role: 'user', content: 'hi' }, { role: 'user', content: 'there' }],
      { format: 'claude' },
    )
    expect(result.ok).toBe(true)
    const parsed = cap.lines().map((l) => JSON.parse(l))
    expect(parsed).toEqual([
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'user', message: { role: 'user', content: 'there' } },
    ])
  })

  it("format:'flat' produces the kimi-1.44.0 shape — top-level role+content, no envelope", async () => {
    const cap = collectLines()
    const result = await writeStdinPayload(
      cap.stdin,
      [{ role: 'user', content: 'say PING' }],
      { format: 'flat' },
    )
    expect(result.ok).toBe(true)
    const parsed = cap.lines().map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(parsed).toEqual([{ role: 'user', content: 'say PING' }])
    // Defensive — make sure neither envelope key leaks through.
    for (const obj of parsed) {
      expect(obj.type).toBeUndefined()
      expect(obj.message).toBeUndefined()
    }
  })

  it("format:'raw' produces literal content bytes — no JSON envelope, no per-message newline framing", async () => {
    // opencode's `run` subcommand reads stdin as the literal message
    // text when no positional argv is supplied. A JSON envelope would
    // appear to the model as user-supplied text, not as a structured
    // message. Lock that no framing leaks through.
    const stdin = new PassThrough()
    const chunks: string[] = []
    stdin.on('data', (b: Buffer | string) => {
      chunks.push(typeof b === 'string' ? b : b.toString('utf8'))
    })
    const result = await writeStdinPayload(
      stdin,
      [{ role: 'user', content: 'hello opencode' }],
      { format: 'raw' },
    )
    expect(result.ok).toBe(true)
    const text = chunks.join('')
    expect(text).toBe('hello opencode')
    // No JSON envelope characters appear at all.
    expect(text).not.toContain('"role"')
    expect(text).not.toContain('"content"')
    expect(text).not.toContain('"type"')
  })

  it("format:'raw' joins multi-message content with a blank line — preserves turn boundaries without inventing a wire schema", async () => {
    const stdin = new PassThrough()
    const chunks: string[] = []
    stdin.on('data', (b: Buffer | string) => {
      chunks.push(typeof b === 'string' ? b : b.toString('utf8'))
    })
    const result = await writeStdinPayload(
      stdin,
      [
        { role: 'user', content: 'first turn' },
        { role: 'user', content: 'second turn' },
      ],
      { format: 'raw' },
    )
    expect(result.ok).toBe(true)
    expect(chunks.join('')).toBe('first turn\n\nsecond turn')
  })

  it("format:'raw' survives prompts > 128 KiB without truncation (the E2BIG threshold)", async () => {
    // Direct E2BIG regression: previously the same bytes would have
    // overflowed Linux MAX_ARG_STRLEN at exec time. Through stdin, no
    // such limit applies — assert the helper writes every byte.
    const big = 'A'.repeat(200_000)
    const stdin = new PassThrough()
    const chunks: string[] = []
    stdin.on('data', (b: Buffer | string) => {
      chunks.push(typeof b === 'string' ? b : b.toString('utf8'))
    })
    const result = await writeStdinPayload(stdin, [{ role: 'user', content: big }], { format: 'raw' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.bytesWritten).toBe(200_000)
    expect(chunks.join('').length).toBe(200_000)
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
  /** Concatenated stdin chunks the backend wrote into the faux child. */
  stdinChunks: string[]
  releaseCalls: number
}

function createStubSpawner(lines: string[]): StubSpawnerHandle {
  const handle: StubSpawnerHandle = {
    spawner: null as never,
    observedArgs: null,
    observedOpts: null,
    stdinChunks: [],
    releaseCalls: 0,
  }
  handle.spawner = async (_bin, args, opts) => {
    handle.observedArgs = args
    handle.observedOpts = opts
    const stdout = Readable.from(lines.map((l) => `${l}\n`))
    const stderr = new PassThrough()
    const child = makeFakeChild(stdout, stderr, () => {})
    const stdin = (child as unknown as { stdin: PassThrough }).stdin
    stdin.on('data', (chunk: Buffer | string) => {
      handle.stdinChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    })
    const result: SpawnResult = {
      child,
      release: () => { handle.releaseCalls++ },
    }
    return result
  }
  return handle
}

function createDelayedStubSpawner(closeAfterMs: number): StubSpawnerHandle {
  const handle: StubSpawnerHandle = {
    spawner: null as never,
    observedArgs: null,
    observedOpts: null,
    stdinChunks: [],
    releaseCalls: 0,
  }
  handle.spawner = async (_bin, args, opts) => {
    handle.observedArgs = args
    handle.observedOpts = opts
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = makeFakeChild(stdout, stderr, () => {})
    setTimeout(() => stdout.end(), closeAfterMs).unref()
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
  // claude.ts now writes the NDJSON prompt to stdin via writeStdinPayload;
  // the stub exposes a sink stdin so the chat() path can call .write/.end
  // without blowing up. Tests that observe what claude.ts wrote to stdin
  // can attach a 'data' listener before the chat() call returns.
  const stdin = new PassThrough()
  ;(ee as unknown as { stdin: PassThrough }).stdin = stdin
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

  it('KimiBackend writes FLAT-shape NDJSON to stdin (kimi 1.44.0 rejects claude-wrapped envelope)', async () => {
    // Regression: kimi --print --input-format stream-json parses ONLY
    // `{"role":"user","content":"…"}`. If we hand it claude-code's
    // `{"type":"user","message":{…}}` envelope the CLI emits zero bytes
    // silently — the bridge then surfaces "kimi produced no stream
    // output", which from the caller's perspective looks like a model
    // outage. Lock the wire shape here.
    const stub = createStubSpawner([
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'PING' }] }),
      JSON.stringify({ type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }),
    ])
    const backend = new KimiBackend({ bin: 'kimi', timeoutMs: 5000, spawner: stub.spawner })
    const ctrl = new AbortController()
    const sink: Array<{ content?: string }> = []
    for await (const d of backend.chat(
      { model: 'kimi-code/kimi-k2.6', messages: [{ role: 'user', content: 'say PING' }] },
      null,
      ctrl.signal,
    )) sink.push(d)

    const stdinText = stub.stdinChunks.join('')
    const ndjson = stdinText.trim().split('\n').filter((l) => l.length > 0)
    expect(ndjson.length).toBeGreaterThan(0)
    const parsed = ndjson.map((l) => JSON.parse(l) as Record<string, unknown>)
    // Every line MUST be the flat shape — top-level `role` + `content`,
    // never the wrapped `{type:"user", message:{…}}` envelope.
    for (const obj of parsed) {
      expect(obj.role).toBe('user')
      expect(typeof obj.content).toBe('string')
      expect(obj.type).toBeUndefined()
      expect(obj.message).toBeUndefined()
    }
  })

  it('KimiBackend surfaces buffered-stdout silence as keepalive deltas (not synthetic tool_calls)', async () => {
    // Why this matters: pre-fix, kimi.ts emitted progress as fake
    // tool_calls named `kimi_progress`. Strict OpenAI consumers (Vercel
    // AI SDK in particular) require every tool_calls[].name to exist in
    // the caller's tools registry, so the synthetic name broke every
    // multi-turn agent loop driving kimi via cli-bridge. The fix keeps
    // the liveness signal but routes it through ChatDelta.keepalive,
    // which the SSE writer renders as an SSE comment (silently dropped
    // by every conforming consumer) — see backends/types.ts ChatDelta.
    const originalProgressMs = process.env.KIMI_PROGRESS_MS
    process.env.KIMI_PROGRESS_MS = '10'
    const stub = createDelayedStubSpawner(35)
    const backend = new KimiBackend({ bin: 'kimi', timeoutMs: 5000, spawner: stub.spawner })
    const ctrl = new AbortController()
    const deltas: Array<{
      tool_calls?: Array<{ name: string }>
      keepalive?: { source: string; elapsedMs: number }
    }> = []
    try {
      await expect(async () => {
        for await (const d of backend.chat(
          { model: 'kimi-code/kimi-for-coding', messages: [{ role: 'user', content: 'hi' }] },
          null,
          ctrl.signal,
        )) deltas.push(d)
      }).rejects.toThrow(/produced no stream output/)
    } finally {
      if (originalProgressMs === undefined) delete process.env.KIMI_PROGRESS_MS
      else process.env.KIMI_PROGRESS_MS = originalProgressMs
    }

    // Keepalive deltas MUST be emitted with source='kimi' — that's the
    // only operator-visible signal that kimi is alive but silent.
    const keepalives = deltas.filter((d) => d.keepalive)
    expect(keepalives.length).toBeGreaterThan(0)
    expect(keepalives.every((d) => d.keepalive?.source === 'kimi')).toBe(true)
    expect(keepalives.every((d) => typeof d.keepalive?.elapsedMs === 'number')).toBe(true)
    // No synthetic tool_calls — strict consumers would reject these.
    expect(deltas.flatMap((d) => d.tool_calls ?? [])).toEqual([])
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
    expect(stub.observedArgs).not.toContain('--dangerously-skip-permissions')
    expect(stub.releaseCalls).toBe(1)
  })

  it('OpencodeBackend pipes the prompt via stdin, never argv (E2BIG regression)', async () => {
    // Regression: previously the prompt was appended as the last argv
    // entry to `opencode run …`. Linux MAX_ARG_STRLEN = 128 KiB per
    // argv string on x86_64, so any caller passing a long system
    // prompt hit `spawn E2BIG` (errno -7) on the bridge. Lock the
    // invariant that the prompt text NEVER reaches argv and IS what
    // arrives on stdin.
    const longPrompt = 'X'.repeat(200_000) // > MAX_ARG_STRLEN
    const stub = createStubSpawner([
      JSON.stringify({ type: 'session.created', session_id: 'oc-stdin' }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'ok' } }),
      JSON.stringify({ type: 'run.completed' }),
    ])
    const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 5000, spawner: stub.spawner })
    const ctrl = new AbortController()
    const deltas: Array<{ content?: string; finish_reason?: string }> = []
    for await (const d of backend.chat(
      { model: 'opencode/zai-coding-plan/glm-5.1', messages: [{ role: 'user', content: longPrompt }] },
      null,
      ctrl.signal,
    )) deltas.push(d)

    // Every argv entry must be < the prompt — the prompt itself or
    // any substring of it must not appear in argv at any size.
    const args = stub.observedArgs ?? []
    for (const a of args) {
      expect(a.length).toBeLessThan(longPrompt.length)
      expect(a).not.toContain('XXXXX') // a 5-char witness suffices — argv-safe
    }
    // Args we DO expect.
    expect(args).toContain('run')
    expect(args).toContain('--format')
    expect(args).toContain('json')
    expect(args).toContain('-m')
    // Backend strips the `opencode/` harness prefix before passing to the CLI.
    expect(args).toContain('zai-coding-plan/glm-5.1')

    // Prompt must arrive on stdin (raw bytes, no JSON envelope).
    const stdinText = stub.stdinChunks.join('')
    expect(stdinText.length).toBe(longPrompt.length)
    expect(stdinText).toBe(longPrompt)
    expect(stdinText).not.toContain('"role"')
    expect(stdinText).not.toContain('"type"')

    // Sanity: chat still produced a response delta.
    expect(deltas.find((d) => d.content === 'ok')).toBeDefined()
    expect(stub.releaseCalls).toBe(1)
  })

  it('OpencodeBackend translates opencode tool parts with callID and step token usage', async () => {
    const stub = createStubSpawner([
      JSON.stringify({ type: 'step_start', sessionID: 'oc-2', part: { type: 'step-start' } }),
      JSON.stringify({
        type: 'tool_use',
        sessionID: 'oc-2',
        part: {
          type: 'tool',
          tool: 'write',
          callID: 'call_abc123',
          state: {
            status: 'completed',
            input: { filePath: '/tmp/hello.txt', content: 'hello' },
            output: 'Wrote file successfully.',
          },
        },
      }),
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'oc-2',
        part: {
          type: 'step-finish',
          tokens: { total: 27045, input: 25153, output: 77, reasoning: 23 },
          cost: 0.04437406,
        },
      }),
      JSON.stringify({ type: 'text', sessionID: 'oc-2', part: { type: 'text', text: 'finished' } }),
    ])
    const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 5000, spawner: stub.spawner })
    const ctrl = new AbortController()
    const deltas: Array<{
      content?: string
      internal_session_id?: string
      finish_reason?: string
      tool_calls?: Array<{ id: string; name: string; arguments: string }>
      usage?: { input_tokens?: number; output_tokens?: number }
    }> = []
    for await (const d of backend.chat(
      { model: 'opencode/deepseek/deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] },
      null,
      ctrl.signal,
    )) deltas.push(d)

    expect(deltas.find((d) => d.internal_session_id === 'oc-2')).toBeDefined()
    expect(deltas.find((d) => d.content === 'finished')).toBeDefined()
    const tool = deltas.flatMap((d) => d.tool_calls ?? []).find((tc) => tc.id === 'call_abc123')
    expect(tool?.name).toBe('write')
    expect(JSON.parse(tool?.arguments ?? '{}')).toEqual({ filePath: '/tmp/hello.txt', content: 'hello' })
    expect(deltas.at(-1)?.usage).toEqual({ input_tokens: 25153, output_tokens: 77 })
  })

  it('OpencodeBackend surfaces buffered-stdout silence as keepalive deltas (not synthetic tool_calls)', async () => {
    // Mirror of the KimiBackend keepalive test — see the comment there
    // for the rationale on why we deliberately do NOT synthesize a
    // tool_call to signal liveness.
    const originalProgressMs = process.env.OPENCODE_PROGRESS_MS
    process.env.OPENCODE_PROGRESS_MS = '10'
    const stub = createDelayedStubSpawner(35)
    const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 5000, spawner: stub.spawner })
    const ctrl = new AbortController()
    const deltas: Array<{
      tool_calls?: Array<{ name: string }>
      keepalive?: { source: string; elapsedMs: number }
    }> = []
    try {
      await expect(async () => {
        for await (const d of backend.chat(
          { model: 'opencode/deepseek/deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] },
          null,
          ctrl.signal,
        )) deltas.push(d)
      }).rejects.toThrow(/produced no stream output/)
    } finally {
      if (originalProgressMs === undefined) delete process.env.OPENCODE_PROGRESS_MS
      else process.env.OPENCODE_PROGRESS_MS = originalProgressMs
    }

    const keepalives = deltas.filter((d) => d.keepalive)
    expect(keepalives.length).toBeGreaterThan(0)
    expect(keepalives.every((d) => d.keepalive?.source === 'opencode')).toBe(true)
    expect(keepalives.every((d) => typeof d.keepalive?.elapsedMs === 'number')).toBe(true)
    expect(deltas.flatMap((d) => d.tool_calls ?? [])).toEqual([])
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
