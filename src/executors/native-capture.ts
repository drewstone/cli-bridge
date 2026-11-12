/** Terminal native-family copies share the raw producer spool and precede private lease release. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  BOUND_HARNESS_SESSION_READ_LIMITS as bounds,
  CODEX_HOME_RULE, STORES, claudeCodeRefForFile, codexRefForFile,
  completeLinePrefix, locateDeclaredSessionFiles, readBoundHarnessSessions, readSessionInput, storeGlob,
  type NativeSessionCopy,
} from '@tangle-network/harness-sessions'
import type { EffectiveNativeStore } from '../jail/types.js'
import type { NativeRunCapture, RunSnapshot } from '../runs/types.js'

const READ_DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const CREATE_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
const digest = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

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
  if (!['codex', 'claude-code'].includes(input.backend)) return unavailable('unsupported-native-harness')
  if (process.platform !== 'linux') return unavailable('unsupported-descriptor-relative-host')
  const harness = input.backend as 'codex' | 'claude-code'
  const { store, snapshot } = input
  if (!input.cwd || !input.profileDigest || !snapshot.sessionId || input.nativeSessionIds.length !== 1 ||
    !input.processIds.length || input.processIds.length !== input.processes.length || !store || store.harness !== harness || store.basis !== 'host-jail') {
    return unavailable('native-execution-binding-unavailable')
  }
  let home: FileHandle | undefined
  let files: Awaited<ReturnType<typeof locateDeclaredSessionFiles<string>>>['files'] = []
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
    await mkdir(root, { recursive: true, mode: 0o700 })
    const spool = await lstat(root)
    if (!spool.isDirectory() || spool.isSymbolicLink() || (spool.mode & 0o077) || await realpath(root) !== root || spool.uid !== process.getuid?.()) {
      return unavailable('native-spool-is-not-private')
    }
    home = await open(cwd, READ_DIRECTORY)
    const uid = (await home.stat()).uid
    const directories = harness === 'codex' ? CODEX_HOME_RULE.sessionDirs : ['projects']
    const patterns = harness === 'codex' ? [storeGlob(CODEX_HOME_RULE.rollout)] : STORES['claude-code.projects-jsonl'].files.map((glob) => storeGlob(glob))
    const located = await locateDeclaredSessionFiles({ home, uid, maxEntries: bounds.maxFiles,
      stores: directories.map((directory) => ({ store: directory, root: `${relativeStore}/${directory}`,
        matches: (path: string) => patterns.some((pattern) => pattern.test(harness === 'codex' ? path.split('/').at(-1)! : path)) })) })
    files = located.files
    const inventory = files.map((file) => {
      const path = file.path.slice(relativeStore.length + 1)
      return { path, nativeSessionId: nativeRef(harness, path).nativeSessionId, handle: file.handle, store: file.store }
    })
    const id = randomUUID()
    const provenance: Array<{ path: string; nativeSessionId: string; parentNativeSessionId: string | null; sourceSha256: string; sourceByteLength: number; retainedSha256: string; retainedByteLength: number; payload: string; redacted: boolean; truncated: boolean }> = []
    const missingReasons = [...located.rejected]
    let total = 0
    let family: Awaited<ReturnType<typeof readBoundHarnessSessions>> | undefined
    try {
      family = await readBoundHarnessSessions({ nativeSessionId: input.nativeSessionIds[0]!, files: inventory,
        validatePath: (path) => { if (!inventory.some((file) => file.path === path)) throw new Error('Native file was not in the held host inventory') },
        parse: (text, file) => readSessionInput(harness, { text }, { ...nativeRef(harness, file.path), label: file.path }, { corruption: 'strict' }),
        read: async (file) => {
          const source = inventory.find((entry) => entry.path === file.path)!
          const before = await source.handle.stat()
          total += before.size
          if (before.size > bounds.maxFileBytes || total > bounds.maxTotalBytes) throw new Error('Native source bytes exceed capture bound')
          const length = await completeLinePrefix(source.handle, before.size)
          const bytes = Buffer.alloc(before.size)
          let at = 0
          while (at < bytes.length) {
            const { bytesRead } = await source.handle.read(bytes, at, bytes.length - at, at)
            if (!bytesRead) throw new Error('Native source ended before its held size')
            at += bytesRead
          }
          const after = await source.handle.stat()
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Native source changed during terminal capture')
          if (length !== bytes.length) missingReasons.push(`native_incomplete_final_line:${file.path}`)
          const prefix = bytes.subarray(0, length)
          const retained = input.redact(prefix)
          // Preserve the reader-owned native basename, including Claude's agent-<id> child attribution.
          const payload = `${id}-${provenance.length}/${basename(file.path)}`
          const labels = Buffer.from(JSON.stringify({ payload, path: file.path, nativeSessionId: file.nativeSessionId,
            parentNativeSessionId: nativeRef(harness, file.path).parentNativeSessionId }))
          if (!Buffer.from(input.redact(labels)).equals(labels)) throw new Error('Private native labels cannot become retained identities')
          await writePayload(root, payload, retained)
          provenance.push({ path: file.path, nativeSessionId: file.nativeSessionId, parentNativeSessionId: nativeRef(harness, file.path).parentNativeSessionId,
            sourceSha256: digest(bytes), sourceByteLength: bytes.length,
            retainedSha256: digest(retained), retainedByteLength: retained.byteLength, payload,
            redacted: !Buffer.from(retained).equals(prefix), truncated: length !== bytes.length })
          return retained
        },
      })
    } catch { missingReasons.push('native-family-integrity-unverified') }
    const familyVerified = !!family && !missingReasons.length
    const copy: NativeSessionCopy = {
      harness, format: harness === 'codex' ? 'codex.rollout-jsonl' : 'claude-code.projects-jsonl',
      executionId: snapshot.executionId ?? snapshot.id, attempt: 1, nativeSessionId: input.nativeSessionIds[0]!,
      copy: 'settled', capturedAt: new Date().toISOString(),
      // Preserve an actual single-child receipt; multiple children have individual receipts below.
      process: input.processes.length === 1 ? { pid: input.processes[0]!.pid, exitedAt: input.processes[0]!.closedAt,
        exitCode: input.processes[0]!.exitCode, signal: input.processes[0]!.signal } : { pid: null, exitedAt: null, exitCode: null, signal: null },
      files: provenance.map((file) => ({ path: file.payload, store: harness === 'codex' ? '.codex' : '.claude', storePath: `${harness === 'codex' ? '.codex' : '.claude'}/${file.path}`, sizeBytes: file.retainedByteLength,
        sha256: file.retainedSha256, method: 'atomic-file', truncated: file.truncated })),
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
    if (!Buffer.from(input.redact(bytes)).equals(bytes)) return unavailable('native-capture-metadata-requires-redaction')
    const committed = await writePayload(root, `${id}.native.json`, bytes)
    // Commit the directory before the terminal snapshot can advertise its manifest.
    const directory = await open(root, READ_DIRECTORY)
    try { await directory.sync() } finally { await directory.close() }
    return { status: familyVerified ? 'retained' : 'incomplete', ...committed }
  } catch { return unavailable('native-capture-failed') }
  finally { await Promise.all(files.map((file) => file.handle.close())); await home?.close() }
}
