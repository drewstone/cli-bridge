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

import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { posix } from 'node:path'
import { promisify } from 'node:util'
import { hostSpawner, sanitizeHostEnv } from './host.js'
import { applyJail } from './jail-support.js'
import type { Spawner, SpawnResult } from './types.js'

const SLICE = 'cli-bridge-llm.slice'
const DEFAULT_SCOPE_TASKS_MAX = 128
const DEFAULT_SCOPE_MEMORY_MAX = '3G'
const DEFAULT_SCOPE_MAX_CONCURRENCY = 4
const DEFAULT_SCOPE_ACQUIRE_DEADLINE_MS = 60_000
const SYSTEMD_RUN_BIN = existsSync('/usr/bin/systemd-run') ? '/usr/bin/systemd-run' : '/bin/systemd-run'
const SYSTEMCTL_BIN = existsSync('/usr/bin/systemctl') ? '/usr/bin/systemctl' : '/bin/systemctl'
const execFileAsync = promisify(execFile)

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

class ScopedSemaphore {
  private inFlight = 0
  private bulkInFlight = 0
  private readonly waiters: Record<'reserved' | 'bulk', Waiter[]> = { reserved: [], bulk: [] }
  acquires = 0
  timeouts = 0

  constructor(
    private readonly max: number,
    private readonly acquireDeadlineMs: number,
    /**
     * Slots inside `max` that only `reserved` callers may occupy. Mirrors the
     * host admission lane: reserving at admission alone is not enough, because
     * this semaphore is the tighter of the two whenever
     * CLI_BRIDGE_SCOPE_MAX_CONCURRENCY < BRIDGE_HOST_CHAT_MAX_ACTIVE.
     */
    private readonly reserved: number,
  ) {
    if (reserved < 0 || reserved >= max) {
      throw new Error(
        `invalid CLI_BRIDGE_SCOPE_RESERVED_CONCURRENCY: ${reserved} — expected an integer in [0, ${max - 1}]`,
      )
    }
  }

  private canAdmit(admissionClass: 'reserved' | 'bulk'): boolean {
    if (this.inFlight >= this.max) return false
    if (admissionClass === 'bulk') return this.bulkInFlight < this.max - this.reserved
    return true
  }

  private take(admissionClass: 'reserved' | 'bulk'): void {
    this.inFlight += 1
    if (admissionClass === 'bulk') this.bulkInFlight += 1
  }

  async acquire(admissionClass: 'reserved' | 'bulk' = 'bulk'): Promise<void> {
    this.acquires += 1
    if (this.canAdmit(admissionClass)) {
      this.take(admissionClass)
      return
    }
    await new Promise<void>((resolve, reject) => {
      const queue = this.waiters[admissionClass]
      const timer = setTimeout(() => {
        const idx = queue.findIndex((w) => w.timer === timer)
        if (idx >= 0) queue.splice(idx, 1)
        this.timeouts += 1
        reject(
          new Error(
            `scoped-host-executor: acquire timeout after ${this.acquireDeadlineMs}ms ` +
              `(lane=${admissionClass}, in_flight=${this.inFlight}/${this.max}, ` +
              `bulk=${this.bulkInFlight}/${this.max - this.reserved}, queued=${queue.length}). ` +
              `Reduce parallel callers or raise CLI_BRIDGE_SCOPE_MAX_CONCURRENCY.`,
          ),
        )
      }, this.acquireDeadlineMs).unref()
      queue.push({ resolve, reject, timer })
    })
  }

  release(admissionClass: 'reserved' | 'bulk' = 'bulk'): void {
    if (this.inFlight > 0) this.inFlight -= 1
    if (admissionClass === 'bulk' && this.bulkInFlight > 0) this.bulkInFlight -= 1
    // Reserved waiters first, FIFO within a lane.
    for (const lane of ['reserved', 'bulk'] as const) {
      const queue = this.waiters[lane]
      while (queue.length > 0 && this.canAdmit(lane)) {
        const next = queue.shift()
        if (!next) break
        clearTimeout(next.timer)
        this.take(lane)
        next.resolve()
      }
    }
  }

  snapshot(): {
    in_flight: number
    max: number
    queued: number
    acquires: number
    timeouts: number
    reserved: number
    bulk_in_flight: number
    bulk_max: number
    queued_reserved: number
    queued_bulk: number
  } {
    return {
      in_flight: this.inFlight,
      max: this.max,
      queued: this.waiters.reserved.length + this.waiters.bulk.length,
      acquires: this.acquires,
      timeouts: this.timeouts,
      reserved: this.reserved,
      bulk_in_flight: this.bulkInFlight,
      bulk_max: this.max - this.reserved,
      queued_reserved: this.waiters.reserved.length,
      queued_bulk: this.waiters.bulk.length,
    }
  }
}

const scopeMaxConcurrency = positiveIntEnv('CLI_BRIDGE_SCOPE_MAX_CONCURRENCY', DEFAULT_SCOPE_MAX_CONCURRENCY)

const scopedSemaphore = new ScopedSemaphore(
  scopeMaxConcurrency,
  positiveIntEnv('CLI_BRIDGE_SCOPE_ACQUIRE_DEADLINE_MS', DEFAULT_SCOPE_ACQUIRE_DEADLINE_MS),
  nonNegativeIntEnv('CLI_BRIDGE_SCOPE_RESERVED_CONCURRENCY', Math.min(2, scopeMaxConcurrency - 1)),
)

/** Result of the one-shot probe. `null` until first call, then cached. */
let systemdRunUsable: boolean | null = null

function probeSystemdRun(): boolean {
  if (systemdRunUsable !== null) return systemdRunUsable
  try {
    // systemd-run is at a stable path on every distro we support.
    // We probe by spawning `systemd-run --user --scope --quiet -- /bin/true`
    // synchronously is awkward, so probe by file existence + a cheap
    // env check. The actual call site catches spawn errors and falls
    // back per-invocation; this just avoids the overhead of trying
    // when we know systemd-run can't work.
    if (!existsSync('/usr/bin/systemd-run') && !existsSync('/bin/systemd-run')) {
      systemdRunUsable = false
      return false
    }
    // User systemd manager must be reachable. XDG_RUNTIME_DIR
    // pointing at a directory with systemd/private is the canonical
    // signal that `--user` will work.
    const xdg = process.env.XDG_RUNTIME_DIR
    if (!xdg) { systemdRunUsable = false; return false }
    if (!existsSync(`${xdg}/systemd/private`)) { systemdRunUsable = false; return false }
    systemdRunUsable = true
    return true
  } catch {
    systemdRunUsable = false
    return false
  }
}

/**
 * The env handed to the systemd-run wrapper.
 *
 * `undefined` is not an empty environment — it is Node's INHERIT, and the whole bridge environment
 * (PATH first among it) is what lets systemd-run resolve `pi`, `claude`, `codex`, `opencode` at all.
 * Spreading an undefined base into an object silently converted "inherit everything" into "these two
 * transport variables and nothing else": every unjailed host spawn lost its PATH at once, and the
 * bridge reported `Failed to find executable pi: No such file or directory` for every backend
 * simultaneously — a total outage that reads like four missing CLIs.
 *
 * So an absent base stays absent. The bus transport variables are read from `process.env` and are
 * therefore already present in an inherited environment; they only need re-injecting when a caller
 * supplied an explicit, narrowed env that stripped them (the case #126 fixed).
 */
export function resolveScopedSpawnEnv(
  hostEnv: NodeJS.ProcessEnv | undefined,
  busTransportEnv: Record<string, string>,
): NodeJS.ProcessEnv | undefined {
  if (hostEnv === undefined) return undefined
  return { ...hostEnv, ...busTransportEnv }
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

async function resolveUnitControlGroup(unitName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      SYSTEMCTL_BIN,
      ['--user', 'show', '--property=ControlGroup', '--value', unitName],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 4096 },
    )
    const lines = stdout.trim().split('\n')
    if (lines.length !== 1 || !lines[0]) return null
    return lines[0]
  } catch {
    return null
  }
}

async function stopScopeUnit(unitName: string): Promise<void> {
  if (!isOwnedScopeUnitName(unitName)) return
  try {
    await execFileAsync(
      SYSTEMCTL_BIN,
      ['--user', '--quiet', 'stop', unitName],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 4096 },
    )
  } catch {
    // The unit may already have exited and auto-collected.
  }
}

async function killCgroup(unitName: string): Promise<void> {
  const controlGroup = await resolveUnitControlGroup(unitName)
  const currentControlGroup = resolveProcessControlGroup(process.pid)
  if (controlGroup && isOwnedScopeControlGroup(controlGroup, unitName, currentControlGroup)) {
    const cgPath = `/sys/fs/cgroup${controlGroup}`
    try {
      if (!statSync(cgPath).isDirectory()) throw new Error('scope cgroup is not a directory')
      // cgroup.kill (Linux 5.14+) SIGKILLs every task in the cgroup
      // atomically. Faster than walking cgroup.procs and ignores
      // pgid manipulation by descendants.
      await writeFile(`${cgPath}/cgroup.kill`, '1')
      return
    } catch {
      // fall through to systemctl
    }
  }
  // Safe fallback: stop only the exact random unit. Never infer a kill target
  // from the launcher's PID when ownership could not be proven.
  await stopScopeUnit(unitName)
}

export const scopedHostSpawner: Spawner = async (bin, args, opts) => {
  if (!probeSystemdRun()) {
    return hostSpawner(bin, args, opts)
  }

  const admissionClass = opts.admissionClass ?? 'bulk'
  await scopedSemaphore.acquire(admissionClass)
  let semaphoreReleased = false
  const releaseSemaphore = (): void => {
    if (semaphoreReleased) return
    semaphoreReleased = true
    scopedSemaphore.release(admissionClass)
  }

  // Unit name MUST be unique per spawn; collisions would refuse to
  // start. Include pid + 12 random hex chars (96 bits of entropy).
  const unitName = `cli-bridge-${process.pid}-${randomBytes(6).toString('hex')}.scope`
  const tasksMax = positiveIntEnv('CLI_BRIDGE_SCOPE_TASKS_MAX', DEFAULT_SCOPE_TASKS_MAX)
  const runtimeMaxSec = optionalPositiveIntEnv('CLI_BRIDGE_SCOPE_RUNTIME_MAX_SEC')
  const memoryMax = process.env.CLI_BRIDGE_SCOPE_MEMORY_MAX || DEFAULT_SCOPE_MEMORY_MAX

  // Wrap (bin, args) in the OS write-jail FIRST (when a spec is present),
  // then put the wrapped command inside the systemd scope: the cgroup
  // contains the launcher → CLI tree, so cgroup.kill still reaps it.
  // Pass-through (jailed.bin/args === bin/args) when no jail spec.
  let jailCleanup: (() => Promise<void> | void) | undefined
  let jailed
  try {
    jailed = await applyJail(bin, args, opts)
    jailCleanup = jailed.cleanup
  } catch (err) {
    releaseSemaphore()
    throw err
  }

  const wrapped: string[] = [
    '--user',
    '--scope',
    '--collect',           // auto-remove the scope unit once empty
    '--quiet',
    `--unit=${unitName}`,
    `--slice=${SLICE}`,
    `--property=TasksMax=${tasksMax}`,
    `--property=MemoryMax=${memoryMax}`,
    ...(runtimeMaxSec === null ? [] : [`--property=RuntimeMaxSec=${runtimeMaxSec}`]),
    '--property=OOMPolicy=stop',
    '--',
    jailed.bin,
    ...jailed.args,
  ]

  // systemd-run itself resolves the user manager through XDG_RUNTIME_DIR /
  // DBUS_SESSION_BUS_ADDRESS in ITS environment. A backend with a strict child
  // env allowlist (prime) strips both, so without re-injecting the bridge's own
  // transport vars the wrapper exits 1 ("Failed to connect to bus") and the
  // failure is misattributed to the backend CLI. Transport plumbing, not
  // credentials — the payload ignores them.
  const busTransportEnv: Record<string, string> = {}
  for (const key of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] as const) {
    const value = process.env[key]
    if (value) busTransportEnv[key] = value
  }

  let child
  try {
    child = spawn(SYSTEMD_RUN_BIN, wrapped, {
      stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd,
      env: resolveScopedSpawnEnv(sanitizeHostEnv(jailed.env, opts.cwd), busTransportEnv),
      // `detached: true` makes the wrapper a process-group leader, so
      // existing killTree() (kill -pgid) still works as the graceful
      // first signal. The cgroup-kill in release() is the hard backstop.
      detached: true,
    })
  } catch (err) {
    releaseSemaphore()
    if (jailCleanup) void Promise.resolve(jailCleanup()).catch(() => {})
    throw err
  }

  let spawnError: Error | null = null
  child.on('error', (err) => { spawnError = err })
  child.once('exit', releaseSemaphore)
  child.once('error', releaseSemaphore)

  let released = false
  const release = (): void => {
    if (released) return
    released = true
    releaseSemaphore()
    // Fire-and-forget: writing 1 to cgroup.kill is synchronous from
    // the kernel's perspective; the actual SIGKILLs cascade
    // asynchronously and we don't need to await them. Errors are
    // swallowed because by the time release() runs the scope may
    // have already auto-collected if the child exited cleanly.
    void killCgroup(unitName).catch(() => {})
    // Idempotent via the `released` guard: jail temp state is torn down
    // exactly once regardless of which path (finally / exit / error)
    // fires release first.
    if (jailCleanup) void Promise.resolve(jailCleanup()).catch(() => {})
  }

  const result: SpawnResult = {
    child,
    release,
    spawnError: () => spawnError,
  }
  return result
}
scopedHostSpawner.executionEnvironment = 'host'

/** Concurrency ceiling of the scoped executor, for cross-gate coherence checks. */
export function scopedHostConcurrencyLimits(): { max: number; reserved: number } {
  const snap = scopedSemaphore.snapshot()
  return { max: snap.max, reserved: snap.reserved }
}

/** Diagnostics for /metrics. */
export function scopedHostExecutorSnapshot(): {
  in_flight: number
  max: number
  queued: number
  acquires: number
  timeouts: number
  reserved: number
  bulk_in_flight: number
  bulk_max: number
  queued_reserved: number
  queued_bulk: number
} {
  return scopedSemaphore.snapshot()
}

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function optionalPositiveIntEnv(name: string): number | null {
  const raw = process.env[name]
  if (raw === undefined || raw === '' || raw === '0') return null
  if (!/^\d+$/.test(raw)) {
    throw new Error(`invalid ${name}: expected a positive integer or 0 to disable`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`invalid ${name}: expected a positive integer or 0 to disable`)
  }
  return value
}

function nonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`invalid ${name}: ${raw} — expected a non-negative integer`)
  }
  return value
}
