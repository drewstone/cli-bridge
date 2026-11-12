import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { Transform } from 'node:stream'
import type { RunSnapshot } from '../runs/types.js'
import type { NativeCaptureInput } from './native-capture.js'
import type { EffectiveNativeStore } from '../jail/types.js'

export type TerminalNativeCapture = (input: Pick<NativeCaptureInput, 'store' | 'nativeSessionIds' | 'processIds'>) => Promise<void>

interface CaptureScope {
  root?: string
  identity: Pick<RunSnapshot, 'id' | 'requestDigest' | 'provider' | 'environmentId' | 'sessionId' | 'executionId'>
  backend: string
  workspace?: string
  pending: Array<{ child: ChildProcess; done: Promise<void> }>
  failures: Error[]
  nativeSessionIds: Set<string>
  processIds: string[]
  protectedValues: readonly string[]
  terminal?: TerminalNativeCapture
  nativeStore?: EffectiveNativeStore
  nativeStoreConflict?: boolean
}
const scopes = new AsyncLocalStorage<CaptureScope>()

/** Bind process bytes to the durable run after any admitted credential redaction. */
export function withRawProcessCapture<T>(source: AsyncIterable<T>, snapshot: RunSnapshot, backend: string, workspace?: string, protectedValues: readonly string[] = [], terminal?: TerminalNativeCapture): AsyncIterable<T> {
  const root = process.env.BRIDGE_RAW_CAPTURE_DIR
  if (!root && !protectedValues.length && !terminal) return source
  if (root && !isAbsolute(root)) throw new Error('BRIDGE_RAW_CAPTURE_DIR must be absolute')
  const scope: CaptureScope = {
    ...(root && { root: resolve(root) }), backend, workspace, protectedValues, terminal,
    identity: { id: snapshot.id, requestDigest: snapshot.requestDigest,
      provider: snapshot.provider, environmentId: snapshot.environmentId,
      sessionId: snapshot.sessionId, executionId: snapshot.executionId },
    pending: [], failures: [], nativeSessionIds: new Set(), processIds: [],
  }
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = scopes.run(scope, () => source[Symbol.asyncIterator]())
      const sourceErrors: unknown[] = []
      try {
        while (true) {
          const next = await scopes.run(scope, () => iterator.next())
          if (next.done) break
          if (typeof next.value === 'object' && next.value !== null) {
            const delta = next.value as { internal_session_id?: unknown; finish_reason?: unknown; effective_native_store?: EffectiveNativeStore }
            if (typeof delta.internal_session_id === 'string') scope.nativeSessionIds.add(delta.internal_session_id)
            if (delta.effective_native_store) {
              if (scope.nativeStore && JSON.stringify(scope.nativeStore) !== JSON.stringify(delta.effective_native_store)) scope.nativeStoreConflict = true
              scope.nativeStore = delta.effective_native_store
            }
            if (delta.finish_reason) {
              // The parser has declared its terminal; drain any trailing original bytes.
              for (const { child } of scope.pending) { child.stdout?.resume(); child.stderr?.resume() }
            }
          }
          yield next.value
        }
      } catch (error) {
        sourceErrors.push(error)
      } finally {
        const closing = scopes.run(scope, async () => { await iterator.return?.() })
          .catch(error => { sourceErrors.push(error) })
        // A parser may stop at a terminal message before consuming the last pipe bytes.
        for (const { child } of scope.pending) { child.stdout?.resume(); child.stderr?.resume() }
        await closing
        await Promise.all(scope.pending.map(({ done }) => done))
        try { await scope.terminal?.({ store: scope.nativeStoreConflict ? undefined : scope.nativeStore,
          nativeSessionIds: [...scope.nativeSessionIds], processIds: scope.processIds }) }
        catch (error) { sourceErrors.push(error) }
        try {
          if (scope.root && scope.processIds.length) {
            const name = createHash('sha256').update(JSON.stringify(scope.identity)).digest('hex') + '.json'
            const fd = openSync(join(scope.root, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
            try {
              const bytes = Buffer.from(JSON.stringify({ ...scope.identity, backend: scope.backend,
                nativeSessionIds: [...scope.nativeSessionIds], processIds: scope.processIds,
                processStreams: scope.failures.length ? 'incomplete' : 'captured', nativeStore: 'external',
                ...(scope.protectedValues.length && { redaction: 'private-mcp-secrets' }),
              }) + '\n')
              for (let offset = 0; offset < bytes.length;) {
                const written = writeSync(fd, bytes, offset, bytes.length - offset)
                if (written <= 0) throw new Error('Raw manifest write made no progress')
                offset += written
              }
              fsyncSync(fd)
            } finally { closeSync(fd) }
          }
        } catch (error) { sourceErrors.push(error) }
        const errors = [...sourceErrors, ...scope.failures]
        if (errors.length === 1) throw errors[0]
        if (errors.length) throw new AggregateError(errors, 'Source execution, cleanup, or original process capture failed')
      }
    },
  }
}

/** One exact-byte filter for native process streams and trusted retained-copy redaction. */
function credentialWriter(values: readonly string[], emit: (bytes: Buffer) => void) {
  const needles = [...new Set(values.flatMap(value => [value, JSON.stringify(value).slice(1, -1)]))]
    .filter(Boolean).map(value => Buffer.from(value)).sort((a, b) => b.length - a.length)
  const keep = Math.max(0, ...needles.map(value => value.length - 1))
  let pending: Buffer = Buffer.alloc(0)
  return (chunk: Uint8Array, final = false) => {
    pending = Buffer.concat([pending, chunk])
    const limit = final ? pending.length : Math.max(0, pending.length - keep)
    let at = 0, start = 0
    while (at < limit) {
      const match = needles.find(needle => pending.subarray(at, at + needle.length).equals(needle))
      if (!match) { at++; continue }
      if (at > start) emit(pending.subarray(start, at))
      emit(Buffer.from('[redacted:MCP]'))
      at += match.length
      start = at
    }
    if (at > start) emit(pending.subarray(start, at))
    pending = pending.subarray(at)
  }
}

/** Trusted in-process capability; no value crosses the port and server close revokes it. */
export function privateCopyRedactor(values: readonly string[]) {
  let current: readonly string[] | undefined = [...values]
  return {
    redact(bytes: Uint8Array): Uint8Array {
      if (!current) throw new Error('Private run redaction authority is closed')
      const chunks: Buffer[] = []
      credentialWriter(current, bytes => chunks.push(bytes))(bytes, true)
      return Buffer.concat(chunks)
    },
    close() { current = undefined },
  }
}

/** Filter before any parser or raw log observes the process's bytes, including split secrets. */
function protectChild(child: ChildProcess, values: readonly string[]): ChildProcess {
  if (!values.length) return child
  for (const stream of ['stdout', 'stderr'] as const) {
    const source = child[stream]
    if (!source) continue
    const write = credentialWriter(values, bytes => filter.push(bytes))
    const filter = new Transform({
      transform(chunk: Buffer, _encoding, callback) { write(chunk); callback() },
      flush(callback) { write(Buffer.alloc(0), true); callback() },
    })
    source.on('error', error => filter.destroy(error))
    child[stream] = source.pipe(filter)
    child.stdio[stream === 'stdout' ? 1 : 2] = filter
  }
  return child
}

function trackChild(scope: CaptureScope, child: ChildProcess, close: (code: number | null, signal: NodeJS.Signals | null) => void) {
  const done = new Promise<void>(resolveDone => {
    child.once('close', (code, signal) => {
      try { close(code, signal) } catch (error) { scope.failures.push(error instanceof Error ? error : new Error(String(error))) } finally { resolveDone() }
    })
  })
  scope.pending.push({ child, done })
}

/** All shared executors use this spawn seam; harness adapters do not select capture behavior. */
export function spawnCaptured(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  const scope = scopes.getStore()
  if (!scope) return nodeSpawn(command, args, options)
  if (!scope.root) {
    const child = protectChild(nodeSpawn(command, args, options), scope.protectedValues)
    if (scope.terminal) { scope.processIds.push(randomUUID()); trackChild(scope, child, () => {}) }
    return child
  }
  if (scope.workspace) {
    const rel = relative(resolve(scope.workspace), scope.root)
    if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Raw capture must be outside the agent workspace')
  }
  if (options.stdio !== undefined && options.stdio !== 'pipe' && (!Array.isArray(options.stdio) || options.stdio[1] !== 'pipe' || options.stdio[2] !== 'pipe')) throw new Error('Raw capture requires piped stdout and stderr')
  mkdirSync(scope.root, { recursive: true, mode: 0o700 })
  const root = lstatSync(scope.root)
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0 || realpathSync(scope.root) !== scope.root) {
    throw new Error('Raw capture root must be a private real directory')
  }
  const id = randomUUID()
  scope.processIds.push(id)
  const fd = openSync(join(scope.root, id + '.frames'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  const target = fstatSync(fd)
  if (!target.isFile() || target.nlink !== 1) { closeSync(fd); throw new Error('Raw capture requires a regular private file') }
  let sequence = 0
  let captureError: string | null = null
  let closed = false
  const append = (record: Record<string, unknown>) => {
    const bytes = Buffer.from(JSON.stringify({ processId: id, sequence: sequence++, at: new Date().toISOString(), ...record }) + '\n')
    for (let offset = 0; offset < bytes.length;) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (written <= 0) throw new Error('Raw capture write made no progress')
      offset += written
    }
  }
  const fail = (error: unknown) => {
    const failure = error instanceof Error ? error : new Error(String(error))
    captureError ??= failure.message
    scope.failures.push(failure)
  }
  const close = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: string) => {
    if (closed) return
    closed = true
    try {
      append({ terminal: { exitCode, signal, captureError, ...(spawnError ? { spawnError } : {}) } })
      fsyncSync(fd)
    } catch (error) { fail(error) } finally { closeSync(fd) }
  }
  let child: ChildProcess
  try {
    const binding = Buffer.from(JSON.stringify({ ...scope.identity, backend: scope.backend, executable: command }))
    append({ stream: 'protocol', base64Bytes: binding.toString('base64'), sizeBytes: binding.length,
      sha256: createHash('sha256').update(binding).digest('hex'), metadata: { kind: 'bridge-run-binding' } })
    child = protectChild(nodeSpawn(command, args, options), scope.protectedValues)
  } catch (error) {
    close(null, null, error instanceof Error ? error.message : String(error))
    throw error
  }
  for (const stream of ['stdout', 'stderr'] as const) {
    const source = child[stream]
    if (!source) { fail(new Error('Raw capture requires piped ' + stream)); continue }
    const tee = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          append({ stream, base64Bytes: chunk.toString('base64'), sizeBytes: chunk.length,
            sha256: createHash('sha256').update(chunk).digest('hex') })
          callback(null, chunk)
        } catch (error) {
          fail(error)
          callback(error instanceof Error ? error : new Error(String(error)))
          child.kill('SIGTERM')
        }
      },
    })
    // Capture before a harness parser can decode UTF-8 or discard a native frame.
    source.on('error', error => tee.destroy(error))
    tee.on('error', error => { fail(error) })
    child[stream] = source.pipe(tee)
    child.stdio[stream === 'stdout' ? 1 : 2] = tee
  }
  let spawnError: string | undefined
  child.once('error', error => { spawnError = error.message })
  trackChild(scope, child, (code, signal) => close(code, signal, spawnError))
  return child
}
