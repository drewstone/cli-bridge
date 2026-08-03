import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { processMatchesOwner, processStartIdentity } from '../runtime/private-temporary.js'

const execFileAsync = promisify(execFile)

export interface TemporaryTreeAccess {
  cleanup(): Promise<void>
}

/**
 * Give one numeric container identity access to a bridge-owned private tree
 * without changing ownership or granting the host group/other users access.
 *
 * POSIX ACLs are the only portable Linux mechanism that lets the bridge retain
 * ownership for reliable cleanup while a differently numbered container user
 * can read request credentials and create runtime files. Symlinks are rejected
 * before invoking setfacl so a planted link cannot redirect the grant.
 */
export async function grantPrivateTreeToUid(root: string, uid: number): Promise<void> {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error(`invalid private-tree uid: ${uid}`)
  if (process.getuid?.() === uid) return

  const directories: string[] = []
  collectPrivateTree(root, directories)

  try {
    await execFileAsync('setfacl', ['-R', '-m', `u:${uid}:rwX`, '--', root], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    })
    for (let offset = 0; offset < directories.length; offset += 128) {
      await execFileAsync('setfacl', [
        '-m', `d:u:${uid}:rwx`,
        '--',
        ...directories.slice(offset, offset + 128),
      ], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      })
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `cannot grant private generated files to container uid ${uid}: ${detail}. ` +
      'Install the Linux acl package, or configure the Docker executor to use the bridge process uid.',
      { cause: error },
    )
  }
}

/**
 * Temporarily grant one container uid access to a project config directory,
 * then restore the exact ACL that existed before the request.
 *
 * Unlike request-private roots, project directories survive cleanup and may
 * predate the bridge. A permanent ACL grant there would silently broaden a
 * user's workspace permissions after every run. The identity snapshot also
 * prevents restoration through a path the workspace replaced mid-run.
 */
export async function grantTemporaryTreeToUid(root: string, uid: number): Promise<TemporaryTreeAccess> {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error(`invalid temporary-tree uid: ${uid}`)
  if (process.getuid?.() === uid) return { cleanup: async () => {} }

  const releaseLease = await acquireTemporaryTreeLease(resolve(root))

  const created = !existsSync(root)
  try {
    if (created) mkdirSync(root, { mode: 0o700 })
  } catch (error) {
    releaseLease()
    throw error
  }
  const identities: PathIdentity[] = []
  const directories: string[] = []
  let acl: string
  try {
    collectPrivateTree(root, directories, identities)
    acl = await readAcl(root)
  } catch (error) {
    if (created) {
      try { rmdirSync(root) } catch { /* preserve the unexpected contents */ }
    }
    releaseLease()
    throw error
  }

  try {
    await grantTree(root, uid)
  } catch (error) {
    const failures: unknown[] = [error]
    try { await restoreAcl(acl, identities) } catch (candidate) { failures.push(candidate) }
    if (created) {
      try { rmdirSync(root) } catch (candidate) {
        if ((candidate as NodeJS.ErrnoException).code !== 'ENOTEMPTY') failures.push(candidate)
      }
    }
    try { releaseLease() } catch (candidate) { failures.push(candidate) }
    if (failures.length === 1) throw failures[0]
    throw new AggregateError(failures, `failed to grant, restore, or release temporary access at ${root}`)
  }

  let cleaned = false
  let cleanupInFlight: Promise<void> | null = null
  let currentRelease: (() => void) | null = releaseLease
  return {
    cleanup: async () => {
      if (cleaned) return
      if (cleanupInFlight) return await cleanupInFlight
      cleanupInFlight = (async () => {
        if (!currentRelease) currentRelease = await acquireTemporaryTreeLease(resolve(root))
        const failures: unknown[] = []
        try {
          if (existsSync(root)) {
            try { await restoreAcl(acl, identities) } catch (error) { failures.push(error) }
            if (created) {
              try { rmdirSync(root) } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') failures.push(error)
              }
            }
          }
        } finally {
          const release = currentRelease
          currentRelease = null
          if (release) {
            try { release() } catch (error) { failures.push(error) }
          }
        }
        if (failures.length === 0) {
          cleaned = true
          return
        }
        if (failures.length === 1) throw failures[0]
        throw new AggregateError(failures, `failed to restore or release temporary access at ${root}`)
      })()
      try {
        await cleanupInFlight
      } finally {
        cleanupInFlight = null
      }
    },
  }
}

const temporaryTreeLeases = new Map<string, Promise<void>>()

async function acquireTemporaryTreeLease(root: string): Promise<() => void> {
  const releaseInProcess = await acquireInProcessTreeLease(root)
  try {
    const releaseCrossProcess = await acquireCrossProcessTreeLease(root)
    return () => {
      let releaseError: unknown
      try { releaseCrossProcess() } catch (error) { releaseError = error } finally { releaseInProcess() }
      if (releaseError !== undefined) throw releaseError
    }
  } catch (error) {
    releaseInProcess()
    throw error
  }
}

async function acquireInProcessTreeLease(root: string): Promise<() => void> {
  const previous = temporaryTreeLeases.get(root) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolveLease => { release = resolveLease })
  temporaryTreeLeases.set(root, current)
  await previous
  let released = false
  return () => {
    if (released) return
    released = true
    if (temporaryTreeLeases.get(root) === current) temporaryTreeLeases.delete(root)
    release()
  }
}

interface TreeLockRecord {
  pid: number
  processStart: string | null
  nonce: string
  root: string
}

async function acquireCrossProcessTreeLease(root: string): Promise<() => void> {
  const uid = process.getuid?.() ?? 0
  const runtimeBase = process.env.XDG_RUNTIME_DIR && existsSync(process.env.XDG_RUNTIME_DIR)
    ? process.env.XDG_RUNTIME_DIR
    : existsSync(`/run/user/${uid}`) ? `/run/user/${uid}` : tmpdir()
  const registry = `${runtimeBase}/cli-bridge-acl-locks-${uid}`
  mkdirSync(registry, { recursive: true, mode: 0o700 })
  const registryStat = lstatSync(registry)
  if (
    !registryStat.isDirectory()
    || registryStat.isSymbolicLink()
    || registryStat.uid !== uid
    || (registryStat.mode & 0o077) !== 0
  ) {
    throw new Error(`unsafe temporary ACL lock directory: ${registry}`)
  }
  const digest = createHash('sha256').update(root).digest('hex')
  const lockPath = `${registry}/${digest}.lock`
  const record: TreeLockRecord = {
    pid: process.pid,
    processStart: processStartIdentity(process.pid),
    nonce: randomBytes(16).toString('hex'),
    root,
  }
  const configuredTimeout = Number(process.env.CLI_BRIDGE_ACL_LOCK_TIMEOUT_MS)
  const lockTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 0
    ? configuredTimeout
    : 60_000
  const deadline = Date.now() + lockTimeoutMs
  while (true) {
    const candidatePath = `${registry}/.${digest}.${record.nonce}.candidate`
    try {
      // Publish only a complete record. Creating the final path and then
      // filling it left a window where another process could misread a live,
      // empty lock as stale. A same-directory hard link is an atomic
      // no-replace publish: readers see either no lock or the full record.
      writeFileSync(candidatePath, JSON.stringify(record), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      linkSync(candidatePath, lockPath)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (treeLockIsStale(lockPath)) {
        try { unlinkSync(lockPath) } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
        }
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for temporary ACL ownership of ${root}`)
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 25))
    } finally {
      try { unlinkSync(candidatePath) } catch { /* candidate cleanup cannot invalidate a published lock */ }
    }
  }

  let released = false
  return () => {
    if (released) return
    const current = readTreeLock(lockPath)
    if (!current || current.nonce !== record.nonce || current.root !== root) {
      throw new Error(`refusing to release replaced temporary ACL lock ${lockPath}`)
    }
    unlinkSync(lockPath)
    released = true
  }
}

function treeLockIsStale(lockPath: string): boolean {
  let stat
  try { stat = lstatSync(lockPath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== (process.getuid?.() ?? 0)) return false
  const record = readTreeLock(lockPath)
  // A malformed record has no provable owner. Atomic publication means this is
  // not a bridge write in progress, so stealing it would be guessing about ACL
  // ownership. Keep it held for explicit operator inspection.
  if (!record) return false
  return !processMatchesOwner(record.pid, record.processStart)
}

function readTreeLock(lockPath: string): TreeLockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<TreeLockRecord>
    return Number.isSafeInteger(parsed.pid)
      && typeof parsed.nonce === 'string'
      && /^[a-f0-9]{32}$/u.test(parsed.nonce)
      && typeof parsed.root === 'string'
      && (typeof parsed.processStart === 'string' || parsed.processStart === null)
      ? parsed as TreeLockRecord
      : null
  } catch {
    return null
  }
}

interface PathIdentity {
  path: string
  device: string
  inode: string
}

async function readAcl(root: string): Promise<string> {
  try {
    const result = await execFileAsync('getfacl', ['-R', '--absolute-names', '--numeric', '--', root], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return result.stdout
  } catch (error) {
    throw aclToolError('snapshot', root, error)
  }
}

async function grantTree(root: string, uid: number): Promise<void> {
  try {
    await execFileAsync('setfacl', ['-R', '-m', `u:${uid}:rwX`, '--', root], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    })
    // Do not install a default ACL on persistent workspace directories. A file
    // created during the request would inherit it but is absent from the
    // pre-run snapshot, leaving the container uid with access after rollback.
    // Existing paths are sufficient for generated config; ordinary workspace
    // write access remains governed by the mount's native uid/mode ownership.
  } catch (error) {
    throw aclToolError(`grant to uid ${uid}`, root, error)
  }
}

async function restoreAcl(acl: string, identities: PathIdentity[]): Promise<void> {
  for (const identity of identities) {
    let stat
    try { stat = lstatSync(identity.path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (stat.isSymbolicLink()
      || String(stat.dev) !== identity.device
      || String(stat.ino) !== identity.inode) {
      throw new Error(`refusing to restore ACL through a replaced path: ${identity.path}`)
    }
  }
  await runWithInput('setfacl', ['--restore=-'], acl)
}

async function runWithInput(bin: string, args: string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`${bin} timed out after 10000ms`))
    }, 10_000)
    child.stderr.on('data', chunk => {
      if (stderr.length < 8_192) stderr += chunk.toString()
    })
    child.once('error', error => finish(error))
    child.stdin.once('error', error => finish(error))
    child.once('close', code => {
      if (code === 0) finish()
      else finish(new Error(`${bin} exited ${code ?? 'unknown'}: ${stderr.trim()}`))
    })
    child.stdin.end(input)
  })
}

function aclToolError(action: string, root: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(
    `cannot ${action} ACLs for ${root}: ${detail}. `
      + 'Install the Linux acl package, or configure the Docker executor to use the bridge process uid.',
    { cause: error },
  )
}

function collectPrivateTree(path: string, directories: string[], identities?: PathIdentity[]): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`refusing to grant access through symlink: ${path}`)
  identities?.push({ path, device: String(stat.dev), inode: String(stat.ino) })
  if (!stat.isDirectory()) return
  directories.push(path)
  for (const entry of readdirSync(path)) collectPrivateTree(`${path}/${entry}`, directories, identities)
}
