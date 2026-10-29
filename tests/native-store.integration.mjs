// Real OS child, host jail, HTTP authentication and SQLite session mapping. No model service.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'
const { loadConfig, startServer } = await tsImport('../src/server.ts', import.meta.url)

test('Codex exact session lookup reports the actual host-visible native store across restart', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-native-store-'))
  const previous = process.env.CODEX_HOME
  let server
  try {
    const workspace = join(root, 'workspace'), seed = join(root, 'seed'), state = join(root, 'state')
    await Promise.all([mkdir(workspace), mkdir(seed)])
    process.env.CODEX_HOME = seed
    await writeFile(join(seed, 'config.toml'), 'model="native-store-fixture"\n')
    const bin = join(workspace, 'codex-protocol')
    await writeFile(bin, `#!/bin/sh
set -eu
if [ "$1" = --version ]; then printf 'codex-cli 0.164.0\\n'; exit; fi
mkdir -p "$CODEX_HOME/sessions"
printf '%s' "$CODEX_HOME" > native-store-receipt
printf '%s\\n' '{"type":"session_meta","payload":{"id":"native-store-owned-thread"}}' > "$CODEX_HOME/sessions/owned.jsonl"
printf '%s\\n' '{"type":"thread.started","thread_id":"native-store-owned-thread"}' '{"type":"item.completed","item":{"type":"agent_message","text":"fixture complete"}}' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`, { mode: 0o700 })
    const config = { ...loadConfig({ BRIDGE_DATA_DIR: state, BRIDGE_BACKENDS: 'codex', CODEX_BIN: bin,
      BRIDGE_BEARER: 'native-store-public-fixture', BRIDGE_TRACE: 'off', BRIDGE_JAIL_MODE: 'fs-jail' }), port: 0 }
    server = await startServer({ config, cwd: workspace, quiet: true, handleSignals: false })
    const headers = { authorization: 'Bearer native-store-public-fixture', 'content-type': 'application/json' }
    const endpoint = '/v1/sessions?session_id=owned-external-session&backend=codex'
    assert.equal((await fetch(server.url + endpoint)).status, 401)
    assert.equal((await fetch(server.url + endpoint, { headers: { authorization: 'Bearer wrong-fixture' } })).status, 401)
    const response = await fetch(server.url + '/v1/chat/completions', { method: 'POST', headers,
      body: JSON.stringify({ model: 'codex/native-store-fixture', cwd: workspace, session_id: 'owned-external-session',
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
    assert.equal(session.internalId, 'native-store-owned-thread')
    assert.equal(session.cwd, workspace)
    const binding = session.metadata.effective_native_store
    assert.ok(binding, 'Actual effective native store binding is missing')
    const actualHome = await readFile(join(workspace, 'native-store-receipt'), 'utf8')
    assert.equal(binding.root, await realpath(actualHome))
    assert.equal(binding.root, await realpath(join(workspace, '.agent-home', '.codex')))
    assert.equal(binding.harness, 'codex')
    assert.equal(binding.basis, 'host-jail')
    assert.equal(binding.nativeSessionId, session.internalId)
    assert.equal(binding.runId, 'owned-native-store-run')
    assert.match(binding.requestDigest, /^sha256:[a-f0-9]{64}$/u)
    assert.ok((await readFile(join(binding.root, 'sessions', 'owned.jsonl'), 'utf8')).includes(session.internalId))
    assert.deepEqual((await fetch(server.url + endpoint.replace('backend=codex', 'backend=pi'), { headers }).then(r => r.json())).data, [])
    assert.equal((await fetch(server.url + '/v1/sessions?session_id=owned-external-session', { headers })).status, 400)
    assert.deepEqual((await fetch(server.url + endpoint.replace('owned-external-session', 'unknown'), { headers }).then(r => r.json())).data, [])
    await server.close()
    server = await startServer({ config, cwd: workspace, quiet: true, handleSignals: false })
    assert.deepEqual(await lookup(), session, 'exact binding must survive a Bridge restart without native work')
  } finally {
    await server?.close()
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})
