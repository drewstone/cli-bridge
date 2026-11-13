// Real OS child, host jail, HTTP authentication and SQLite session mapping. No model service.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'
const { loadConfig, startServer } = await tsImport('../src/server.ts', import.meta.url)

for (const [harness, override, unsafeLabels = false] of [['codex', false], ['claude-code', false], ['claude-code', true], ['claude-code', false, true]]) test(`${harness} exact session lookup reports the actual host-visible native store across restart (override ${override}, private label ${unsafeLabels})`, { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-native-store-'))
  const previous = process.env.CODEX_HOME
  const previousClaude = process.env.CLAUDE_CONFIG_DIR
  const previousRaw = process.env.BRIDGE_RAW_CAPTURE_DIR
  delete process.env.CLAUDE_CONFIG_DIR
  let server
  try {
    const workspace = join(root, 'workspace'), seed = join(root, 'seed'), state = join(root, 'state'), captureDir = join(root, 'capture')
    await Promise.all([mkdir(workspace), mkdir(seed), mkdir(captureDir, { mode: 0o700 })])
    process.env.BRIDGE_RAW_CAPTURE_DIR = captureDir
    if (override) {
      process.env.CLAUDE_CONFIG_DIR = join(workspace, 'external-claude-home')
      await mkdir(process.env.CLAUDE_CONFIG_DIR)
    }
    process.env.CODEX_HOME = seed
    await writeFile(join(seed, 'config.toml'), 'model="native-store-fixture"\n')
    const labelSecret = 'private-native-label-canary-7c53e2'
    const bin = join(workspace, 'native-protocol')
    const nativeRoot = harness === 'codex' ? '$CODEX_HOME' : '${CLAUDE_CONFIG_DIR:-$HOME/.claude}'
    const events = harness === 'codex' ? [
      { type: 'thread.started', thread_id: '00000000-0000-4000-8000-000000000001' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'fixture complete' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ] : [
      { type: 'system', subtype: 'init', session_id: '00000000-0000-4000-8000-000000000001' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'fixture complete' }] } },
      { type: 'result', subtype: 'success', session_id: '00000000-0000-4000-8000-000000000001', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const nativeId = '00000000-0000-4000-8000-000000000001'
    const directory = harness === 'codex' ? 'sessions/2026/11/12' : 'projects/owned-native'
    const filename = harness === 'codex' ? `rollout-2026-11-12T00-00-00-${nativeId}.jsonl` : `${nativeId}.jsonl`
    const records = harness === 'codex'
      ? [{ type: 'session_meta', payload: { id: nativeId, cwd: workspace } }, { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'native capture proof' }] } }]
      : [{ type: 'user', sessionId: nativeId, cwd: workspace, message: { role: 'user', content: 'native capture proof' } }, { type: 'assistant', sessionId: nativeId, message: { id: 'native-answer', role: 'assistant', content: [{ type: 'text', text: 'complete' }] } }]
    await writeFile(bin, `#!/bin/sh
set -eu
if [ "$1" = --version ]; then printf 'codex-cli 0.164.0\\n'; exit; fi
mkdir -p "${nativeRoot}/${directory}"
printf '%s' "${nativeRoot}" > native-store-receipt
printf '%s\\n' ${records.map(record => `'${JSON.stringify(record)}'`).join(' ')} > "${nativeRoot}/${directory}/${filename}"
${unsafeLabels ? `config=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = --mcp-config ]; then shift; config=$1; fi
  shift
done
label=$(sed -n 's/.*"Authorization":[[:space:]]*"Bearer \\([^" ]*\\)".*/\\1/p' "$config" | tr -d '\\r\\n')
[ -n "$label" ]
ln -s "${nativeRoot}/${directory}/${filename}" "${nativeRoot}/${directory}/$label.jsonl"
` : ''}printf '%s\\n' ${events.map(event => `'${JSON.stringify(event)}'`).join(' ')}
`, { mode: 0o700 })
    const config = { ...loadConfig({ BRIDGE_DATA_DIR: state, BRIDGE_BACKENDS: harness === 'codex' ? 'codex' : 'claude', CODEX_BIN: bin, CLAUDE_BIN: bin,
      BRIDGE_BEARER: 'native-store-public-fixture', BRIDGE_TRACE: 'off', BRIDGE_JAIL_MODE: 'fs-jail' }), port: 0 }
    const mcpSecrets = { async get(key) { return key === 'label' ? labelSecret : undefined } }
    server = await startServer({ config, cwd: workspace, quiet: true, handleSignals: false, mcpSecrets })
    const headers = { authorization: 'Bearer native-store-public-fixture', 'content-type': 'application/json' }
    const endpoint = `/v1/sessions?session_id=owned-external-session&backend=${harness}`
    assert.equal((await fetch(server.url + endpoint)).status, 401)
    assert.equal((await fetch(server.url + endpoint, { headers: { authorization: 'Bearer wrong-fixture' } })).status, 401)
    const response = await fetch(server.url + '/v1/chat/completions', { method: 'POST', headers,
      // A custom MCP credential is a protected value; a jailed coordination attachment would need a registered listener.
      body: JSON.stringify({ model: `${harness}/native-store-fixture`, cwd: workspace, session_id: 'owned-external-session',
        agent_profile: { name: 'native-capture-fixture', ...(unsafeLabels ? { mcp: { label: { transport: 'http', url: 'http://127.0.0.1:9/mcp',
          headers: { Authorization: { kind: 'secret-ref', key: 'label', format: 'bearer' } } } } } : {}) },
        run_id: 'owned-native-store-run', messages: [{ role: 'user', content: 'Only exercise the local executable fixture.' }] }) })
    assert.equal(response.status, 200, await response.clone().text())
    const completion = await response.text()
    assert.ok(!completion.includes('effective_native_store'), 'host store metadata must not leak into ordinary completion payloads')
    const lookup = async () => {
      const response = await fetch(server.url + endpoint, { headers })
      assert.equal(response.status, 200)
      const result = await response.json()
      assert.equal(result.object, 'list')
      assert.equal(result.data.length, 1)
      return result.data[0]
    }
    const session = await lookup()
    assert.equal(session.externalId, 'owned-external-session')
    assert.equal(session.internalId, '00000000-0000-4000-8000-000000000001')
    assert.equal(session.cwd, workspace)
    const binding = session.metadata.effective_native_store
    assert.ok(binding, 'Actual effective native store binding is missing')
    const actualHome = await readFile(join(workspace, 'native-store-receipt'), 'utf8')
    assert.equal(binding.root, await realpath(actualHome))
    assert.equal(binding.root, await realpath(override ? join(workspace, 'external-claude-home') : join(workspace, '.agent-home', harness === 'codex' ? '.codex' : '.claude')))
    assert.equal(binding.harness, harness)
    assert.equal(binding.basis, override ? 'host-environment' : 'host-jail')
    assert.equal(binding.nativeSessionId, session.internalId)
    assert.equal(binding.runId, 'owned-native-store-run')
    assert.match(binding.requestDigest, /^sha256:[a-f0-9]{64}$/u)
    const original = await readFile(join(binding.root, directory, filename))
    assert.ok(original.includes(Buffer.from(session.internalId)))
    const originalDigest = createHash('sha256').update(original).digest('hex')
    const runUrl = `${server.url}/v1/runs/owned-native-store-run`
    const terminal = await fetch(runUrl, { headers }).then(r => r.json())
    assert.equal(terminal.terminal, true)
    const capture = terminal.nativeCapture
    assert.ok(capture, 'Every attempted native producer has an explicit outcome')
    if (override || unsafeLabels || process.platform !== 'linux') {
      assert.equal(capture.status, 'unavailable', 'External/unqualified roots and private path labels must not become trusted copies')
      if (unsafeLabels && process.platform === 'linux') {
        assert.equal(capture.reason, 'native-capture-metadata-requires-redaction')
        for (const entry of await readdir(captureDir,{recursive:true,withFileTypes:true})) {
          assert.ok(!entry.name.includes(labelSecret))
          if (entry.isFile()) assert.ok(!(await readFile(join(entry.parentPath,entry.name))).includes(Buffer.from(labelSecret)))
        }
      }
    } else {
      assert.equal(capture.status, 'retained')
      assert.ok((await readdir(captureDir)).some(name => name.endsWith('.frames')), 'Native copies share the one opt-in capture directory')
      const manifestBytes = await readFile(capture.path)
      assert.equal(manifestBytes.length, capture.byteLength)
      assert.equal(`sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`, capture.sha256)
      const manifest = JSON.parse(manifestBytes)
      assert.equal(manifest.bridge.schema, 'cli-bridge.native-capture.v1')
      assert.equal(manifest.bridge.familyVerified, true)
      assert.equal(manifest.bridge.runId, terminal.id)
      assert.equal(manifest.bridge.requestDigest, terminal.requestDigest)
      assert.equal(manifest.bridge.sessionId, session.externalId)
      assert.equal(manifest.bridge.profileDigest, session.metadata.agent_profile_binding.effectiveProfileDigest)
      assert.equal(manifest.bridge.cwd, workspace)
      assert.equal(manifest.bridge.processes.length, 1)
      assert.equal(manifest.bridge.processes[0].captureId, manifest.bridge.processIds[0])
      assert.ok(manifest.bridge.processes[0].pid > 0)
      assert.equal(manifest.bridge.processes[0].exitCode, 0)
      assert.equal(manifest.bridge.processes[0].signal, null)
      assert.ok(Number.isFinite(Date.parse(manifest.bridge.processes[0].closedAt)))
      assert.equal(manifest.nativeSessions[0].process.pid, manifest.bridge.processes[0].pid)
      assert.equal(manifest.nativeSessions[0].process.exitCode, 0)
      assert.equal(manifest.nativeSessions[0].complete, true)
      assert.deepEqual(manifest.nativeSessions[0].missingReasons, [])
      assert.equal(manifest.bridge.files.length, 1)
      const file = manifest.bridge.files[0]
      assert.equal(file.sourceSha256, `sha256:${originalDigest}`)
      const retained = await readFile(join(captureDir, file.payload))
      assert.deepEqual(retained, original)
      assert.equal(file.redacted, false)
      assert.equal(file.truncated, false)
      const { listCapture, readCapture } = await import('@tangle-network/harness-sessions')
      const listing = await listCapture(captureDir, manifest)
      assert.equal(listing.sessions.length, 1)
      assert.deepEqual(listing.missing, [])
      const parsed = []
      for await (const session of readCapture(captureDir, manifest)) parsed.push(session)
      assert.equal(parsed[0].nativeSessionId, nativeId)
      assert.equal(parsed[0].integrity.truncated, false)
      assert.deepEqual(parsed[0].integrity.gaps, [])
    }
    assert.equal(createHash('sha256').update(await readFile(join(binding.root, directory, filename))).digest('hex'), originalDigest)
    assert.deepEqual((await fetch(server.url + endpoint.replace(`backend=${harness}`, 'backend=pi'), { headers }).then(r => r.json())).data, [])
    assert.equal((await fetch(server.url + '/v1/sessions?session_id=owned-external-session', { headers })).status, 400)
    assert.deepEqual((await fetch(server.url + endpoint.replace('owned-external-session', 'unknown'), { headers }).then(r => r.json())).data, [])
    await server.close()
    server = await startServer({ config, cwd: workspace, quiet: true, handleSignals: false })
    assert.deepEqual(await lookup(), session, 'exact binding must survive a Bridge restart without native work')
    assert.deepEqual((await fetch(`${server.url}/v1/runs/owned-native-store-run`, { headers }).then(r => r.json())).nativeCapture, capture, 'Durable snapshot retains the exact producer reference across Bridge restart')
  } finally {
    await server?.close()
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousClaude
    if (previousRaw === undefined) delete process.env.BRIDGE_RAW_CAPTURE_DIR
    else process.env.BRIDGE_RAW_CAPTURE_DIR = previousRaw
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})
