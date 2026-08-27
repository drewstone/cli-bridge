import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { promisify } from 'node:util'
import { hostSpawner } from './host.js'
import { applyJail } from './jail-support.js'
import { killTree } from './process-tree.js'
import { ExecutorAbortedError, throwIfExecutorAborted, type Spawner } from './types.js'

export const SYSTEMD_RUN_BIN = existsSync('/usr/bin/systemd-run') ? '/usr/bin/systemd-run' : '/bin/systemd-run'
const SYSTEMCTL_BIN = existsSync('/usr/bin/systemctl') ? '/usr/bin/systemctl' : '/bin/systemctl'
const SLICE = 'cli-bridge-llm.slice'
const execFileAsync = promisify(execFile)
const DEFAULT_SCOPE_TASKS_MAX = 128
const DEFAULT_SCOPE_MEMORY_MAX = '3G'
const DEFAULT_SCOPE_RUNTIME_MAX_SEC = 7200
const DEFAULT_SCOPE_MAX_CONCURRENCY = 4
const DEFAULT_SCOPE_ACQUIRE_DEADLINE_MS = 60_000

interface Waiter {
  resolve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
}

export class ScopedSemaphore {
  private inFlight = 0
  private readonly waiters: Waiter[] = []
  acquires = 0
  timeouts = 0

  constructor(private readonly max: number, private readonly acquireDeadlineMs: number) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    this.acquires += 1
    throwIfExecutorAborted(signal)
    if (this.inFlight < this.max) { this.inFlight += 1; return }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex(waiter => waiter.timer === timer)
        if (index < 0) return
        const [waiter] = this.waiters.splice(index, 1)
        if (waiter?.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
        this.timeouts += 1
        reject(new Error(`scoped-host-executor: acquire timeout after ${this.acquireDeadlineMs}ms (in_flight=${this.inFlight}/${this.max}, queued=${this.waiters.length}). Reduce parallel callers or raise CLI_BRIDGE_SCOPE_MAX_CONCURRENCY.`))
      }, this.acquireDeadlineMs).unref()
      const waiter: Waiter = { resolve, reject, timer, signal }
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter)
        if (index < 0) return
        this.waiters.splice(index, 1)
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
      if (next.signal?.aborted) { next.reject(new ExecutorAbortedError(next.signal.reason)); continue }
      next.resolve()
      return
    }
    if (this.inFlight > 0) this.inFlight -= 1
  }

  snapshot(): { in_flight: number; max: number; queued: number; acquires: number; timeouts: number } {
    return { in_flight: this.inFlight, max: this.max, queued: this.waiters.length, acquires: this.acquires, timeouts: this.timeouts }
  }
}

export const scopedSemaphore = new ScopedSemaphore(
  positiveIntEnv('CLI_BRIDGE_SCOPE_MAX_CONCURRENCY', DEFAULT_SCOPE_MAX_CONCURRENCY),
  positiveIntEnv('CLI_BRIDGE_SCOPE_ACQUIRE_DEADLINE_MS', DEFAULT_SCOPE_ACQUIRE_DEADLINE_MS),
)

export interface ScopeLimits { tasksMax: number; memoryMax: string; runtimeMaxSec: number }

export function currentScopeLimits(): ScopeLimits {
  return {
    tasksMax: positiveIntEnv('CLI_BRIDGE_SCOPE_TASKS_MAX', DEFAULT_SCOPE_TASKS_MAX),
    memoryMax: process.env.CLI_BRIDGE_SCOPE_MEMORY_MAX || DEFAULT_SCOPE_MEMORY_MAX,
    runtimeMaxSec: positiveIntEnv('CLI_BRIDGE_SCOPE_RUNTIME_MAX_SEC', DEFAULT_SCOPE_RUNTIME_MAX_SEC),
  }
}

export function scopeControlArgs(unitName: string, limits: ScopeLimits): string[] {
  return ['--user', '--scope', '--collect', '--quiet', `--unit=${unitName}`, `--slice=${SLICE}`,
    `--property=TasksMax=${limits.tasksMax}`, `--property=MemoryMax=${limits.memoryMax}`,
    `--property=RuntimeMaxSec=${limits.runtimeMaxSec}`, '--property=OOMPolicy=stop']
}

let systemdRunProbe: { signature: string; usable: boolean } | null = null

function probeSystemdRun(limits: ScopeLimits): boolean {
  const signature = JSON.stringify(limits)
  if (systemdRunProbe?.signature === signature) return systemdRunProbe.usable
  try {
    if (!existsSync('/usr/bin/systemd-run') && !existsSync('/bin/systemd-run')) return cacheProbe(signature, false)
    const xdg = process.env.XDG_RUNTIME_DIR
    if (!xdg || !existsSync(`${xdg}/systemd/private`)) return cacheProbe(signature, false)
    const unitName = `cli-bridge-probe-${process.pid}-${randomBytes(4).toString('hex')}.scope`
    execFileSync(SYSTEMD_RUN_BIN, [...scopeControlArgs(unitName, limits), '--wait', '--', '/bin/true'], { stdio: 'ignore', timeout: 3_000 })
    return cacheProbe(signature, true)
  } catch { return cacheProbe(signature, false) }
}

function cacheProbe(signature: string, usable: boolean): boolean {
  systemdRunProbe = { signature, usable }
  return usable
}

function resolveProcessControlGroup(pid: number): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').find(value => value.startsWith('0::'))
    const group = line?.slice(3)
    return group?.startsWith('/') ? group : null
  } catch { return null }
}

function isCanonicalControlGroup(value: string): boolean {
  return value.startsWith('/') && value !== '/' && posix.normalize(value) === value && !/[\0\r\n]/.test(value)
}

function isOwnedScopeUnitName(unitName: string): boolean { return /^cli-bridge-[1-9]\d*-[0-9a-f]{12}\.scope$/.test(unitName) }
function isSameOrAncestor(candidate: string, path: string): boolean {
  const relative = posix.relative(candidate, path)
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
}

export function isOwnedScopeControlGroup(controlGroup: string, unitName: string, currentControlGroup: string | null): boolean {
  if (!isOwnedScopeUnitName(unitName) || !isCanonicalControlGroup(controlGroup) || !currentControlGroup || !isCanonicalControlGroup(currentControlGroup)) return false
  const parts = controlGroup.split('/').filter(Boolean)
  if (parts.at(-1) !== unitName || parts.at(-2) !== SLICE) return false
  if (posix.normalize(currentControlGroup) !== currentControlGroup || /[\0\r\n]/.test(currentControlGroup)) return false
  return !isSameOrAncestor(controlGroup, currentControlGroup)
}

export interface ScopeUnitState { loadState: string; activeState: string; controlGroup: string | null }
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
  const text = [candidate.message, candidate.stdout, candidate.stderr].filter((value): value is string => typeof value === 'string').join('\n')
  return /unit .+ (?:could not be found|not found|is not loaded)|no such unit/iu.test(text)
}

async function showScopeUnit(unitName: string): Promise<ScopeUnitState> {
  try {
    const { stdout } = await execFileAsync(SYSTEMCTL_BIN, ['--user', 'show', '--property=LoadState', '--property=ActiveState', '--property=ControlGroup', unitName], { encoding: 'utf8', timeout: 3000, maxBuffer: 4096 })
    const properties = Object.fromEntries(stdout.trim().split('\n').map(line => {
      const index = line.indexOf('='); return index < 0 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)]
    }))
    return { loadState: properties.LoadState ?? '', activeState: properties.ActiveState ?? '', controlGroup: properties.ControlGroup || null }
  } catch (error) {
    if (confirmedMissingUnit(error)) return { loadState: 'not-found', activeState: 'inactive', controlGroup: null }
    throw error
  }
}

async function stopScopeUnitStrict(unitName: string): Promise<void> {
  try { await execFileAsync(SYSTEMCTL_BIN, ['--user', '--quiet', 'stop', unitName], { encoding: 'utf8', timeout: 3000, maxBuffer: 4096 }) }
  catch (error) { if (!confirmedMissingUnit(error)) throw error }
}

function cgroupIsPopulated(controlGroup: string): boolean {
  const path = `/sys/fs/cgroup${controlGroup}`
  if (!existsSync(path)) return false
  if (!statSync(path).isDirectory()) throw new Error(`scope cgroup is not a directory: ${path}`)
  try {
    const populated = /^populated\s+([01])$/mu.exec(readFileSync(`${path}/cgroup.events`, 'utf8'))
    if (populated) return populated[1] === '1'
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  try { return readFileSync(`${path}/cgroup.procs`, 'utf8').trim().length > 0 }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

const defaultScopeCleanupOperations: ScopeCleanupOperations = {
  showUnit: showScopeUnit,
  stopUnit: stopScopeUnitStrict,
  currentControlGroup: () => resolveProcessControlGroup(process.pid),
  cgroupIsPopulated,
  writeCgroupKill: async controlGroup => {
    const path = `/sys/fs/cgroup${controlGroup}`
    if (!statSync(path).isDirectory()) throw new Error(`scope cgroup is not a directory: ${path}`)
    await writeFile(`${path}/cgroup.kill`, '1')
  },
  wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

export async function terminateOwnedScope(unitName: string, operations: ScopeCleanupOperations = defaultScopeCleanupOperations, timeoutMs = 3_000): Promise<void> {
  if (!isOwnedScopeUnitName(unitName)) throw new Error(`refusing to stop unowned scope unit ${unitName}`)
  const initial = await operations.showUnit(unitName)
  if (initial.loadState === 'not-found') return
  const current = operations.currentControlGroup()
  const owned = initial.controlGroup && isOwnedScopeControlGroup(initial.controlGroup, unitName, current) ? initial.controlGroup : null
  let directKillError: unknown
  if (owned) { try { await operations.writeCgroupKill(owned) } catch (error) { directKillError = error } }
  if (!owned || directKillError !== undefined) {
    try { await operations.stopUnit(unitName) }
    catch (error) {
      if (directKillError !== undefined) throw new AggregateError([directKillError, error], `failed to stop ${unitName}`)
      throw error
    }
  }
  const deadline = Date.now() + timeoutMs
  while (true) {
    const state = await operations.showUnit(unitName)
    if (state.loadState === 'not-found') return
    const group = state.controlGroup && isOwnedScopeControlGroup(state.controlGroup, unitName, operations.currentControlGroup()) ? state.controlGroup : owned
    if (!(group && operations.cgroupIsPopulated(group)) && ['inactive', 'failed', 'dead'].includes(state.activeState)) return
    if (Date.now() >= deadline) throw new Error(`scope ${unitName} remained ${state.activeState || 'present'} after termination`)
    await operations.wait(25)
  }
}

export interface ScopeStartObservation { started: boolean; error?: Error }
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
  return { path: join(root, 'started'), cleanup: () => { rmSync(root, { recursive: true, force: true }) } }
}

async function observeScopeStart(child: ChildProcess, markerPath: string, signal?: AbortSignal, timeoutMs = 3_000): Promise<ScopeStartObservation> {
  return await new Promise(resolve => {
    let settled = false
    let spawnError: Error | null = null
    let interval: NodeJS.Timeout
    let timeout: NodeJS.Timeout
    const finish = (result: ScopeStartObservation): void => {
      if (settled) return
      settled = true; clearInterval(interval); clearTimeout(timeout)
      child.off('error', onError); child.off('exit', onExit); signal?.removeEventListener('abort', onAbort); resolve(result)
    }
    const check = (): void => {
      if (existsSync(markerPath)) finish({ started: true })
      else if (spawnError) finish({ started: false, error: spawnError })
      else if (child.exitCode !== null || child.signalCode !== null) finish({ started: false, error: new Error(`systemd-run exited before the workload started (code=${child.exitCode ?? 'null'}, signal=${child.signalCode ?? 'none'})`) })
    }
    const onError = (error: Error): void => { spawnError = error; check() }
    const onExit = (): void => { check() }
    const onAbort = (): void => finish({ started: false, error: new ExecutorAbortedError(signal?.reason) })
    child.on('error', onError); child.on('exit', onExit); signal?.addEventListener('abort', onAbort, { once: true })
    interval = setInterval(check, 10); timeout = setTimeout(() => finish({ started: false, error: new Error(`systemd-run did not start the workload within ${timeoutMs}ms`) }), timeoutMs)
    interval.unref(); timeout.unref(); if (signal?.aborted) onAbort(); else check()
  })
}

export const defaultScopedDependencies: ScopedHostSpawnerDependencies = {
  probe: probeSystemdRun,
  invalidateProbe: limits => { systemdRunProbe = { signature: JSON.stringify(limits), usable: false } },
  semaphore: scopedSemaphore,
  spawnProcess: spawn,
  fallbackSpawner: hostSpawner,
  applyJailFn: applyJail,
  killTreeFn: killTree,
  killScopeFn: terminateOwnedScope,
  observeStart: observeScopeStart,
  createMarker: createScopeStartMarker,
}

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}
