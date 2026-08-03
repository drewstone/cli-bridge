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

import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable, PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

const TEST_RESOURCE_OWNER = '0'.repeat(64)

function ownershipInspect(
  args: string[],
  exists: (name: string) => boolean,
): { code: number; stdout: string; stderr: string } | null {
  if (args[0] !== 'container' || args[1] !== 'inspect') return null
  const name = args[args.length - 1]!
  return exists(name)
    ? { code: 0, stdout: `${TEST_RESOURCE_OWNER}\n`, stderr: '' }
    : { code: 1, stdout: '', stderr: `Error: No such container: ${name}` }
}
import { canonicalCandidateDigest } from '@tangle-network/agent-interface'
import { ClaudeBackend } from '../src/backends/claude.js'
import { BackendError, type ChatDelta } from '../src/backends/types.js'
import { CodexBackend } from '../src/backends/codex.js'
import { KimiBackend } from '../src/backends/kimi.js'
import { OpencodeBackend } from '../src/backends/opencode.js'
import { GeminiBackend } from '../src/backends/gemini.js'
import { PiBackend } from '../src/backends/pi.js'
import { buildContainerRunArgs, ContainerPool } from '../src/executors/container-pool.js'
import type { DockerCli } from '../src/executors/docker-cli.js'
import { assertDockerWorkspaceCwd, buildDockerExecArgs, createDockerSpawner } from '../src/executors/docker.js'
import { hostSpawner, sanitizeHostEnv } from '../src/executors/host.js'
import { killTree } from '../src/executors/process-tree.js'
import { grantTemporaryTreeToUid } from '../src/executors/private-path-access.js'
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
  it.skipIf(process.platform !== 'linux')('spawns each child as its own process-group leader (pgid == pid) so the whole tree is signalable', async () => {
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
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      ANTHROPIC_API_KEY: 'sk-test',
      OPENCODE_CONFIG: '/tmp/opencode.json',
      GEMINI_SYSTEM_MD: '1',
      GEMINI_TIMEOUT_MS: '999999',
      GH_TOKEN: 'ghp_test',
      HUGE_SESSION_BLOB: 'x'.repeat(1024 * 1024),
      npm_config_user_agent: 'pnpm/test',
    })

    expect(env).toEqual({
      HOME: '/home/drew',
      PATH: '/usr/bin',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      ANTHROPIC_API_KEY: 'sk-test',
      OPENCODE_CONFIG: '/tmp/opencode.json',
      GEMINI_SYSTEM_MD: '1',
      GH_TOKEN: 'ghp_test',
    })
  })

  it('passes only the materializer-owned Gemini activation into a real host child', async () => {
    const result = await hostSpawner('python3', [
      '-c',
      'import json,os,sys; sys.stdout.write(json.dumps({"system": os.environ.get("GEMINI_SYSTEM_MD"), "timeout": os.environ.get("GEMINI_TIMEOUT_MS")}))',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        GEMINI_SYSTEM_MD: '1',
        GEMINI_TIMEOUT_MS: '999999',
      },
    })
    let stdout = ''
    result.child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      result.child.once('error', reject)
      result.child.once('close', resolve)
    })

    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ system: '1', timeout: null })
    result.release()
  })

  it('passes an exact Pi environment through the host executor without ambient additions', async () => {
    const result = await hostSpawner('python3', [
      '-c',
      'import json, os; print(json.dumps({"selected": os.environ.get("DEEPSEEK_API_KEY"), "ambient": os.environ.get("OPENAI_API_KEY")}))',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      exactEnv: true,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        DEEPSEEK_API_KEY: 'selected-provider-canary',
        OPENAI_API_KEY: undefined,
      },
    })
    let stdout = ''
    result.child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      result.child.once('error', reject)
      result.child.once('close', resolve)
    })
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ selected: 'selected-provider-canary', ambient: null })
    result.release()
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
  it('hard-stops a child that ignores SIGTERM and waits for exit proof', async () => {
    const result = await hostSpawner('python3', ['-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print("ready", flush=True); time.sleep(30)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('stubborn child did not start')), 2_000)
      result.child.stdout?.once('data', () => { clearTimeout(timer); resolve() })
    })
    await result.terminate?.()
    expect(result.child.exitCode !== null || result.child.signalCode !== null).toBe(true)
    result.release()
  })

  it('kills the entire process group, including grandchildren', async () => {
    // hostSpawner uses detached:true, so the spawned node becomes a
    // pgrp leader. Its child (default attached) inherits that pgid.
    // Signaling -pgid reaches both. Print grandchild pid to stdout so
    // the test can verify it died after killTree returns.
    const parent = await hostSpawner('python3', [
      '-c',
      [
        'import subprocess,sys,time;',
        'g = subprocess.Popen(["python3", "-c", "import time; time.sleep(30)"]);',
        'print(g.pid, flush=True);',
        'time.sleep(30);',
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

  it('kills descendants after the process-group leader has already exited', async () => {
    const parent = spawn('python3', [
      '-c',
      [
        'import subprocess,sys;',
        'g = subprocess.Popen(["python3", "-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL);',
        'print(g.pid, flush=True);',
      ].join(''),
    ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let grandchildPid = 0
    try {
      grandchildPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('detached leader fixture did not report its child')), 2_000)
        parent.stdout?.once('data', chunk => {
          clearTimeout(timer)
          resolve(Number(chunk.toString().trim()))
        })
      })
      if (parent.exitCode === null && parent.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('process-group leader did not exit')), 2_000)
          parent.once('exit', () => { clearTimeout(timer); resolve() })
        })
      }
      expect(parent.exitCode).toBe(0)
      expect(processExists(grandchildPid)).toBe(true)

      await killTree(parent, { gracefulMs: 50 })
      const deadline = Date.now() + 2_000
      while (processExists(grandchildPid) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(processExists(grandchildPid)).toBe(false)
    } finally {
      if (grandchildPid > 0 && processExists(grandchildPid)) {
        try { process.kill(grandchildPid, 'SIGKILL') } catch { /* already gone */ }
      }
    }
  })

  it('keeps host capacity occupied until descendants are gone', () => {
    const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
    const hostUrl = pathToFileURL(join(process.cwd(), 'src', 'executors', 'host.ts')).href
    const source = [
      `import { once } from 'node:events'`,
      `import { hostSpawner } from ${JSON.stringify(hostUrl)}`,
      `void (async () => {`,
      `const first = await hostSpawner('python3', ['-c', 'import subprocess; g=subprocess.Popen(["python3", "-c", "import os,signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); os.write(1,bytes([82])); time.sleep(30)"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL); g.stdout.read(1)'], { stdio: ['ignore', 'pipe', 'pipe'] })`,
      `if (first.child.exitCode === null) await once(first.child, 'exit')`,
      `const started = Date.now()`,
      `const second = await hostSpawner('/bin/true', [], { stdio: ['ignore', 'pipe', 'pipe'] })`,
      `const elapsed = Date.now() - started`,
      `await second.terminate()`,
      `second.release()`,
      `first.release()`,
      `process.stdout.write(String(elapsed))`,
      `})().catch(error => { console.error(error); process.exitCode = 1 })`,
    ].join(';')
    const result = spawnSync(process.execPath, [tsx, '-e', source], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        BRIDGE_HOST_MAX_CONCURRENCY: '1',
        BRIDGE_HOST_ACQUIRE_DEADLINE_MS: '8000',
      },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(Number(result.stdout)).toBeGreaterThanOrEqual(1_800)
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

  it('forwards harness env and skips host-only env', () => {
    const args = buildDockerExecArgs('cid', 'claude', [], {
      env: {
        ANTHROPIC_API_KEY: 'sk-test',
        CLAUDE_DEBUG: '1',
        GEMINI_SYSTEM_MD: '1',
        GEMINI_TIMEOUT_MS: '999999',
        PATH: '/usr/bin', // host-only, must NOT propagate
        HOME: '/Users/drew', // host-only, must NOT propagate
      },
    })
    const flat = args.join(' ')
    expect(flat).toContain('-e ANTHROPIC_API_KEY=sk-test')
    expect(flat).toContain('-e CLAUDE_DEBUG=1')
    expect(flat).toContain('-e GEMINI_SYSTEM_MD=1')
    expect(flat).not.toContain('GEMINI_TIMEOUT_MS')
    expect(flat).not.toContain('-e PATH=')
    expect(flat).not.toContain('-e HOME=')
  })

  it('replaces the container environment for exact child launches', () => {
    const args = buildDockerExecArgs('cid', 'pi', ['--mode', 'rpc'], {
      exactEnv: true,
      env: { HOME: '/work/home', PATH: '/usr/bin', DEEPSEEK_API_KEY: 'selected' },
    })
    expect(args).toEqual([
      'exec', '-i', 'cid', 'env', '-i',
      'HOME=/work/home', 'PATH=/usr/bin', 'DEEPSEEK_API_KEY=selected',
      'pi', '--mode', 'rpc',
    ])
  })

  it('uses the container PATH for an exact environment', () => {
    const args = buildDockerExecArgs('cid', 'pi', [], {
      exactEnv: true,
      env: { PATH: '/host/only/bin', DEEPSEEK_API_KEY: 'selected' },
    }, '', '/usr/local/sbin:/usr/local/bin:/usr/bin:/bin')
    expect(args).toContain('PATH=/usr/local/sbin:/usr/local/bin:/usr/bin:/bin')
    expect(args).not.toContain('PATH=/host/only/bin')
  })

  it('uses the container HOME for an exact environment', () => {
    const args = buildDockerExecArgs('cid', 'pi', [], {
      exactEnv: true,
      env: { HOME: '/home/drew', PATH: '/host/only/bin' },
    }, '', '/usr/local/bin:/usr/bin:/bin', '/home/node')
    expect(args).toContain('HOME=/home/node')
    expect(args).not.toContain('HOME=/home/drew')
  })

  it('maps explicit Pi and XDG paths but rejects an unmounted host path', () => {
    const mapPath = (value: string): string => {
      if (value === '/host/pi') return '/root/.pi/agent'
      if (value.startsWith('/host/pi/')) return `/root/.pi/agent${value.slice('/host/pi'.length)}`
      if (value === '/host/work') return '/host/work'
      throw new Error(`unmapped host path: ${value}`)
    }
    const args = buildDockerExecArgs('cid', 'pi', [], {
      exactEnv: true,
      env: {
        HOME: '/host/home',
        PATH: '/host/bin',
        PI_CODING_AGENT_DIR: '/host/pi',
        XDG_CONFIG_HOME: '/host/pi/config',
      },
    }, '', '/usr/bin:/bin', '/root', mapPath)
    expect(args).toContain('PI_CODING_AGENT_DIR=/root/.pi/agent')
    expect(args).toContain('XDG_CONFIG_HOME=/root/.pi/agent/config')
    expect(args).not.toContain('PI_CODING_AGENT_DIR=/host/pi')
    expect(() => buildDockerExecArgs('cid', 'pi', [], {
      exactEnv: true,
      env: { PI_PACKAGE_DIR: '/host/not-mounted' },
    }, '', '/usr/bin:/bin', '/root', mapPath)).toThrow(/unmapped host path/u)
  })

  it('respects binPrefix when specified', () => {
    const args = buildDockerExecArgs('cid', 'claude', ['-p', 'x'], {}, '/usr/local/bin/')
    expect(args).toContain('/usr/local/bin/claude')
  })
})

describe('Docker cancellation ownership', () => {
  it('restarts the exclusive slot after a clean docker-exec exit', async () => {
    const stdout = new PassThrough()
    const child = makeFakeChild(stdout, new PassThrough(), () => {})
    let restartCalls = 0
    let releases = 0
    const pool = {
      acquire: async () => ({
        containerId: 'clean-exit-container',
        slotIndex: 0,
        release: () => { releases += 1 },
      }),
    } as unknown as ContainerPool
    const spawner = createDockerSpawner({
      pool,
      spawnProcess: (() => child) as unknown as typeof import('node:child_process').spawn,
      restartContainer: async () => { restartCalls += 1 },
    })

    const spawned = await spawner('opencode', ['run'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    stdout.resume()
    stdout.end()
    await closed
    await spawned.terminate?.()
    spawned.release()

    expect(child.exitCode).toBe(0)
    expect(restartCalls).toBe(1)
    expect(releases).toBe(1)
  })

  it('does not return a slot until container restart has completed', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = makeFakeChild(stdout, stderr, () => {})
    let slotReleases = 0
    let restartCalls = 0
    let finishRestart!: () => void
    const restartBlocked = new Promise<void>((resolve) => { finishRestart = resolve })
    const pool = {
      acquire: async () => ({
        containerId: 'container-under-test',
        slotIndex: 0,
        release: () => { slotReleases += 1 },
      }),
    } as unknown as ContainerPool
    const spawner = createDockerSpawner({
      pool,
      spawnProcess: (() => child) as unknown as typeof import('node:child_process').spawn,
      restartContainer: async (containerId) => {
        expect(containerId).toBe('container-under-test')
        restartCalls += 1
        await restartBlocked
      },
    })

    const spawned = await spawner('opencode', ['run'], { stdio: ['pipe', 'pipe', 'pipe'] })
    spawned.release()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(restartCalls).toBe(1)
    expect(slotReleases).toBe(0)

    finishRestart()
    await spawned.terminate?.()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(slotReleases).toBe(1)

    // Concurrent timeout/abort/finally calls share one restart.
    await spawned.terminate?.()
    spawned.release()
    expect(restartCalls).toBe(1)
    expect(slotReleases).toBe(1)
  })

  it('quarantines capacity when both termination and container replacement fail', async () => {
    const child = makeFakeChild(new PassThrough(), new PassThrough(), () => {})
    let slotReleases = 0
    let recycleAttempts = 0
    const pool = {
      acquire: async () => ({
        containerId: 'unproved-container',
        slotIndex: 0,
        release: () => { slotReleases += 1 },
      }),
      recycleHeldSlot: async () => {
        recycleAttempts += 1
        throw new Error('replacement failed')
      },
    } as unknown as ContainerPool
    const spawner = createDockerSpawner({
      pool,
      spawnProcess: (() => child) as unknown as typeof import('node:child_process').spawn,
      restartContainer: async () => { throw new Error('restart failed') },
      cli: async () => ({ code: 0, stdout: 'running\n', stderr: '' }),
    })
    const spawned = await spawner('opencode', ['run'], { stdio: ['pipe', 'pipe', 'pipe'] })

    spawned.release()
    const deadline = Date.now() + 1_000
    while (recycleAttempts === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    expect(recycleAttempts).toBe(1)
    expect(slotReleases).toBe(0)
    await expect(spawned.terminate?.()).rejects.toThrow(/restart failed/)
    expect(slotReleases).toBe(0)
  })
})

describe('temporary container-user access', () => {
  it.skipIf(
    process.platform !== 'linux'
      || !existsSync('/usr/bin/getfacl')
      || !existsSync('/usr/bin/setfacl'),
  )('restores an existing project ACL exactly and removes a generated directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-bridge-acl-restore-'))
    const existing = join(root, '.gemini')
    const existingConfig = join(existing, 'settings.json')
    const created = join(root, '.factory')
    const uid = (process.getuid?.() ?? 1_000) + 10_000
    const acl = (path: string): string => {
      const result = spawnSync('getfacl', ['-R', '--absolute-names', '--numeric', '--', path], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
      return result.stdout
    }
    try {
      mkdirSync(existing, { mode: 0o700 })
      writeFileSync(existingConfig, '{"keep":true}\n', { mode: 0o600 })
      const before = acl(existing)
      const existingAccess = await grantTemporaryTreeToUid(existing, uid)
      expect(acl(existing)).toContain(`user:${uid}:rw`)
      const createdDuringRun = join(existing, 'created-during-run.json')
      writeFileSync(createdDuringRun, '{}', { mode: 0o600 })
      expect(acl(createdDuringRun)).not.toContain(`user:${uid}:`)
      await existingAccess.cleanup()
      await existingAccess.cleanup()
      // The child survives rollback and still carries no inherited access for
      // the temporary container uid.
      expect(existsSync(createdDuringRun)).toBe(true)
      expect(acl(createdDuringRun)).not.toContain(`user:${uid}:`)
      rmSync(createdDuringRun)
      expect(acl(existing)).toBe(before)

      const firstLease = await grantTemporaryTreeToUid(existing, uid)
      let secondGranted = false
      const secondLeasePromise = grantTemporaryTreeToUid(existing, uid).then(access => {
        secondGranted = true
        return access
      })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(secondGranted).toBe(false)
      await firstLease.cleanup()
      const secondLease = await secondLeasePromise
      await secondLease.cleanup()
      expect(acl(existing)).toBe(before)

      const createdAccess = await grantTemporaryTreeToUid(created, uid)
      writeFileSync(join(created, 'mcp.json'), '{}', { mode: 0o600 })
      expect(acl(created)).toContain(`user:${uid}:rw`)
      rmSync(join(created, 'mcp.json'))
      await createdAccess.cleanup()
      expect(existsSync(created)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(
    process.platform !== 'linux'
      || !existsSync('/usr/bin/getfacl')
      || !existsSync('/usr/bin/setfacl'),
  )('releases ACL ownership after a failed restore so later requests are not blocked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-bridge-acl-release-'))
    const active = join(root, 'workspace')
    const moved = join(root, 'workspace-before-replacement')
    const uid = (process.getuid?.() ?? 1_000) + 10_000
    try {
      mkdirSync(active, { mode: 0o700 })
      writeFileSync(join(active, 'settings.json'), '{}', { mode: 0o600 })
      const first = await grantTemporaryTreeToUid(active, uid)
      renameSync(active, moved)
      mkdirSync(active, { mode: 0o700 })

      await expect(first.cleanup()).rejects.toThrow(/replaced path/u)
      const second = await grantTemporaryTreeToUid(active, uid)
      await second.cleanup()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(
    process.platform !== 'linux'
      || !existsSync('/usr/bin/getfacl')
      || !existsSync('/usr/bin/setfacl'),
  )('never steals a malformed cross-process ACL lock based only on its age', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-bridge-acl-malformed-'))
    const runtime = join(root, 'runtime')
    const workspace = join(root, 'workspace')
    const uid = (process.getuid?.() ?? 1_000) + 10_000
    const previousRuntime = process.env.XDG_RUNTIME_DIR
    const previousTimeout = process.env.CLI_BRIDGE_ACL_LOCK_TIMEOUT_MS
    try {
      mkdirSync(runtime, { mode: 0o700 })
      mkdirSync(workspace, { mode: 0o700 })
      process.env.XDG_RUNTIME_DIR = runtime
      process.env.CLI_BRIDGE_ACL_LOCK_TIMEOUT_MS = '40'
      const registry = join(runtime, `cli-bridge-acl-locks-${process.getuid?.() ?? 0}`)
      mkdirSync(registry, { mode: 0o700 })
      const digest = createHash('sha256').update(realpathSync(workspace)).digest('hex')
      const lockPath = join(registry, `${digest}.lock`)
      writeFileSync(lockPath, '{incomplete', { mode: 0o600 })

      await expect(grantTemporaryTreeToUid(workspace, uid)).rejects.toThrow(/timed out waiting/u)
      expect(existsSync(lockPath)).toBe(true)
      expect(require('node:fs').readFileSync(lockPath, 'utf8')).toBe('{incomplete')
    } finally {
      if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = previousRuntime
      if (previousTimeout === undefined) delete process.env.CLI_BRIDGE_ACL_LOCK_TIMEOUT_MS
      else process.env.CLI_BRIDGE_ACL_LOCK_TIMEOUT_MS = previousTimeout
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('Docker container run configuration', () => {
  const poolOpts = {
    size: 1,
    image: 'runtime:latest',
    namePrefix: 'test-pool',
    resourceOwner: TEST_RESOURCE_OWNER,
    oauthMode: 'share' as const,
    shareMounts: ['/home/test/.claude:/root/.claude'],
  }

  it('joins one configured Docker network and leaves the default unchanged when absent', () => {
    const configured = buildContainerRunArgs({ ...poolOpts, network: 'r391-task_net.1' }, 0)
    expect(configured.slice(configured.indexOf('--network'), configured.indexOf('--network') + 2)).toEqual([
      '--network', 'r391-task_net.1',
    ])
    expect(buildContainerRunArgs(poolOpts, 0)).not.toContain('--network')
  })

  it('rejects unsafe Docker network values at the pool boundary', () => {
    for (const network of ['-leading-dash', 'has space', 'container:peer', 'name/segment', 'x'.repeat(256)]) {
      expect(() => buildContainerRunArgs({ ...poolOpts, network }, 0)).toThrow(/invalid Docker network/)
    }
  })

  it('bind-mounts exactly one configured workspace root read-write at the identical path', () => {
    const args = buildContainerRunArgs({ ...poolOpts, workspaceRoot: '/tmp/research-workspaces' }, 0)
    const mountIndex = args.indexOf('--mount')
    expect(mountIndex).toBeGreaterThan(-1)
    expect(args[mountIndex + 1]).toBe(
      'type=bind,source=/tmp/research-workspaces,target=/tmp/research-workspaces',
    )
    expect(args[mountIndex + 1]).not.toContain('readonly')
    expect(args).toContain('/home/test/.claude:/root/.claude')
  })

  it('runs every pool process as the configured non-root identity with a writable HOME', () => {
    const args = buildContainerRunArgs({
      ...poolOpts,
      containerUser: '1000:1000',
      containerHome: '/tmp/cli-home',
    }, 0)
    expect(args.slice(args.indexOf('--user'), args.indexOf('--user') + 4)).toEqual([
      '--user', '1000:1000', '--env', 'HOME=/tmp/cli-home',
    ])
  })

  it('rejects root, named, incomplete, and unsafe container identities', () => {
    expect(() => buildContainerRunArgs({ ...poolOpts, containerUser: '0:0', containerHome: '/tmp/home' }, 0)).toThrow(/non-root container user/)
    expect(() => buildContainerRunArgs({ ...poolOpts, containerUser: 'node:node', containerHome: '/tmp/home' }, 0)).toThrow(/non-root container user/)
    expect(() => buildContainerRunArgs({ ...poolOpts, containerUser: '1000:1000' }, 0)).toThrow(/configured together/)
    expect(() => buildContainerRunArgs({ ...poolOpts, containerUser: '1000:1000', containerHome: '/' }, 0)).toThrow(/container home/)
  })

  it('keeps the workspace bind when OAuth uses an isolated per-slot volume', () => {
    const args = buildContainerRunArgs({
      ...poolOpts,
      oauthMode: 'per-slot',
      shareMounts: undefined,
      perSlotVolumes: [
        { volumePrefix: 'test-oauth', target: '/root/.claude' },
        { volumePrefix: 'test-oauth1', target: '/root/.local/share/claude' },
      ],
      workspaceRoot: '/tmp/research-workspaces',
    }, 2)
    expect(args).toContain('type=bind,source=/tmp/research-workspaces,target=/tmp/research-workspaces')
    expect(args).toContain('test-oauth-2:/root/.claude')
    // Every credential directory the CLI reads gets its own per-slot volume.
    expect(args).toContain('test-oauth1-2:/root/.local/share/claude')
  })

  it('rejects unsafe bind roots at the pool boundary', () => {
    expect(() => buildContainerRunArgs({ ...poolOpts, workspaceRoot: '/' }, 0)).toThrow(/invalid Docker workspace root/)
    expect(() => buildContainerRunArgs({ ...poolOpts, workspaceRoot: '/tmp/has,comma' }, 0)).toThrow(/invalid Docker workspace root/)
  })

  it('canonicalizes nested cwd and rejects lexical and symlink escapes', () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-bridge-cwd-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'cli-bridge-cwd-outside-'))
    const task = join(root, 'task-1')
    const inRootLink = join(root, 'task-link')
    const outsideLink = join(root, 'outside-link')
    mkdirSync(task)
    symlinkSync(task, inRootLink)
    symlinkSync(outside, outsideLink)
    try {
      expect(assertDockerWorkspaceCwd(root, task)).toBe(realpathSync(task))
      expect(assertDockerWorkspaceCwd(root, inRootLink)).toBe(realpathSync(task))
      expect(assertDockerWorkspaceCwd(root, undefined)).toBeUndefined()
      expect(() => assertDockerWorkspaceCwd(root, 'task-1')).toThrow(/must be absolute/)
      expect(() => assertDockerWorkspaceCwd(root, `${root}-escape`)).toThrow(/does not exist|outside configured workspace root/)
      expect(() => assertDockerWorkspaceCwd(root, join(root, '..', 'escape'))).toThrow(/does not exist|outside configured workspace root/)
      expect(() => assertDockerWorkspaceCwd(root, outsideLink)).toThrow(/outside configured workspace root/)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
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

describe('ContainerPool afterCreate hook', () => {
  /** Records docker argv so the test can prove the container was destroyed. */
  const recordingCli = (calls: string[][]): DockerCli => async (args) => {
    calls.push(args)
    const ownership = ownershipInspect(args, (name) => name === 'container-abc')
    if (ownership) return ownership
    if (args[0] === 'run') return { code: 0, stdout: 'container-abc\n', stderr: '' }
    if (args[0] === 'inspect') return { code: 0, stdout: 'true 2026-08-01T00:00:00Z\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }

  it('destroys the slot and fails provisioning when the hook rejects', async () => {
    // The net-jail writes its egress filter here. A slot that kept running
    // after the filter failed would serve requests with unrestricted egress —
    // the exact silent non-enforcement the jail exists to eliminate.
    const calls: string[][] = []
    await expect(ContainerPool.create({ resourceOwner: TEST_RESOURCE_OWNER,
      size: 1,
      image: 'x:latest',
      namePrefix: 'p',
      oauthMode: 'share',
      shareMounts: [],
      cli: recordingCli(calls),
      afterCreate: async () => { throw new Error('egress rules could not be installed') },
    })).rejects.toThrow(/slot 0 was destroyed unused.*egress rules could not be installed/s)
    expect(calls.some((args) => args[0] === 'rm' && args.includes('container-abc'))).toBe(true)
  })

  it('runs the hook before anything execs in the container', async () => {
    const calls: string[][] = []
    const seen: string[] = []
    const pool = await ContainerPool.create({ resourceOwner: TEST_RESOURCE_OWNER,
      size: 1,
      image: 'x:latest',
      namePrefix: 'p',
      oauthMode: 'share',
      shareMounts: [],
      cli: async (args) => { seen.push(args[0]!); return recordingCli(calls)(args) },
      afterCreate: async () => { seen.push('afterCreate') },
    })
    // Nothing may run INSIDE the container before the hook. `inspect` is
    // allowed to precede it: reading `.State.StartedAt` is how the pool stamps
    // which container start the hook's work belongs to, and it touches nothing.
    const armed = seen.indexOf('afterCreate')
    expect(armed).toBeGreaterThan(seen.indexOf('run'))
    // `container inspect` is the ownership check before stale-name cleanup; it
    // also reads Docker metadata and never executes inside the worker.
    expect(seen.slice(0, armed).every((op) => ['container', 'run', 'inspect'].includes(op))).toBe(true)
    await pool.destroy()
  })
})

/**
 * `afterCreate` writes into the container's KERNEL NAMESPACES, and Docker
 * recreates those empty on every restart. So the hook is scoped to a container
 * START, and a slot whose container has started again since is a slot whose
 * setup is gone — with the same container id, the same mounts and the same
 * filesystem, so nothing about it looks different.
 *
 * Measured before these tests existed: a worker exited non-zero, the executor
 * restarted its slot to kill the process tree, and the next request pulled
 * 339,598 bytes of github.com out of that slot through the Docker host.
 */
describe('ContainerPool re-arms start-scoped setup across a container restart', () => {
  interface FakeDaemon {
    /** What `docker inspect` reports for `.State.StartedAt`. Move it to restart. */
    startedAt: string
    calls: string[][]
    /** Container ids handed out by successive `docker run` calls. */
    runIds: string[]
  }

  const fakeDocker = (daemon: FakeDaemon): DockerCli => {
    let runSeq = 0
    const alive = new Set<string>()
    return async (args) => {
      daemon.calls.push(args)
      const ownership = ownershipInspect(args, (name) => alive.has(name))
      if (ownership) return ownership
      if (args[0] === 'run') {
        const id = daemon.runIds[runSeq++] ?? 'container-abc'
        alive.add(id)
        return { code: 0, stdout: `${id}\n`, stderr: '' }
      }
      if (args[0] === 'rm') alive.delete(args[args.length - 1]!)
      if (args[0] === 'inspect') return { code: 0, stdout: `true ${daemon.startedAt}\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
  }

  const newDaemon = (runIds = ['c-first', 'c-second']): FakeDaemon =>
    ({ startedAt: '2026-08-01T00:00:00Z', calls: [], runIds })

  it('carries NO Docker restart policy, so a dead jailed container is replaced and never revived', () => {
    // A restart policy revives the container in place, with fresh empty
    // namespaces, and nothing in this process observes it happening. The pool
    // already models a dead slot correctly — `rm -f` then provision, which
    // re-runs the hook — so a hook means the slot opts out of revival.
    const jailed = buildContainerRunArgs({ resourceOwner: TEST_RESOURCE_OWNER,
      size: 1, image: 'x:latest', namePrefix: 'p', oauthMode: 'share', shareMounts: [],
      afterCreate: async () => {},
    }, 0)
    expect(jailed[jailed.indexOf('--restart') + 1]).toBe('no')

    const plain = buildContainerRunArgs({ resourceOwner: TEST_RESOURCE_OWNER,
      size: 1, image: 'x:latest', namePrefix: 'p', oauthMode: 'share', shareMounts: [],
    }, 0)
    expect(plain[plain.indexOf('--restart') + 1]).toBe('on-failure:3')
  })

  it('re-runs the hook before handing out a slot whose container has restarted', async () => {
    const daemon = newDaemon()
    const armedFor: string[] = []
    const pool = await ContainerPool.create({ resourceOwner: TEST_RESOURCE_OWNER,
      size: 1,
      image: 'x:latest',
      namePrefix: 'p',
      oauthMode: 'share',
      shareMounts: [],
      cli: fakeDocker(daemon),
      afterCreate: async () => { armedFor.push(daemon.startedAt) },
    })
    try {
      expect(armedFor).toEqual(['2026-08-01T00:00:00Z'])

      // No restart: the hook must not be re-run, or every request pays for it.
      ;(await pool.acquire()).release()
      expect(armedFor).toEqual(['2026-08-01T00:00:00Z'])

      // The container restarted. Same id, same mounts, empty namespaces.
      daemon.startedAt = '2026-08-01T00:05:00Z'
      const slot = await pool.acquire()
      expect(armedFor).toEqual(['2026-08-01T00:00:00Z', '2026-08-01T00:05:00Z'])
      expect(slot.containerId).toBe('c-first')
      expect(pool.snapshot().slot_rearms).toBe(1)
      slot.release()

      // ...and once, not on every acquire thereafter.
      ;(await pool.acquire()).release()
      expect(pool.snapshot().slot_rearms).toBe(1)
    } finally {
      await pool.destroy()
    }
  })

  it('replaces the container rather than serving it when the re-arm fails', async () => {
    const daemon = newDaemon()
    let refuse = false
    const pool = await ContainerPool.create({ resourceOwner: TEST_RESOURCE_OWNER,
      size: 1,
      image: 'x:latest',
      namePrefix: 'p',
      oauthMode: 'share',
      shareMounts: [],
      cli: fakeDocker(daemon),
      afterCreate: async (containerId) => {
        if (refuse && containerId === 'c-first') throw new Error('egress rules could not be installed')
      },
    })
    try {
      daemon.startedAt = '2026-08-01T00:05:00Z'
      refuse = true
      const slot = await pool.acquire()
      // Handing back `c-first` would be handing back a container with no filter.
      expect(slot.containerId).toBe('c-second')
      expect(pool.snapshot().slot_rearm_failures).toBe(1)
      slot.release()
    } finally {
      await pool.destroy()
    }
  })

  it('does not re-arm forever after a replacement, because the stamp follows the new container', async () => {
    // The stamp names a container START. A replacement produces a new one, and
    // `provisionSlot` has already armed it — carrying the dead container's stamp
    // forward is not unsafe (it never matches, so every handout re-arms) but it
    // runs an enforcer sidecar per request on a pool that is working perfectly.
    const daemon = newDaemon(['c-first', 'c-second'])
    let armCount = 0
    let vanished = false
    const pool = await ContainerPool.create({ resourceOwner: TEST_RESOURCE_OWNER,
      size: 1,
      image: 'x:latest',
      namePrefix: 'p',
      oauthMode: 'share',
      shareMounts: [],
      cli: async (args) => {
        daemon.calls.push(args)
        const ownership = ownershipInspect(args, (name) => /^c-/u.test(name))
        if (ownership) return ownership
        if (args[0] === 'run') return { code: 0, stdout: `${daemon.runIds.shift() ?? 'c-extra'}\n`, stderr: '' }
        if (args[0] === 'inspect') {
          // Once the first container has been swept, only the replacement
          // answers — and it reports a DIFFERENT start, which is exactly what a
          // stale stamp would misread as "this container restarted".
          return vanished && args.includes('c-first')
            ? { code: 1, stdout: '', stderr: 'Error: No such object: c-first' }
            : { code: 0, stdout: `true ${daemon.startedAt}\n`, stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
      afterCreate: async () => { armCount += 1 },
    })
    try {
      const armsAfterProvision = armCount
      vanished = true
      daemon.startedAt = '2026-08-01T00:09:00Z'
      const slot = await pool.acquire()
      expect(slot.containerId).toBe('c-second')
      slot.release()
      const armsAfterReplacement = armCount
      for (let i = 0; i < 3; i++) (await pool.acquire()).release()
      expect(armCount).toBe(armsAfterReplacement)
      expect(armsAfterReplacement).toBeGreaterThan(armsAfterProvision)
      expect(pool.snapshot().slot_rearms).toBe(0)
    } finally {
      await pool.destroy()
    }
  })

  it('checks the container start on EVERY acquire, ignoring the liveness TTL', async () => {
    // The TTL exists to skip a `docker inspect` on a warm path. The very fact
    // the inspect now reads — which start this container is on — is what changes
    // inside the cached window, so a 30-second cache is 30 seconds of serving a
    // restarted container with its previous incarnation's setup.
    const jailed = newDaemon()
    const jailedPool = await ContainerPool.create({ resourceOwner: TEST_RESOURCE_OWNER,
      size: 1, image: 'x:latest', namePrefix: 'p', oauthMode: 'share', shareMounts: [],
      livenessTtlMs: 600_000, cli: fakeDocker(jailed), afterCreate: async () => {},
    })
    const plain = newDaemon()
    const plainPool = await ContainerPool.create({ resourceOwner: TEST_RESOURCE_OWNER,
      size: 1, image: 'x:latest', namePrefix: 'p', oauthMode: 'share', shareMounts: [],
      livenessTtlMs: 600_000, cli: fakeDocker(plain),
    })
    try {
      const inspectsSoFar = (d: FakeDaemon): number => d.calls.filter((args) => args[0] === 'inspect').length
      const jailedBase = inspectsSoFar(jailed)
      const plainBase = inspectsSoFar(plain)
      for (let i = 0; i < 3; i++) {
        ;(await jailedPool.acquire()).release()
        ;(await plainPool.acquire()).release()
      }
      expect(inspectsSoFar(jailed) - jailedBase).toBe(3)
      expect(inspectsSoFar(plain) - plainBase).toBe(0)
    } finally {
      await jailedPool.destroy()
      await plainPool.destroy()
    }
  })

  it('refuses to record a slot as armed when the container restarted DURING the hook', async () => {
    // The window's only failure mode: the hook writes into a namespace that is
    // already gone, and the slot is then stamped with the start it never armed.
    // Reading the start before AND after is what catches it.
    const daemon = newDaemon()
    let restarts = 0
    await expect(ContainerPool.create({ resourceOwner: TEST_RESOURCE_OWNER,
      size: 1,
      image: 'x:latest',
      namePrefix: 'p',
      oauthMode: 'share',
      shareMounts: [],
      cli: fakeDocker(daemon),
      afterCreate: async () => { daemon.startedAt = `2026-08-01T00:0${++restarts}:00Z` },
    })).rejects.toThrow(/restarted during afterCreate 3 times in a row/)
  })
})

describe('ContainerPool.create rejects pool size < 1', async () => {
  it('throws on size 0', async () => {
    await expect(ContainerPool.create({ resourceOwner: TEST_RESOURCE_OWNER,
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
  it('retains the system:init session id on the successful terminal delta', async () => {
    const stubLines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'internal-uuid', model: 'sonnet' }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'text', text: 'hello world' }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 5, output_tokens: 10 } }),
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

  it('surfaces a Claude rate-limit result as one typed failure with safe provider detail', async () => {
    const stubSpawner = createStubSpawner([
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'rate-limited-session',
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        session_id: 'rate-limited-session',
        is_error: true,
        result: 'Monthly spend limit reached.\nTry again at 1:40 PM.\u0000',
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    ])
    const backend = new ClaudeBackend({
      bin: 'claude', timeoutMs: 5000, harness: 'claude-code', spawner: stubSpawner.spawner,
    })
    const deltas: ChatDelta[] = []
    let failure: unknown
    try {
      for await (const delta of backend.chat(
        { model: 'claude-code/opus', messages: [{ role: 'user', content: 'hi' }] },
        null,
        new AbortController().signal,
      )) {
        deltas.push(delta)
      }
    } catch (err) {
      failure = err
    }

    expect(failure).toBeInstanceOf(BackendError)
    expect(failure).toMatchObject({ code: 'upstream' })
    expect((failure as Error).message).toContain('Monthly spend limit reached. Try again at 1:40 PM.')
    expect((failure as Error).message).not.toMatch(/[\n\u0000]/u)
    expect(deltas).toEqual([])
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
  ;(ee as unknown as { signalCode: NodeJS.Signals | null }).signalCode = null
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
  it('defaults host-chat admission to a box-safe cap', () => {
    const config = loadConfig({ HOME: '/home/test' })
    expect(config.admission).toEqual({
      maxActive: 8,
      maxQueue: 16,
      queueTimeoutMs: 30_000,
    })
  })

  it('defaults all backends to host when no env is set', () => {
    const config = loadConfig({ HOME: '/home/test' })
    expect(config.executors.claude!.kind).toBe('host')
    expect(config.executors.kimi!.kind).toBe('host')
    expect(config.executors.gemini!.kind).toBe('host')
    expect(config.executors.codex!.kind).toBe('host')
    expect(config.executors.opencode!.kind).toBe('host')
    expect(config.backends).toEqual(new Set([
      'claude',
      'codex',
      'opencode',
      'kimi',
      'gemini',
      'pi',
      'passthrough',
    ]))
    expect(config.backends.has('sandbox')).toBe(false)
  })

  it('BRIDGE_DEFAULT_EXECUTOR=docker flips every backend that has no override', () => {
    const config = loadConfig({ HOME: '/home/test', BRIDGE_DEFAULT_EXECUTOR: 'docker' })
    expect(config.executors.claude!.kind).toBe('docker')
    expect(config.executors.kimi!.kind).toBe('docker')
    expect(config.executors.gemini!.kind).toBe('docker')
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
    expect(c.namePrefix).toMatch(/^cli-bridge-claude-[a-f0-9]{12}-pool$/u)
    expect(c.resourceOwner).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('loads an explicit non-root Docker identity and HOME', () => {
    const config = loadConfig({
      HOME: '/home/test',
      CLAUDE_EXECUTOR: 'docker',
      CLAUDE_DOCKER_USER: '1000:1000',
      CLAUDE_DOCKER_HOME: '/tmp/claude-home',
      CLAUDE_DOCKER_CONTAINER_CONFIG_DIR: '/tmp/claude-home/.claude',
    })
    const c = config.executors.claude!
    expect(c.containerUser).toBe('1000:1000')
    expect(c.containerHome).toBe('/tmp/claude-home')
  })

  it('maps a custom Pi agent directory into Docker instead of leaking the host path', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pi-docker-workspace-'))
    try {
      const config = loadConfig({
        HOME: '/home/test',
        PI_EXECUTOR: 'docker',
        PI_CODING_AGENT_DIR: '/srv/pi-agent',
        PI_DOCKER_WORKSPACE_ROOT: workspace,
      })
      expect(config.executors.pi!.hostConfigDir).toBe('/srv/pi-agent')
      expect(config.executors.pi!.containerConfigDir).toBe('/root/.pi/agent')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('loads a backend Docker network only in Docker mode', () => {
    const config = loadConfig({
      HOME: '/home/test',
      OPENCODE_EXECUTOR: 'docker',
      OPENCODE_DOCKER_NETWORK: 'r391-task_net.1',
    })
    expect(config.executors.opencode!.network).toBe('r391-task_net.1')
    expect(config.executors.claude!.network).toBeUndefined()
    expect(() => loadConfig({
      HOME: '/home/test',
      OPENCODE_DOCKER_NETWORK: 'r391-task-net',
    })).toThrow(/OPENCODE_DOCKER_NETWORK is set but OPENCODE_EXECUTOR is host/)
  })

  it('rejects unsafe backend Docker network names', () => {
    const base = { HOME: '/home/test', OPENCODE_EXECUTOR: 'docker' }
    for (const network of ['-leading-dash', 'has space', 'container:peer', 'name/segment', 'x'.repeat(256)]) {
      expect(() => loadConfig({ ...base, OPENCODE_DOCKER_NETWORK: network })).toThrow(/invalid OPENCODE_DOCKER_NETWORK/)
    }
  })

  it('rejects incomplete, root, named, unsafe, and mismatched Docker identities', () => {
    const base = { HOME: '/home/test', CLAUDE_EXECUTOR: 'docker' }
    expect(() => loadConfig({ ...base, CLAUDE_DOCKER_USER: '1000:1000' })).toThrow(/configured together/)
    expect(() => loadConfig({ ...base, CLAUDE_DOCKER_USER: '0:0', CLAUDE_DOCKER_HOME: '/tmp/home' })).toThrow(/positive numeric/)
    expect(() => loadConfig({ ...base, CLAUDE_DOCKER_USER: 'node:node', CLAUDE_DOCKER_HOME: '/tmp/home' })).toThrow(/positive numeric/)
    expect(() => loadConfig({ ...base, CLAUDE_DOCKER_USER: '1000:1000', CLAUDE_DOCKER_HOME: '/' })).toThrow(/absolute non-root path/)
    expect(() => loadConfig({
      ...base,
      CLAUDE_DOCKER_USER: '1000:1000',
      CLAUDE_DOCKER_HOME: '/tmp/home',
      CLAUDE_DOCKER_CONTAINER_CONFIG_DIR: '/root/.claude',
    })).toThrow(/CLAUDE_DOCKER_CONTAINER_CONFIG_DIR=\/root\/\.claude is outside CLAUDE_DOCKER_HOME=\/tmp\/home/)
  })

  it('loads and canonicalizes an existing Docker workspace directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-bridge-workspace-'))
    try {
      const config = loadConfig({
        HOME: '/home/test',
        CLAUDE_EXECUTOR: 'docker',
        CLAUDE_DOCKER_WORKSPACE_ROOT: root,
      })
      expect(config.executors.claude!.workspaceRoot).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects workspace roots that are inactive, relative, missing, files, or filesystem root', () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-bridge-workspace-invalid-'))
    const file = join(root, 'file')
    writeFileSync(file, 'not a directory')
    try {
      expect(() => loadConfig({
        HOME: '/home/test',
        CLAUDE_DOCKER_WORKSPACE_ROOT: root,
      })).toThrow(/CLAUDE_DOCKER_WORKSPACE_ROOT is set but CLAUDE_EXECUTOR is host/)
      expect(() => loadConfig({
        HOME: '/home/test',
        CLAUDE_EXECUTOR: 'docker',
        CLAUDE_DOCKER_WORKSPACE_ROOT: 'relative/path',
      })).toThrow(/expected an absolute path/)
      expect(() => loadConfig({
        HOME: '/home/test',
        CLAUDE_EXECUTOR: 'docker',
        CLAUDE_DOCKER_WORKSPACE_ROOT: join(root, 'missing'),
      })).toThrow(/path does not exist/)
      expect(() => loadConfig({
        HOME: '/home/test',
        CLAUDE_EXECUTOR: 'docker',
        CLAUDE_DOCKER_WORKSPACE_ROOT: file,
      })).toThrow(/path is not a directory/)
      expect(() => loadConfig({
        HOME: '/home/test',
        CLAUDE_EXECUTOR: 'docker',
        CLAUDE_DOCKER_WORKSPACE_ROOT: '/',
      })).toThrow(/refusing to expose filesystem root/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects host or container OAuth/config overlap, including symlink aliases', () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-bridge-overlap-home-'))
    const oauth = join(home, '.claude')
    const separate = mkdtempSync(join(tmpdir(), 'cli-bridge-overlap-workspace-'))
    const oauthAlias = join(home, 'oauth-alias')
    mkdirSync(oauth)
    symlinkSync(oauth, oauthAlias)
    try {
      for (const oauthMode of ['share', 'per-slot'] as const) {
        expect(() => loadConfig({
          HOME: home,
          CLAUDE_EXECUTOR: 'docker',
          CLAUDE_DOCKER_OAUTH_MOUNT: oauthMode,
          CLAUDE_DOCKER_WORKSPACE_ROOT: home,
        })).toThrow(/must not overlap/)
        expect(() => loadConfig({
          HOME: home,
          CLAUDE_EXECUTOR: 'docker',
          CLAUDE_DOCKER_OAUTH_MOUNT: oauthMode,
          CLAUDE_DOCKER_HOST_CONFIG_DIR: oauthAlias,
          CLAUDE_DOCKER_WORKSPACE_ROOT: oauth,
        })).toThrow(/must not overlap/)
        expect(() => loadConfig({
          HOME: home,
          CLAUDE_EXECUTOR: 'docker',
          CLAUDE_DOCKER_OAUTH_MOUNT: oauthMode,
          CLAUDE_DOCKER_HOST_CONFIG_DIR: oauth,
          CLAUDE_DOCKER_CONTAINER_CONFIG_DIR: join(separate, '.claude'),
          CLAUDE_DOCKER_WORKSPACE_ROOT: separate,
        })).toThrow(/must not overlap/)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(separate, { recursive: true, force: true })
    }
  })

  it('rejects invalid <NAME>_EXECUTOR with a clear message', () => {
    expect(() => loadConfig({ HOME: '/home/test', CLAUDE_EXECUTOR: 'banana' as never })).toThrow(/CLAUDE_EXECUTOR/)
  })

  it('rejects invalid <NAME>_DOCKER_OAUTH_MOUNT', () => {
    expect(() => loadConfig({ HOME: '/home/test', CLAUDE_EXECUTOR: 'docker', CLAUDE_DOCKER_OAUTH_MOUNT: 'wat' as never })).toThrow(/CLAUDE_DOCKER_OAUTH_MOUNT/)
  })

  it('all subprocess backends share the same default runtime image', () => {
    const config = loadConfig({ HOME: '/home/test', BRIDGE_DEFAULT_EXECUTOR: 'docker' })
    const images = ['claude', 'kimi', 'gemini', 'codex', 'opencode'].map((n) => config.executors[n]!.image)
    expect(new Set(images).size).toBe(1)
    expect(images[0]).toBe('cli-bridge-cli-runtime:latest')
  })
})

// ─── non-claude backends respect injected Spawner ────────────────────────

function subprocessBackendCases(spawner: Spawner) {
  return [
    { model: 'claude/opus', backend: new ClaudeBackend({ bin: 'claude', timeoutMs: 100, spawner }) },
    { model: 'opencode/test/model', backend: new OpencodeBackend({ bin: 'opencode', timeoutMs: 100, spawner }) },
    { model: 'kimi-code/kimi-for-coding', backend: new KimiBackend({ bin: 'kimi', timeoutMs: 100, spawner }) },
    { model: 'codex/default', backend: new CodexBackend({ bin: 'codex', timeoutMs: 100, spawner }) },
    { model: 'gemini/gemini-2.5-pro', backend: new GeminiBackend({ bin: 'gemini', timeoutMs: 100, spawner }) },
    { model: 'pi/openai/gpt-5', backend: new PiBackend({ bin: 'pi', timeoutMs: 100, spawner }) },
  ]
}

describe('Spawner injection works across all subprocess backends', () => {
  it('maps every generated config path into the Docker-visible workspace before spawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-bridge-docker-config-paths-'))
    const originalPiAdapter = process.env.CLI_BRIDGE_PI_MCP_ADAPTER
    process.env.CLI_BRIDGE_PI_MCP_ADAPTER = '1'
    const valueAfter = (args: string[] | null, flag: string): string | undefined => {
      const index = args?.indexOf(flag) ?? -1
      return index >= 0 ? args?.[index + 1] : undefined
    }
    const mappedStub = (lines: string[], cwd: string) => {
      const stub = createStubSpawner(lines)
      const prepared: Array<{ host: string; runtime: string; entries: string[] }> = []
      const mapPath = (path: string): string => path.startsWith(`${cwd}/`)
        ? `/executor${path.slice(cwd.length)}`
        : `/executor-mount${path}`
      const baseSpawner = stub.spawner
      stub.spawner = async (bin, args, opts) => {
        for (const item of prepared) {
          if (existsSync(item.host)) item.entries = readdirSync(item.host, { recursive: true }).map(String).sort()
        }
        return await baseSpawner(bin, args, opts)
      }
      stub.spawner.resolveCwd = requested => requested ?? cwd
      stub.spawner.mapPath = mapPath
      stub.spawner.preparePrivatePath = async path => {
        expect(existsSync(path)).toBe(true)
        const runtime = mapPath(path)
        prepared.push({
          host: path,
          runtime,
          entries: readdirSync(path, { recursive: true }).map(String).sort(),
        })
        return runtime
      }
      stub.spawner.prepareWorkspacePath = async path => {
        if (!existsSync(path)) mkdirSync(path)
        const runtime = mapPath(path)
        prepared.push({ host: path, runtime, entries: [] })
        return { path: runtime, cleanup: async () => {} }
      }
      return { stub, prepared }
    }
    const request = (model: string, cwd: string) => ({
      model,
      cwd,
      messages: [{ role: 'user' as const, content: 'work' }],
      mcp: { mcpServers: { echo: { command: 'echo', args: ['ok'] } } },
    })

    try {
      const claudeCwd = join(root, 'claude')
      mkdirSync(claudeCwd)
      const claude = mappedStub([
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-paths' }),
        JSON.stringify({ type: 'result', subtype: 'success' }),
      ], claudeCwd)
      for await (const _ of new ClaudeBackend({ bin: 'claude', timeoutMs: 5_000, spawner: claude.stub.spawner }).chat(
        request('claude/sonnet', claudeCwd), null, new AbortController().signal,
      )) { /* drain */ }
      expect(valueAfter(claude.stub.observedArgs, '--mcp-config')).toMatch(/^\/executor\//u)
      expect(claude.prepared.some(item => item.entries.includes('mcp-config.json'))).toBe(true)

      const opencodeCwd = join(root, 'opencode')
      mkdirSync(opencodeCwd)
      const opencode = mappedStub([
        JSON.stringify({ type: 'message', text: 'ok' }),
        JSON.stringify({ type: 'run.completed' }),
      ], opencodeCwd)
      for await (const _ of new OpencodeBackend({ bin: 'opencode', timeoutMs: 5_000, spawner: opencode.stub.spawner }).chat(
        request('opencode/test/model', opencodeCwd), null, new AbortController().signal,
      )) { /* drain */ }
      expect(opencode.stub.observedOpts?.env?.OPENCODE_CONFIG).toMatch(/^\/executor\//u)
      expect(opencode.prepared.some(item => item.entries.includes('opencode.json'))).toBe(true)

      const kimiCwd = join(root, 'kimi')
      mkdirSync(kimiCwd)
      const kimi = mappedStub([
        JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }),
        JSON.stringify({ type: 'result' }),
      ], kimiCwd)
      for await (const _ of new KimiBackend({ bin: 'kimi', timeoutMs: 5_000, spawner: kimi.stub.spawner }).chat(
        request('kimi-code/kimi-for-coding', kimiCwd), null, new AbortController().signal,
      )) { /* drain */ }
      expect(valueAfter(kimi.stub.observedArgs, '--mcp-config-file')).toMatch(/^\/executor\//u)
      expect(kimi.prepared.some(item => item.entries.includes('mcp-config.json'))).toBe(true)

      const codexCwd = join(root, 'codex')
      mkdirSync(codexCwd)
      const codex = mappedStub([
        JSON.stringify({ type: 'thread.started', thread_id: 'codex-paths' }),
        JSON.stringify({ type: 'turn.completed' }),
      ], codexCwd)
      for await (const _ of new CodexBackend({ bin: 'codex', timeoutMs: 5_000, spawner: codex.stub.spawner }).chat(
        request('codex/default', codexCwd), null, new AbortController().signal,
      )) { /* drain */ }
      expect(codex.stub.observedOpts?.env?.CODEX_HOME).toMatch(/^\/executor\//u)
      expect(codex.prepared.some(item => item.entries.includes('config.toml'))).toBe(true)

      const geminiCwd = join(root, 'gemini')
      mkdirSync(geminiCwd)
      const gemini = mappedStub(['ok'], geminiCwd)
      for await (const _ of new GeminiBackend({ bin: 'gemini', timeoutMs: 5_000, spawner: gemini.stub.spawner }).chat(
        request('gemini/gemini-2.5-pro', geminiCwd), null, new AbortController().signal,
      )) { /* drain */ }
      expect(gemini.prepared).toEqual(expect.arrayContaining([
        expect.objectContaining({ host: join(geminiCwd, '.gemini'), entries: expect.arrayContaining(['settings.json']) }),
      ]))

      const piCwd = join(root, 'pi')
      mkdirSync(piCwd)
      const pi = mappedStub([
        JSON.stringify({ type: 'session', id: 'pi-paths' }),
        JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } }),
        JSON.stringify({ type: 'turn_end', message: { usage: { input: 1, output: 1 } } }),
        JSON.stringify({ type: 'agent_end' }),
      ], piCwd)
      const piProfile = {
        prompt: { systemPrompt: 'private profile instruction' },
        resources: { skills: [{ kind: 'inline' as const, name: 'private-skill', content: 'private skill' }] },
      }
      for await (const _ of new PiBackend({ bin: 'pi', timeoutMs: 5_000, spawner: pi.stub.spawner }).chat(
        {
          ...request('pi/openai/gpt-5', piCwd),
          interaction_policy: 'unattended-allow',
          interaction_policy_receipt: {
            schema: 'cli-bridge.interaction-policy.v1',
            name: 'unattended-allow',
            profileDigest: canonicalCandidateDigest(piProfile),
          },
          agent_profile: piProfile,
        },
        null,
        new AbortController().signal,
      )) { /* drain */ }
      expect(valueAfter(pi.stub.observedArgs, '--mcp-config')).toMatch(/^\/executor\//u)
      expect(valueAfter(pi.stub.observedArgs, '--system-prompt')).toMatch(/^\/executor\//u)
      expect(valueAfter(pi.stub.observedArgs, '--skill')).toMatch(/^\/executor\//u)
      const generatedExtensions = (pi.stub.observedArgs ?? [])
        .flatMap((arg, index, args) => arg === '--extension' ? [args[index + 1]!] : [])
        .filter(path => path.startsWith('/executor/'))
      expect(generatedExtensions.length).toBeGreaterThan(0)
      expect(pi.prepared.every(item => item.host.startsWith(`${piCwd}/`))).toBe(true)
    } finally {
      if (originalPiAdapter === undefined) delete process.env.CLI_BRIDGE_PI_MCP_ADAPTER
      else process.env.CLI_BRIDGE_PI_MCP_ADAPTER = originalPiAdapter
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects an unsafe profile before materializing MCP secrets or spawning any backend', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-bridge-pre-spawn-'))
    const originalTmpdir = process.env.TMPDIR
    const originalPiAdapter = process.env.CLI_BRIDGE_PI_MCP_ADAPTER
    let spawnCalls = 0
    const refusingSpawner: Spawner = async () => {
      spawnCalls++
      throw new Error('backend must not spawn for an invalid profile')
    }
    const cases = subprocessBackendCases(refusingSpawner)

    process.env.TMPDIR = root
    process.env.CLI_BRIDGE_PI_MCP_ADAPTER = '1'
    try {
      for (const { model, backend } of cases) {
        await expect(async () => {
          for await (const _ of backend.chat({
            model,
            cwd: root,
            messages: [{ role: 'user', content: 'work' }],
            mcp: {
              mcpServers: {
                secret: { command: 'node', env: { TOKEN: 'secret-witness' } },
              },
            },
            agent_profile: {
              resources: {
                skills: [{ kind: 'inline', name: '../../../unsafe', content: 'unsafe' }],
              },
            },
          }, null, new AbortController().signal)) { /* drain */ }
        }).rejects.toThrow(/AgentProfile workspace materialization failed/)
      }

      expect(spawnCalls).toBe(0)
      expect(readdirSync(root, { recursive: true })).toEqual([])
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = originalTmpdir
      if (originalPiAdapter === undefined) delete process.env.CLI_BRIDGE_PI_MCP_ADAPTER
      else process.env.CLI_BRIDGE_PI_MCP_ADAPTER = originalPiAdapter
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('removes every MCP config and lock when the spawner rejects before returning a child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-bridge-spawn-reject-'))
    const originalTmpdir = process.env.TMPDIR
    const originalPiAdapter = process.env.CLI_BRIDGE_PI_MCP_ADAPTER
    let spawnCalls = 0
    const refusingSpawner: Spawner = async () => {
      spawnCalls++
      throw new Error('backend spawn refused')
    }

    process.env.TMPDIR = root
    process.env.CLI_BRIDGE_PI_MCP_ADAPTER = '1'
    try {
      for (const { model, backend } of subprocessBackendCases(refusingSpawner)) {
        await expect(async () => {
          for await (const _ of backend.chat({
            model,
            cwd: root,
            messages: [{ role: 'user', content: 'work' }],
            mcp: {
              mcpServers: {
                server: { command: 'node', env: { SAFE_SETTING: 'witness' } },
              },
            },
          }, null, new AbortController().signal)) { /* drain */ }
        }).rejects.toThrow('backend spawn refused')

        const entries = readdirSync(root, { recursive: true }).map(String)
        const privateRegistry = entries.find(path => path.startsWith('cli-bridge-private-temp-registry-'))
        if (privateRegistry) expect(readdirSync(join(root, privateRegistry))).toEqual([])
        const residue = entries.filter(
          path => path !== '.gemini'
            && path !== '.pi'
            && !path.startsWith('cli-bridge-private-temp-registry-'),
        )
        expect(residue).toEqual([])
      }
      expect(spawnCalls).toBe(6)
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = originalTmpdir
      if (originalPiAdapter === undefined) delete process.env.CLI_BRIDGE_PI_MCP_ADAPTER
      else process.env.CLI_BRIDGE_PI_MCP_ADAPTER = originalPiAdapter
      rmSync(root, { recursive: true, force: true })
    }
  })


  /** The kimi-k2.6 path reads $HOME/.kimi/config.toml (then rewrites it into a temp
   *  copy). That file exists on a dev host and not on a CI runner, which made these
   *  two tests host-state-dependent — the repo's first CI run exposed it. A temp HOME
   *  with a minimal config makes them hermetic; ensureK2DefaultConfig accepts any TOML. */
  const withKimiHome = async (fn: () => Promise<void>): Promise<void> => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const home = mkdtempSync(join(tmpdir(), 'kimi-home-'))
    mkdirSync(join(home, '.kimi'), { recursive: true })
    writeFileSync(join(home, '.kimi', 'config.toml'), 'default_model = "kimi-code/kimi-k2.6"\n')
    const prev = process.env.HOME
    process.env.HOME = home
    try { await fn() } finally {
      process.env.HOME = prev
      rmSync(home, { recursive: true, force: true })
    }
  }

  it('KimiBackend uses injected spawner + forwards session_id', async () => {
    await withKimiHome(async () => {
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
  })

  it('KimiBackend writes FLAT-shape NDJSON to stdin (kimi 1.44.0 rejects claude-wrapped envelope)', async () => {
    await withKimiHome(async () => {
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

  it('GeminiBackend uses injected spawner + pipes prompt via stdin', async () => {
    const stub = createStubSpawner(['gemini out'])
    const backend = new GeminiBackend({ bin: 'gemini', timeoutMs: 5000, spawner: stub.spawner })
    const ctrl = new AbortController()
    const deltas: Array<{ content?: string; finish_reason?: string }> = []
    for await (const d of backend.chat(
      { model: 'gemini/gemini-2.5-pro', messages: [{ role: 'user', content: 'hi gemini' }] },
      null,
      ctrl.signal,
    )) deltas.push(d)
    expect(deltas.some((d) => d.content?.includes('gemini out'))).toBe(true)
    expect(stub.observedArgs).toContain('--model')
    expect(stub.observedArgs).toContain('gemini-2.5-pro')
    expect(stub.stdinChunks.join('')).toBe('hi gemini')
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

  it('OpencodeBackend does not finish an aborted request before executor termination', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = makeFakeChild(stdout, stderr, () => {})
    let terminateCalls = 0
    let releaseCalls = 0
    let finishTermination!: () => void
    const terminationBlocked = new Promise<void>((resolve) => { finishTermination = resolve })
    const spawner: Spawner = async () => ({
      child,
      terminate: async () => {
        terminateCalls += 1
        await terminationBlocked
      },
      release: () => { releaseCalls += 1 },
    })
    const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 5000, spawner })
    const controller = new AbortController()
    const iterator = backend.chat(
      { model: 'opencode/zai-coding-plan/glm-5.2', messages: [{ role: 'user', content: 'work' }] },
      null,
      controller.signal,
    )[Symbol.asyncIterator]()

    const firstDelta = iterator.next()
    stdout.write(`${JSON.stringify({ type: 'session.created', session_id: 'cancel-test' })}\n`)
    await expect(firstDelta).resolves.toMatchObject({
      done: false,
      value: { internal_session_id: 'cancel-test' },
    })

    controller.abort()
    let settled = false
    const drain = (async () => {
      while (!(await iterator.next()).done) { /* drain */ }
    })().finally(() => { settled = true })
    stdout.end()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(terminateCalls).toBe(1)
    expect(releaseCalls).toBe(0)
    expect(settled).toBe(false)

    finishTermination()
    await drain
    expect(releaseCalls).toBe(1)
    expect(settled).toBe(true)
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

  it('OpencodeBackend translates tool parts and preserves a reported step receipt', async () => {
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
        timestamp: 1,
        sessionID: 'oc-2',
        part: {
          id: 'part-step-1',
          sessionID: 'oc-2',
          messageID: 'message-1',
          type: 'step-finish',
          reason: 'tool-calls',
          tokens: {
            total: 27045,
            input: 25153,
            output: 77,
            reasoning: 23,
            cache: { read: 1792, write: 0 },
          },
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
      usage?: { input_tokens?: number; output_tokens?: number; cost?: number }
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
    expect(deltas.at(-1)?.usage).toEqual({
      input_tokens: 26945,
      output_tokens: 100,
      cost: 0.04437406,
    })
  })

  it('OpencodeBackend aggregates every step receipt across a multi-step run', async () => {
    const stub = createStubSpawner([
      JSON.stringify({
        type: 'step_finish',
        timestamp: 1,
        sessionID: 'oc-multi-step',
        part: {
          id: 'part-step-1',
          sessionID: 'oc-multi-step',
          messageID: 'message-1',
          type: 'step-finish',
          reason: 'tool-calls',
          tokens: {
            total: 165,
            input: 100,
            output: 20,
            reasoning: 5,
            cache: { read: 30, write: 10 },
          },
          cost: 0.01,
        },
      }),
      JSON.stringify({
        type: 'step_finish',
        timestamp: 2,
        sessionID: 'oc-multi-step',
        part: {
          id: 'part-step-2',
          sessionID: 'oc-multi-step',
          messageID: 'message-2',
          type: 'step-finish',
          reason: 'stop',
          tokens: {
            total: 57,
            input: 40,
            output: 5,
            reasoning: 2,
            cache: { read: 8, write: 2 },
          },
          cost: 0.02,
        },
      }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'finished' } }),
    ])
    const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 5000, spawner: stub.spawner })
    const deltas: ChatDelta[] = []
    for await (const delta of backend.chat(
      { model: 'opencode/zai-coding-plan/glm-5.1', messages: [{ role: 'user', content: 'hi' }] },
      null,
      new AbortController().signal,
    )) deltas.push(delta)

    const receipt = deltas.at(-1)?.usage as (ChatDelta['usage'] & { cost?: number }) | undefined
    expect(receipt).toMatchObject({ input_tokens: 190, output_tokens: 32 })
    expect(receipt?.cost).toBeCloseTo(0.03, 12)
    expect(receipt?.estimated).toBeUndefined()
    expect(deltas.filter((delta) => delta.finish_reason)).toHaveLength(1)
    expect(stub.releaseCalls).toBe(1)
  })

  it('OpencodeBackend omits cost when any step receipt has unknown cost', async () => {
    const stub = createStubSpawner([
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'oc-partial-cost',
        part: {
          type: 'step-finish',
          tokens: {
            input: 100,
            output: 20,
            cache: { read: 30, write: 10 },
          },
          cost: 0.01,
        },
      }),
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'oc-partial-cost',
        part: {
          type: 'step-finish',
          tokens: {
            input: 40,
            output: 5,
            cache: { read: 8, write: 2 },
          },
        },
      }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'finished' } }),
    ])
    const backend = new OpencodeBackend({
      bin: 'opencode',
      timeoutMs: 5000,
      spawner: stub.spawner,
    })
    const deltas: ChatDelta[] = []
    for await (const delta of backend.chat(
      { model: 'opencode/zai-coding-plan/glm-5.1', messages: [{ role: 'user', content: 'hi' }] },
      null,
      new AbortController().signal,
    )) deltas.push(delta)

    expect(deltas.at(-1)?.usage).toEqual({
      input_tokens: 190,
      output_tokens: 25,
    })
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
