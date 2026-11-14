import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCliBridgeProvider } from '@tangle-network/agent-provider-cli-bridge'
import { loadConfig, startServer } from '../../src/server.js'

// The published provider parses /v1/capabilities with agent-interface's strict schema,
// so a key the published schema does not know fails every consumer's discovery.
test('published cli-bridge provider discovers the default codex capability document', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-capability-consumer-'))
  let bridge: Awaited<ReturnType<typeof startServer>> | undefined
  context.after(async () => { await bridge?.close(); await rm(directory, { recursive: true, force: true }) })
  const bin = join(directory, 'codex')
  await writeFile(bin, `#!${process.execPath}\nprocess.stdout.write('codex-cli 0.167.2\\n')\n`, { mode: 0o755 })
  bridge = await startServer({
    config: { ...loadConfig({
      BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(directory, 'state'), BRIDGE_BACKENDS: 'codex',
      BRIDGE_BEARER: 'test-only', BRIDGE_TRACE: 'off', CODEX_BIN: bin,
    }), port: 0 },
    handleSignals: false,
    quiet: true,
  })
  const model = 'codex/gpt-5.1-codex'

  const provider = createCliBridgeProvider({ baseUrl: bridge.url, bearerToken: 'test-only', defaultModel: model })
  const discovered = await provider.capabilities()
  assert.equal(discovered.streaming.live, true)

  const headers = { authorization: 'Bearer test-only' }
  const route = `${bridge.url}/v1/capabilities?model=${encodeURIComponent(model)}`
  const plain = await (await fetch(route, { headers })).json() as Record<string, unknown>
  assert.equal('modelReroutes' in plain, false)
  const extended = await fetch(`${route}&include=modelReroutes`, { headers })
  assert.equal(extended.status, 200)
  assert.equal((await extended.json() as Record<string, unknown>).modelReroutes, true)
  assert.equal((await fetch(`${route}&include=everything`, { headers })).status, 400)
})
