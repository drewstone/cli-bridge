import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { loadConfig, startServer } from '../src/server.js'

test('real HTTP boundaries refuse removed network confinement before creating sessions or running a child', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'bridge-execution-boundary-'))
  const config = loadConfig({ BRIDGE_BACKENDS: 'codex', CODEX_EXECUTOR: 'host', BRIDGE_DATA_DIR: dataDir, BRIDGE_BEARER: 'boundary-proof' })
  const server = await startServer({ config: { ...config, port: 0 }, quiet: true, handleSignals: false })
  const headers = { authorization: 'Bearer boundary-proof', 'content-type': 'application/json' }
  const post = (path: string, body: unknown) => fetch(server.url + path, { method: 'POST', headers, body: JSON.stringify(body) })
  try {
    for (const kind of ['host', 'sandbox']) for (const netJail of [{ mode: 'net-jail' }, { mode: 'off' }, {}]) {
      const execution = { kind, netJail }
      const chat = await post('/v1/chat/completions', { model: 'codex/gpt-5', messages: [{ role: 'user', content: 'must not execute' }], execution })
      expect(chat.status).toBe(400)
      expect(await chat.text()).toContain('execution.netJail is no longer supported')
      const retained = await post('/v1/sessions', { model: 'codex/gpt-5', execution })
      expect(retained.status).toBe(400)
      expect(await retained.text()).toContain('execution.netJail is no longer supported')
    }
    const metrics = await fetch(server.url + '/metrics', { headers })
    expect(metrics.status).toBe(200)
    expect(await metrics.json()).toMatchObject({ host_executor: { in_flight: 0 }, scoped_host_executor: { in_flight: 0 } })
    const unauthorized = await fetch(server.url + '/metrics')
    expect(unauthorized.status).toBe(401)
  } finally { await server.close(); await rm(dataDir, { recursive: true, force: true }) }
}, 30_000)
