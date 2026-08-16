/**
 * Single-instance guards for the bridge.
 *
 * The data directory is the ownership boundary for `sessions.sqlite` and
 * every other durable run file. It therefore has one owner, independent of
 * which HTTP port that owner selected. The port guard remains separate: it
 * protects the listener address and catches a distinct configuration error.
 *
 * Node does not expose a portable `flock`, so both guards use an exclusive
 * lockfile. The record contains the process id and its kernel start identity.
 * Legacy pid-only records are checked with the same liveness probe as new
 * records, so an older live bridge still blocks startup. Corrupt, unreadable,
 * symlinked, or foreign-owned locks fail closed.
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/*
 * The reclaimer is a separate, exclusive lease. Every current bridge
 * version takes it before inspecting and removing a stale lock. This keeps
 * two reclaimers from deleting a lock that one of them has already replaced.
 */
const RECLAIM_SUFFIX = '.reclaim'

export interface InstanceLock {
  /** Absolute path to the pidfile this lock holds. */
  path: string
  /** Remove the pidfile. Idempotent — safe to call from shutdown + atexit. */
  release(): void
}

export interface DataDirectoryLock extends InstanceLock {
  /** Canonical directory whose durable state this lock owns. */
  dataDir: string
}

export class InstanceLockError extends Error {
  constructor(
    message: string,
    public readonly lockPath: string,
    public readonly holderPid: number | null,
  ) {
    super(message)
    this.name = 'InstanceLockError'
  }
}

export class PortAlreadyBoundError extends InstanceLockError {
  constructor(
    public readonly port: number,
    public readonly lockPath: string,
    public readonly holderPid: number | null,
  ) {
    super(
      `cli-bridge is already running on port ${port}` +
        (holderPid ? ` (pid ${holderPid})` : '') +
        `. Lockfile ${lockPath} is held by a live process. ` +
        `Stop the other instance or set BRIDGE_PORT to a free port.`,
      lockPath,
      holderPid,
    )
    this.name = 'PortAlreadyBoundError'
  }
}

export class DataDirectoryAlreadyBoundError extends InstanceLockError {
  constructor(
    public readonly dataDir: string,
    public readonly lockPath: string,
    public readonly holderPid: number | null,
  ) {
    super(
      `cli-bridge data directory ${dataDir} is already owned` +
        (holderPid ? ` by pid ${holderPid}` : '') +
        `. Lockfile ${lockPath} is held by a live process. ` +
        `Stop the other instance or choose a different BRIDGE_DATA_DIR.`,
      lockPath,
      holderPid,
    )
    this.name = 'DataDirectoryAlreadyBoundError'
  }
}

export class InstanceLockUnavailableError extends InstanceLockError {
  constructor(lockPath: string, reason: string) {
    super(`cannot safely inspect CLI Bridge lockfile ${lockPath}: ${reason}`, lockPath, null)
    this.name = 'InstanceLockUnavailableError'
  }
}

/** Create one local-user-only directory for durable bridge state. */
export function ensurePrivateDataDirectory(inputPath: string): string {
  const requestedPath = resolve(inputPath)
  mkdirSync(requestedPath, { recursive: true, mode: 0o700 })
  const path = realpathSync(requestedPath)
  const metadata = lstatSync(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`CLI Bridge data path ${JSON.stringify(path)} is not a real directory`)
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error(`CLI Bridge data directory ${JSON.stringify(path)} is owned by uid ${metadata.uid}`)
  }
  chmodSync(path, 0o700)
  if ((statSync(path).mode & 0o777) !== 0o700) {
    throw new Error(`CLI Bridge data directory ${JSON.stringify(path)} could not be restricted to mode 0700`)
  }
  return path
}

const DATA_DIRECTORY_LOCK_NAME = '.cli-bridge-data-directory.pid'

/**
 * Acquire the single writer lock for one canonical durable data directory.
 *
 * This must be acquired before `buildApp()` opens `sessions.sqlite`. The
 * returned directory is the path all later runtime components must use.
 */
export function acquireDataDirectoryLock(inputPath: string): DataDirectoryLock {
  const dataDir = ensurePrivateDataDirectory(inputPath)
  const path = join(dataDir, DATA_DIRECTORY_LOCK_NAME)
  claim(path, (lockPath, holderPid) => new DataDirectoryAlreadyBoundError(dataDir, lockPath, holderPid))

  let released = false
  return {
    path,
    dataDir,
    release(): void {
      if (released) return
      released = true
      removeOwnedLock(path)
    },
  }
}

/**
 * Acquire the per-port single-instance lock. Throws
 * `PortAlreadyBoundError` (a fatal startup error — see
 * `isFatalServerStartupError`) when a LIVE process already holds it.
 * Reclaims a stale lockfile left by a crashed predecessor. Returns a
 * handle whose `release()` removes the pidfile.
 *
 * `dir` defaults to the OS temp dir — a writable location even under
 * systemd `ProtectSystem=strict`. PrivateTmp gives each unit its own
 * /tmp namespace, which is correct: the guard is per-host-port within
 * one namespace, and systemd never runs two instances of the same
 * templated unit on the same port.
 */
export function acquireInstanceLock(port: number, dir: string = tmpdir()): InstanceLock {
  const path = join(dir, `cli-bridge-${port}.pid`)
  claim(path, (lockPath, holderPid) => new PortAlreadyBoundError(port, lockPath, holderPid))

  let released = false
  return {
    path,
    release(): void {
      if (released) return
      released = true
      removeOwnedLock(path)
    },
  }
}

/**
 * Try to create the lockfile exclusively. On collision, a reclaimer lease
 * serializes a fresh liveness check and inode check before stale removal.
 * Legacy numeric pidfiles use the same cross-platform liveness probe as new
 * records, so an older live bridge still blocks a new bridge.
 */
function claim(
  path: string,
  conflict: (lockPath: string, holderPid: number | null) => InstanceLockError,
  attempt = 0,
): void {
  let fd: number
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    reclaimStaleLock(path, conflict, attempt)
    claim(path, conflict, attempt + 1)
    return
  }
  try {
    const owner = processStartIdentity(process.pid)
    if (owner.kind !== 'live') {
      try { closeSync(fd) } catch { /* preserve the identity failure */ }
      try { unlinkSync(path) } catch { /* preserve the identity failure */ }
      throw new InstanceLockUnavailableError(
        path,
        owner.kind === 'unavailable' ? owner.reason : 'the current process disappeared before lock creation',
      )
    }
    writeSync(fd, `${JSON.stringify({ pid: process.pid, startIdentity: owner.startIdentity })}\n`)
    fsyncSync(fd)
  } catch (writeError) {
    try { closeSync(fd) } catch { /* preserve the write failure */ }
    try { unlinkSync(path) } catch { /* preserve the write failure */ }
    throw writeError
  }
  closeSync(fd)
}

function reclaimStaleLock(
  path: string,
  conflict: (lockPath: string, holderPid: number | null) => InstanceLockError,
  attempt: number,
): void {
  if (attempt >= 2) {
    throw new InstanceLockUnavailableError(path, 'stale lock could not be reclaimed after repeated replacement races')
  }
  const guard = acquireReclaimLease(path)
  try {
    const inspection = inspectLock(path)
    if (inspection.kind === 'missing') {
      return
    }
    if (inspection.kind === 'invalid') {
      throw new InstanceLockUnavailableError(path, inspection.reason)
    }
    const current = processStartIdentity(inspection.pid)
    if (current.kind === 'unavailable') {
      throw new InstanceLockUnavailableError(path, current.reason)
    }
    const live = current.kind === 'live' && (
      inspection.startIdentity === null || current.startIdentity === inspection.startIdentity
    )
    if (live) throw conflict(path, inspection.pid)
    // The second inode read is deliberate. A cooperating bridge cannot
    // replace this file while the reclaimer lease is held, and the check
    // prevents a stale inspection from unlinking a newer inode if an older
    // bridge version raced this operation.
    const latest = inspectLock(path)
    if (latest.kind === 'missing') return
    if (latest.kind !== 'holder' || !sameLockInode(inspection, latest)) {
      throw new InstanceLockUnavailableError(path, 'lock inode changed during stale reclamation')
    }
    const latestCurrent = processStartIdentity(latest.pid)
    if (latestCurrent.kind === 'unavailable') {
      throw new InstanceLockUnavailableError(path, latestCurrent.reason)
    }
    const latestLive = latestCurrent.kind === 'live' && (
      latest.startIdentity === null || latestCurrent.startIdentity === latest.startIdentity
    )
    if (latestLive) throw conflict(path, latest.pid)
    try {
      unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return
    }
  } finally {
    guard.release()
  }
}

interface ReclaimLease {
  release(): void
}

function acquireReclaimLease(lockPath: string): ReclaimLease {
  const path = `${lockPath}${RECLAIM_SUFFIX}`
  let fd: number
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const inspection = inspectLock(path)
    if (inspection.kind === 'invalid') throw new InstanceLockUnavailableError(path, inspection.reason)
    if (inspection.kind === 'holder') {
      const holder = processStartIdentity(inspection.pid)
      if (holder.kind === 'unavailable') throw new InstanceLockUnavailableError(path, holder.reason)
      const live = holder.kind === 'live' && (
        inspection.startIdentity === null || holder.startIdentity === inspection.startIdentity
      )
      if (live) throw new InstanceLockUnavailableError(lockPath, 'stale lock reclamation is already in progress')
      const latest = inspectLock(path)
      if (latest.kind === 'missing') return acquireReclaimLease(lockPath)
      if (latest.kind !== 'holder' || !sameLockInode(inspection, latest)) {
        throw new InstanceLockUnavailableError(lockPath, 'reclamation lease inode changed during stale cleanup')
      }
      try { unlinkSync(path) } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
      }
      return acquireReclaimLease(lockPath)
    }
    return acquireReclaimLease(lockPath)
  }
  try {
    const owner = processStartIdentity(process.pid)
    if (owner.kind !== 'live') {
      try { closeSync(fd) } catch { /* preserve the identity failure */ }
      try { unlinkSync(path) } catch { /* preserve the identity failure */ }
      throw new InstanceLockUnavailableError(
        lockPath,
        owner.kind === 'unavailable' ? owner.reason : 'the current process disappeared before reclamation',
      )
    }
    writeSync(fd, `${JSON.stringify({ pid: process.pid, startIdentity: owner.startIdentity })}\n`)
    fsyncSync(fd)
  } catch (writeError) {
    try { closeSync(fd) } catch { /* preserve the write failure */ }
    try { unlinkSync(path) } catch { /* preserve the write failure */ }
    throw writeError
  }
  closeSync(fd)
  return {
    release(): void {
      removeOwnedLock(path)
    },
  }
}

type LockInspection =
  | { kind: 'holder'; pid: number; startIdentity: string | null; dev: number; ino: number }
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string }

function inspectLock(path: string): LockInspection {
  try {
    const metadata = lstatSync(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return { kind: 'invalid', reason: 'it is not a regular file' }
    }
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      return { kind: 'invalid', reason: `it is owned by uid ${metadata.uid}` }
    }
    const raw = readFileSync(path, 'utf8').trim()
    if (/^\d+$/u.test(raw)) {
      const pid = Number(raw)
      if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: 'invalid', reason: 'it contains an invalid pid' }
      return { kind: 'holder', pid, startIdentity: null, dev: metadata.dev, ino: metadata.ino }
    }
    let value: unknown
    try {
      value = JSON.parse(raw) as unknown
    } catch {
      return { kind: 'invalid', reason: 'it is not a lock record' }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { kind: 'invalid', reason: 'it is not a lock record' }
    }
    const record = value as { pid?: unknown; startIdentity?: unknown }
    if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0) {
      return { kind: 'invalid', reason: 'it contains an invalid pid' }
    }
    if (record.startIdentity === undefined || record.startIdentity === null) {
      return { kind: 'holder', pid: record.pid, startIdentity: null, dev: metadata.dev, ino: metadata.ino }
    }
    if (typeof record.startIdentity !== 'string' || record.startIdentity.length === 0) {
      return { kind: 'invalid', reason: 'it contains an invalid process start identity' }
    }
    return {
      kind: 'holder',
      pid: record.pid,
      startIdentity: record.startIdentity,
      dev: metadata.dev,
      ino: metadata.ino,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'invalid', reason: 'it could not be read safely' }
  }
}

function sameLockInode(left: Extract<LockInspection, { kind: 'holder' }>, right: Extract<LockInspection, { kind: 'holder' }>): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/** Only remove a lock whose current contents still identify this process. */
function removeOwnedLock(path: string): void {
  const inspection = inspectLock(path)
  const owner = processStartIdentity(process.pid)
  if (
    inspection.kind !== 'holder' ||
    inspection.pid !== process.pid ||
    inspection.startIdentity === null ||
    owner.kind !== 'live' ||
    inspection.startIdentity !== owner.startIdentity
  ) return
  const latest = inspectLock(path)
  if (latest.kind !== 'holder' || !sameLockInode(inspection, latest) || latest.startIdentity !== owner.startIdentity) return
  try {
    unlinkSync(path)
  } catch { /* leave it for proven-stale reclaim after this process exits */ }
}

type ProcessStartIdentity =
  | { kind: 'live'; startIdentity: string }
  | { kind: 'dead' }
  | { kind: 'unavailable'; reason: string }

/** Return a process-instance identity on every supported desktop platform. */
function processStartIdentity(pid: number): ProcessStartIdentity {
  if (process.platform === 'linux') return linuxProcessStartIdentity(pid)
  if (process.platform === 'win32') return windowsProcessStartIdentity(pid)
  return psProcessStartIdentity(pid)
}

function linuxProcessStartIdentity(pid: number): ProcessStartIdentity {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const closingCommand = stat.lastIndexOf(')')
    if (closingCommand < 0) return { kind: 'unavailable', reason: 'process stat has no command boundary' }
    const fields = stat.slice(closingCommand + 1).trim().split(/\s+/u)
    const startTime = fields[19]
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    if (!startTime || !/^\d+$/u.test(startTime) || bootId.length === 0) {
      return { kind: 'unavailable', reason: 'process stat has no usable start identity' }
    }
    return { kind: 'live', startIdentity: `${bootId}:${startTime}` }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'dead' }
    return { kind: 'unavailable', reason: 'process start identity could not be read safely' }
  }
}

function psProcessStartIdentity(pid: number): ProcessStartIdentity {
  try {
    const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (started.length === 0) return { kind: 'unavailable', reason: 'ps returned no process start time' }
    return { kind: 'live', startIdentity: `ps:${started}` }
  } catch (error) {
    const status = (error as NodeJS.ErrnoException & { status?: number }).status
    if (status === 1) return { kind: 'dead' }
    return { kind: 'unavailable', reason: 'process start identity could not be read from ps' }
  }
}

function windowsProcessStartIdentity(pid: number): ProcessStartIdentity {
  const command = '$p = Get-Process -Id ([int]$env:CLI_BRIDGE_PID -as [int]) -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks'
  const environment = { ...process.env, CLI_BRIDGE_PID: String(pid) }
  let lastError: unknown
  for (const executable of ['powershell.exe', 'pwsh']) {
    try {
      const started = execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: environment,
      }).trim()
      if (!/^\d+$/u.test(started)) return { kind: 'unavailable', reason: 'PowerShell returned no process start time' }
      return { kind: 'live', startIdentity: `win32:${started}` }
    } catch (error) {
      lastError = error
      const status = (error as NodeJS.ErrnoException & { status?: number }).status
      if (status === 1) return { kind: 'dead' }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') break
    }
  }
  void lastError
  return { kind: 'unavailable', reason: 'process start identity could not be read from PowerShell' }
}
