/** Terminal native-family copies share the raw producer spool and precede private lease release. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, realpath, rm, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import * as harnessSessions from '@tangle-network/harness-sessions'
import {
  BOUND_HARNESS_SESSION_READ_LIMITS as bounds,
  CODEX_HOME_RULE, STORES, claudeCodeRefForFile, codexRefForFile,
  completeLinePrefix, locateDeclaredSessionFiles, maybeReaderFor, readBoundHarnessSessions, readHeldSessionFile, readSessionInput, storeGlob,
  type NativeSessionCopy, type HarnessSession, type HarnessFileBinding, type ReadOptions,
} from '@tangle-network/harness-sessions'
import type { EffectiveNativeStore } from '../jail/types.js'
import type { NativeRunCapture, RunSnapshot } from '../runs/types.js'
import { isPrivateDirectory } from '../runtime/single-instance.js'
import { captureConfinedOpenCodeStore, NativeSnapshotUnavailable } from './native-snapshot.js'

const READ_DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const CREATE_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
const digest = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

type NativeFamily = Awaited<ReturnType<typeof readBoundHarnessSessions<HarnessSession>>>
type BinaryFamilyInput = Omit<Parameters<typeof readBoundHarnessSessions<HarnessSession>>[0], 'parse'> & {
  parseBytes(bytes: Uint8Array, file: HarnessFileBinding, signal?: AbortSignal): Promise<HarnessSession>
}
interface OpenCodeSnapshots {
  captureOpenCodeSessionStore(path: string, ids: readonly string[], options?: ReadOptions): Promise<{ bytes: Uint8Array; nativeSessionIds: string[] }>
  readOpenCodeSessionSnapshot(bytes: Uint8Array, id: string, options?: ReadOptions & { label?: string }): Promise<HarnessSession>
  readBoundHarnessSessions(input: BinaryFamilyInput): Promise<NativeFamily>
}

/** These APIs ship together in the reader owner. An older installed reader stays unsupported. */
function openCodeSnapshots(): OpenCodeSnapshots | undefined {
  const api = harnessSessions as unknown as Partial<OpenCodeSnapshots>
  return typeof api.captureOpenCodeSessionStore === 'function'
    && typeof api.readOpenCodeSessionSnapshot === 'function'
    && typeof api.readBoundHarnessSessions === 'function' ? api as OpenCodeSnapshots : undefined
}

export interface NativeProcessTerminal {
  captureId: string
  pid: number | null
  exitCode: number | null
  signal: NodeJS.Signals | null
  closedAt: string
}

export interface NativeCaptureInput {
  snapshot: RunSnapshot
  backend: string
  cwd?: string
  profileDigest: string | null
  store?: EffectiveNativeStore
  nativeSessionIds: readonly string[]
  processIds: readonly string[]
  processes: readonly NativeProcessTerminal[]
  /** Existing process wrapper invokes this only after every spawned child has closed. */
  root: string
  redact(bytes: Uint8Array): Uint8Array
}
export type NativeCaptureTarget = (input: Omit<NativeCaptureInput, 'root' | 'redact'>) => Promise<NativeRunCapture>

/** The reader supplies native identity; this adapter only binds a child filename to its recorded parent folder. */
function nativeRef(harness: 'codex' | 'claude-code', path: string) {
  if (harness === 'codex') return codexRefForFile(path)
  const parts = path.split('/')
  const at = parts.indexOf('subagents')
  return claudeCodeRefForFile(path, at > 0 ? parts[at - 1]! : null)
}

async function writePayload(root: string, name: string, bytes: Uint8Array) {
  const path = join(root, name)
  const parent = dirname(path)
  if (parent !== root) await mkdir(parent, { mode: 0o700 })
  const handle = await open(path, CREATE_FILE, 0o600)
  try { await handle.writeFile(bytes); await handle.sync() }
  finally { await handle.close() }
  if (parent !== root) {
    const directory = await open(parent, READ_DIRECTORY)
    try { await directory.sync() } finally { await directory.close() }
  }
  return { path, sha256: digest(bytes), byteLength: bytes.byteLength }
}

/** No source bytes or private values are written before the exact redactor transforms them. */
export async function captureTerminalNativeFamily(input: NativeCaptureInput): Promise<NativeRunCapture> {
  const unavailable = (reason: string): NativeRunCapture => ({ status: 'unavailable', reason })
  if (!['codex', 'claude-code', 'opencode', 'gemini'].includes(input.backend)) return unavailable('unsupported-native-harness')
  if (process.platform !== 'linux') return unavailable('unsupported-descriptor-relative-host')
  const harness = input.backend as EffectiveNativeStore['harness']
  const snapshots = harness === 'opencode' ? openCodeSnapshots() : undefined
  if (harness === 'opencode' && !snapshots) return unavailable('opencode-session-snapshot-capability-unavailable')
  const gemini = harness === 'gemini' ? maybeReaderFor('gemini') : undefined
  if (harness === 'gemini' && !gemini?.formats.some(format => String(format) === 'gemini.chat-jsonl')) return unavailable('gemini-native-reader-capability-unavailable')
  const { store, snapshot } = input
  if (!input.cwd || !input.profileDigest || !snapshot.sessionId || input.nativeSessionIds.length !== 1 ||
    !input.processIds.length || input.processIds.length !== input.processes.length || !store || store.harness !== harness || store.basis !== 'host-jail') {
    return unavailable('native-execution-binding-unavailable')
  }
  let home: FileHandle | undefined
  let files: Awaited<ReturnType<typeof locateDeclaredSessionFiles<string>>>['files'] = []
  // A capture that commits no manifest removes every payload it wrote.
  const written: string[] = []
  const discard = () => Promise.all(written.map((path) => rm(path, { recursive: true, force: true }))).catch(() => undefined)
  try {
    const cwd = await realpath(input.cwd)
    const storeRoot = await realpath(store.root)
    const root = resolve(input.root)
    const identity = Buffer.from(JSON.stringify({ cwd, root, store, runId: snapshot.id, sessionId: snapshot.sessionId,
      profileDigest: input.profileDigest, nativeSessionIds: input.nativeSessionIds }))
    if (!Buffer.from(input.redact(identity)).equals(identity)) return unavailable('native-capture-metadata-requires-redaction')
    const spoolFromCwd = relative(cwd, root)
    const relativeStore = relative(cwd, storeRoot)
    if (cwd !== input.cwd || storeRoot !== store.root || !relativeStore.startsWith('.agent-home/') ||
      !spoolFromCwd || (!(spoolFromCwd === '..' || spoolFromCwd.startsWith('../')) && !isAbsolute(spoolFromCwd))) {
      return unavailable('native-store-or-spool-outside-host-policy')
    }
    if (!isPrivateDirectory(root)) return unavailable('native-spool-is-not-private')
    home = await open(cwd, READ_DIRECTORY)
    const uid = (await home.stat()).uid
    const id = randomUUID()
    const provenance: Array<{ path: string; nativeSessionId: string; parentNativeSessionId: string | null; sourceSha256: string; sourceByteLength: number; retainedSha256: string; retainedByteLength: number; payload: string; redacted: boolean; truncated: boolean }> = []
    const missingReasons: string[] = []
    let family: NativeFamily | undefined
    if (harness === 'opencode') {
      const directory = await open(storeRoot, READ_DIRECTORY)
      let database: FileHandle | undefined
      try {
        const source = `/proc/self/fd/${directory.fd}/opencode.db`
        database = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const before = await database.stat()
        if (!before.isFile() || before.uid !== uid || before.nlink !== 1
          || await realpath(source) !== join(storeRoot, 'opencode.db')) {
          return unavailable('native-database-outside-host-policy')
        }
        // SQLite opens its own WAL/SHM/journal. The existing read jail constrains all
        // of those opens; pre/post descriptor checks alone are not a race-free boundary.
        const captured = await captureConfinedOpenCodeStore(directory, database, input.nativeSessionIds, root)
        const check = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const after = await check.stat()
          if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('Native database changed during capture')
        } finally { await check.close() }
        const retained = input.redact(captured.bytes)
        // A byte redactor cannot repair SQLite page structure. Never commit original secrets
        // or a corrupted database; a format-aware redaction owner is a separate capability.
        if (!Buffer.from(retained).equals(Buffer.from(captured.bytes))) return unavailable('native-binary-redaction-required')
        const path = 'opencode.db', payload = `${id}/${path}`
        const sha256 = digest(retained)
        const bindings = captured.nativeSessionIds.map(nativeSessionId => ({ path, nativeSessionId, sha256, byteLength: retained.byteLength }))
        family = await snapshots!.readBoundHarnessSessions({ nativeSessionId: input.nativeSessionIds[0]!, files: bindings,
          validatePath: path => { if (path !== 'opencode.db') throw new Error('Native file was not in the selected projection') },
          read: async () => retained,
          parseBytes: (bytes, file, signal) => snapshots!.readOpenCodeSessionSnapshot(bytes, file.nativeSessionId, { label: file.path, signal, corruption: 'strict' }),
        })
        for (const file of family.files) {
          const session = family.sessions.find(session => session.nativeSessionId === file.nativeSessionId)!
          provenance.push({ path, nativeSessionId: file.nativeSessionId, parentNativeSessionId: session.parentNativeSessionId,
            // The source object is the selected-session projection, never the whole DB.
            sourceSha256: sha256, sourceByteLength: retained.byteLength,
            retainedSha256: sha256, retainedByteLength: retained.byteLength, payload, redacted: false, truncated: false })
        }
        const labels = Buffer.from(JSON.stringify(provenance))
        if (!Buffer.from(input.redact(labels)).equals(labels)) return unavailable('native-capture-metadata-requires-redaction')
        written.push(join(root, id))
        await writePayload(root, payload, retained)
      } finally { await database?.close(); await directory.close() }
    } else {
      const directories = harness === 'codex' ? CODEX_HOME_RULE.sessionDirs : harness === 'gemini' ? ['tmp'] : ['projects']
      const patterns = harness === 'codex' ? [storeGlob(CODEX_HOME_RULE.rollout)]
        : (harness === 'gemini' ? gemini!.stores.flatMap(store => store.files) : STORES['claude-code.projects-jsonl'].files).map(glob => storeGlob(glob))
      const located = await locateDeclaredSessionFiles({ home, uid, maxEntries: bounds.maxFiles,
        stores: directories.map((directory) => ({ store: directory, root: `${relativeStore}/${directory}`,
          matches: (path: string) => patterns.some((pattern) => pattern.test(harness === 'codex' ? path.split('/').at(-1)! : path)) })) })
      files = located.files
      const inventory: Array<{ path: string; nativeSessionId: string; parentNativeSessionId: string | null; handle: FileHandle; bytes?: Uint8Array }> = []
      let scanned = 0
      for (const file of files) {
        const path = file.path.slice(relativeStore.length + 1)
        if (harness !== 'gemini') {
          const ref = nativeRef(harness, path)
          inventory.push({ path, nativeSessionId: ref.nativeSessionId, parentNativeSessionId: ref.parentNativeSessionId, handle: file.handle })
          continue
        }
        // Gemini filenames shorten the native ID. Select the exact header through
        // the shared fold, using held bounded bytes and the process-bound workspace.
        try {
          const bytes = await readHeldSessionFile(file.handle, Math.min(bounds.maxFileBytes, bounds.maxTotalBytes - scanned))
          scanned += bytes.length
          const length = path.endsWith('.jsonl') ? await completeLinePrefix(bytes, bytes.length) : bytes.length
          const init = { label: path, cwd }
          const parsed = readSessionInput('gemini', { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)) }, init, { corruption: 'strict' })
          if (parsed.nativeSessionId === input.nativeSessionIds[0]) {
            if (parsed.integrity.truncated || parsed.integrity.unparsedRecords || parsed.integrity.gaps.length) {
              return unavailable('native-session-identity-or-integrity-unverified')
            }
            inventory.push({ path, nativeSessionId: parsed.nativeSessionId,
              parentNativeSessionId: parsed.parentNativeSessionId, handle: file.handle, bytes })
          }
        } catch { missingReasons.push('native-inventory-record-unreadable') }
      }
      missingReasons.push(...located.rejected)
      let total = 0
      try {
        family = await readBoundHarnessSessions({ nativeSessionId: input.nativeSessionIds[0]!, files: inventory,
          validatePath: (path) => { if (!inventory.some((file) => file.path === path)) throw new Error('Native file was not in the held host inventory') },
          parse: (text, file) => {
            const source = inventory.find(entry => entry.path === file.path)!
            const init = { nativeSessionId: file.nativeSessionId, parentNativeSessionId: source.parentNativeSessionId, label: file.path, ...(harness === 'gemini' ? { cwd } : {}) }
            return readSessionInput(harness, { text }, init, { corruption: 'strict' })
          },
          read: async (file) => {
            const source = inventory.find((entry) => entry.path === file.path)!
            const bytes = source.bytes ?? await readHeldSessionFile(source.handle, Math.min(bounds.maxFileBytes, bounds.maxTotalBytes - total))
            total += bytes.length
            const length = harness === 'gemini' && file.path.endsWith('.json') ? bytes.length : await completeLinePrefix(bytes, bytes.length)
            const sourceSha256 = digest(bytes)
            if (length !== bytes.length) missingReasons.push(`native_incomplete_final_line:${file.path}`)
            const prefix = bytes.subarray(0, length)
            const retained = input.redact(prefix)
            // Preserve the reader-owned native basename, including Claude's agent-<id> child attribution.
            const payload = `${id}-${provenance.length}/${basename(file.path)}`
            const labels = Buffer.from(JSON.stringify({ payload, path: file.path, nativeSessionId: file.nativeSessionId,
              parentNativeSessionId: source.parentNativeSessionId }))
            if (!Buffer.from(input.redact(labels)).equals(labels)) throw new Error('Private native labels cannot become retained identities')
            const directory = join(root, dirname(payload))
            written.push(directory)
            await writePayload(root, payload, retained).catch(async (error: unknown) => { await rm(directory, { recursive: true, force: true }); throw error })
            provenance.push({ path: file.path, nativeSessionId: file.nativeSessionId, parentNativeSessionId: source.parentNativeSessionId,
              sourceSha256, sourceByteLength: bytes.length,
              retainedSha256: digest(retained), retainedByteLength: retained.byteLength, payload,
              redacted: !Buffer.from(retained).equals(prefix), truncated: length !== bytes.length })
            return retained
          },
        })
      } catch { missingReasons.push('native-family-integrity-unverified') }
    }
    if (family && family.sessions.find(session => session.nativeSessionId === input.nativeSessionIds[0])?.cwd !== cwd) {
      await discard()
      return unavailable('native-session-workspace-mismatch')
    }
    const familyVerified = !!family && !missingReasons.length
    const storeLabel = harness === 'codex' ? '.codex' : harness === 'opencode' ? '.local/share/opencode' : harness === 'gemini' ? '.gemini' : '.claude'
    const copy: NativeSessionCopy = {
      harness, format: family?.sessions.find(session => session.nativeSessionId === input.nativeSessionIds[0])?.format
        ?? (harness === 'codex' ? 'codex.rollout-jsonl' : harness === 'opencode' ? 'opencode.sqlite' : harness === 'gemini' ? 'gemini.chat-json' : 'claude-code.projects-jsonl'),
      executionId: snapshot.executionId ?? snapshot.id, attempt: 1, nativeSessionId: input.nativeSessionIds[0]!,
      copy: 'settled', capturedAt: new Date().toISOString(),
      // Preserve an actual single-child receipt; multiple children have individual receipts below.
      process: input.processes.length === 1 ? { pid: input.processes[0]!.pid, exitedAt: input.processes[0]!.closedAt,
        exitCode: input.processes[0]!.exitCode, signal: input.processes[0]!.signal } : { pid: null, exitedAt: null, exitCode: null, signal: null },
      files: [...new Map(provenance.map(file => [file.payload, file])).values()].map((file) => ({ path: file.payload, store: storeLabel, storePath: `${storeLabel}/${file.path}`, sizeBytes: file.retainedByteLength,
        sha256: file.retainedSha256, method: file.truncated ? 'byte-prefix' : 'atomic-file', truncated: file.truncated })),
      complete: familyVerified && !provenance.some((file) => file.redacted),
      missingReasons: [...new Set([...missingReasons, ...(provenance.some((file) => file.redacted) ? ['native-original-bytes-redacted'] : [])])],
    }
    const manifest = { schema: 'tangle.raw-evidence-archive.v2', nativeSessions: [copy],
      bridge: { schema: 'cli-bridge.native-capture.v1', runId: snapshot.id, requestDigest: snapshot.requestDigest, sessionId: snapshot.sessionId,
        executionId: snapshot.executionId, provider: snapshot.provider, environmentId: snapshot.environmentId,
        profileDigest: input.profileDigest, cwd, nativeStore: store, processIds: input.processIds, processes: input.processes,
        familyVerified, files: provenance,
        family: family?.files.map((file) => ({ path: file.path, nativeSessionId: file.nativeSessionId, sha256: file.sha256, byteLength: file.byteLength })) ?? [] } }
    const bytes = Buffer.from(JSON.stringify(manifest) + '\n')
    if (!Buffer.from(input.redact(bytes)).equals(bytes)) { await discard(); return unavailable('native-capture-metadata-requires-redaction') }
    written.push(join(root, `${id}.native.json`))
    const committed = await writePayload(root, `${id}.native.json`, bytes)
    // Commit the directory before the terminal snapshot can advertise its manifest.
    const directory = await open(root, READ_DIRECTORY)
    try { await directory.sync() } finally { await directory.close() }
    return { status: familyVerified ? 'retained' : 'incomplete', ...committed }
  } catch (error) { await discard(); return unavailable(error instanceof NativeSnapshotUnavailable ? error.reason : 'native-capture-failed') }
  finally { await Promise.all(files.map((file) => file.handle.close())); await home?.close() }
}
