/** Native default-zero receipts through a real child, HTTP and the shared usage fold. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { OpencodeBackend } from '../src/backends/opencode.js'
import { BackendRegistry } from '../src/backends/registry.js'
import { hostSpawner } from '../src/executors/host.js'
import { RunRegistry } from '../src/runs/registry.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { SessionStore } from '../src/sessions/store.js'

let cwd: string, app: Hono, sessions: SessionStore, runs: RunRegistry
const positive = { input: 7, output: 5, reasoning: 2, cache: { read: 3, write: 1 } }
const zero = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'bridge-opencode-usage-'))
  const bin = join(cwd, 'native.cjs')
  writeFileSync(bin, `#!${process.execPath}\nconst fs = require('node:fs'); process.stdin.resume();
process.stdin.on('end', () => { for (const e of JSON.parse(fs.readFileSync('events.json','utf8'))) process.stdout.write(JSON.stringify(e)+'\\n'); });\n`, { mode: 0o700 })
  sessions = new SessionStore(join(cwd, 'state')); runs = new RunRegistry(); app = new Hono()
  mountChatCompletions(app, { registry: new BackendRegistry().register(new OpencodeBackend({ bin, timeoutMs: 5000, spawner: hostSpawner })), sessions, runs })
})
afterEach(async () => {
  await runs.shutdown(); sessions.close(); rmSync(cwd, { recursive: true, force: true })
})

it.each([
  { name: 'all positive observed classes', tokens: [positive], expected: { prompt_tokens: 11, completion_tokens: 7,
    total_tokens: 18, fresh_input_tokens: 7, cache_read_input_tokens: 3, cache_write_input_tokens: 1, reasoning_tokens: 2 } },
  { name: 'partial classes with normalized zero', tokens: [{ ...zero, input: 7, output: 5 }], expected: { fresh_input_tokens: 7 } },
  { name: 'entirely absent native usage', tokens: [zero], expected: {} },
  { name: 'a missing call between measured calls', tokens: [positive, zero, positive], expected: {} },
])('does not promote $name beyond its native coverage', async ({ tokens, expected }) => {
  const nativeId = 'ses_native_usage'
  const events = [{ type: 'step_start', sessionID: nativeId },
    ...tokens.map(value => ({ type: 'step_finish', sessionID: nativeId, part: { type: 'step-finish', reason: 'stop', tokens: value, cost: 0 } })),
    { type: 'text', sessionID: nativeId, part: { text: 'native answer' } }]
  writeFileSync(join(cwd, 'events.json'), JSON.stringify(events))
  const response = await app.request('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'opencode/fixture/model', cwd, messages: [{ role: 'user', content: 'answer' }] }) })
  const body = await response.json() as any
  expect(response.status).toBe(200)
  expect(body.choices[0].message.content).toBe('native answer')
  expect(body.usage).toEqual({ ...expected, estimated: false, cost_known: false, cost_scope: 'total' })
})

it('does not reuse counters attached to a failed native step', async () => {
  writeFileSync(join(cwd, 'events.json'), JSON.stringify([
    { type: 'step_start', sessionID: 'ses_failed_usage' },
    { type: 'step_finish', sessionID: 'ses_failed_usage', error: { message: 'native failed' },
      part: { type: 'step-finish', reason: 'error', tokens: positive, cost: 1 } },
  ]))
  const response = await app.request('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'opencode/fixture/model', cwd, stream: true, messages: [{ role: 'user', content: 'answer' }] }) })
  const frames = (await response.text()).split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
  expect(frames.filter(frame => frame.usage).map(frame => frame.usage)).toEqual([{ estimated: false, cost_known: false }])
  expect(frames.some(frame => frame.error)).toBe(true)
})
