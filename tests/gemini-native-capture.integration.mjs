// Actual CLI0.68.0 session bytes through the terminal capture owner. The host
// attestation below is a contract fixture; this does not qualify a host jail.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { maybeReaderFor, readSessionInput } from '@tangle-network/harness-sessions'
import { tsImport } from 'tsx/esm/api'
const { captureTerminalNativeFamily } = await tsImport('../src/executors/native-capture.ts', import.meta.url)
const fixture = await readFile(new URL('./fixtures/gemini-native/native-0.68.0.jsonl', import.meta.url), 'utf8')
assert.equal(createHash('sha256').update(fixture).digest('hex'), '6237044909209b2721207fdf70ab51e402175d629dc1026fa3987813f620282c')
const nativeId = '11111111-2222-4333-8444-555555555555'
const available = maybeReaderFor('gemini')?.formats.includes('gemini.chat-jsonl')
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

for (const wrongWorkspace of [false, true]) test(`Gemini full native identity and workspace binding (wrong workspace ${wrongWorkspace}; reader ${!!available})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-gemini-capture-'))
  try {
    const cwd = join(root, 'workspace'), spool = join(root, 'capture'), store = join(cwd, '.agent-home/.gemini')
    const chats = join(store, 'tmp/workspace/chats')
    await Promise.all([mkdir(chats, { recursive: true }), mkdir(spool, { mode: 0o700 })])
    const records = fixture.trimEnd().split('\n').map(line => JSON.parse(line))
    // Only bind the original native header to this disposable execution workspace.
    records[0].projectHash = createHash('sha256').update(wrongWorkspace ? join(root, 'other') : cwd).digest('hex')
    const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n')
    await writeFile(join(chats, 'session-2026-11-15T05-42-11111111.jsonl'), bytes)
    const collision = [{ ...records[0], sessionId: '11111111-aaaa-4bbb-8ccc-999999999999' }, ...records.slice(1)]
    await writeFile(join(chats, 'session-2026-11-15T05-43-11111111.jsonl'), collision.map(record => JSON.stringify(record)).join('\n') + '\n')
    const result = await captureTerminalNativeFamily({
      snapshot: { id: 'gemini-native-run', requestDigest: hash(Buffer.from('native request')), sessionId: 'caller-session',
        provider: 'gemini', environmentId: 'fixture-host', executionId: 'fixture-execution' },
      backend: 'gemini', cwd, profileDigest: hash(Buffer.from('native profile')),
      store: { harness: 'gemini', root: store, basis: 'host-jail' }, nativeSessionIds: [nativeId],
      processIds: ['native-process'], processes: [{ captureId: 'native-process', pid: 1, exitCode: 0, signal: null, closedAt: new Date().toISOString() }],
      root: spool, redact: bytes => bytes,
    })
    if (!available || wrongWorkspace) {
      assert.equal(result.status, 'unavailable')
      assert.equal(result.reason, available ? 'native-session-identity-or-integrity-unverified' : 'gemini-native-reader-capability-unavailable')
      assert.deepEqual(await readdir(spool), [])
    } else {
      assert.equal(result.status, 'retained', JSON.stringify(result))
      const manifestBytes = await readFile(result.path), manifest = JSON.parse(manifestBytes)
      assert.equal(hash(manifestBytes), result.sha256)
      assert.equal(manifest.bridge.familyVerified, true)
      assert.equal(manifest.nativeSessions[0].format, 'gemini.chat-jsonl')
      assert.equal(manifest.bridge.family.length, 1, 'A shortened filename collision must not capture another conversation')
      assert.equal(manifest.bridge.family[0].nativeSessionId, nativeId)
      const kept = await readFile(join(spool, manifest.bridge.files[0].payload))
      assert.deepEqual(kept, bytes)
      const parsed = readSessionInput('gemini', { text: kept.toString('utf8') }, { nativeSessionId: nativeId, cwd }, { corruption: 'strict' })
      assert.equal(parsed.cwd, cwd)
      assert.equal(parsed.toolCalls[0].name, 'read_file')
      assert.equal(parsed.ending.status, 'open', 'Native transcript completeness must not invent a terminal execution event')
      assert.deepEqual(parsed.servedModels, {})
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
