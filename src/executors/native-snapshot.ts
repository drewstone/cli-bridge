/** Run the existing SQLite reader inside the existing OS read boundary. */
import { constants, existsSync, readFileSync, realpathSync } from 'node:fs'
import { lstat, mkdtemp, open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOUND_HARNESS_SESSION_READ_LIMITS as bounds } from '@tangle-network/harness-sessions'
import { hostSpawner } from './host.js'
import { retryCleanupUntilSuccessful, terminateSpawned } from './process-tree.js'
import type { SpawnResult } from './types.js'

const MAX_OUTPUT = Math.ceil(bounds.maxFileBytes / 3) * 4 + 512 * 1024
const DEADLINE_MS = 15_000

export class NativeSnapshotUnavailable extends Error {
  constructor(readonly reason: string) { super(reason) }
}

/** Admit only the actual shared SQLite companions. Never truncate, unlink or
 * repair them: a normal writer can adopt a newly created companion immediately. */
async function openCompanion(directory: FileHandle, suffix: 'wal' | 'shm', uid: number): Promise<FileHandle> {
  const path = `/proc/self/fd/${directory.fd}/opencode.db-${suffix}`
  let handle: FileHandle | undefined
  try {
    const existing = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (existing && (!existing.isFile() || existing.nlink !== 1 || existing.uid !== uid)) throw new Error('Unsafe companion')
    const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK
    try { handle = await open(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      handle = await open(path, flags)
    }
    const held = await handle.stat()
    if (!held.isFile() || held.nlink !== 1 || held.uid !== uid) throw new Error('Unsafe companion')
    return handle
  } catch {
    await handle?.close()
    throw new NativeSnapshotUnavailable('native-snapshot-companion-outside-host-policy')
  }
}

/** Resolve installed package roots and their exact lookup aliases, never a node_modules,
 * workspace or HOME ancestor. A changed/incomplete package closure refuses capture. */
function readerPaths(entry: string): string[] {
  const paths = new Set<string>(), seen = new Set<string>()
  const pending: Array<{ name: string; entry: string; aliases: string[] }> = [{ name: '@tangle-network/harness-sessions', entry, aliases: [] }]
  while (pending.length) {
    const next = pending.shift()!
    let root = dirname(realpathSync(next.entry))
    let manifest: { name?: string; dependencies?: Record<string, string> } | undefined
    for (;;) {
      const path = join(root, 'package.json')
      if (existsSync(path)) {
        const value = JSON.parse(readFileSync(path, 'utf8')) as typeof manifest
        if (value?.name === next.name) { manifest = value; break }
      }
      if (root === parse(root).root) throw new Error('Reader package root is unavailable')
      root = dirname(root)
    }
    paths.add(root)
    for (const alias of next.aliases) {
      if (realpathSync(alias) !== root) throw new Error('Reader dependency alias differs from its installed package')
      paths.add(alias)
    }
    if (seen.has(root)) continue
    if (seen.size >= 64) throw new Error('Reader dependency closure exceeds the bound')
    seen.add(root)
    const require = createRequire(join(root, 'package.json'))
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const resolved = require.resolve(name)
      const aliases = (require.resolve.paths(name) ?? []).map(base => join(base, name)).filter(path => existsSync(path))
      // Only the first real lookup candidate is part of this installed dependency.
      pending.push({ name, entry: resolved, aliases: aliases.slice(0, 1) })
    }
  }
  return [...paths]
}

export async function captureConfinedOpenCodeStore(directory: FileHandle, database: FileHandle, nativeSessionIds: readonly string[], spool: string): Promise<{ bytes: Uint8Array; nativeSessionIds: string[] }> {
  const entry = import.meta.resolve('@tangle-network/harness-sessions')
  const readable = readerPaths(fileURLToPath(entry))
  const job = await mkdtemp(join(spool, 'snapshot-'))
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), DEADLINE_MS)
  let spawned: SpawnResult | undefined
  const companions: FileHandle[] = []
  try {
    const uid = (await database.stat()).uid
    companions.push(await openCompanion(directory, 'wal', uid))
    companions.push(await openCompanion(directory, 'shm', uid))
    const script = join(job, 'snapshot.mjs')
    await writeFile(script, await readFile(new URL('./native-snapshot-worker.mjs', import.meta.url)), { mode: 0o600 })
    const request = JSON.stringify(nativeSessionIds)
    if (Buffer.byteLength(request) > 64 * 1024) throw new NativeSnapshotUnavailable('native-snapshot-input-bound-exceeded')
    spawned = await hostSpawner(process.execPath, [script, entry, '/native-store/opencode.db', '/native-source/opencode.db'], {
      cwd: job, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: job },
      stdio: ['pipe', 'pipe', 'pipe', directory.fd, database.fd, companions[0]!.fd, companions[1]!.fd, directory.fd], signal: controller.signal, acquireDeadlineMs: 5_000,
      jail: { root: '.agent-home', projectDir: job, readConfine: true, requireEnforcement: true, network: 'none',
        exactReadPaths: [...new Set([process.execPath, realpathSync(process.execPath), '/usr/lib', '/usr/lib64', '/lib', '/lib64', '/etc/ld.so.cache', ...readable])].filter(existsSync),
        readOnlyDescriptors: [{ fd: 3, path: '/native-store' }, { fd: 4, path: '/native-store/opencode.db' }, { fd: 7, path: '/native-source' }],
        sqliteCompanionDescriptors: [{ fd: 5, path: '/native-store/opencode.db-wal' }, { fd: 6, path: '/native-store/opencode.db-shm' }] },
    })
    const child = spawned.child
    const chunks: Buffer[] = []
    let length = 0, stderrBytes = 0, failed = false
    const closed = new Promise<number | null>(resolve => {
      child.once('error', () => { failed = true })
      child.once('close', code => resolve(code))
    })
    child.stdout?.on('data', (bytes: Buffer) => {
      length += bytes.length
      if (length > MAX_OUTPUT) { failed = true; controller.abort() }
      else chunks.push(bytes)
    })
    child.stderr?.on('data', (bytes: Buffer) => {
      stderrBytes += bytes.length
      if (stderrBytes > 16 * 1024) { failed = true; controller.abort() }
    })
    child.stdin?.on('error', () => { failed = true })
    child.stdin?.end(request)
    controller.signal.throwIfAborted()
    if (spawned.spawnError?.()) throw new NativeSnapshotUnavailable('native-snapshot-worker-unavailable')
    let rejectAbort: (() => void) | undefined
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new NativeSnapshotUnavailable('native-snapshot-deadline-or-output-bound-exceeded'))
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    let code: number | null
    try { code = await Promise.race([closed, interrupted]) }
    finally { if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort) }
    if (controller.signal.aborted) throw new NativeSnapshotUnavailable('native-snapshot-deadline-or-output-bound-exceeded')
    if (failed || code !== 0 || spawned.spawnError?.()) throw new NativeSnapshotUnavailable('native-snapshot-worker-unavailable')
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { bytes?: unknown; nativeSessionIds?: unknown }
    const ids = value.nativeSessionIds
    if (typeof value.bytes !== 'string' || !Array.isArray(ids)
      || !ids.length || ids.length > bounds.maxFiles
      || ids.some(id => typeof id !== 'string' || !id)
      || new Set(ids).size !== ids.length
      || !nativeSessionIds.every(id => ids.includes(id))) throw new Error('Invalid snapshot output')
    const bytes = Buffer.from(value.bytes, 'base64')
    if (bytes.length > bounds.maxFileBytes || bytes.toString('base64') !== value.bytes) throw new Error('Invalid snapshot bytes')
    return { bytes, nativeSessionIds: ids as string[] }
  } finally {
    clearTimeout(deadline)
    const cleanup = async () => {
      if (spawned && await terminateSpawned(spawned) !== 'stopped') throw new Error('Native snapshot worker termination is unconfirmed')
      await rm(job, { recursive: true, force: true })
    }
    spawned?.release()
    try { await cleanup() } catch (error) { retryCleanupUntilSuccessful(cleanup); throw error }
    finally { await Promise.all(companions.map(handle => handle.close())) }
  }
}
