// Real HTTP, jailed OS child, native SQLite store and restart. No model service.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import * as sessions from '@tangle-network/harness-sessions'
import { tsImport } from 'tsx/esm/api'
const { loadConfig, startServer } = await tsImport('../src/server.ts', import.meta.url)
const { captureTerminalNativeFamily } = await tsImport('../src/executors/native-capture.ts', import.meta.url)
const { privateCopyRedactor } = await tsImport('../src/executors/raw-capture.ts', import.meta.url)

const rootId = 'ses_capture_root', childId = 'ses_capture_child'
const accountCanary = 'account-access-token-must-not-be-captured'
const unrelatedCanary = 'unrelated-session-must-not-be-captured'
const protectedCanary = 'admitted-private-transcript-canary-384cfa'
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const snapshotsAvailable = typeof sessions.captureOpenCodeSessionStore === 'function'
  && typeof sessions.readOpenCodeSessionSnapshot === 'function'

function nativeProgram(mode) {
  return `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
process.stdin.resume();
process.stdin.on('end', () => {
  const root = path.join(process.env.XDG_DATA_HOME, 'opencode');
  fs.mkdirSync(root, { recursive: true });
  const nativePath = path.join(root, 'opencode.db');
  const databasePath = ['symlink', 'fifo'].includes(${JSON.stringify(mode)}) ? path.join(process.cwd(), 'linked.db') : nativePath;
  const db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE session_v2 (id TEXT, parent_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, time_busy INTEGER, time_idle INTEGER, idle_outcome TEXT, model TEXT, agent TEXT); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE session_part (message_id TEXT, session_id TEXT, ordinal INTEGER, type TEXT, call_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE account (access_token TEXT, refresh_token TEXT)');
  db.prepare('INSERT INTO account VALUES (?,?)').run(${JSON.stringify(accountCanary)}, 'refresh-token-private');
  const at = 1794720000000;
  for (const [id, parent, text] of ${JSON.stringify([[rootId, null, mode === 'protected-content' ? protectedCanary : 'root response'], [childId, rootId, 'child response'], ['ses_unrelated', null, unrelatedCanary]])}) {
    db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, parent, process.cwd(), at, at + 2, at, at + 2, 'succeeded', null, null);
    const message = { model: { providerID: 'fixture', id: 'native-store' }, time: { created: at, completed: at + 1 }, finish: 'stop', tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, content: [{ type: 'text', text }] };
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(id + '_answer', id, 'assistant', 1, at, at + 1, JSON.stringify(message));
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(id + '_idle', id, 'idle', 2, at + 2, at + 2, JSON.stringify({ outcome: 'succeeded', time: { created: at + 2 } }));
  }
  db.close();
  if (${JSON.stringify(mode)} === 'symlink') fs.symlinkSync(databasePath, nativePath);
  if (${JSON.stringify(mode)} === 'fifo') {
    const result = require('node:child_process').spawnSync('mkfifo', [nativePath]);
    if (result.status !== 0) throw new Error('FIFO control setup failed');
  }
  fs.writeFileSync('native-store-receipt.json', JSON.stringify({ root, path: databasePath, sha256: 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex') }));
  for (const event of [{ type: 'step_start', sessionID: ${JSON.stringify(rootId)} }, { type: 'text', sessionID: ${JSON.stringify(rootId)}, part: { type: 'text', text: 'fixture complete' } }, { type: 'step_finish', sessionID: ${JSON.stringify(rootId)}, part: { type: 'step-finish', reason: 'stop', tokens: { input: 4, output: 2 } } }]) process.stdout.write(JSON.stringify(event) + '\\n');
});
`
}

for (const mode of ['family', 'symlink']) test(`OpenCode selected-session capture (${mode}; snapshot capability ${snapshotsAvailable})`, { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-opencode-capture-'))
  const previousCapture = process.env.BRIDGE_RAW_CAPTURE_DIR
  const previousXdg = process.env.XDG_DATA_HOME
  let server
  try {
    const workspace = join(root, 'workspace'), captureDir = join(root, 'capture'), state = join(root, 'state')
    await Promise.all([mkdir(workspace), mkdir(captureDir, { mode: 0o700 })])
    process.env.BRIDGE_RAW_CAPTURE_DIR = captureDir
    // The jail's actual mapping must win over an inherited operator XDG location.
    process.env.XDG_DATA_HOME = join(root, 'operator-data')
    const bin = join(workspace, 'native-protocol.cjs')
    await writeFile(bin, nativeProgram(mode), { mode: 0o700 })
    const config = { ...loadConfig({ BRIDGE_DATA_DIR: state, BRIDGE_BACKENDS: 'opencode', OPENCODE_BIN: bin,
      BRIDGE_BEARER: 'opencode-capture-fixture', BRIDGE_TRACE: 'off', BRIDGE_JAIL_MODE: 'fs-jail' }), port: 0 }
    server = await startServer({ config, cwd: workspace, quiet: true, handleSignals: false })
    const headers = { authorization: 'Bearer opencode-capture-fixture', 'content-type': 'application/json' }
    const endpoint = '/v1/sessions?session_id=capture-session&backend=opencode'
    assert.equal((await fetch(server.url + endpoint)).status, 401)
    const response = await fetch(server.url + '/v1/chat/completions', { method: 'POST', headers,
      body: JSON.stringify({ model: 'opencode/fixture/native-store', cwd: workspace, session_id: 'capture-session', run_id: 'capture-run',
        agent_profile: { name: 'native-capture-fixture' },
        messages: [{ role: 'user', content: 'Only run the local native protocol fixture.' }] }) })
    assert.equal(response.status, 200, await response.clone().text())
    const completion = await response.text()
    assert.ok(completion.includes('fixture complete'), completion)
    assert.ok(!completion.includes('effective_native_store'))
    const lookup = async () => {
      const result = await fetch(server.url + endpoint, { headers }).then(response => response.json())
      assert.equal(result.data.length, 1)
      return result.data[0]
    }
    const session = await lookup(), store = session.metadata.effective_native_store
    const actual = JSON.parse(await readFile(join(workspace, 'native-store-receipt.json'), 'utf8'))
    assert.equal(session.internalId, rootId)
    assert.equal(store.root, actual.root)
    assert.equal(store.root, join(workspace, '.agent-home', '.local/share/opencode'))
    assert.equal(store.harness, 'opencode')
    assert.equal(store.basis, 'host-jail')
    assert.equal(store.nativeSessionId, rootId)
    const terminal = await fetch(server.url + '/v1/runs/capture-run', { headers }).then(response => response.json())
    assert.equal(terminal.terminal, true)
    const capture = terminal.nativeCapture
    if (!snapshotsAvailable || mode !== 'family' || process.platform !== 'linux') {
      assert.equal(capture.status, 'unavailable')
      if (!snapshotsAvailable) assert.equal(capture.reason, 'opencode-session-snapshot-capability-unavailable')
      else if (mode === 'protected-content') assert.equal(capture.reason, 'native-binary-redaction-required')
      for (const entry of await readdir(captureDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue
        assert.notEqual(entry.name, 'opencode.db', 'A refused binary copy leaves no retained payload')
        const bytes = await readFile(join(entry.parentPath, entry.name))
        for (const canary of [accountCanary, unrelatedCanary, protectedCanary]) assert.ok(!bytes.includes(Buffer.from(canary)))
      }
    } else {
      assert.equal(capture.status, 'retained')
      const manifestBytes = await readFile(capture.path), manifest = JSON.parse(manifestBytes)
      assert.equal(manifestBytes.length, capture.byteLength)
      assert.equal(digest(manifestBytes), capture.sha256)
      assert.equal(manifest.bridge.familyVerified, true)
      assert.equal(manifest.bridge.runId, terminal.id)
      assert.equal(manifest.bridge.requestDigest, terminal.requestDigest)
      assert.equal(manifest.bridge.sessionId, session.externalId)
      assert.equal(manifest.bridge.profileDigest, session.metadata.agent_profile_binding.effectiveProfileDigest)
      assert.equal(manifest.bridge.cwd, workspace)
      assert.equal(manifest.bridge.processes.length, 1)
      assert.ok(manifest.bridge.processes[0].pid > 0)
      assert.equal(manifest.bridge.processes[0].exitCode, 0)
      assert.ok(Number.isFinite(Date.parse(manifest.bridge.processes[0].closedAt)))
      assert.equal(manifest.nativeSessions[0].nativeSessionId, rootId)
      assert.equal(manifest.nativeSessions[0].complete, true)
      assert.equal(manifest.nativeSessions[0].format, 'opencode.sqlite')
      assert.equal(manifest.nativeSessions[0].files.length, 1, 'One physical snapshot contains the selected native family')
      assert.deepEqual(manifest.bridge.family.map(file => file.nativeSessionId), [rootId, childId])
      assert.deepEqual(manifest.bridge.files.map(file => file.parentNativeSessionId), [null, rootId])
      assert.equal(new Set(manifest.bridge.files.map(file => file.payload)).size, 1)
      const retained = await readFile(join(captureDir, manifest.bridge.files[0].payload))
      for (const file of manifest.bridge.files) {
        assert.equal(file.path, 'opencode.db')
        assert.equal(file.sourceSha256, digest(retained), 'Source commitment describes only the selected-session projection')
        assert.equal(file.retainedSha256, digest(retained))
        assert.equal(file.sourceByteLength, retained.length)
        assert.equal(file.retainedByteLength, retained.length)
        assert.equal(file.redacted, false)
        assert.equal(file.truncated, false)
        const parsed = await sessions.readOpenCodeSessionSnapshot(retained, file.nativeSessionId)
        assert.equal(parsed.nativeSessionId, file.nativeSessionId)
        assert.equal(parsed.parentNativeSessionId, file.parentNativeSessionId)
        assert.deepEqual(parsed.integrity.gaps, [])
      }
      for (const canary of [accountCanary, unrelatedCanary]) assert.ok(!retained.includes(Buffer.from(canary)))
      const db = new DatabaseSync(join(captureDir, manifest.bridge.files[0].payload), { readOnly: true })
      try {
        assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.name), ['session_message', 'session_part', 'session_v2'])
      } finally { db.close() }
    }
    const original = await readFile(join(store.root, 'opencode.db'))
    assert.equal(digest(original), actual.sha256, 'Native source is unchanged')
    assert.ok(original.includes(Buffer.from(accountCanary)))
    assert.ok(original.includes(Buffer.from(unrelatedCanary)))
    await server.close()
    server = await startServer({ config, cwd: workspace, quiet: true, handleSignals: false })
    assert.deepEqual(await lookup(), session)
    assert.deepEqual((await fetch(server.url + '/v1/runs/capture-run', { headers }).then(response => response.json())).nativeCapture, capture)
  } finally {
    await server?.close()
    if (previousCapture === undefined) delete process.env.BRIDGE_RAW_CAPTURE_DIR
    else process.env.BRIDGE_RAW_CAPTURE_DIR = previousCapture
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousXdg
    await rm(root, { recursive: true, force: true })
  }
})

// Supplied host-attestation coordinates are a contract fixture here. These checks exercise
// the real terminal owner and OS/SQLite boundaries, but do not qualify a filesystem jail.
for (const mode of ['family', 'protected-content', 'symlink', 'fifo']) test(`OpenCode terminal owner (${mode}; snapshot capability ${snapshotsAvailable})`, { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-opencode-owner-'))
  try {
    const workspace = join(root, 'workspace'), captureDir = join(root, 'capture')
    const home = join(workspace, '.agent-home'), data = join(home, '.local/share')
    await Promise.all([mkdir(workspace), mkdir(captureDir, { mode: 0o700 })])
    const bin = join(workspace, 'native-protocol.cjs')
    await writeFile(bin, nativeProgram(mode), { mode: 0o700 })
    const child = spawn(process.execPath, [bin], { cwd: workspace, env: { ...process.env, HOME: home, XDG_DATA_HOME: data }, stdio: ['pipe', 'ignore', 'pipe'] })
    let diagnostics = ''
    child.stderr.on('data', bytes => { diagnostics += bytes })
    child.stdin.end()
    const [exitCode, signal] = await once(child, 'close')
    assert.equal(exitCode, 0, diagnostics)
    const actual = JSON.parse(await readFile(join(workspace, 'native-store-receipt.json'), 'utf8'))
    const redactor = privateCopyRedactor(mode === 'protected-content' ? [protectedCanary] : [])
    const capture = await captureTerminalNativeFamily({
      snapshot: { id: 'owner-run', requestDigest: digest(Buffer.from('fixture request')), sessionId: 'owner-session', provider: 'opencode', environmentId: 'owner-host', executionId: 'owner-execution' },
      backend: 'opencode', cwd: workspace, profileDigest: digest(Buffer.from('fixture profile')),
      store: { harness: 'opencode', root: actual.root, basis: 'host-jail' }, nativeSessionIds: [rootId],
      processIds: ['owner-process'], processes: [{ captureId: 'owner-process', pid: child.pid, exitCode, signal, closedAt: new Date().toISOString() }],
      root: captureDir, redact: bytes => redactor.redact(bytes),
    })
    redactor.close()
    if (!snapshotsAvailable || mode !== 'family') {
      assert.equal(capture.status, 'unavailable')
      if (!snapshotsAvailable) assert.equal(capture.reason, 'opencode-session-snapshot-capability-unavailable')
      else if (mode === 'protected-content') assert.equal(capture.reason, 'native-binary-redaction-required')
      else if (mode === 'fifo') assert.equal(capture.reason, 'native-database-outside-host-policy')
      assert.deepEqual(await readdir(captureDir), [], 'A refused copy commits no payload or manifest')
    } else {
      assert.equal(capture.status, 'retained', JSON.stringify(capture))
      const manifestBytes = await readFile(capture.path), manifest = JSON.parse(manifestBytes)
      assert.equal(digest(manifestBytes), capture.sha256)
      assert.equal(manifestBytes.length, capture.byteLength)
      assert.equal(manifest.bridge.familyVerified, true)
      assert.equal(manifest.nativeSessions[0].files.length, 1)
      assert.deepEqual(manifest.bridge.family.map(file => file.nativeSessionId), [rootId, childId])
      assert.deepEqual(manifest.bridge.files.map(file => file.parentNativeSessionId), [null, rootId])
      assert.equal(new Set(manifest.bridge.files.map(file => file.payload)).size, 1)
      const retained = await readFile(join(captureDir, manifest.bridge.files[0].payload))
      for (const canary of [accountCanary, unrelatedCanary]) assert.ok(!retained.includes(Buffer.from(canary)))
      for (const file of manifest.bridge.files) {
        assert.equal(file.sourceSha256, digest(retained))
        assert.equal(file.retainedSha256, digest(retained))
        assert.equal(file.sourceByteLength, retained.length)
        assert.equal(file.retainedByteLength, retained.length)
        const parsed = await sessions.readOpenCodeSessionSnapshot(retained, file.nativeSessionId)
        assert.equal(parsed.parentNativeSessionId, file.parentNativeSessionId)
        assert.deepEqual(parsed.integrity.gaps, [])
      }
      const db = new DatabaseSync(join(captureDir, manifest.bridge.files[0].payload), { readOnly: true })
      try {
        assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.name), ['session_message', 'session_part', 'session_v2'])
      } finally { db.close() }
    }
    const original = await readFile(actual.path)
    assert.equal(digest(original), actual.sha256)
    assert.ok(original.includes(Buffer.from(accountCanary)))
    assert.ok(original.includes(Buffer.from(unrelatedCanary)))
  } finally { await rm(root, { recursive: true, force: true }) }
})
