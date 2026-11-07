/** Public spawn: POST /v1/chat/completions, then the host spawner jail. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve4 } from 'node:dns/promises'
import { serve } from '@hono/node-server'
import { loadConfig } from '../src/config.js'
import { buildApp } from '../src/server.js'
import { hostSpawner } from '../src/executors/host.js'
import { resolveJailSpec } from '../src/jail/resolve-spec.js'
import type { Backend, ChatRequest } from '../src/backends/types.js'

assert.equal(process.platform, 'linux')
const key = process.env.TANGLE_ROUTER_KEY ?? ''
assert.ok(key.length > 0, 'TANGLE_ROUTER_KEY is unset')
const redact = (value: string) => value.split(key).join('[redacted]')
const githubIp = (await resolve4('github.com'))[0]
assert.ok(githubIp)
const floor = resolveJailSpec({
  execMode: 'fs-jail', execNetwork: 'router', cwd: '/tmp',
  env: { BRIDGE_JAIL_MODE: 'fs-jail', BRIDGE_JAIL_NETWORK: 'none' },
})
assert.equal(floor?.network, 'none')

const probe = `
;(async () => {
  const { spawnSync } = require('node:child_process')
  const key = process.env.TANGLE_ROUTER_KEY || ''
  const clip = (value) => String(value || '').split(key).join('[redacted]').slice(0, 180)
  const curl = (url) => {
    const run = spawnSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--connect-timeout', '5', '--max-time', '12', url], { encoding: 'utf8' })
    return { status: run.status, http: (run.stdout || '').trim() }
  }
  const cap = require('node:fs').readFileSync('/proc/self/status', 'utf8').match(/CapEff:\\t([0-9a-f]+)/)
  let model = { status: 0, choice: false }
  try {
    const res = await fetch('https://router.tangle.tools/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'zai/glm-5.3', messages: [{ role: 'user', content: 'Reply with the single word pong.' }], max_tokens: 32 }),
      signal: AbortSignal.timeout(25000),
    })
    const text = await res.text()
    let choice = false
    let tokens = null
    try {
      const body = JSON.parse(text)
      const message = body.choices && body.choices[0] && body.choices[0].message
      choice = Boolean(message && (message.content || message.reasoning || message.reasoning_content || body.choices[0].finish_reason))
      tokens = body.usage ? { prompt: body.usage.prompt_tokens, completion: body.usage.completion_tokens } : null
      if (!choice) model = { status: res.status, choice, tokens, err: clip(body.error && body.error.message) }
      else model = { status: res.status, choice, tokens }
    } catch { model = { status: res.status, choice: false, err: clip(text) } }
  } catch (error) { model = { status: 0, choice: false, err: clip(error && error.name) } }
  console.log(JSON.stringify({ cap: cap && cap[1], github: curl('https://github.com/'), githubIp: curl('https://' + process.argv[1] + '/'), model }))
})()
`

async function scenario(network: 'none' | 'router', floorNetwork?: 'none') {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-net-http-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const config = loadConfig({
    BRIDGE_BACKENDS: '', BRIDGE_DATA_DIR: join(directory, 'state'), BRIDGE_TRACE: 'off',
    BRIDGE_JAIL_MODE: 'fs-jail', BRIDGE_JAIL_ROOT: '.agent-home/captured', BRIDGE_JAIL_FALLBACK: 'deny',
    ...(floorNetwork ? { BRIDGE_JAIL_NETWORK: floorNetwork } : {}),
  })
  const built = await buildApp(config)
  let seen: string | undefined
  const backend: Backend = {
    name: 'net-probe', matches: (model) => model === 'net-probe',
    health: async () => ({ name: 'net-probe', state: 'ready' }),
    async *chat(request, _session, signal) {
      seen = request.jailSpec?.network
      const spawned = await hostSpawner(process.execPath, ['-e', probe, githubIp], {
        cwd: workspace, env: process.env, jail: request.jailSpec ?? undefined, signal,
      })
      let stdout = '', stderr = ''
      spawned.child.stdout!.setEncoding('utf8').on('data', (text) => { stdout += text })
      spawned.child.stderr!.setEncoding('utf8').on('data', (text) => { stderr += text })
      const timer = setTimeout(() => spawned.terminate?.(), 90_000)
      try {
        const [code] = await once(spawned.child, 'close')
        assert.equal(code, 0, redact(stderr).slice(-700))
        yield { content: stdout, finish_reason: 'stop' }
      } finally { clearTimeout(timer); spawned.release() }
    },
  }
  built.registry.register(backend)
  const server = serve({ fetch: built.app.fetch, hostname: '127.0.0.1', port: 0 })
  try {
    if (!server.listening) await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: backend.name, messages: [{ role: 'user', content: 'network probe' }], cwd: workspace,
        execution: { kind: 'host', jail: { mode: 'fs-jail', network } },
      }),
      signal: AbortSignal.timeout(120_000),
    })
    const body = await response.json() as { choices?: Array<{ message: { content: string } }>; error?: { message?: string } }
    assert.equal(response.status, 200, redact(JSON.stringify(body)))
    const result = JSON.parse(body.choices![0]!.message.content) as {
      cap: string
      github: { status: number; http: string }
      githubIp: { status: number; http: string }
      model: { status: number; choice: boolean; tokens: { prompt: number; completion: number } | null; err?: string }
    }
    return { seen, result }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    for (const close of built.extras.shutdownHooks) await close()
    built.sessions.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const blocked = await scenario('router', 'none')
assert.equal(blocked.seen, 'none')
assert.notEqual(blocked.result.github.status, 0, JSON.stringify(blocked.result.github))
assert.notEqual(blocked.result.githubIp.status, 0)
assert.notEqual(blocked.result.model.status, 200)
assert.equal(blocked.result.model.choice, false)
const open = await scenario('router')
assert.equal(open.seen, 'router')
assert.notEqual(open.result.github.status, 0, JSON.stringify(open.result.github))
assert.notEqual(open.result.githubIp.status, 0)
assert.equal(open.result.model.status, 200, redact(JSON.stringify(open.result.model)))
assert.equal(open.result.model.choice, true)
assert.equal(open.result.cap, '0000000000000000')
const report = {
  replay: { network: blocked.seen, github: blocked.result.github.status, githubIp: blocked.result.githubIp.status, model: blocked.result.model.status },
  graph: { network: open.seen, github: open.result.github.status, githubIp: open.result.githubIp.status, model: open.result.model.status, choice: open.result.model.choice, tokens: open.result.model.tokens, cap: open.result.cap },
}
console.log('PASS public spawn: replay cannot reach GitHub or the Router; router egress completes one model turn')
console.log(JSON.stringify(report))
