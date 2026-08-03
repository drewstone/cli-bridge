/**
 * Second pass over the same defect class: NO FAILURE MAY PRESENT AS A
 * DIFFERENT FAILURE. Each test below encodes a case that survived the first
 * pass and was reproduced live on the fixed build.
 *
 *   1. A backend that fails AFTER its first delta returned HTTP 200,
 *      `finish_reason: "error"`, `content: ""` and no message at all — the only
 *      copy of the reason went to the bridge's stdout
 *      (`BackendError: opencode: opencode error { code: 'upstream' }`).
 *      `Run.pump` recorded the error only `if (this.seq === 0)`, so every
 *      post-output failure — which is what a credential/auth failure actually
 *      produces — lost its reason. An empty completion reads as a model
 *      problem, which is the exact misattribution this class is about.
 *
 *   2. `preflight ok` + /health `ready` with ZERO credentials in the pool. The
 *      empty-credential warning skipped `kind !== 'bind'`, so per-slot volumes
 *      were never looked at, and the check was "is the directory non-empty"
 *      rather than "does it hold credentials". Measured on this host:
 *        /home/drew/.config/opencode      -> 6 entries, NO auth.json
 *        /home/drew/.local/share/opencode -> auth.json (432 B)
 *      i.e. the DEFAULT opencode docker mount (.config/opencode) carries no
 *      credentials at all, which is why the operator had to hand-pin
 *      OPENCODE_DOCKER_HOST_CONFIG_DIR to the data dir to get a working bridge.
 *
 *   3. A request that sent NO cwd was refused with
 *      "this request asks to run in /home/drew/code/cli-bridge-preflight" —
 *      the BRIDGE'S own working directory, injected by the backend
 *      (`req.cwd ?? session?.cwd ?? process.cwd()`). The remedy it offered
 *      ("send requests without a cwd") was the thing the caller had already
 *      done and is unreachable through the HTTP API.
 *
 *   4. Slot self-healing was checked in `handOut` only, which is the free-slot
 *      path. A QUEUED waiter went through `releaseSlot -> waiter.resolve ->
 *      markAcquired` and was handed the removed container id at any TTL, so
 *      the pool healed only when idle — never when saturated, which is the
 *      condition it exists for.
 *
 *   5. The top-level `status` and HTTP code were computed from possibly-cached
 *      backend verdicts with no staleness marker while `ts` was always fresh,
 *      so a bridge with zero containers answered `status: "ok"` + 200 for the
 *      full cache TTL. Per-backend `probed_at`/`cached` were honest; the two
 *      fields a watchdog reads were not.
 */

import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'

const TEST_RESOURCE_OWNER = '2'.repeat(64)
import { loadConfig } from '../src/config.js'
import { ContainerPool } from '../src/executors/container-pool.js'
import { createDockerSpawner } from '../src/executors/docker.js'
import { resolveSpawnerCwd } from '../src/executors/types.js'
import {
  buildCommandFor,
  preflightDockerImage,
  preflightDockerSlot,
  type DockerPreflightTarget,
} from '../src/executors/docker-preflight.js'
import type { DockerCli, DockerCliResult } from '../src/executors/docker-cli.js'
import { mountHealth } from '../src/routes/health.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { BackendRegistry } from '../src/backends/registry.js'
import { OpencodeBackend } from '../src/backends/opencode.js'
import { BackendError, type Backend, type BackendHealth, type ChatDelta } from '../src/backends/types.js'
import { SessionStore } from '../src/sessions/store.js'
import { RunRegistry } from '../src/runs/registry.js'

// ─── helpers ─────────────────────────────────────────────────────────────

const tempDirs: string[] = []
const stores: SessionStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function childExiting(code: number, stdoutText: string, stderrText = ''): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  const stderr = new PassThrough()
  ;(child as unknown as { stdout: Readable }).stdout = Readable.from(stdoutText ? [stdoutText] : [])
  ;(child as unknown as { stderr: PassThrough }).stderr = stderr
  ;(child as unknown as { stdin: PassThrough }).stdin = new PassThrough()
  ;(child as unknown as { pid: number }).pid = 4242
  ;(child as unknown as { kill: () => boolean }).kill = () => true
  // `null` while running, like a real ChildProcess: `waitForProcessClose`
  // short-circuits on any non-null value, so `undefined` here would be read as
  // "exited undefined" and every fake run would look like a CLI failure.
  ;(child as unknown as { exitCode: number | null }).exitCode = null
  setImmediate(() => {
    if (stderrText) stderr.write(stderrText)
    stderr.end()
    ;(child as unknown as { exitCode: number | null }).exitCode = code
    child.emit('close', code)
  })
  return child
}

/** A backend that emits `deltas`, then throws — the post-output failure shape. */
function throwingBackend(deltas: ChatDelta[], error: unknown): Backend {
  return {
    name: 'opencode',
    matches: (model: string) => model === 'opencode' || model.startsWith('opencode/'),
    health: async (): Promise<BackendHealth> => ({ name: 'opencode', state: 'ready' }),
    chat: async function* (): AsyncIterable<ChatDelta> {
      for (const d of deltas) yield d
      throw error
    },
  } as unknown as Backend
}

function chatApp(backend: Backend): Hono {
  const app = new Hono()
  const registry = new BackendRegistry().register(backend)
  const sessions = new SessionStore(tempDir('cli-bridge-attribution-store-'))
  stores.push(sessions)
  mountChatCompletions(app, { registry, sessions, runs: new RunRegistry({}) })
  return app
}

async function postChat(app: Hono, body: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

async function streamChat(app: Hono, body: unknown): Promise<string> {
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(body as object), stream: true }),
  })
  return await res.text()
}

const ok = (stdout = ''): DockerCliResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string, code = 1): DockerCliResult => ({ code, stdout: '', stderr })

function ownershipInspect(args: string[], exists: (name: string) => boolean): DockerCliResult | null {
  if (args[0] !== 'container' || args[1] !== 'inspect') return null
  const name = args[args.length - 1]!
  return exists(name) ? ok(`${TEST_RESOURCE_OWNER}\n`) : fail(`Error: No such container: ${name}`)
}

function target(over: Partial<DockerPreflightTarget> = {}): DockerPreflightTarget {
  return {
    backend: 'opencode',
    envPrefix: 'OPENCODE',
    image: 'cli-bridge-cli-runtime:latest',
    bin: 'opencode',
    containerHome: '/root',
    mounts: [{ source: '/host/.config/opencode', target: '/root/.config/opencode', kind: 'bind' }],
    buildCommand: buildCommandFor('cli-bridge-cli-runtime:latest'),
    ...over,
  }
}

/**
 * A container whose filesystem is described by `files`: every path listed
 * exists, and `ls -A <dir>` reports the children it has. Everything else the
 * slot preflight probes succeeds, so a failing check is the one under test.
 */
function containerWithFiles(files: string[], opts: { writableDirs?: string[] } = {}): DockerCli {
  const exists = (p: string): boolean => files.some((f) => f === p || f.startsWith(`${p}/`))
  return async (args) => {
    const script = args[args.length - 1] ?? ''
    if (args[0] === 'version') return ok('27.5.1')
    if (args[0] === 'image') return ok('sha256:1')
    if (script.includes('id -u')) return ok('0\n0\n/root')
    if (script.includes('HOME_WRITABLE')) return ok('HOME_WRITABLE')
    const lsMatch = /^ls -A '([^']+)'/u.exec(script)
    if (lsMatch) {
      const dir = lsMatch[1]!
      const children = files
        .filter((f) => f.startsWith(`${dir}/`))
        .map((f) => f.slice(dir.length + 1).split('/')[0]!)
      return ok(children.length > 0 ? `${[...new Set(children)].join('\n')}\n` : '')
    }
    const testMatch = /test -e '([^']+)'/u.exec(script)
    if (testMatch) return exists(testMatch[1]!) ? ok() : fail('', 1)
    const writeMatch = /(?:: >|touch) '([^']+)'/u.exec(script)
    if (writeMatch) {
      const dir = writeMatch[1]!.slice(0, writeMatch[1]!.lastIndexOf('/'))
      const writable = opts.writableDirs ?? null
      return writable === null || writable.includes(dir) ? ok() : fail(`touch: cannot touch: Permission denied`, 1)
    }
    if (script.includes('test -r')) return ok()
    if (script.includes('command -v')) return ok(`/usr/local/bin/opencode`)
    if (args.includes('--version')) return ok('1.18.9')
    return ok()
  }
}

/** Fake docker CLI for the pool: `alive` tracks which container ids still exist. */
function poolDocker(): {
  cli: DockerCli
  vanish: (id: string) => void
} {
  const state = { runs: 0 }
  const alive = new Set<string>()
  return {
    cli: async (args) => {
      const ownership = ownershipInspect(args, (id) => alive.has(id))
      if (ownership) return ownership
      if (args[0] === 'run') {
        state.runs += 1
        const id = `container-${state.runs}`
        alive.add(id)
        return ok(`${id}\n`)
      }
      if (args[0] === 'inspect') {
        const id = args[args.length - 1]!
        return alive.has(id) ? ok('true\n') : fail(`Error: No such object: ${id}`)
      }
      if (args[0] === 'rm') { alive.delete(args[args.length - 1]!); return ok() }
      return ok()
    },
    vanish: (id) => { alive.delete(id) },
  }
}

const basePool = {
  size: 1,
  image: 'cli-bridge-cli-runtime:latest',
  namePrefix: 'cli-bridge-attribution-test',
  oauthMode: 'share' as const,
  shareMounts: [],
  acquireDeadlineMs: 2_000,
  slotMaxHoldMs: 60_000,
}

// ─── 1. a failure after the first delta still carries its reason ─────────

describe('a post-output failure answers with its reason, not an empty 200', () => {
  it('returns the backend status and message when the run produced no content', async () => {
    // The measured shape: opencode emits its session id, then fails against
    // credentials that are not there. Pre-fix this was 200 + content:'' and the
    // reason existed only in the bridge's stdout.
    const app = chatApp(throwingBackend(
      [{ internal_session_id: 'ses_abc' }],
      new BackendError('opencode: no credentials in /root/.local/share/opencode', 'upstream'),
    ))

    const { status, json } = await postChat(app, {
      model: 'opencode/zai-coding-plan/glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(json.error?.message).toContain('no credentials in /root/.local/share/opencode')
    expect(json.error?.type).toBe('upstream')
    // Same status a pre-output BackendError('upstream') gets: the caller cannot
    // tell where in the stream the failure happened, and must not have to.
    expect(status).toBe(502)
  })

  it('keeps partial content AND names the failure when output had already started', async () => {
    const app = chatApp(throwingBackend(
      [{ content: 'partial answer' }],
      new BackendError('opencode: upstream closed the stream', 'upstream'),
    ))

    const { status, json } = await postChat(app, {
      model: 'opencode/zai-coding-plan/glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    })

    // Real work is not discarded, but the body says outright that it failed.
    expect(status).toBe(200)
    expect(json.choices[0].message.content).toBe('partial answer')
    expect(json.choices[0].finish_reason).toBe('error')
    expect(json.error?.message).toContain('upstream closed the stream')
    expect(json.error?.type).toBe('upstream')
  })

  it('streams the reason as an error frame instead of a bare terminal delta', async () => {
    const app = chatApp(throwingBackend(
      [{ content: 'partial answer' }],
      new BackendError('opencode: no credentials in /root/.local/share/opencode', 'upstream'),
    ))

    const body = await streamChat(app, {
      model: 'opencode/zai-coding-plan/glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(body).toContain('no credentials in /root/.local/share/opencode')
    expect(body).toContain('"type":"upstream"')
  })

  it('leaves a successful run untouched — no error field, no status change', async () => {
    const app = chatApp({
      name: 'opencode',
      matches: (m: string) => m.startsWith('opencode'),
      health: async () => ({ name: 'opencode', state: 'ready' as const }),
      chat: async function* () {
        yield { content: 'all good' }
        yield { finish_reason: 'stop' as const }
      },
    } as unknown as Backend)

    const { status, json } = await postChat(app, {
      model: 'opencode/zai-coding-plan/glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(status).toBe(200)
    expect(json.error).toBeUndefined()
    expect(json.choices[0].message.content).toBe('all good')
    expect(json.choices[0].finish_reason).toBe('stop')
  })
})

// ─── 2. credentials are proven, not assumed ──────────────────────────────

describe('a pool with no credentials in it cannot report preflight ok in silence', () => {
  it('warns about an EMPTY per-slot volume, not only about bind mounts', async () => {
    const warnings: string[] = []
    const findings = await preflightDockerSlot(
      target({ mounts: [{ source: 'cli-bridge-opencode-pool-oauth-0', target: '/root/.config/opencode', kind: 'volume' }] }),
      'abcdef1234567890',
      containerWithFiles([]),
      warnings,
    )

    expect(findings).toEqual([])
    expect(warnings.join('\n')).toMatch(/EMPTY/)
    expect(warnings.join('\n')).toContain('cli-bridge-opencode-pool-oauth-0')
    expect(warnings.join('\n')).toContain('opencode auth login')
  })

  it('warns when the mount holds files but NOT the credential file the CLI reads', async () => {
    // Measured: /home/drew/.config/opencode has 6 entries and no auth.json, so a
    // non-emptiness check passes on a directory that cannot authenticate.
    const warnings: string[] = []
    const findings = await preflightDockerSlot(
      target({
        mounts: [{
          source: '/home/drew/.config/opencode',
          target: '/root/.config/opencode',
          kind: 'bind',
          credentialFile: 'auth.json',
        }],
      }),
      'abcdef1234567890',
      containerWithFiles([
        '/root/.config/opencode/opencode.json',
        '/root/.config/opencode/package.json',
      ]),
      warnings,
    )

    expect(findings).toEqual([])
    expect(warnings.join('\n')).toContain('/root/.config/opencode/auth.json')
    expect(warnings.join('\n')).toContain('opencode auth login')
  })

  it('stays silent when the credential file is actually there', async () => {
    const warnings: string[] = []
    const findings = await preflightDockerSlot(
      target({
        mounts: [{
          source: '/home/drew/.local/share/opencode',
          target: '/root/.local/share/opencode',
          kind: 'bind',
          credentialFile: 'auth.json',
        }],
      }),
      'abcdef1234567890',
      containerWithFiles(['/root/.local/share/opencode/auth.json']),
      warnings,
    )

    expect(findings).toEqual([])
    expect(warnings).toEqual([])
  })

  it('names host permissions — not the image — when a credential mount is read-only', async () => {
    // The CLI writes into its own config dir (session state, refreshed tokens).
    // Pre-fix this could only be caught by the catch-all `<bin> --version` check,
    // whose remedy is "rebuild the image" — a neighbouring cause, not this one.
    const findings = await preflightDockerSlot(
      target({
        mounts: [{
          source: '/home/drew/.local/share/opencode',
          target: '/root/.local/share/opencode',
          kind: 'bind',
          credentialFile: 'auth.json',
        }],
      }),
      'abcdef1234567890',
      containerWithFiles(['/root/.local/share/opencode/auth.json'], { writableDirs: [] }),
    )

    expect(findings.map((f) => f.check)).toContain('auth-mount-writable')
    const finding = findings.find((f) => f.check === 'auth-mount-writable')!
    expect(finding.remedy).toContain('/home/drew/.local/share/opencode')
    expect(finding.remedy).not.toMatch(/rebuild the image/)
    // And it must not be reported as a broken CLI.
    expect(findings.map((f) => f.check)).not.toContain('trivial-exec')
  })

  it('mounts the directory opencode actually keeps auth.json in, by default', () => {
    // ~/.config/opencode holds config; ~/.local/share/opencode holds auth.json.
    // Mounting only the former is a pool with no credentials in it.
    const cfg = loadConfig({
      HOME: '/home/test',
      BRIDGE_BACKENDS: 'opencode',
      OPENCODE_EXECUTOR: 'docker',
    }).executors.opencode!
    const pairs = [
      `${cfg.hostConfigDir}:${cfg.containerConfigDir}`,
      ...(cfg.extraMounts ?? []).map((m) => `${m.host}:${m.container}`),
    ]

    expect(pairs).toContain('/home/test/.config/opencode:/root/.config/opencode')
    expect(pairs).toContain('/home/test/.local/share/opencode:/root/.local/share/opencode')
    expect(cfg.credentialFile).toBe('.local/share/opencode/auth.json')
  })

  it('keeps every credential mount inside a configured non-root HOME', () => {
    const cfg = loadConfig({
      HOME: '/home/test',
      BRIDGE_BACKENDS: 'opencode',
      OPENCODE_EXECUTOR: 'docker',
      OPENCODE_DOCKER_USER: '1000:1000',
      OPENCODE_DOCKER_HOME: '/home/node',
    }).executors.opencode!

    expect(cfg.containerConfigDir).toBe('/home/node/.config/opencode')
    expect((cfg.extraMounts ?? []).map((m) => m.container))
      .toEqual(['/home/node/.local/share/opencode'])
  })
})

// ─── 3. a request that sent no cwd is not blamed for the bridge's own ────

describe('a cwd-less request runs where the container can actually run', () => {
  function spawnerWith(workspaceRoot: string | undefined, seen: string[][]): ReturnType<typeof createDockerSpawner> {
    const pool = {
      acquire: async () => ({ containerId: 'container-1', slotIndex: 0, release: () => {} }),
      reportContainerUnusable: async () => {},
      recycleHeldSlot: async () => {},
    } as unknown as ContainerPool
    return createDockerSpawner({
      pool,
      backend: 'opencode',
      envPrefix: 'OPENCODE',
      ...(workspaceRoot ? { workspaceRoot } : {}),
      spawnProcess: ((_cmd: string, args: string[]) => {
        seen.push(args)
        // One opencode stream event, so the run succeeds for reasons other than
        // the cwd under test.
        return childExiting(0, `${JSON.stringify({ type: 'message.completed', text: 'ok' })}\n`)
      }) as never,
    })
  }

  it('resolves an absent cwd to the mounted workspace, not to the bridge process cwd', () => {
    const ws = tempDir('cli-bridge-attribution-ws-')
    const spawner = spawnerWith(ws, [])

    expect(resolveSpawnerCwd(spawner, undefined)).toBe(ws)
    // The bridge's own directory is never a legal answer on a docker executor.
    expect(resolveSpawnerCwd(spawner, undefined)).not.toBe(process.cwd())
  })

  it('a host spawner still defaults to the bridge process cwd', () => {
    const hostSpawner = (async () => { throw new Error('not spawned') }) as never
    expect(resolveSpawnerCwd(hostSpawner, undefined)).toBe(process.cwd())
    expect(resolveSpawnerCwd(hostSpawner, '/some/dir')).toBe('/some/dir')
  })

  it('serves a chat request that carries no cwd at all', async () => {
    const ws = tempDir('cli-bridge-attribution-ws-')
    const seen: string[][] = []
    const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 5_000, spawner: spawnerWith(ws, seen) })
    const app = chatApp(backend)

    const { status, json } = await postChat(app, {
      model: 'opencode/zai-coding-plan/glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    })

    // Pre-fix: 501 "this request asks to run in <the bridge's own directory>",
    // with a remedy the HTTP API cannot express.
    expect(json.error?.message ?? '').not.toMatch(/asks to run in/)
    expect(status).toBe(200)
    expect(seen[0]).toContain('--workdir')
    expect(seen[0]![seen[0]!.indexOf('--workdir') + 1]).toBe(ws)
  })

  it('refuses an unmounted generated config even when no cwd is sent', async () => {
    const seen: string[][] = []
    const spawner = spawnerWith(undefined, seen)
    expect(resolveSpawnerCwd(spawner, undefined)).toBeUndefined()

    const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 5_000, spawner })
    const { status, json } = await postChat(chatApp(backend), {
      model: 'opencode/zai-coding-plan/glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(status).toBe(501)
    expect(json.error?.message).toMatch(/cannot expose host-only path/u)
    expect(seen).toEqual([])
  })

  it('still refuses a cwd the container cannot see, and now names the remedy', () => {
    const ws = tempDir('cli-bridge-attribution-ws-')
    const outside = tempDir('cli-bridge-attribution-outside-')
    const spawner = spawnerWith(ws, [])

    expect(() => spawner.resolveCwd?.(outside)).toThrow(/OPENCODE_DOCKER_WORKSPACE_ROOT/)
    expect(() => spawner.resolveCwd?.(outside)).toThrow(/outside/)
  })

  it('gives a docker executor a mounted workspace by default, so the mode is not a promise it cannot keep', () => {
    const dataDir = tempDir('cli-bridge-attribution-data-')
    const cfg = loadConfig({
      HOME: '/home/test',
      BRIDGE_BACKENDS: 'opencode',
      BRIDGE_DATA_DIR: dataDir,
      OPENCODE_EXECUTOR: 'docker',
    }).executors.opencode!

    expect(cfg.workspaceRoot).toBe(join(dataDir, 'workspace', 'opencode'))
  })

  it('creates the workspace root during phase 1 rather than letting Docker create it as root', async () => {
    const base = tempDir('cli-bridge-attribution-wsroot-')
    const workspaceRoot = join(base, 'workspace', 'opencode')
    const findings = await preflightDockerImage(
      target({ workspaceRoot, mounts: [] }),
      containerWithFiles([]),
    )

    expect(findings).toEqual([])
    expect(() => writeFileSync(join(workspaceRoot, 'probe'), 'x')).not.toThrow()
  })

  it('reports a workspace root that cannot be created, naming the setting', async () => {
    const base = tempDir('cli-bridge-attribution-wsdeny-')
    const locked = join(base, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o500)
    const findings = await preflightDockerImage(
      target({ workspaceRoot: join(locked, 'ws'), mounts: [] }),
      containerWithFiles([]),
    )
    chmodSync(locked, 0o700)

    expect(findings.map((f) => f.check)).toEqual(['workspace-root'])
    expect(findings[0]!.remedy).toContain('OPENCODE_DOCKER_WORKSPACE_ROOT')
  })
})

// ─── 4. a queued waiter never receives a dead container ──────────────────

describe('slot self-healing covers the saturated pool, not only the idle one', () => {
  it('hands a QUEUED waiter a fresh container after the old one was removed', async () => {
    const docker = poolDocker()
    const pool = await ContainerPool.create({ resourceOwner: TEST_RESOURCE_OWNER, ...basePool, cli: docker.cli, livenessTtlMs: 0 })

    const first = await pool.acquire()
    const queued = pool.acquire()          // saturated: this one waits
    docker.vanish(first.containerId)       // host sweep / manual docker rm
    first.release()

    const served = await queued
    expect(served.containerId).not.toBe(first.containerId)
    served.release()
    await pool.destroy()
  })

  it('does not poison every waiter in the queue with the same dead id', async () => {
    const docker = poolDocker()
    const pool = await ContainerPool.create({ resourceOwner: TEST_RESOURCE_OWNER, ...basePool, cli: docker.cli, livenessTtlMs: 0 })

    const first = await pool.acquire()
    const q1 = pool.acquire()
    const q2 = pool.acquire()
    docker.vanish(first.containerId)
    first.release()

    const a = await q1
    a.release()
    const b = await q2
    expect([a.containerId, b.containerId]).not.toEqual([first.containerId, first.containerId])
    b.release()
    await pool.destroy()
  })

  it('still costs no docker round-trip on the warm queued path', async () => {
    const docker = poolDocker()
    let inspects = 0
    const counting: DockerCli = async (args) => {
      if (args[0] === 'inspect') inspects += 1
      return docker.cli(args)
    }
    const pool = await ContainerPool.create({ resourceOwner: TEST_RESOURCE_OWNER, ...basePool, cli: counting, livenessTtlMs: 60_000 })

    const first = await pool.acquire()
    const queued = pool.acquire()
    first.release()
    const served = await queued
    served.release()
    await pool.destroy()

    expect(inspects).toBe(0)
  })
})

// ─── 5. the top-level health verdict carries its own provenance ──────────

describe('/health cannot present a remembered verdict as a fresh one', () => {
  function healthApp(probe: () => Promise<BackendHealth>, now: () => number): Hono {
    const app = new Hono()
    const registry = new BackendRegistry().register({
      name: 'opencode',
      matches: () => true,
      health: probe,
      chat: async function* () { /* unused */ },
    } as unknown as Backend)
    mountHealth(app, { registry }, { cacheMs: 30_000, now, probe: (b) => b.health() })
    return app
  }

  it('marks the response when the verdict behind status:ok was not measured now', async () => {
    let clock = 1_000
    let probes = 0
    const app = healthApp(async () => {
      probes += 1
      return { name: 'opencode', state: 'ready', version: '1.18.9' }
    }, () => clock)

    const first = await (await app.request('/health')).json() as any
    expect(first.cached_verdicts).toBe(false)

    clock += 11_000
    const second = await (await app.request('/health')).json() as any
    expect(probes).toBe(1)
    expect(second.cached_verdicts).toBe(true)
    // The response is fresh; the verdict behind it is 11 s old and says so.
    expect(second.oldest_probed_at).toBe(new Date(1_000).toISOString())
    expect(second.ts).toBe(new Date(12_000).toISOString())
  })

  it('says the verdicts are fresh when they are', async () => {
    let clock = 1_000
    const app = healthApp(async () => ({ name: 'opencode', state: 'error', detail: 'container gone' }), () => clock)

    const first = await (await app.request('/health')).json() as any
    expect(first.cached_verdicts).toBe(false)
    clock += 11_000
    const second = await (await app.request('/health')).json() as any
    // A failing verdict is never cached, so the second answer is measured.
    expect(second.cached_verdicts).toBe(false)
    expect(second.oldest_probed_at).toBe(new Date(12_000).toISOString())
  })
})
