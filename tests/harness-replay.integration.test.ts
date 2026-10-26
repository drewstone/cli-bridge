/** Real native process -> HTTP SSE -> SQLite reopen. No synthetic backend or spawner. */
import { serve } from '@hono/node-server'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { expect, it } from 'vitest'
import { ClaudeBackend } from '../src/backends/claude.js'
import { BackendRegistry } from '../src/backends/registry.js'
import { hostSpawner } from '../src/executors/host.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { mountRuns } from '../src/routes/runs.js'
import { RunRegistry } from '../src/runs/registry.js'
import { SessionStore } from '../src/sessions/store.js'

const nativeProcess = `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync('dispatches.txt', String(process.pid) + '\\n');
const events = [
 { type:'system', subtype:'init', session_id:'native-replay-session' },
 { type:'assistant', message:{content:[{type:'text',text:'progress before final JSON'}]} },
 { type:'assistant', message:{content:[{type:'text',text:'{"answer":42}'}]} },
 { type:'result', subtype:'success', session_id:'native-replay-session', result:'{"answer":42}',
   usage:{input_tokens:11,cache_read_input_tokens:7,cache_creation_input_tokens:5,output_tokens:13},
   total_cost_usd:0.125 }
];
for (const event of events) process.stdout.write(JSON.stringify(event)+'\\n');
`

async function startServer(root: string, bin: string, bounded = false) {
  const store = new SessionStore(join(root, 'store'))
  const runs = new RunRegistry(bounded ? {
    maxReplayDeltas: 2, replayRetentionMs: 100, identityRetentionMs: 10000,
  } : {})
  const registry = new BackendRegistry().register(new ClaudeBackend({
    bin, harness: 'claude-code', timeoutMs: 5000, spawner: hostSpawner,
  }))
  const app = new Hono()
  mountChatCompletions(app, { registry, sessions: store, retainedRuns: store, runs })
  mountRuns(app, { runs, retainedStore: store })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind TCP')
  return {
    url: `http://127.0.0.1:${address.port}`, runs,
    async stop() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await runs.shutdown()
      store.close()
    },
  }
}

function ids(text: string): number[] {
  return [...text.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]))
}
function frames(text: string): Array<Record<string, unknown>> {
  return [...text.matchAll(/^data: (.+)$/gmu)]
    .filter((match) => match[1] !== '[DONE]').map((match) => JSON.parse(match[1]!))
}
async function dispatch(url: string, body: object, cursor?: number) {
  return fetch(`${url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      ...(cursor === undefined ? {} : { 'Last-Event-ID': String(cursor) }) },
    body: JSON.stringify(body),
  })
}

it('persists native final output and usage, replays exact suffixes, and binds retries across a real HTTP server reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-native-replay-'))
  const bin = join(root, 'native.cjs')
  await writeFile(bin, nativeProcess)
  await chmod(bin, 0o755)
  const body = {
    model: 'claude-code/protocol-fixture', cwd: root, mode: 'byob', stream: true,
    messages: [{ role: 'user', content: 'exercise native replay without inference' }],
    response_format: { type: 'json_object' }, run_id: 'native-replay-run',
    provider: 'fixture', environment_id: 'fixture-env', session_id: 'fixture-session', execution_id: 'fixture-execution',
  }
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    server = await startServer(root, bin)
    const initial = await dispatch(server.url, body)
    expect(initial.status).toBe(200)
    const text = await initial.text()
    const initialIds = ids(text)
    expect(initialIds.length).toBeGreaterThan(2)
    expect(initialIds.every((id, index) => id === index + 1)).toBe(true)
    const nativeFrames = frames(text)
    expect(nativeFrames.filter((frame) => Object.hasOwn(frame, 'final_output'))
      .map((frame) => frame.final_output)).toEqual([{ answer: 42 }])
    const usage = nativeFrames.find((frame) => frame.usage !== undefined)?.usage
    expect(usage).toMatchObject({ prompt_tokens: 23, completion_tokens: 13,
      fresh_input_tokens: 11, cache_read_input_tokens: 7, cache_write_input_tokens: 5,
      cost: 0.125, cost_known: true, cost_provenance: 'provider-receipt', cost_scope: 'total' })
    const cursor = initialIds[1]!
    const retry = await dispatch(server.url, body, cursor)
    expect(retry.status).toBe(200)
    expect(ids(await retry.text())).toEqual(initialIds.filter((id) => id > cursor))
    const conflict = await dispatch(server.url, { ...body, messages: [{ role: 'user', content: 'different request' }] })
    expect(conflict.status).toBe(409)
    await conflict.text()
    const ahead = await dispatch(server.url, body, initialIds.at(-1)! + 1)
    expect(ahead.status).toBe(409)
    await expect(ahead.json()).resolves.toMatchObject({ error: { type: 'invalid_replay_cursor' } })
    await server.stop()
    server = undefined
    server = await startServer(root, bin)
    const replay = await fetch(`${server.url}/v1/runs/${body.run_id}/events`, { headers: { 'Last-Event-ID': '0' } })
    expect(replay.status).toBe(200)
    const reopened = await replay.text()
    expect(ids(reopened)).toEqual(initialIds)
    expect(frames(reopened).find((frame) => Object.hasOwn(frame, 'final_output'))?.final_output).toEqual({ answer: 42 })
    expect(frames(reopened).find((frame) => frame.usage !== undefined)?.usage).toEqual(usage)
    const retryAfterReopen = await dispatch(server.url, body, cursor)
    expect(retryAfterReopen.status).toBe(200)
    expect(ids(await retryAfterReopen.text())).toEqual(initialIds.filter((id) => id > cursor))
    expect((await readFile(join(root, 'dispatches.txt'), 'utf8')).trim().split('\n')).toHaveLength(1)
  } finally {
    await server?.stop()
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

it('refuses rotated and expired replay cursors after an actual native process completes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-native-cursor-'))
  const bin = join(root, 'native.cjs')
  await writeFile(bin, nativeProcess)
  await chmod(bin, 0o755)
  const server = await startServer(root, bin, true)
  const body = { model: 'claude-code/protocol-fixture', cwd: root, stream: true,
    messages: [{ role: 'user', content: 'native cursor boundaries' }], run_id: 'native-cursor-run' }
  try {
    const initial = await dispatch(server.url, body)
    expect(initial.status).toBe(200)
    const initialIds = ids(await initial.text())
    const rotated = await dispatch(server.url, body, 0)
    expect(rotated.status).toBe(410)
    await expect(rotated.json()).resolves.toMatchObject({ error: { type: 'expired_replay_cursor' } })
    const deadline = Date.now() + 2000
    while (!server.runs.get(body.run_id)?.snapshot().replay.expired && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(server.runs.get(body.run_id)?.snapshot().replay.expired).toBe(true)
    const expired = await dispatch(server.url, body, initialIds.at(-1))
    expect(expired.status).toBe(410)
    await expired.text()
    expect((await readFile(join(root, 'dispatches.txt'), 'utf8')).trim().split('\n')).toHaveLength(1)
  } finally {
    await server.stop()
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
