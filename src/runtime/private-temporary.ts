import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const PRIVATE_PREFIX = /^\.?cli-bridge-[a-z0-9-]+-$/u
const PRIVATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_MANIFEST_BYTES = 8 * 1024

interface PrivateTemporaryManifest {
  version: 2
  pid: number
  processStart: string | null
  id: string
  parent: string
  parentDevice: string
  parentInode: string
  prefix: string
  root: string
  rootDevice: string | null
  rootInode: string | null
}

export interface PrivateTemporaryRoot {
  readonly path: string
  cleanup(): void
}

/**
 * Create one owner-only temporary directory and register it before creation so
 * a SIGKILL can be repaired at the next bridge startup.
 */
export function createPrivateTemporaryRoot(parent: string, prefix: string): PrivateTemporaryRoot {
  if (!isAbsolute(parent)) throw new Error(`temporary parent must be absolute: ${parent}`)
  if (!PRIVATE_PREFIX.test(prefix)) throw new Error(`invalid private temporary prefix: ${prefix}`)
  const canonicalParent = realpathSync(resolve(parent))
  const parentStat = lstatSync(canonicalParent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`temporary parent is not a real directory: ${canonicalParent}`)
  }
  const id = randomUUID()
  const root = join(canonicalParent, `${prefix}${process.pid}-${id}`)
  let manifest: PrivateTemporaryManifest = {
    version: 2,
    pid: process.pid,
    processStart: processStartIdentity(process.pid),
    id,
    parent: canonicalParent,
    parentDevice: String(parentStat.dev),
    parentInode: String(parentStat.ino),
    prefix,
    root,
    rootDevice: null,
    rootInode: null,
  }
  const registry = privateTemporaryRegistryDir()
  const manifestPath = join(registry, `${process.pid}-${id}.json`)

  writeFileSync(manifestPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
  try {
    mkdirSync(root, { mode: 0o700 })
    assertOwnedDirectory(root)
    chmodSync(root, 0o700)
    const rootStat = lstatSync(root)
    manifest = {
      ...manifest,
      rootDevice: String(rootStat.dev),
      rootInode: String(rootStat.ino),
    }
    writeManifestAtomic(manifestPath, manifest)
  } catch (error) {
    try { removeOwnedRoot(manifest) } catch { /* the manifest preserves retry state */ }
    if (!existsSync(root) && !existsSync(quarantinePath(manifest))) {
      rmSync(manifestPath, { force: true })
    }
    throw error
  }

  let cleaned = false
  return {
    path: root,
    cleanup: () => {
      if (cleaned) return
      removeOwnedRoot(manifest)
      rmSync(manifestPath, { force: true })
      cleaned = true
    },
  }
}

/** Remove group/other access from every generated file beneath a private root. */
export function hardenPrivateTemporaryTree(root: string): void {
  assertOwnedDirectory(root)
  chmodSync(root, 0o700)
  for (const name of readdirSync(root)) {
    hardenEntry(join(root, name))
  }
}

/** Remove registered roots whose creating process no longer exists. */
export function reapStalePrivateTemporaryRoots(): number {
  const registry = privateTemporaryRegistryDir()
  let removed = 0
  for (const name of readdirSync(registry)) {
    if (!name.endsWith('.json')) continue
    const manifestPath = join(registry, name)
    const manifest = readManifest(manifestPath)
    if (!manifest) {
      rmSync(manifestPath, { force: true })
      continue
    }
    if (processMatchesOwner(manifest.pid, manifest.processStart)) continue
    if (manifestIsSafe(manifest)) {
      try {
        const existed = existsSync(manifest.root) || existsSync(quarantinePath(manifest))
        removeOwnedRoot(manifest)
        if (existed) removed += 1
      } catch {
        // Keep the manifest so a later startup can retry after a transient
        // filesystem failure. Never delete an unproved target.
        continue
      }
    }
    rmSync(manifestPath, { force: true })
  }
  return removed
}

function privateTemporaryRegistryDir(): string {
  const owner = typeof process.getuid === 'function' ? process.getuid() : 'user'
  const registry = join(tmpdir(), `cli-bridge-private-temp-registry-${owner}`)
  // This directory is shared by every bridge process for the same uid. Keep it
  // after the last manifest is removed: deleting an observed-empty directory
  // races with another process between its mkdir and manifest write.
  mkdirSync(registry, { recursive: true, mode: 0o700 })
  assertOwnedDirectory(registry)
  chmodSync(registry, 0o700)
  return registry
}

function readManifest(path: string): PrivateTemporaryManifest | null {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) return null
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return null
    chmodSync(path, 0o600)
    const candidate = JSON.parse(readFileSync(path, 'utf8')) as Partial<PrivateTemporaryManifest>
    if (
      candidate.version !== 2
      || !Number.isSafeInteger(candidate.pid)
      || Number(candidate.pid) <= 0
      || !(candidate.processStart === null || typeof candidate.processStart === 'string')
      || typeof candidate.id !== 'string'
      || typeof candidate.parent !== 'string'
      || typeof candidate.parentDevice !== 'string'
      || typeof candidate.parentInode !== 'string'
      || typeof candidate.prefix !== 'string'
      || typeof candidate.root !== 'string'
      || !(candidate.rootDevice === null || typeof candidate.rootDevice === 'string')
      || !(candidate.rootInode === null || typeof candidate.rootInode === 'string')
    ) return null
    return candidate as PrivateTemporaryManifest
  } catch {
    return null
  }
}

function manifestIsSafe(manifest: PrivateTemporaryManifest): boolean {
  if (!PRIVATE_ID.test(manifest.id) || !PRIVATE_PREFIX.test(manifest.prefix)) return false
  if (!isAbsolute(manifest.parent) || resolve(manifest.parent) !== manifest.parent) return false
  if (!/^\d+$/u.test(manifest.parentDevice) || !/^\d+$/u.test(manifest.parentInode)) return false
  if ((manifest.rootDevice === null) !== (manifest.rootInode === null)) return false
  if (manifest.rootDevice !== null && (!/^\d+$/u.test(manifest.rootDevice) || !/^\d+$/u.test(manifest.rootInode!))) return false
  const expectedName = `${manifest.prefix}${manifest.pid}-${manifest.id}`
  return isAbsolute(manifest.root)
    && dirname(manifest.root) === manifest.parent
    && basename(manifest.root) === expectedName
    && manifest.root === join(manifest.parent, expectedName)
}

function assertOwnedDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`private temporary path is not a real directory: ${path}`)
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`private temporary directory is owned by another user: ${path}`)
  }
}

function removeOwnedRoot(manifest: PrivateTemporaryManifest): void {
  assertPathIdentity(manifest.parent, manifest.parentDevice, manifest.parentInode, 'temporary parent')
  const root = manifest.root
  const quarantine = quarantinePath(manifest)
  if (!existsSync(root)) {
    if (!existsSync(quarantine)) return
    removeQuarantinedRoot(quarantine, manifest)
    return
  }
  let stat
  try {
    stat = lstatSync(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`refusing to recursively remove an unproved temporary root: ${root}`)
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`refusing to remove another user's temporary root: ${root}`)
  }
  if (manifest.rootDevice !== null && (
    String(stat.dev) !== manifest.rootDevice || String(stat.ino) !== manifest.rootInode
  )) {
    throw new Error(`refusing to remove a replaced temporary root: ${root}`)
  }
  if (existsSync(quarantine)) throw new Error(`temporary quarantine already exists: ${quarantine}`)
  renameSync(root, quarantine)
  const observed: PrivateTemporaryManifest = manifest.rootDevice === null
    ? { ...manifest, rootDevice: String(stat.dev), rootInode: String(stat.ino) }
    : manifest
  removeQuarantinedRoot(quarantine, observed)
}

function quarantinePath(manifest: PrivateTemporaryManifest): string {
  return join(manifest.parent, `.cli-bridge-quarantine-${manifest.id}`)
}

function removeQuarantinedRoot(path: string, manifest: PrivateTemporaryManifest): void {
  assertPathIdentity(manifest.parent, manifest.parentDevice, manifest.parentInode, 'temporary parent')
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`refusing to remove an invalid temporary quarantine: ${path}`)
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`refusing to remove another user's temporary quarantine: ${path}`)
  }
  if (manifest.rootDevice === null || manifest.rootInode === null
    || String(stat.dev) !== manifest.rootDevice || String(stat.ino) !== manifest.rootInode) {
    throw new Error(`refusing to remove a replaced temporary quarantine: ${path}`)
  }
  rmSync(path, { recursive: true, force: true })
}

function assertPathIdentity(path: string, device: string, inode: string, label: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || String(stat.dev) !== device || String(stat.ino) !== inode) {
    throw new Error(`${label} identity changed: ${path}`)
  }
}

function hardenEntry(path: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`private temporary tree contains a symlink: ${path}`)
  if (stat.isDirectory()) {
    chmodSync(path, 0o700)
    for (const name of readdirSync(path)) hardenEntry(join(path, name))
    return
  }
  if (!stat.isFile()) throw new Error(`private temporary tree contains a special file: ${path}`)
  chmodSync(path, 0o600 | (stat.mode & 0o100))
}

function pidAlive(pid: number): boolean {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const commandEnd = stat.lastIndexOf(') ')
      if (commandEnd >= 0 && stat.slice(commandEnd + 2).startsWith('Z ')) return false
    } catch {
      return false
    }
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Stable process birth identity used with a PID to reject PID reuse. */
export function processStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const commandEnd = stat.lastIndexOf(') ')
      if (commandEnd < 0) return null
      const suffix = stat.slice(commandEnd + 2).trim().split(/\s+/u)
      const startTicks = suffix[19]
      return startTicks ? `linux:${startTicks}` : null
    } catch {
      return null
    }
  }
  if (process.platform === 'darwin') {
    try {
      const started = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 1_000,
      }).trim()
      return started ? `darwin:${started}` : null
    } catch {
      return null
    }
  }
  return null
}

export function processMatchesOwner(pid: number, expectedStart: string | null): boolean {
  if (!pidAlive(pid)) return false
  if (expectedStart === null) return true
  return processStartIdentity(pid) === expectedStart
}

function writeManifestAtomic(path: string, manifest: PrivateTemporaryManifest): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
    renameSync(temporaryPath, path)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}
