import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { spawnCaptured, withRawProcessCapture } from '../src/executors/raw-capture.js'
import type { RunSnapshot } from '../src/runs/types.js'

const writeFault = vi.hoisted(() => ({ remaining: -1 }))
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, writeSync: (...args: Parameters<typeof original.writeSync>) => {
    if (writeFault.remaining === 0) { writeFault.remaining = -1; throw new Error('injected capture write failure') }
    if (writeFault.remaining > 0) writeFault.remaining--
    return original.writeSync(...args)
  } }
})
const directories: string[] = []
afterEach(() => { delete process.env.BRIDGE_RAW_CAPTURE_DIR; for (const p of directories.splice(0)) rmSync(p, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-raw-')); directories.push(root)
  process.env.BRIDGE_RAW_CAPTURE_DIR = join(root, 'evidence')
  return root
}
function snapshot(id: string): RunSnapshot {
  return { id, requestDigest: 'sha256:' + 'a'.repeat(64), status: 'running', state: 'running', terminal: false,
    attachedReaders: 1, cancelRequestedAt: null, lastSeq: 0,
    replay: { firstAvailableSeq: 1, lastSeq: 0, retainedDeltas: 0, maxRetainedDeltas: 10,
      retainedBytes: 0, maxRetainedBytes: 1000, expiresAt: null, expired: false },
    startedAt: Date.now(), endedAt: null, identityExpiresAt: null, provider: 'native-cli',
    environmentId: 'private-gtr', sessionId: id + '-session', executionId: id + '-execution',
    canonicalLastSeq: 0, lifetimeExpiresAt: null, profileMaterialization: null }
}
function frames(root: string) {
  return readdirSync(join(root, 'evidence')).filter(x => x.endsWith('.frames')).map(file => {
    expect(statSync(join(root, 'evidence', file)).mode & 0o777).toBe(0o600)
    const rows = readFileSync(join(root, 'evidence', file), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    rows.forEach((row, index) => {
      expect(row.sequence).toBe(index)
      if (row.stream) {
        const bytes = Buffer.from(row.base64Bytes, 'base64')
        expect(row.sizeBytes).toBe(bytes.length)
        expect(row.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      }
    })
    expect(rows.at(-1).terminal.captureError).toBe(null)
    return rows
  })
}
async function consume(source: AsyncIterable<unknown>) { for await (const _ of source) { /* drain */ } }

test('captures undecoded bytes for concurrent harnesses with distinct native and durable identities', async () => {
  const root = fixture()
  await Promise.all(['claude-code', 'codex'].map(async (backend, index) => {
    async function* source() {
      const child = spawnCaptured(process.execPath, ['-e', "process.stdout.write(Buffer.from([0,255,195,40]));process.stderr.write(Buffer.from([254,0,10]))"], {})
      const closed = once(child, 'close')
      child.stdout!.setEncoding('utf8')
      for await (const _ of child.stdout!) { /* parser deliberately decodes invalid UTF-8 */ }
      for await (const _ of child.stderr!) { /* drain */ }
      await closed
      yield { internal_session_id: 'native-' + index, finish_reason: 'stop' }
    }
    await consume(withRawProcessCapture(source(), snapshot('run-' + index), backend, join(root, 'workspace-' + index)))
  }))
  const captured = frames(root)
  expect(captured).toHaveLength(2)
  for (const rows of captured) {
    expect(Buffer.concat(rows.filter(x => x.stream === 'stdout').map(x => Buffer.from(x.base64Bytes, 'base64')))).toEqual(Buffer.from([0,255,195,40]))
    expect(Buffer.concat(rows.filter(x => x.stream === 'stderr').map(x => Buffer.from(x.base64Bytes, 'base64')))).toEqual(Buffer.from([254,0,10]))
  }
  const manifests = readdirSync(join(root, 'evidence')).filter(x => x.endsWith('.json')).map(x => JSON.parse(readFileSync(join(root, 'evidence', x), 'utf8')))
  expect(manifests.map(x => [x.id, x.nativeSessionIds[0]]).sort()).toEqual([['run-0','native-0'],['run-1','native-1']])
})

test('drains trailing bytes after parser terminal without waiting on its finally first', async () => {
  const root = fixture()
  async function* source() {
    const child = spawnCaptured(process.execPath, ['-e', "process.stdout.write(Buffer.alloc(2*1024*1024,42))"], {})
    const closed = once(child, 'close')
    child.stderr!.resume()
    yield { finish_reason: 'stop', internal_session_id: 'native-tail' }
    await closed
  }
  await consume(withRawProcessCapture(source(), snapshot('tail'), 'any-harness', join(root, 'workspace')))
  const rows = frames(root)[0]!
  const original = Buffer.concat(rows.filter(x => x.stream === 'stdout').map(x => Buffer.from(x.base64Bytes, 'base64')))
  expect(original).toEqual(Buffer.alloc(2*1024*1024,42))
})

test.each(['inherit', 'ignore'] as const)('refuses uncapturable %s stdio before spawning', async stdio => {
  const root = fixture()
  async function* source() {
    spawnCaptured(process.execPath, ['-e', 'process.exit(0)'], { stdio })
    yield {}
  }
  await expect(consume(withRawProcessCapture(source(), snapshot(stdio), 'any-harness', join(root,'workspace')))).rejects.toThrow('piped stdout and stderr')
  expect(readdirSync(root)).toEqual([])
})

test('refuses an agent-writable evidence root before spawning', async () => {
  const root = fixture();mkdirSync(join(root,'workspace'))
  process.env.BRIDGE_RAW_CAPTURE_DIR=join(root,'workspace','evidence')
  async function* source() { spawnCaptured(process.execPath, ['-e','process.exit(0)'], {}); yield {} }
  await expect(consume(withRawProcessCapture(source(), snapshot('unsafe'), 'any-harness', join(root,'workspace')))).rejects.toThrow('outside the agent workspace')
})


test('retains cancellation terminal and bytes emitted before cancellation', async () => {
  const root=fixture()
  async function* source() {
    const controller=new AbortController()
    const child=spawnCaptured(process.execPath,['-e',"process.stdout.write('before-cancel');setInterval(()=>{},1000)"],{signal:controller.signal})
    const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()))
    child.stderr!.resume()
    const first=await child.stdout![Symbol.asyncIterator]().next()
    expect(first.done).toBe(false)
    controller.abort()
    await closed
    yield {finish_reason:'error',internal_session_id:'cancelled-native'}
  }
  await consume(withRawProcessCapture(source(),snapshot('cancel'),'any-harness',join(root,'workspace')))
  const rows=frames(root)[0]!
  expect(Buffer.concat(rows.filter(x=>x.stream==='stdout').map(x=>Buffer.from(x.base64Bytes,'base64'))).toString()).toBe('before-cancel')
  expect(rows.at(-1).terminal.signal).toBe('SIGTERM')
})

test('a process stream write failure refuses successful capture and remains explicit', async () => {
  const root=fixture();writeFault.remaining=1
  async function* source() {
    const child=spawnCaptured(process.execPath,['-e',"process.stdout.write('original')"],{})
    child.stderr!.resume()
    for await(const _ of child.stdout!) { /* drain */ }
    yield {finish_reason:'stop'}
  }
  await expect(consume(withRawProcessCapture(source(),snapshot('write-failure'),'any-harness',join(root,'workspace')))).rejects.toThrow('capture')
  const manifests=readdirSync(join(root,'evidence')).filter(x=>x.endsWith('.json'))
  expect(JSON.parse(readFileSync(join(root,'evidence',manifests[0]!), 'utf8')).processStreams).toBe('incomplete')
})


test('retains process terminal and manifest even when source cleanup rejects', async () => {
  const root=fixture()
  let spawned=false
  const source: AsyncIterable<unknown>={
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (!spawned) {
            spawned=true
            spawnCaptured(process.execPath,['-e',"process.stdout.write('retained-before-cleanup-error')"],{})
          }
          throw new Error('source execution failed')
        },
        async return() { throw new Error('source cleanup failed') },
      }
    },
  }
  const error=await consume(withRawProcessCapture(source,snapshot('cleanup-error'),'any-harness',join(root,'workspace'))).catch(error=>error)
  expect(error).toBeInstanceOf(AggregateError)
  expect(error.errors.map((item: Error)=>item.message)).toEqual(['source execution failed','source cleanup failed'])
  const rows=frames(root)[0]!
  expect(Buffer.concat(rows.filter(x=>x.stream==='stdout').map(x=>Buffer.from(x.base64Bytes,'base64'))).toString()).toBe('retained-before-cleanup-error')
  const manifests=readdirSync(join(root,'evidence')).filter(x=>x.endsWith('.json'))
  expect(manifests).toHaveLength(1)
})
