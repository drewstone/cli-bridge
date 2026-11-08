// Real-codex integration: CodexBackend + hostSpawner + the pinned codex binary
// against a loopback fake Router. Records only request shape facts, never header values.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'

const { CodexBackend } = await tsImport('../src/backends/codex.ts', import.meta.url)
const { hostSpawner } = await tsImport('../src/executors/host.ts', import.meta.url)
const nativeCodex = resolve('node_modules/.bin/codex')

const seen = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    let parsed = {}
    try { parsed = JSON.parse(body) } catch {}
    const auth = req.headers.authorization
    seen.push({ method: req.method, url: req.url, auth: auth === `Bearer ${process.env.TANGLE_API_KEY}` ? 'router-key' : 'other', model: parsed.model ?? null })
    if (!req.url?.endsWith('/responses')) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    event('response.created', { response: { id: 'resp_probe' } })
    event('response.output_item.done', { item: { type: 'message', role: 'assistant', id: 'msg_probe', content: [{ type: 'output_text', text: 'pong' }] } })
    event('response.completed', { response: { id: 'resp_probe', usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } })
    res.end()
  })
})

test('codex Router mode dials the Router responses API with the full slug', async (t) => {
  t.after(() => { server.close() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const savedRouterUrl = process.env.CODEX_TANGLE_ROUTER_URL
  const savedKey = process.env.TANGLE_API_KEY
  process.env.CODEX_TANGLE_ROUTER_URL = `http://127.0.0.1:${server.address().port}/v1`
  process.env.TANGLE_API_KEY = 'test-tangle-key'
  t.after(() => {
    if (savedRouterUrl === undefined) delete process.env.CODEX_TANGLE_ROUTER_URL
    else process.env.CODEX_TANGLE_ROUTER_URL = savedRouterUrl
    if (savedKey === undefined) delete process.env.TANGLE_API_KEY
    else process.env.TANGLE_API_KEY = savedKey
  })

  const backend = new CodexBackend({ bin: nativeCodex, timeoutMs: 60_000, spawner: hostSpawner })
  for (const model of ['codex/zai/glm-5.3', 'codex/openai/gpt-5.5']) {
    const deltas = []
    for await (const delta of backend.chat({ model, messages: [{ role: 'user', content: 'say pong' }] }, null, AbortSignal.timeout(60_000))) deltas.push(delta)
    assert.equal(deltas.find((d) => d.finish_reason)?.finish_reason, 'stop', `${model} turn must finish stop`)
    assert.ok(deltas.map((d) => d.content ?? '').join('').includes('pong'), `${model} turn must answer pong`)
  }
  const dials = seen.filter((row) => row.url?.endsWith('/responses'))
  assert.deepEqual(dials.map(({ method, url, auth }) => ({ method, url, auth })), [
    { method: 'POST', url: '/v1/responses', auth: 'router-key' },
    { method: 'POST', url: '/v1/responses', auth: 'router-key' },
  ])
  assert.deepEqual(dials.map((row) => row.model), ['zai/glm-5.3', 'openai/gpt-5.5'])
  assert.ok(seen.every((row) => row.auth === 'router-key'), 'every request to the Router must carry the TANGLE_API_KEY bearer')

  seen.length = 0
  await assert.rejects(
    async () => {
      for await (const delta of backend.chat({ model: 'codex/glm-5.3', messages: [{ role: 'user', content: 'say pong' }] }, null, AbortSignal.timeout(60_000))) void delta
    },
    (error) => error.code === 'not_configured',
    'a bare model must be refused not_configured',
  )
  assert.equal(seen.length, 0, 'no request may leave for a refused route')
}, 120_000)
