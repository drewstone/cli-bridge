/**
 * Single-writer ownership for the durable CLI Bridge data directory.
 *
 * A PID file cannot safely own a process lifetime: file creation and PID writes
 * are separate operations, and stale-file deletion races a new owner. SQLite's
 * exclusive transaction is an OS-backed lock that the kernel releases on
 * process death, so there is no stale-claim protocol to race.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

export interface InstanceLock {
  /** Absolute path to the SQLite file whose transaction owns the lock. */
  path: string
  /** Canonical durable-data directory protected by this lock. */
  dataDir: string
  /** Roll back the ownership transaction and close its file. Idempotent. */
  release(): void
}

export class DataDirectoryInUseError extends Error {
  constructor(
    public readonly dataDir: string,
    public readonly requestedPort: number,
    public readonly lockPath: string,
    public readonly holderPid: number | null,
  ) {
    super(
      `cli-bridge data directory ${JSON.stringify(dataDir)} is already owned` +
        (holderPid ? ` by pid ${holderPid}` : '') +
        `. Ownership database ${lockPath} is locked by a live process. ` +
        'Stop the other instance or set BRIDGE_DATA_DIR to a different directory.',
    )
    this.name = 'DataDirectoryInUseError'
  }
}

/** Create or normalize one local-user-only directory and return its real path. */
export function ensurePrivateDataDirectory(inputPath: string): string {
  mkdirSync(inputPath, { recursive: true, mode: 0o700 })
  const path = realpathSync(inputPath)
  const before = lstatSync(path)
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`CLI Bridge data path ${JSON.stringify(path)} is not a real directory`)
  }
  if (typeof process.getuid === 'function' && before.uid !== process.getuid()) {
    throw new Error(`CLI Bridge data directory ${JSON.stringify(path)} is owned by uid ${before.uid}`)
  }
  chmodSync(path, 0o700)
  if ((statSync(path).mode & 0o777) !== 0o700) {
    throw new Error(`CLI Bridge data directory ${JSON.stringify(path)} could not be restricted to mode 0700`)
  }
  return path
}

export function acquireInstanceLock(
  input: { port: number; dataDir: string },
  lockDir?: string,
): InstanceLock {
  const dataDir = ensurePrivateDataDirectory(input.dataDir)
  const ownershipDir = ensurePrivateDataDirectory(lockDir ?? dataDir)
  const digest = createHash('sha256').update(dataDir).digest('hex')
  const path = join(ownershipDir, `cli-bridge-owner-${digest}.sqlite`)
  const ownerPath = `${path}.json`
  const token = randomUUID()
  const db = new Database(path, { timeout: 0 })
  chmodSync(path, 0o600)

  try {
    db.pragma('journal_mode = DELETE')
    db.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    db.close()
    const holderPid = readOwnerPid(ownerPath)
    throw new DataDirectoryInUseError(dataDir, input.port, path, holderPid)
  }

  try {
    writeOwner(ownerPath, { pid: process.pid, port: input.port, dataDir, token })
    restrictOwnershipFiles(path)
  } catch (error) {
    try { db.exec('ROLLBACK') } finally { db.close() }
    throw error
  }
  let released = false
  return {
    path,
    dataDir,
    release(): void {
      if (released) return
      released = true
      try {
        db.exec('ROLLBACK')
      } catch {
        // A fatal SQLite error may already have ended the transaction.
      }
      db.close()
      try {
        const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { token?: string }
        if (owner.token === token) rmSync(ownerPath, { force: true })
      } catch {
        // A crash or external cleanup may already have removed the diagnostic.
      }
    },
  }
}

function writeOwner(
  path: string,
  owner: { pid: number; port: number; dataDir: string; token: string },
): void {
  const temporaryPath = `${path}.${process.pid}.${owner.token}.tmp`
  try {
    writeFileSync(temporaryPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
    renameSync(temporaryPath, path)
    chmodSync(path, 0o600)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function readOwnerPid(path: string): number | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }
    return typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0
      ? value.pid
      : null
  } catch {
    return null
  }
}

function restrictOwnershipFiles(path: string): void {
  for (const candidate of [path, `${path}-journal`]) {
    if (existsSync(candidate)) chmodSync(candidate, 0o600)
  }
}
