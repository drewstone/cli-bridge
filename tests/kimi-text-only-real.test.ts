import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import { expect, it, vi } from 'vitest'
import { KimiBackend } from '../src/backends/kimi.js'
import { BackendRegistry } from '../src/backends/registry.js'
import { hostSpawner } from '../src/executors/host.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { RunRegistry } from '../src/runs/registry.js'
import { SessionStore } from '../src/sessions/store.js'

const bin = process.env.CLI_BRIDGE_REAL_KIMI_BIN

it.skipIf(!bin)('enforces the local Kimi tool choice at the provider and preserves ordinary coding', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'bridge-kimi-wire-'))
  const cwd = join(scratch, 'project')
  const home = join(scratch, 'kimi')
  const marker = randomUUID()
  const sentinel = join(cwd, 'fixture.txt')
  const mcpStarted = join(scratch, 'mcp-started')
  mkdirSync(join(cwd, '.git'), { recursive: true })
  mkdirSync(home)
  writeFileSync(sentinel, marker)
  writeFileSync(join(cwd, 'AGENTS.md'), 'Native workspace instruction fixture.')
  writeFileSync(join(home, 'SYSTEM.md'), 'Native operator instruction fixture.\n${agents_md}')
  const calls: { names: string[]; read: boolean; cwd: boolean; system: boolean; prompt: boolean; model: string }[] = []
  let askRead = false
  let firstCall = 0
  const model = 'kimi-code/local-wire'
  const needle = 'end-of-user-input'
  const receiver = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      model: string
      tools?: { function: { name: string } }[]
      messages: { role: string; content: unknown }[]
    }
    const messages = JSON.stringify(body.messages)
    const sendRead = askRead && calls.length === firstCall
    calls.push({
      names: (body.tools ?? []).map(tool => tool.function.name),
      read: body.messages.filter(message => message.role === 'tool').some(message => JSON.stringify(message.content).includes(marker)),
      cwd: messages.includes('Native workspace instruction fixture.'),
      system: messages.includes('Native operator instruction fixture.'),
      prompt: messages.includes(needle), model: body.model,
    })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (delta: object, finish_reason: string | null) => {
      res.write('data: ' + JSON.stringify({ id: 'local-test', object: 'chat.completion.chunk',
        model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
    }
    if (sendRead) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'local-read', type: 'function',
        function: { name: 'Read', arguments: JSON.stringify({ path: sentinel }) } }] }, null)
      send({}, 'tool_calls')
    } else {
      send({ role: 'assistant', content: 'completed' }, null)
      send({}, 'stop')
    }
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
  const sessions = new SessionStore(join(scratch, 'bridge'))
  const runs = new RunRegistry()
  try {
    const address = receiver.address() as AddressInfo
    const offline = 'http://127.0.0.1:1'
    const base = 'http://127.0.0.1:' + address.port + '/v1'
    writeFileSync(join(home, 'config.toml'), [
      'default_model = "' + model + '"', 'telemetry = false', '[providers.loopback]', 'type = "kimi"',
      'base_url = "' + base + '"', 'api_key = "loopback-fixture"', '[models."' + model + '"]',
      'provider = "loopback"', 'model = "' + model + '"', 'max_context_size = 262144', 'capabilities = ["tool_use"]',
    ].join('\n'))
    const localEnv = { KIMI_CODE_HOME: home, KIMI_MODEL_NAME: '', KIMI_MODEL_BASE_URL: base,
      KIMI_CODE_OAUTH_HOST: offline, KIMI_CODE_BASE_URL: offline, KIMI_CODE_PLUGIN_MARKETPLACE_URL: offline,
      KIMI_DISABLE_TELEMETRY: '1', KIMI_CODE_NO_AUTO_UPDATE: '1', HTTP_PROXY: offline,
      HTTPS_PROXY: offline, ALL_PROXY: offline, NO_PROXY: '127.0.0.1,localhost' }
    for (const [key, value] of Object.entries(localEnv)) vi.stubEnv(key, value)
    const app = new Hono()
    mountChatCompletions(app, {
      registry: new BackendRegistry().register(new KimiBackend({ bin: bin!, timeoutMs: 25_000, spawner: hostSpawner })),
      sessions, runs,
    })
    async function turn(long: boolean, choice?: 'none' | 'auto', extra: object = {}) {
      firstCall = calls.length
      const content = (long ? 'A detailed task. '.repeat(15_000) : 'Short task. ') + needle
      const response = await app.request('/v1/chat/completions', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          model, cwd, messages: [{ role: 'user', content }], ...(choice ? { tool_choice: choice } : {}), ...extra,
        }) })
      const result = await response.json() as { choices?: { message: { content?: string; tool_calls?: unknown[] } }[];
        error?: { type?: string; message?: string; provider_dispatch?: string } }
      return { status: response.status, result, hops: calls.slice(firstCall) }
    }
    for (const long of [true, false]) {
      askRead = false
      const none = await turn(long, 'none', { mcp: { mcpServers: { example: { type: 'stdio',
        command: 'node', args: ['-e', 'require("fs").writeFileSync(process.argv[1], "started")', mcpStarted] } } } })
      expect(none.result.error).toBeUndefined()
      expect(none.result.choices?.[0]?.message.content).toBe('completed')
      expect(none.hops).toHaveLength(1)
      expect(none.hops[0]).toMatchObject({ names: [], read: false, prompt: true, cwd: true, system: true, model })
      expect(existsSync(mcpStarted)).toBe(false)
      askRead = true
      const denied = await turn(long, 'none')
      expect(denied.hops.length).toBeGreaterThan(0)
      expect(denied.hops.every(hop => hop.names.length === 0 && !hop.read)).toBe(true)
      expect(denied.result.choices?.[0]?.message.tool_calls).toBeUndefined()
      const ordinary = await turn(long, 'auto')
      expect(ordinary.status).toBe(200)
      expect(ordinary.hops[0]!.names).toContain('Read')
      expect(ordinary.hops.some(hop => hop.read)).toBe(true)
    }
    askRead = false
    const incompatible = await turn(false, 'none', { session_id: 'coding-session' })
    expect(incompatible.status).toBe(501)
    expect(incompatible.result.error).toMatchObject({ type: 'capability_denied', provider_dispatch: 'not_started' })
    expect(incompatible.hops).toHaveLength(0)
    const sameId = await turn(false, undefined, { session_id: 'coding-session' })
    expect(sameId.hops[0]!.names).toContain('Read')
    expect((await turn(true, 'none', { resume_id: 'coding-session' })).hops).toHaveLength(0)
    expect(readdirSync(cwd).sort()).toEqual(['.git', 'AGENTS.md', 'fixture.txt'])
    expect(readFileSync(sentinel, 'utf8')).toBe(marker)
  } finally {
    await runs.shutdown()
    sessions.close()
    vi.unstubAllEnvs()
    await new Promise<void>(resolve => receiver.close(() => resolve()))
    rmSync(scratch, { recursive: true, force: true })
  }
}, 110_000)
