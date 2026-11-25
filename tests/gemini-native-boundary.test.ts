/** Recorded Gemini CLI 0.68.0 stream-json shapes, replayed by a real child through
 * the HTTP route and SQLite session owner. No model service or operator auth. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { GeminiBackend } from '../src/backends/gemini.js'
import { BackendRegistry } from '../src/backends/registry.js'
import { RunRegistry } from '../src/runs/registry.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { SessionStore } from '../src/sessions/store.js'

const nativeId = '11111111-2222-4333-8444-555555555555'
const init = { type: 'init', session_id: nativeId, model: 'gemini-2.5-flash' }
const answer = { type: 'message', role: 'assistant', content: 'native answer', delta: true }
const stats = { input_tokens: 200, output_tokens: 40, total_tokens: 246, cached: 14, input: 186,
  models: { 'gemini-provider-response-version': { input_tokens: 200, output_tokens: 40 } } }
const result = { type: 'result', status: 'success', stats }
let cwd: string, sessions: SessionStore, runs: RunRegistry, app: Hono

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'bridge-gemini-boundary-'))
  const bin = join(cwd, 'native-protocol.cjs')
  writeFileSync(bin, `#!${process.execPath}\nconst fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
  fs.writeFileSync('launch.json', JSON.stringify(process.argv.slice(2)));
  fs.writeFileSync('launch-env.json', JSON.stringify(Object.fromEntries(
    ['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_CLI_TRUST_WORKSPACE', 'GEMINI_UNRELATED'].map((key) => [key, process.env[key] ?? null]))));
  for (const event of JSON.parse(fs.readFileSync('events.json', 'utf8'))) {
    process.stdout.write(JSON.stringify(event) + '\\n');
  }
});\n`, { mode: 0o700 })
  sessions = new SessionStore(join(cwd, 'state'))
  runs = new RunRegistry()
  app = new Hono()
  mountChatCompletions(app, { registry: new BackendRegistry().register(new GeminiBackend({ bin, timeoutMs: 5000 })), sessions, runs })
})

afterEach(async () => {
  await runs.shutdown()
  sessions.close()
  rmSync(cwd, { recursive: true, force: true })
})

async function post(events: unknown[], stream = false, extra: Record<string, unknown> = {}) {
  writeFileSync(join(cwd, 'events.json'), JSON.stringify(events))
  return app.request('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini/gemini-2.5-flash', cwd, stream, session_id: 'caller-session',
      messages: [{ role: 'user', content: 'caller prompt must not be an answer' }], ...extra }) })
}

function frames(text: string): any[] {
  return text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
}

it('retains native session, exact tool outcomes and measured usage across two HTTP turns', async () => {
  const first = await post([init, { type: 'message', role: 'user', content: 'echoed caller prompt' },
    { type: 'tool_use', tool_name: 'read_file', tool_id: 'native-tool', parameters: { file_path: 'fixture.txt' } },
    { type: 'tool_result', tool_id: 'native-tool', status: 'error', error: { message: 'file missing' } },
    answer, result], true)
  expect(first.status).toBe(200)
  const chunks = frames(await first.text())
  const deltas = chunks.flatMap(frame => frame.choices ?? []).map(choice => choice.delta)
  expect(deltas.map(delta => delta.content ?? '').join('')).toBe('native answer')
  expect(deltas.flatMap(delta => delta.tool_calls ?? [])).toMatchObject([
    { id: 'native-tool', function: { name: 'read_file', arguments: '{"file_path":"fixture.txt"}' } },
  ])
  expect(deltas.flatMap(delta => delta.tool_results ?? [])).toEqual([
    { id: 'native-tool', name: 'read_file', status: 'error', error: 'file missing' },
  ])
  expect(chunks.some(chunk => chunk.error)).toBe(false)
  expect(chunks.filter(chunk => chunk.usage).map(chunk => chunk.usage)).toEqual([
    { prompt_tokens: 200, cache_read_input_tokens: 14, fresh_input_tokens: 186, estimated: false, cost_known: false },
  ])
  expect(chunks.flatMap(chunk => chunk.provider_models ?? [])).toEqual([])
  expect(sessions.get('caller-session', 'gemini')?.internalId).toBe(nativeId)

  const second = await post([init, answer, { ...result, stats: { ...stats, input_tokens: 100, cached: 7, input: 93, output_tokens: 20, total_tokens: 120 } }])
  expect(second.status).toBe(200)
  const body = await second.json() as any
  expect(body.choices[0].message.content).toBe('native answer')
  // Input, output and total are all positive and the total is their sum, so the output subtotal is kept;
  // the first turn's total held 6 tokens more than its input and output, and its output stayed unknown.
  expect(body.usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
    cache_read_input_tokens: 7, fresh_input_tokens: 93, estimated: false, cost_known: false })
  expect(body).not.toHaveProperty('provider_models')
  const args = JSON.parse(readFileSync(join(cwd, 'launch.json'), 'utf8')) as string[]
  expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', nativeId])
})

it.each([
  { name: 'different native session', events: [{ ...init, session_id: 'a-different-session' }, answer, result], error: 'different native session' },
  { name: 'missing resumed session acknowledgement', events: [answer, result], error: 'did not confirm its resumed native session' },
  { name: 'missing native terminal result', events: [init, answer], error: 'without a terminal result' },
  { name: 'inconsistent measured token classes', events: [init, answer, { ...result, stats: { ...stats, cached: 201 } }], error: 'inconsistent input token classes' },
])('refuses $name instead of completing a partial native turn', async ({ events, error }) => {
  const seed = await post([init, answer, result])
  await seed.text()
  const response = await post(events)
  const body = await response.json() as any
  expect(body.error?.message).toContain(error)
  if (body.choices) expect(body.choices[0].finish_reason).toBe('error')
  else expect(response.status).toBeGreaterThanOrEqual(400)
  expect(sessions.get('caller-session', 'gemini')?.internalId).toBe(nativeId)
})

it.each([
  { name: 'absent usage', reported: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cached: 0, input: 0 }, input: undefined },
  { name: 'prompt-only usage', reported: { input_tokens: 200, output_tokens: 0, total_tokens: 0, cached: 0, input: 200 }, input: 200 },
])('keeps actual Gemini default-zero $name unknown without a text estimate', async ({ reported, input }) => {
  // Both shapes were emitted by real Gemini 0.68.0 against a localhost provider:
  // missing usageMetadata and usageMetadata containing only promptTokenCount.
  const response = await post([init, answer, { ...result, stats: reported }])
  const body = await response.json() as any
  expect(body.choices[0].message.content).toBe('native answer')
  expect(body.usage.prompt_tokens).toBe(input)
  for (const field of ['completion_tokens', 'total_tokens', 'cache_read_input_tokens', 'fresh_input_tokens']) {
    expect(body.usage).not.toHaveProperty(field)
  }
  expect(body.usage.estimated).not.toBe(true)
  expect(body.usage.cost_known).toBe(false)
})

it('gives the CLI its API route, and trusts the project settings only for a turn whose configuration it wrote there', async () => {
  const names = ['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_CLI_TRUST_WORKSPACE', 'GEMINI_UNRELATED'] as const
  const saved = names.map((name) => [name, process.env[name]] as const)
  const launched = () => ({ env: JSON.parse(readFileSync(join(cwd, 'launch-env.json'), 'utf8')) as Record<string, string | null>,
    args: JSON.parse(readFileSync(join(cwd, 'launch.json'), 'utf8')) as string[] })
  const route = { GEMINI_API_KEY: 'fixture-key', GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:9/router' }
  try {
    // The Bridge's own environment cannot state the trust: only what the Bridge wrote decides it.
    Object.assign(process.env, { ...route, GEMINI_UNRELATED: 'stays with the Bridge', GEMINI_CLI_TRUST_WORKSPACE: 'true' })
    expect((await post([init, answer, result])).status).toBe(200)
    expect(launched().env).toEqual({ ...route, GEMINI_CLI_TRUST_WORKSPACE: null, GEMINI_UNRELATED: null })
    expect(launched().args).toContain('--skip-trust')

    const mounted = await post([init, answer, result], false, { session_id: 'profiled-session', agent_profile: { name: 'fixture',
      mcp: { conformance: { transport: 'stdio', command: process.execPath, args: [{ kind: 'public', value: join(cwd, 'server.cjs') }] } } } })
    expect(mounted.status, await mounted.clone().text()).toBe(200)
    expect(launched().env).toEqual({ ...route, GEMINI_CLI_TRUST_WORKSPACE: 'true', GEMINI_UNRELATED: null })
    expect(launched().args).toContain('--skip-trust')
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
