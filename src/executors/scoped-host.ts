/**
 * Scoped host spawner — wraps node `spawn` in a transient systemd
 * `--user --scope` so the entire process tree lives in its own cgroup.
 *
 * Why this exists:
 *
 *   The default hostSpawner relies on `detached: true` + `kill(-pgid)`
 *   to reap the spawned CLI and its descendants. That works as long
 *   as descendants stay in the original process group. It does not
 *   work for grandchildren that call `setsid()` to escape — e.g.
 *   vitest workers, `pnpm dev` child servers, or test fixtures that
 *   intentionally install `process.on('SIGTERM', () => {})` and keep
 *   themselves alive with `setInterval(() => {}, 1000)`.
 *
 *   Production failure mode this addresses (2026-05-22 → 2026-05-23):
 *   LLM CLIs invoked via cli-bridge ran `pnpm test` inside PR
 *   review worktrees. The vitest children of those test runs
 *   detached into their own process groups, survived `killTree()`,
 *   and accumulated in the cli-bridge.service cgroup. Over ~36 hours
 *   the bridge's TasksMax saturated (766/768) and every subsequent
 *   spawn returned EAGAIN. The pr-reviewer aggregator published
 *   "⚠️ Review Failed — All review passes errored" on every open PR
 *   across six repos.
 *
 * Strategy:
 *
 *   For each spawn, ask the user systemd manager to create a
 *   transient scope under `cli-bridge-llm.slice`:
 *
 *     systemd-run --user --scope --collect --quiet
 *                 --unit=cli-bridge-<rand>.scope
 *                 --slice=cli-bridge-llm.slice
 *                 -- <bin> <args...>
 *
 *   The scope owns its own cgroup. On chat() finally we write `1`
 *   to the scope's `cgroup.kill` — a Linux 5.14+ kernel feature
 *   that SIGKILLs every task in the cgroup atomically, regardless
 *   of pgid manipulation. `--collect` removes the unit once empty.
 *
 *   killTree() still runs first to give the direct child a chance
 *   to flush stdout and exit cleanly; the cgroup-kill in release()
 *   is the belt-and-suspenders backstop that catches escapees.
 *
 * Fallback:
 *
 *   If systemd-run is unavailable (running outside a systemd user
 *   manager, in a minimal container, etc.) this spawner degrades
 *   to hostSpawner. Detection is a one-shot synchronous probe at
 *   module load — cheap and definitive.
 */

import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { promisify } from 'node:util'
import { hostSpawner, sanitizeHostEnv } from './host.js'
import { applyJail } from './jail-support.js'
import { killTree, retryCleanupUntilSuccessful } from './process-tree.js'
import {
  ExecutorAbortedError,
  throwIfExecutorAborted,
  type Spawner,
  type SpawnResult,
} from './types.js'

const SLICE = 'cli-bridge-llm.slice'
const DEFAULT_SCOPE_TASKS_MAX = 128
const DEFAULT_SCOPE_MEMORY_MAX = '3G'
const DEFAULT_SCOPE_RUNTIME_MAX_SEC = 7200
const DEFAULT_SCOPE_MAX_CONCURRENCY = 4
const DEFAULT_SCOPE_ACQUIRE_DEADLINE_MS = 60_000
const SYSTEMD_RUN_BIN = existsSync('/usr/bin/systemd-run') ? '/usr/bin/systemd-run' : '/bin/systemd-run'
const SYSTEMCTL_BIN = existsSync('/usr/bin/systemctl') ? '/usr/bin/systemctl' : '/bin/systemctl'
const execFileAsync = promisify(execFile)

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
}

class ScopedSemaphore {
  private inFlight = 0
  private readonly waiters: Waiter[] = []
  acquires = 0
  timeouts = 0

  constructor(
    private readonly max: number,
    private readonly acquireDeadlineMs: number,
  ) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    this.acquires += 1
    throwIfExecutorAborted(signal)
    if (this.inFlight < this.max) {
      this.inFlight += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer)
        if (idx < 0) return
        const [waiter] = this.waiters.splice(idx, 1)
        if (waiter?.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
        this.timeouts += 1
        reject(
          new Error(
            `scoped-host-executor: acquire timeout after ${this.acquireDeadlineMs}ms ` +
              `(in_flight=${this.inFlight}/${this.max}, queued=${this.waiters.length}). ` +
              `Reduce parallel callers or raise CLI_BRIDGE_SCOPE_MAX_CONCURRENCY.`,
          ),
        )
      }, this.acquireDeadlineMs).unref()
      const waiter: Waiter = { resolve, reject, timer, signal }
      const onAbort = (): void => {
        const idx = this.waiters.indexOf(waiter)
        if (idx < 0) return
        this.waiters.splice(idx, 1)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(new ExecutorAbortedError(signal?.reason))
      }
      waiter.onAbort = onAbort
      this.waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  release(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters.shift()!
      clearTimeout(next.timer)
      if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort)
      if (next.signal?.aborted) {
        next.reject(new ExecutorAbortedError(next.signal.reason))
        continue
      }
      next.resolve()
      return
    }
    if (this.inFlight > 0) this.inFlight -= 1
  }

  snapshot(): { in_flight: number; max: number; queued: number; acquires: number; timeouts: number } {
    return {
      in_flight: this.inFlight,
      max: this.max,
      queued: this.waiters.length,
      acquires: this.acquires,
      timeouts: this.timeouts,
    }
  }
}

const scopedSemaphore = new ScopedSemaphore(
  positiveIntEnv('CLI_BRIDGE_SCOPE_MAX_CONCURRENCY', DEFAULT_SCOPE_MAX_CONCURRENCY),
  positiveIntEnv('CLI_BRIDGE_SCOPE_ACQUIRE_DEADLINE_MS', DEFAULT_SCOPE_ACQUIRE_DEADLINE_MS),
)

export interface ScopeLimits {
  tasksMax: number
  memoryMax: string
  runtimeMaxSec: number
}

function currentScopeLimits(): ScopeLimits {
  return {
    tasksMax: positiveIntEnv('CLI_BRIDGE_SCOPE_TASKS_MAX', DEFAULT_SCOPE_TASKS_MAX),
    memoryMax: process.env.CLI_BRIDGE_SCOPE_MEMORY_MAX || DEFAULT_SCOPE_MEMORY_MAX,
    runtimeMaxSec: positiveIntEnv('CLI_BRIDGE_SCOPE_RUNTIME_MAX_SEC', DEFAULT_SCOPE_RUNTIME_MAX_SEC),
  }
}

export function scopeControlArgs(unitName: string, limits: ScopeLimits): string[] {
  return [
    '--user',
    '--scope',
    '--collect',
    '--quiet',
    `--unit=${unitName}`,
    `--slice=${SLICE}`,
    `--property=TasksMax=${limits.tasksMax}`,
    `--property=MemoryMax=${limits.memoryMax}`,
    `--property=RuntimeMaxSec=${limits.runtimeMaxSec}`,
    '--property=OOMPolicy=stop',
  ]
}

/** Result of the exact-property probe, cached per configured limit set. */
let systemdRunProbe: { signature: string; usable: boolean } | null = null

function probeSystemdRun(limits: ScopeLimits): boolean {
  const signature = JSON.stringify(limits)
  if (systemdRunProbe?.signature === signature) return systemdRunProbe.usable
  try {
    // systemd-run is at a stable path on every distro we support.
    // We probe by spawning `systemd-run --user --scope --quiet -- /bin/true`
    // synchronously is awkward, so probe by file existence + a cheap
    // env check. The actual call site catches spawn errors and falls
    // back per-invocation; this just avoids the overhead of trying
    // when we know systemd-run can't work.
    if (!existsSync('/usr/bin/systemd-run') && !existsSync('/bin/systemd-run')) {
      systemdRunProbe = { signature, usable: false }
      return false
    }
    // User systemd manager must be reachable. The private socket is only a
    // hint: managed sandboxes can expose the path while denying the actual
    // bus operation. Run the same kind of scope this spawner will use so a
    // false positive falls back to the host executor before any real child
    // receives a pipe that systemd will immediately close.
    const xdg = process.env.XDG_RUNTIME_DIR
    if (!xdg) { systemdRunProbe = { signature, usable: false }; return false }
    if (!existsSync(`${xdg}/systemd/private`)) { systemdRunProbe = { signature, usable: false }; return false }
    const unitName = `cli-bridge-probe-${process.pid}-${randomBytes(4).toString('hex')}.scope`
    execFileSync(
      SYSTEMD_RUN_BIN,
      [
        ...scopeControlArgs(unitName, limits),
        '--wait',
        '--',
        '/bin/true',
      ],
      { stdio: 'ignore', timeout: 3_000 },
    )
    systemdRunProbe = { signature, usable: true }
    return true
  } catch {
    systemdRunProbe = { signature, usable: false }
    return false
  }
}

/** Resolve a process's cgroup-v2 path from `/proc/<pid>/cgroup`. */
function resolveProcessControlGroup(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
    const line = raw.split('\n').find((l) => l.startsWith('0::'))
    if (!line) return null
    const controlGroup = line.slice(3)
    return controlGroup.startsWith('/') ? controlGroup : null
  } catch {
    return null
  }
}

function isCanonicalControlGroup(value: string): boolean {
  return value.startsWith('/') && value !== '/' && posix.normalize(value) === value && !/[\0\r\n]/.test(value)
}

function isOwnedScopeUnitName(unitName: string): boolean {
  return /^cli-bridge-[1-9]\d*-[0-9a-f]{12}\.scope$/.test(unitName)
}

function isSameOrAncestor(candidate: string, path: string): boolean {
  const rel = posix.relative(candidate, path)
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel))
}

/**
 * Prove a systemd-reported cgroup belongs to the exact random scope this
 * process created. A PID-derived path is insufficient: when systemd-run fails,
 * its wrapper remains in the caller's service/tmux cgroup.
 */
export function isOwnedScopeControlGroup(
  controlGroup: string,
  unitName: string,
  currentControlGroup: string | null,
): boolean {
  if (!isOwnedScopeUnitName(unitName)) return false
  if (!isCanonicalControlGroup(controlGroup)) return false
  if (!currentControlGroup || !isCanonicalControlGroup(currentControlGroup)) return false

  const parts = controlGroup.split('/').filter(Boolean)
  if (parts.at(-1) !== unitName || parts.at(-2) !== SLICE) return false

  const normalizedCurrent = posix.normalize(currentControlGroup)
  if (normalizedCurrent !== currentControlGroup || /[\0\r\n]/.test(normalizedCurrent)) return false
  // Never target the bridge's own cgroup or any of its ancestors. Killing a
  // descendant is safe; killing an ancestor terminates the bridge and its
  // interactive caller along with the intended child.
  return !isSameOrAncestor(controlGroup, normalizedCurrent)
}

export interface ScopeUnitState {
  loadState: string
  activeState: string
  controlGroup: string | null
}

export interface ScopeCleanupOperations {
  showUnit(unitName: string): Promise<ScopeUnitState>
  stopUnit(unitName: string): Promise<void>
  currentControlGroup(): string | null
  cgroupIsPopulated(controlGroup: string): boolean
  writeCgroupKill(controlGroup: string): Promise<void>
  wait(ms: number): Promise<void>
}

function confirmedMissingUnit(error: unknown): boolean {
  const candidate = error as { message?: unknown; stdout?: unknown; stderr?: unknown }
  const text = [candidate.message, candidate.stdout, candidate.stderr]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
  return /unit .+ (?:could not be found|not found|is not loaded)|no such unit/iu.test(text)
}

async function showScopeUnit(unitName: string): Promise<ScopeUnitState> {
  try {
    const { stdout } = await execFileAsync(
      SYSTEMCTL_BIN,
      ['--user', 'show', '--property=LoadState', '--property=ActiveState', '--property=ControlGroup', unitName],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 4096 },
    )
    const properties = Object.fromEntries(stdout.trim().split('\n').map(line => {
      const separator = line.indexOf('=')
      return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)]
    }))
    return {
      loadState: properties.LoadState ?? '',
      activeState: properties.ActiveState ?? '',
      controlGroup: properties.ControlGroup || null,
    }
  } catch (error) {
    if (confirmedMissingUnit(error)) {
      return { loadState: 'not-found', activeState: 'inactive', controlGroup: null }
    }
    throw error
  }
}

async function stopScopeUnitStrict(unitName: string): Promise<void> {
  try {
    await execFileAsync(
      SYSTEMCTL_BIN,
      ['--user', '--quiet', 'stop', unitName],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 4096 },
    )
  } catch (error) {
    if (!confirmedMissingUnit(error)) throw error
  }
}

function cgroupIsPopulated(controlGroup: string): boolean {
  const cgPath = `/sys/fs/cgroup${controlGroup}`
  if (!existsSync(cgPath)) return false
  if (!statSync(cgPath).isDirectory()) throw new Error(`scope cgroup is not a directory: ${cgPath}`)
  try {
    const events = readFileSync(`${cgPath}/cgroup.events`, 'utf8')
    const populated = /^populated\s+([01])$/mu.exec(events)
    if (populated) return populated[1] === '1'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  try {
    return readFileSync(`${cgPath}/cgroup.procs`, 'utf8').trim().length > 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const defaultScopeCleanupOperations: ScopeCleanupOperations = {
  showUnit: showScopeUnit,
  stopUnit: stopScopeUnitStrict,
  currentControlGroup: () => resolveProcessControlGroup(process.pid),
  cgroupIsPopulated,
  writeCgroupKill: async controlGroup => {
    const cgPath = `/sys/fs/cgroup${controlGroup}`
    if (!statSync(cgPath).isDirectory()) throw new Error(`scope cgroup is not a directory: ${cgPath}`)
    await writeFile(`${cgPath}/cgroup.kill`, '1')
  },
  wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

/** Stop one exact bridge-owned scope and prove it is empty before returning. */
export async function terminateOwnedScope(
  unitName: string,
  operations: ScopeCleanupOperations = defaultScopeCleanupOperations,
  timeoutMs = 3_000,
): Promise<void> {
  if (!isOwnedScopeUnitName(unitName)) throw new Error(`refusing to stop unowned scope unit ${unitName}`)
  const initial = await operations.showUnit(unitName)
  if (initial.loadState === 'not-found') return

  const currentControlGroup = operations.currentControlGroup()
  const ownedControlGroup = initial.controlGroup
    && isOwnedScopeControlGroup(initial.controlGroup, unitName, currentControlGroup)
    ? initial.controlGroup
    : null
  let directKillError: unknown
  if (ownedControlGroup) {
    try {
      await operations.writeCgroupKill(ownedControlGroup)
    } catch (error) {
      directKillError = error
    }
  }
  if (!ownedControlGroup || directKillError !== undefined) {
    try {
      await operations.stopUnit(unitName)
    } catch (stopError) {
      if (directKillError !== undefined) {
        throw new AggregateError([directKillError, stopError], `failed to stop ${unitName}`)
      }
      throw stopError
    }
  }

  const deadline = Date.now() + timeoutMs
  while (true) {
    const state = await operations.showUnit(unitName)
    if (state.loadState === 'not-found') return
    const controlGroup = state.controlGroup
      && isOwnedScopeControlGroup(state.controlGroup, unitName, operations.currentControlGroup())
      ? state.controlGroup
      : ownedControlGroup
    const populated = controlGroup ? operations.cgroupIsPopulated(controlGroup) : false
    if (!populated && ['inactive', 'failed', 'dead'].includes(state.activeState)) return
    if (Date.now() >= deadline) {
      throw new Error(`scope ${unitName} remained ${state.activeState || 'present'} after termination`)
    }
    await operations.wait(25)
  }
}

async function killCgroup(unitName: string): Promise<void> {
  await terminateOwnedScope(unitName)
}

interface ScopeStartObservation {
  started: boolean
  error?: Error
}

export interface ScopedHostSpawnerDependencies {
  probe: (limits: ScopeLimits) => boolean
  invalidateProbe: (limits: ScopeLimits) => void
  semaphore: Pick<ScopedSemaphore, 'acquire' | 'release'>
  spawnProcess: typeof spawn
  fallbackSpawner: Spawner
  applyJailFn: typeof applyJail
  killTreeFn: typeof killTree
  killScopeFn: (unitName: string) => Promise<void>
  observeStart: (child: ChildProcess, markerPath: string, signal?: AbortSignal) => Promise<ScopeStartObservation>
  createMarker: () => { path: string; cleanup(): void }
}

function createScopeStartMarker(): { path: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'cli-bridge-scope-start-'))
  return {
    path: join(root, 'started'),
    cleanup: () => { rmSync(root, { recursive: true, force: true }) },
  }
}

async function observeScopeStart(
  child: ChildProcess,
  markerPath: string,
  signal?: AbortSignal,
  timeoutMs = 3_000,
): Promise<ScopeStartObservation> {
  return await new Promise(resolve => {
    let settled = false
    let spawnError: Error | null = null
    let interval: NodeJS.Timeout
    let timeout: NodeJS.Timeout
    const finish = (result: ScopeStartObservation): void => {
      if (settled) return
      settled = true
      clearInterval(interval)
      clearTimeout(timeout)
      child.off('error', onError)
      child.off('exit', onExit)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const check = (): void => {
      if (existsSync(markerPath)) {
        finish({ started: true })
      } else if (spawnError) {
        finish({ started: false, error: spawnError })
      } else if (child.exitCode !== null || child.signalCode !== null) {
        finish({
          started: false,
          error: new Error(
            `systemd-run exited before the workload started ` +
              `(code=${child.exitCode ?? 'null'}, signal=${child.signalCode ?? 'none'})`,
          ),
        })
      }
    }
    const onError = (error: Error): void => { spawnError = error; check() }
    const onExit = (): void => { check() }
    const onAbort = (): void => finish({ started: false, error: new ExecutorAbortedError(signal?.reason) })
    child.on('error', onError)
    child.on('exit', onExit)
    signal?.addEventListener('abort', onAbort, { once: true })
    interval = setInterval(check, 10)
    timeout = setTimeout(() => finish({
      started: false,
      error: new Error(`systemd-run did not start the workload within ${timeoutMs}ms`),
    }), timeoutMs)
    interval.unref()
    timeout.unref()
    if (signal?.aborted) onAbort()
    else check()
  })
}

const defaultScopedDependencies: ScopedHostSpawnerDependencies = {
  probe: probeSystemdRun,
  invalidateProbe: limits => {
    systemdRunProbe = { signature: JSON.stringify(limits), usable: false }
  },
  semaphore: scopedSemaphore,
  spawnProcess: spawn,
  fallbackSpawner: hostSpawner,
  applyJailFn: applyJail,
  killTreeFn: killTree,
  killScopeFn: killCgroup,
  observeStart: observeScopeStart,
  createMarker: createScopeStartMarker,
}

export function createScopedHostSpawner(
  overrides: Partial<ScopedHostSpawnerDependencies> = {},
): Spawner {
  const dependencies = { ...defaultScopedDependencies, ...overrides }
  return async (bin, args, opts) => {
  const limits = currentScopeLimits()
  if (!dependencies.probe(limits)) {
    return dependencies.fallbackSpawner(bin, args, opts)
  }

  await dependencies.semaphore.acquire(opts.signal)
  let semaphoreReleased = false
  const releaseSemaphore = (): void => {
    if (semaphoreReleased) return
    semaphoreReleased = true
    dependencies.semaphore.release()
  }

  // Unit name MUST be unique per spawn; collisions would refuse to
  // start. Include pid + 12 random hex chars (96 bits of entropy).
  const unitName = `cli-bridge-${process.pid}-${randomBytes(6).toString('hex')}.scope`

  // Wrap (bin, args) in the OS write-jail FIRST (when a spec is present),
  // then put the wrapped command inside the systemd scope: the cgroup
  // contains the launcher → CLI tree, so cgroup.kill still reaps it.
  // Pass-through (jailed.bin/args === bin/args) when no jail spec.
  let jailCleanup: (() => Promise<void> | void) | undefined
  let jailed
  try {
    jailed = await dependencies.applyJailFn(bin, args, opts)
    jailCleanup = jailed.cleanup
  } catch (err) {
    releaseSemaphore()
    throw err
  }
  let jailCleaned = jailCleanup === undefined
  const cleanupJail = async (): Promise<void> => {
    if (jailCleaned) return
    await jailCleanup!()
    jailCleaned = true
  }
  const cleanupJailAndRelease = async (): Promise<void> => {
    await cleanupJail()
    releaseSemaphore()
  }
  const rollbackBeforeSpawn = async (error: unknown, context: string): Promise<never> => {
    try {
      await cleanupJailAndRelease()
    } catch (cleanupError) {
      retryCleanupUntilSuccessful(cleanupJailAndRelease)
      throw new AggregateError([error, cleanupError], context)
    }
    throw error
  }
  try {
    throwIfExecutorAborted(opts.signal)
  } catch (error) {
    return await rollbackBeforeSpawn(
      error,
      'scoped host request was cancelled and jail cleanup failed',
    )
  }

  const exactEnvironment = opts.exactEnv
    ? Object.entries(jailed.env ?? {})
      .filter(([, value]) => typeof value === 'string' && value.length > 0)
      .map(([key, value]) => `${key}=${value}`)
    : []
  const childCommand = opts.exactEnv
    ? ['/usr/bin/env', '-i', ...exactEnvironment, jailed.bin, ...jailed.args]
    : [jailed.bin, ...jailed.args]
  let marker: ReturnType<ScopedHostSpawnerDependencies['createMarker']>
  try {
    marker = dependencies.createMarker()
  } catch (error) {
    return await rollbackBeforeSpawn(
      error,
      'scoped host marker creation and jail cleanup failed',
    )
  }
  let markerCleaned = false
  const cleanupMarker = (): void => {
    if (markerCleaned) return
    marker.cleanup()
    markerCleaned = true
  }
  const cleanupOwnedArtifacts = async (): Promise<void> => {
    const failures: unknown[] = []
    try { cleanupMarker() } catch (error) { failures.push(error) }
    try { await cleanupJail() } catch (error) { failures.push(error) }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'failed to remove scoped host temporary artifacts')
    }
  }
  const cleanupArtifactsAndRelease = async (): Promise<void> => {
    await cleanupOwnedArtifacts()
    releaseSemaphore()
  }
  const wrapped: string[] = [
    ...scopeControlArgs(unitName, limits),
    '--',
    '/bin/sh',
    '-c',
    'set -eu; marker=$1; shift; (umask 077; : > "$marker"); exec "$@"',
    'cli-bridge-scope',
    marker.path,
    ...childCommand,
  ]

  let child: ChildProcess
  try {
    child = dependencies.spawnProcess(SYSTEMD_RUN_BIN, wrapped, {
      stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd,
      env: opts.exactEnv ? jailed.env : sanitizeHostEnv(jailed.env, opts.cwd),
      // `detached: true` makes the wrapper a process-group leader, so
      // existing killTree() (kill -pgid) still works as the graceful
      // first signal. The cgroup-kill in release() is the hard backstop.
      detached: true,
    })
  } catch (err) {
    try {
      await cleanupArtifactsAndRelease()
    } catch (cleanupError) {
      retryCleanupUntilSuccessful(cleanupArtifactsAndRelease)
      throw new AggregateError([err, cleanupError], 'scoped host spawn and temporary-artifact cleanup failed')
    }
    throw err
  }

  let spawnError: Error | null = null
  child.on('error', (err) => { spawnError = err })
  const start = await dependencies.observeStart(child, marker.path, opts.signal).catch(
    (error: unknown): ScopeStartObservation => ({
      started: false,
      error: error instanceof Error ? error : new Error(String(error)),
    }),
  )
  if (!start.started) {
    let processGroupFailure: unknown
    try { await dependencies.killTreeFn(child) } catch (error) { processGroupFailure = error }
    let scopeFailure: unknown
    try {
      await dependencies.killScopeFn(unitName)
    } catch (error) {
      scopeFailure = error
    }
    dependencies.invalidateProbe(limits)
    if (scopeFailure !== undefined) {
      // A missing marker is not proof that the shell never reached the
      // workload: it may have appeared just after the observation deadline.
      // Hold capacity and keep retrying the exact scope cleanup. Starting an
      // unscoped copy here could run the same request twice.
      const finishUncertainScope = async (): Promise<void> => {
        await dependencies.killScopeFn(unitName)
        await cleanupArtifactsAndRelease()
      }
      retryCleanupUntilSuccessful(finishUncertainScope)
      throw new AggregateError(
        [start.error, processGroupFailure, scopeFailure].filter(Boolean),
        'systemd scope start was uncertain and termination could not be proven',
      )
    }
    const failures: unknown[] = [start.error, processGroupFailure].filter(Boolean)
    try {
      await cleanupArtifactsAndRelease()
    } catch (error) {
      failures.push(error)
      retryCleanupUntilSuccessful(cleanupArtifactsAndRelease)
    }
    throw new AggregateError(
      failures,
      'systemd scope did not confirm workload start; the request was not retried',
    )
  }

  let finalization: Promise<void> | null = null
  let onAbort: (() => void) | undefined
  const finalizeOwnership = (): Promise<void> => {
    if (finalization) return finalization
    const attempt = (async () => {
      let processGroupFailure: unknown
      try { await dependencies.killTreeFn(child) } catch (error) { processGroupFailure = error }
      try {
        // The cgroup result is authoritative and can recover a failed process-
        // group attempt, including descendants that called setsid().
        await dependencies.killScopeFn(unitName)
      } catch (scopeError) {
        if (processGroupFailure !== undefined) {
          throw new AggregateError([processGroupFailure, scopeError], `failed to terminate ${unitName}`)
        }
        throw scopeError
      }
      await cleanupOwnedArtifacts()
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort)
      releaseSemaphore()
    })()
    finalization = attempt
    void attempt.catch(() => {
      if (finalization === attempt) finalization = null
      retryCleanupUntilSuccessful(finalizeOwnership)
    })
    return attempt
  }

  const release = (): void => {
    // The interface keeps release synchronous, but the capacity token is held
    // until the owned scope and jail files are actually gone. Backends await
    // terminate() first; this path also protects older direct release callers.
    void finalizeOwnership().catch(error => {
      console.error(`[cli-bridge] scoped host ${unitName} cleanup failed:`, error)
    })
  }

  const result: SpawnResult = {
    child,
    terminate: finalizeOwnership,
    release,
    spawnError: () => spawnError,
  }
  onAbort = (): void => { void finalizeOwnership() }
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  if (opts.signal?.aborted) onAbort()
  child.once('exit', release)
  child.once('error', release)
  if (child.exitCode !== null || child.signalCode !== null) queueMicrotask(release)
  return result
  }
}

export const scopedHostSpawner: Spawner = createScopedHostSpawner()

/** Diagnostics for /metrics. */
export function scopedHostExecutorSnapshot(): {
  in_flight: number
  max: number
  queued: number
  acquires: number
  timeouts: number
} {
  return scopedSemaphore.snapshot()
}

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}
