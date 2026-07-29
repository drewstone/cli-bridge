/**
 * The defect class, asserted through surfaces that ALREADY EXIST.
 *
 * Every failure in the four defects reported a DIFFERENT failure than the one
 * that happened: a missing image reported a missing container; a stale cache
 * reported a live timestamp; an incoherent container user reported EACCES on an
 * unrelated path; a missing directory reported a missing command.
 *
 * This file deliberately imports nothing new — only config.ts, docker.ts,
 * container-pool.ts, routes/health.ts and the backends. That keeps it an
 * assertion-level failure against the pre-fix source rather than a
 * module-not-found error, so the red is about behaviour. Unit tests for the two
 * new modules live in docker-preflight.test.ts and docker-exec-diagnosis.test.ts.
 *
 * Measured on this host against cli-bridge-cli-runtime:latest before the fix:
 *
 *   docker exec -w /workspace/does-not-exist <c> opencode --version    -> 127
 *   docker exec -w /workspace              <c> definitely-not-a-binary -> 127
 *   docker exec -w /workspace              <c> /etc/hostname           -> 126
 *   docker exec <removed container>        opencode --version          -> 1
 *       + "Error response from daemon: No such container: <id>"
 *   docker run <absent image>                                          -> 125
 *       + "pull access denied ... repository does not exist"
 *   --user 1000:1000 --env HOME=/home/node, creds at /root/.config/opencode:
 *       cat /root/.config/opencode/auth.json -> Permission denied
 *   -v host:/home/node/.local/share/opencode in an image lacking
 *   /home/node/.local: Docker creates the parents root:root, then
 *       mkdir -p /home/node/.local/state -> Permission denied
 */

import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { ContainerPool } from '../src/executors/container-pool.js'
import { assertDockerWorkspaceCwd, createDockerSpawner, terminateDockerExecution } from '../src/executors/docker.js'
import { mountHealth } from '../src/routes/health.js'
import { BackendRegistry } from '../src/backends/registry.js'
import type { Backend, BackendHealth, ChatDelta } from '../src/backends/types.js'
import type { DockerCli } from '../src/executors/docker-cli.js'
import { OpencodeBackend } from '../src/backends/opencode.js'
import { ClaudeBackend } from '../src/backends/claude.js'
import { CodexBackend } from '../src/backends/codex.js'
import { KimiBackend } from '../src/backends/kimi.js'
import { PiBackend } from '../src/backends/pi.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { SessionStore } from '../src/sessions/store.js'
import { RunRegistry } from '../src/runs/registry.js'

// ─── helpers ─────────────────────────────────────────────────────────────

/** ChildProcess stand-in that emits the given output then closes with `code`. */
function childExiting(code: number, stdoutText: string, stderrText: string): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  const stderr = new PassThrough()
  ;(child as unknown as { stdout: Readable }).stdout = Readable.from(stdoutText ? [stdoutText] : [])
  ;(child as unknown as { stderr: PassThrough }).stderr = stderr
  ;(child as unknown as { stdin: PassThrough }).stdin = new PassThrough()
  ;(child as unknown as { pid: number }).pid = 4242
  ;(child as unknown as { kill: () => boolean }).kill = () => true
  setImmediate(() => {
    if (stderrText) stderr.write(stderrText)
    stderr.end()
    child.emit('close', code)
  })
  return child
}

const VANISHED_ID = '58b95fdb3ab65552bc9e3cef236d9aa8eb32a2b0378f05a64ff10b4c067f57e7'
const DIAGNOSIS =
  `pool container 58b95fdb3ab6 no longer exists, so the CLI never started ` +
  `— exit 1 came from docker exec, not from opencode.`

/**
 * A docker-style executor lease whose container was removed between acquire and
 * exec. The diagnosis text is supplied directly here; the real prober that
 * produces it is unit-tested in docker-exec-diagnosis.test.ts. What this file
 * asserts is that a backend USES the executor's diagnosis instead of formatting
 * the daemon's reply as a CLI exit status.
 */
function vanishedContainerSpawner(): (bin: string, args: string[], opts: unknown) => Promise<unknown> {
  return async () => ({
    child: childExiting(1, '', `Error response from daemon: No such container: ${VANISHED_ID}\n`),
    release: () => {},
    diagnoseExit: async () => DIAGNOSIS,
  })
}

function readySpawner(): (bin: string, args: string[], opts: unknown) => Promise<unknown> {
  return async () => ({ child: childExiting(0, '1.18.9\n', ''), release: () => {} })
}

/** Fake docker CLI for the pool: `alive` tracks which container ids still exist. */
function poolDocker(): {
  cli: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  vanish: (id: string) => void
  counters: () => { runs: number; inspects: number }
} {
  const state = { runs: 0, inspects: 0 }
  const alive = new Set<string>()
  return {
    cli: async (args) => {
      if (args[0] === 'run') {
        state.runs += 1
        const id = `container-${state.runs}`
        alive.add(id)
        return { code: 0, stdout: `${id}\n`, stderr: '' }
      }
      if (args[0] === 'inspect') {
        state.inspects += 1
        const id = args[args.length - 1]!
        return alive.has(id)
          ? { code: 0, stdout: 'true\n', stderr: '' }
          : { code: 1, stdout: '', stderr: `Error: No such object: ${id}` }
      }
      if (args[0] === 'rm') { alive.delete(args[args.length - 1]!); return { code: 0, stdout: '', stderr: '' } }
      return { code: 0, stdout: '', stderr: '' }
    },
    vanish: (id) => { alive.delete(id) },
    counters: () => ({ ...state }),
  }
}

const basePool = {
  size: 1,
  image: 'cli-bridge-cli-runtime:latest',
  namePrefix: 'cli-bridge-honesty-test',
  oauthMode: 'share' as const,
  shareMounts: [],
  acquireDeadlineMs: 1_000,
  slotMaxHoldMs: 60_000,
}

// ─── defect 4: a missing directory reported as a missing command ─────────

describe('defect 4 — a cwd with no mount behind it is refused, not turned into exit 127', () => {
  it('refuses a request cwd when no workspace is mounted, naming the setting that fixes it', () => {
    const attempt = (): unknown => assertDockerWorkspaceCwd(undefined, '/home/drew/work/task-1', {
      backend: 'opencode', envPrefix: 'OPENCODE',
    })
    expect(attempt).toThrow(/OPENCODE_DOCKER_WORKSPACE_ROOT/)
    expect(attempt).toThrow(/does not exist inside the container/)
  })

  // The assertion is unchanged; the CLAIM in the old name — "which is how
  // /health probes run" — was the shape defect written down. A probe that
  // reaches this function with no cwd has skipped the one assertion every real
  // request crosses, and therefore cannot detect the failure requests hit. The
  // health path now resolves its cwd through the executor's own policy first,
  // which is asserted in probe-request-path.test.ts.
  it('returns the cwd unchanged when there is none to validate', () => {
    expect(assertDockerWorkspaceCwd(undefined, undefined)).toBeUndefined()
  })

  it('the health path does NOT reach this function cwd-less', () => {
    const pool = {
      acquire: async () => ({ containerId: 'c1', slotIndex: 0, release: () => {} }),
      reportContainerUnusable: async () => {},
    } as unknown as ContainerPool
    const spawner = createDockerSpawner({
      pool, backend: 'opencode', envPrefix: 'OPENCODE', workspaceRoot: '/workspace/opencode',
    })
    // What a cwd-less request resolves to, and therefore what the probe spawns in.
    expect(spawner.resolveCwd?.(undefined)).toBe('/workspace/opencode')
    expect(typeof spawner.probeRequestPath).toBe('function')
  })

  it('refuses before acquiring a slot, so no container is touched', async () => {
    let acquires = 0
    const pool = {
      acquire: async () => { acquires += 1; throw new Error('must not acquire') },
      reportContainerUnusable: async () => {},
    } as unknown as ContainerPool
    const spawner = createDockerSpawner({ pool, backend: 'opencode', envPrefix: 'OPENCODE' })

    await expect(spawner('opencode', ['run'], { cwd: '/home/drew/work/task-1' }))
      .rejects.toThrow(/OPENCODE_DOCKER_WORKSPACE_ROOT/)
    expect(acquires).toBe(0)
    // resolveCwd runs before any workspace materialization, so it must refuse too.
    expect(() => spawner.resolveCwd?.('/home/drew/work/task-1')).toThrow(/OPENCODE_DOCKER_WORKSPACE_ROOT/)
  })
})

// ─── defect E: a setting that is accepted must be honoured ───────────────

describe('defect E — configuration cannot be silently wrong', () => {
  it('rejects an unknown <NAME>_DOCKER_* variable instead of ignoring it', () => {
    // The original failure had exactly this shape: a workspace-root variable set
    // against a build that did not read it. Accepting it silently is what let the
    // bridge mount nothing and then blame the CLI.
    expect(() => loadConfig({
      HOME: '/home/test', OPENCODE_EXECUTOR: 'docker', OPENCODE_DOCKER_WORKSPACE: '/home/test/ws',
    })).toThrow(/unknown setting OPENCODE_DOCKER_WORKSPACE/)
    expect(() => loadConfig({
      HOME: '/home/test', OPENCODE_EXECUTOR: 'docker', OPENCODE_DOCKER_WORKSPACE_ROOTS: '/home/test/ws',
    })).toThrow(/cli-bridge does not read it/)
  })

  it('rejects every docker-only setting when the executor is not docker', () => {
    for (const key of ['OPENCODE_DOCKER_IMAGE', 'OPENCODE_DOCKER_POOL_SIZE', 'OPENCODE_DOCKER_NAME_PREFIX']) {
      expect(() => loadConfig({ HOME: '/home/test', OPENCODE_EXECUTOR: 'host', [key]: 'x' }))
        .toThrow(new RegExp(`${key} is set but OPENCODE_EXECUTOR is host`))
    }
  })

  it('rejects a non-numeric pool size rather than pooling NaN slots', () => {
    expect(() => loadConfig({ HOME: '/home/test', OPENCODE_EXECUTOR: 'docker', OPENCODE_DOCKER_POOL_SIZE: 'four' }))
      .toThrow(/invalid positive integer/)
  })
})

// ─── defect 3: credentials mounted where the CLI never looks ─────────────

describe('defect 3 — the credential mount target follows the configured HOME', () => {
  it('derives the mount target from OPENCODE_DOCKER_HOME instead of hardcoding /root', () => {
    const config = loadConfig({
      HOME: '/home/test',
      OPENCODE_EXECUTOR: 'docker',
      OPENCODE_DOCKER_USER: '1000:1000',
      OPENCODE_DOCKER_HOME: '/home/node',
    })
    // Pre-fix the default was the hardcoded /root/.config/opencode, so a
    // uid-1000 container with HOME=/home/node had its credentials mounted into
    // another user's home — unreadable, and invisible to the CLI.
    expect(config.executors.opencode!.containerConfigDir).toBe('/home/node/.config/opencode')
    expect(config.executors.opencode!.containerHome).toBe('/home/node')
  })

  it('keeps the /root defaults when no container identity is configured', () => {
    const config = loadConfig({ HOME: '/home/test', BRIDGE_DEFAULT_EXECUTOR: 'docker' })
    expect(config.executors.opencode!.containerConfigDir).toBe('/root/.config/opencode')
    expect(config.executors.claude!.containerConfigDir).toBe('/root/.claude')
    expect(config.executors.pi!.containerConfigDir).toBe('/root/.pi/agent')
    // The host-side default tracks the SAME relative path under $HOME.
    expect(config.executors.opencode!.hostConfigDir).toBe('/home/test/.config/opencode')
  })

  it('rejects an explicit config dir outside the container HOME, naming both paths', () => {
    expect(() => loadConfig({
      HOME: '/home/test',
      OPENCODE_EXECUTOR: 'docker',
      OPENCODE_DOCKER_USER: '1000:1000',
      OPENCODE_DOCKER_HOME: '/home/node',
      OPENCODE_DOCKER_CONTAINER_CONFIG_DIR: '/root/.config/opencode',
    })).toThrow(/is outside OPENCODE_DOCKER_HOME=\/home\/node/)
  })
})

// ─── defect 2a: a slot that cannot heal ──────────────────────────────────

describe('defect 2 — a slot whose container vanished is recreated, not poisoned', () => {
  it('hands out a NEW container after the old one is removed outside the bridge', async () => {
    const docker = poolDocker()
    const pool = await ContainerPool.create({ ...basePool, cli: docker.cli, livenessTtlMs: 0 })

    const first = await pool.acquire()
    expect(first.containerId).toBe('container-1')
    first.release()

    // The host sweep / manual `docker rm` that started the ten-day failure.
    docker.vanish('container-1')

    const second = await pool.acquire()
    expect(second.containerId).toBe('container-2')
    expect(pool.snapshot().slot_liveness_recoveries).toBe(1)
    second.release()

    // And it keeps working: a third acquire reuses the healthy container.
    const third = await pool.acquire()
    expect(third.containerId).toBe('container-2')
    third.release()
    await pool.destroy()
  })

  it('reportContainerUnusable heals the slot even when liveness is still trusted', async () => {
    const docker = poolDocker()
    const pool = await ContainerPool.create({ ...basePool, cli: docker.cli, livenessTtlMs: 10 * 60_000 })
    const first = await pool.acquire()
    expect(first.containerId).toBe('container-1')
    first.release()

    docker.vanish('container-1')
    await pool.reportContainerUnusable('container-1')

    const second = await pool.acquire()
    expect(second.containerId).toBe('container-2')
    second.release()
    await pool.destroy()
  })

  it('ignores a report for a container it no longer owns', async () => {
    const docker = poolDocker()
    const pool = await ContainerPool.create({ ...basePool, cli: docker.cli })
    await expect(pool.reportContainerUnusable('some-other-container')).resolves.toBeUndefined()
    expect(docker.counters().runs).toBe(1)
    await pool.destroy()
  })

  it('checks liveness once per TTL — free on the warm path, guaranteed once it expires', async () => {
    const docker = poolDocker()
    const warm = await ContainerPool.create({ ...basePool, cli: docker.cli, livenessTtlMs: 60_000 })
    const before = docker.counters().inspects
    for (let i = 0; i < 5; i++) {
      const slot = await warm.acquire()
      slot.release()
    }
    // Back-to-back requests on a warm pool must not pay a docker round-trip.
    expect(docker.counters().inspects).toBe(before)
    await warm.destroy()

    // With the TTL expired, liveness MUST be re-established — that check is the
    // only thing between a swept container and a ten-day-stale verdict.
    const checked = await ContainerPool.create({ ...basePool, cli: docker.cli, livenessTtlMs: 0 })
    const inspectsBefore = docker.counters().inspects
    const slot = await checked.acquire()
    expect(docker.counters().inspects).toBeGreaterThan(inspectsBefore)
    slot.release()
    await checked.destroy()
  })
})

// ─── defect 1: an absent image reported as an absent container ───────────

describe('defect 1 — provisioning failures name the IMAGE and its build command', () => {
  it('names the image, not a container, when the first provision fails', async () => {
    const cli = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => (args[0] === 'run'
      ? { code: 125, stdout: '', stderr: 'docker: Error response from daemon: pull access denied for cli-bridge-cli-runtime, repository does not exist' }
      : { code: 0, stdout: '', stderr: '' })
    await expect(ContainerPool.create({ ...basePool, cli }))
      .rejects.toThrow(/image cli-bridge-cli-runtime:latest is not available on this host\. Build it: pnpm run docker:build:runtime/)
    await expect(ContainerPool.create({ ...basePool, cli })).rejects.not.toThrow(/No such container/)
  })

  it('surfaces the build command when a vanished slot cannot be rebuilt', async () => {
    let runs = 0
    const cli = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      if (args[0] === 'run') {
        runs += 1
        if (runs === 1) return { code: 0, stdout: 'container-1\n', stderr: '' }
        return { code: 125, stdout: '', stderr: 'docker: Error response from daemon: No such image: cli-bridge-cli-runtime:latest' }
      }
      if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: 'Error: No such object' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const pool = await ContainerPool.create({ ...basePool, cli, livenessTtlMs: 0 })
    await expect(pool.acquire()).rejects.toThrow(/image cli-bridge-cli-runtime:latest is not available on this host/)
    await expect(pool.acquire()).rejects.toThrow(/pnpm run docker:build:runtime/)
    await pool.destroy()
  })

  it('a queued waiter served after a failed recycle can still release its slot', async () => {
    // Regression: the recycle path pre-acquired the slot AND let the waiter's own
    // resolve acquire it again, bumping the generation twice. The waiter's
    // release() then matched neither generation and became a no-op, leaking the
    // slot as busy until the 10-minute hold watchdog fired.
    let runs = 0
    const cli = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      if (args[0] === 'run') {
        runs += 1
        if (runs <= 2) return { code: 0, stdout: `container-${runs}\n`, stderr: '' }
        return { code: 1, stdout: '', stderr: 'daemon refused' }
      }
      if (args[0] === 'inspect') return { code: 0, stdout: 'true\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const pool = await ContainerPool.create({
      ...basePool, size: 2, cli, livenessTtlMs: 60_000, slotMaxHoldMs: 50, maxConsecutiveFailures: 1,
    })
    const a = await pool.acquire()
    const b = await pool.acquire()
    const queued = pool.acquire()
    // Slot a's holder never releases, so the hold watchdog recycles it; that
    // recycle fails (runs > 2) and must still hand slot b's container to the
    // waiter. Assert by identity, not by literal id: the pool provisions slots
    // in parallel, so which slot gets which container is not ordered.
    b.release()
    const served = await queued
    expect(served.containerId).toBe(b.containerId)
    served.release()
    expect(pool.snapshot().in_flight).toBeLessThanOrEqual(1)

    // The released slot is immediately reusable — proof the release was not a
    // no-op. Pre-fix the waiter's release matched neither generation, so this
    // acquire blocked until the watchdog fired again.
    const reused = await pool.acquire()
    expect(reused.containerId).toBe(b.containerId)
    reused.release()
    void a
    await pool.destroy()
  })
})

// ─── the message has to REACH the caller, not only the log ───────────────

describe('a refused request answers with its reason, not an empty error', () => {
  async function postChat(app: Hono, body: unknown): Promise<{ status: number; json: any }> {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, json: await res.json() }
  }

  it('returns 501 and the remedy when the executor cannot serve the cwd', async () => {
    const app = new Hono()
    const registry = new BackendRegistry().register(new OpencodeBackend({
      bin: 'opencode',
      timeoutMs: 5_000,
      // A docker spawner with no workspace mounted refuses at resolveCwd.
      spawner: createDockerSpawner({
        pool: {
          acquire: async () => { throw new Error('must not acquire') },
          recycleHeldSlot: async () => {},
          reportContainerUnusable: async () => {},
        } as unknown as ContainerPool,
        backend: 'opencode',
        envPrefix: 'OPENCODE',
      }),
    }))
    const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-honesty-store-'))
    const sessions = new SessionStore(dir)
    const runs = new RunRegistry({})
    mountChatCompletions(app, { registry, sessions, runs })

    const { status, json } = await postChat(app, {
      model: 'opencode/zai-coding-plan/glm-5.2',
      cwd: '/home/drew/some/task',
      messages: [{ role: 'user', content: 'hi' }],
    })

    // Pre-fix: 200, finish_reason 'error', content '', and the only copy of the
    // reason went to the bridge's stdout.
    expect(status).toBe(501)
    expect(json.error.type).toBe('executor_misconfigured')
    expect(json.error.message).toMatch(/OPENCODE_DOCKER_WORKSPACE_ROOT/)
    expect(json.error.message).toMatch(/does not exist inside the container/)
    expect(json.choices).toBeUndefined()

    sessions.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns 500 WITH the message for an untyped dispatch failure', async () => {
    const app = new Hono()
    const registry = new BackendRegistry().register(new OpencodeBackend({
      bin: 'opencode',
      timeoutMs: 5_000,
      spawner: async () => { throw new Error('some unexpected executor failure') },
    }))
    const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-honesty-store2-'))
    const sessions = new SessionStore(dir)
    const runs = new RunRegistry({})
    mountChatCompletions(app, { registry, sessions, runs })

    const { status, json } = await postChat(app, {
      model: 'opencode/zai-coding-plan/glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(status).toBe(500)
    expect(json.error.message).toContain('some unexpected executor failure')

    sessions.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

// ─── defect 2d: the slot must come BACK, not just be diagnosed ───────────

describe('defect 2 — a holder that cannot terminate its container hands the slot back', () => {
  it('treats a removed container as already terminated instead of failing termination', async () => {
    const child = childExiting(1, '', 'Error response from daemon: No such container: abc123')
    await new Promise<void>((resolve) => child.once('close', () => resolve()))
    // `docker restart` cannot succeed against a removed container. Reporting
    // that as a termination failure is what left the slot busy for ten minutes.
    await expect(terminateDockerExecution(child, 'abc123', async () => {
      throw new Error('docker executor could not terminate container abc123: No such container: abc123')
    })).resolves.toBeUndefined()
  })

  it('still reports a genuine termination failure rather than pretending it worked', async () => {
    const child = childExiting(1, '', 'boom')
    await new Promise<void>((resolve) => child.once('close', () => resolve()))
    // The container is STILL THERE, so the restart failure is real and must be
    // reported. The liveness answer is injected rather than taken from the host's
    // daemon: with a made-up id a real `docker inspect` legitimately answers "no
    // such object", which would make this test assert the opposite of its name.
    const stillRunning: DockerCli = async (args) =>
      args[0] === 'inspect' ? { code: 0, stdout: 'running\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }
    await expect(terminateDockerExecution(child, 'abc123', async () => {
      throw new Error('docker executor could not terminate container abc123: daemon is unreachable')
    }, stillRunning)).rejects.toThrow(/daemon is unreachable/)
  })

  it('recycles the held slot when termination fails, so the slot is never stranded', async () => {
    const child = childExiting(1, '', 'exec failed')
    let recycled: string | null = null
    let releases = 0
    const pool = {
      acquire: async () => ({ containerId: 'held-container', slotIndex: 0, release: () => { releases += 1 } }),
      recycleHeldSlot: async (id: string) => { recycled = id },
      reportContainerUnusable: async () => {},
    } as unknown as ContainerPool
    const spawner = createDockerSpawner({
      pool,
      backend: 'opencode',
      envPrefix: 'OPENCODE',
      spawnProcess: (() => child) as never,
      restartContainer: async () => { throw new Error('daemon is unreachable') },
      // The container is still there, so termination genuinely failed and the
      // slot must be recycled rather than reused.
      cli: async (args) => (args[0] === 'inspect'
        ? { code: 0, stdout: 'running\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' }),
    })

    const spawned = await spawner('opencode', ['run'], { stdio: ['pipe', 'pipe', 'pipe'] })
    spawned.release()
    // Let the termination attempt, the recycle and the release settle.
    for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r))
    expect(recycled).toBe('held-container')
    expect(releases).toBe(1)
  })

  it('recycleHeldSlot replaces a BUSY slot and returns it free', async () => {
    const docker = poolDocker()
    const pool = await ContainerPool.create({ ...basePool, cli: docker.cli, livenessTtlMs: 10 * 60_000 })
    const held = await pool.acquire()
    expect(pool.snapshot().in_flight).toBe(1)

    await pool.recycleHeldSlot(held.containerId)
    expect(pool.snapshot().in_flight).toBe(0)

    const next = await pool.acquire()
    expect(next.containerId).not.toBe(held.containerId)
    next.release()
    await pool.destroy()
  })
})

// ─── defect 2b: every backend must report through the same probe ─────────

describe('defect 2 — every docker-capable backend reports through the SAME probe', () => {
  // The first version of this fix routed the shared `versionHealth` through the
  // exec diagnosis, and /health STILL printed
  //   "exit 1: Error response from daemon: No such container: 58b95fdb…"
  // on a live bridge, because claude, codex, kimi, opencode and pi each carried
  // their own byte-identical copy of the probe. Only removing a container under
  // a running instance exposed it. This is that live check, in the suite.
  const cases = [
    { name: 'opencode', make: (s: never) => new OpencodeBackend({ bin: 'opencode', timeoutMs: 5_000, spawner: s }) },
    { name: 'claude-code', make: (s: never) => new ClaudeBackend({ bin: 'claude', timeoutMs: 5_000, harness: 'claude-code', spawner: s }) },
    { name: 'codex', make: (s: never) => new CodexBackend({ bin: 'codex', timeoutMs: 5_000, spawner: s }) },
    { name: 'kimi-code', make: (s: never) => new KimiBackend({ bin: 'kimi', timeoutMs: 5_000, harness: 'kimi-code', spawner: s }) },
    { name: 'pi', make: (s: never) => new PiBackend({ bin: 'pi', timeoutMs: 5_000, spawner: s }) },
  ]

  for (const { name, make } of cases) {
    it(`${name} names a vanished pool container instead of printing the daemon's reply`, async () => {
      const health = await make(vanishedContainerSpawner() as never).health()
      expect(health.state).toBe('error')
      expect(health.detail).toContain('pool container 58b95fdb3ab6 no longer exists')
      expect(health.detail).toContain('the CLI never started')
      // The raw shape that reached the operator for ten days.
      expect(health.detail).not.toMatch(/^exit 1: Error response from daemon/)
    })
  }

  it('reports a ready CLI with its version, unchanged', async () => {
    for (const { name, make } of cases) {
      const health = await make(readySpawner() as never).health()
      expect(health.state, name).toBe('ready')
      expect(health.version, name).toBe('1.18.9')
    }
  })
})

// ─── defect 2c: /health must reflect current reality ─────────────────────

class ScriptedBackend implements Backend {
  constructor(readonly name: string, private readonly next: () => BackendHealth) {}
  matches(): boolean { return true }
  async health(): Promise<BackendHealth> { return this.next() }
  async *chat(): AsyncIterable<ChatDelta> { throw new Error('not used') }
}

interface HealthBody {
  status: string
  ts: string
  backends: Array<{ name: string; state: string; detail?: string; probed_at: string; cached: boolean }>
}

describe('defect 2 — a failing backend is retried, and a cached verdict says so', () => {
  it('recovers without a restart once the underlying fault is fixed', async () => {
    const app = new Hono()
    let broken = true
    let probes = 0
    const registry = new BackendRegistry().register(new ScriptedBackend('opencode', () => {
      probes += 1
      return broken
        ? { name: 'opencode', state: 'error', detail: 'No such container: 20e4aee6' }
        : { name: 'opencode', state: 'ready', version: '1.18.9' }
    }))
    // A generous TTL: pre-fix this is exactly the window that froze the verdict.
    mountHealth(app, { registry }, { cacheMs: 60_000, probe: (b) => b.health() })

    const first = await (await app.request('/health')).json() as HealthBody
    expect(first.status).toBe('degraded')
    expect(first.backends[0]!.cached).toBe(false)

    // Repeated polls must keep re-probing a FAILING backend.
    await app.request('/health')
    await app.request('/health')
    expect(probes).toBe(3)

    // Operator fixes the fault. No restart.
    broken = false
    const recovered = await (await app.request('/health')).json() as HealthBody
    expect(recovered.status).toBe('ok')
    expect(recovered.backends[0]!.state).toBe('ready')
    expect(recovered.backends[0]!.cached).toBe(false)
  })

  it('still serves a READY verdict from cache, so the watchdog spawn storm cannot return', async () => {
    const app = new Hono()
    let probes = 0
    const registry = new BackendRegistry().register(new ScriptedBackend('opencode', () => {
      probes += 1
      return { name: 'opencode', state: 'ready', version: '1.18.9' }
    }))
    mountHealth(app, { registry }, { cacheMs: 60_000, probe: (b) => b.health() })
    await app.request('/health')
    await app.request('/health')
    await app.request('/health')
    expect(probes).toBe(1)
  })

  it('marks a cached verdict as cached and dates it to its own probe, not to the response', async () => {
    const app = new Hono()
    let nowValue = 1_000_000
    const registry = new BackendRegistry().register(
      new ScriptedBackend('opencode', () => ({ name: 'opencode', state: 'ready', version: '1.18.9' })),
    )
    mountHealth(app, { registry }, { cacheMs: 60_000, now: () => nowValue, probe: (b) => b.health() })

    const fresh = await (await app.request('/health')).json() as HealthBody
    expect(fresh.backends[0]!.cached).toBe(false)
    expect(fresh.backends[0]!.probed_at).toBe(new Date(1_000_000).toISOString())

    nowValue += 20_000
    const cached = await (await app.request('/health')).json() as HealthBody
    // The response is fresh; the VERDICT is 20s old and says so. Pre-fix the only
    // timestamp was the response's, so a stale verdict looked live.
    expect(cached.ts).toBe(new Date(1_020_000).toISOString())
    expect(cached.backends[0]!.cached).toBe(true)
    expect(cached.backends[0]!.probed_at).toBe(new Date(1_000_000).toISOString())
    expect(cached.backends[0]!.probed_at).not.toBe(cached.ts)
  })
})
