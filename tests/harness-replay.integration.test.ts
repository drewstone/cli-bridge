import { spawn } from 'node:child_process'
import { piResponseIdentityFromEvent } from '../src/backends/pi.js'
import { ATTR, type ContractSpan } from '@tangle-network/agent-trace-contract'
import { TraceEmitter } from '../src/trace/emitter.js'
import { JsonlSpanSink } from '../src/trace/sink.js'
import { collectNonStreaming } from '../src/streaming/sse.js'
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
import { RetainedSessionService } from '../src/sessions/retained.js'

const nativeProcess = `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync('dispatches.txt', String(process.pid) + '\\n');
const events = fs.existsSync('native-case.json') ? JSON.parse(fs.readFileSync('native-case.json', 'utf8')) : [
 { type:'system', subtype:'init', session_id:'native-replay-session' },
 { type:'assistant', message:{content:[{type:'text',text:'progress before final JSON'}]} },
 { type:'assistant', message:{content:[{type:'text',text:'{"answer":42}'}]} },
 { type:'result', subtype:'success', session_id:'native-replay-session', result:'{"answer":42}',
   usage:{input_tokens:11,cache_read_input_tokens:7,cache_creation_input_tokens:5,output_tokens:13},
   total_cost_usd:0.125 }
];
for (const event of events) process.stdout.write(JSON.stringify(event)+'\\n');
`

async function startServer(root: string, bin: string, bounded = false, emptyRedactionAugmentation = false) {
  const store = new SessionStore(join(root, 'store'))
  const runs = new RunRegistry(bounded ? {
    maxReplayDeltas: 2, replayRetentionMs: 100, identityRetentionMs: 10000,
  } : {})
  const registry = new BackendRegistry().register(new ClaudeBackend({
    bin, harness: 'claude-code', timeoutMs: 5000, spawner: hostSpawner,
  }))
  const app = new Hono()
  mountChatCompletions(app, { registry, sessions: store, retainedRuns: store, runs,
    ...(emptyRedactionAugmentation ? { onRunRedaction: () => [] } : {}),
    trace: new TraceEmitter({ sink: new JsonlSpanSink({ file: join(root, 'spans.jsonl'), maxBytes: 1024 * 1024, maxFiles: 1 }), maxToolSpans: 16 }),
  })
  const retainedRuns = new RetainedSessionService({ store, registry, runs })
  mountRuns(app, { runs, retainedRuns, retainedStore: store })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind TCP')
  return {
    url: `http://127.0.0.1:${address.port}`, runs,
    async stop() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await retainedRuns.shutdown()
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
      estimated_cost: 0.125, cost_known: false, cost_provenance: 'catalog-estimate', cost_scope: 'total' })
    expect(usage).not.toHaveProperty('cost')
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


for (const specimen of [
  { name: 'positive native cost is a catalog estimate', models: ['actual-provider-a'], observed: ['actual-provider-a'], cost: 0.125 },
  { name: 'zero native cost is a catalog estimate, not billed zero', models: ['actual-provider-a'], observed: ['actual-provider-a'], cost: 0 },
  { name: 'absent native cost remains unknown without a fabricated amount', models: ['actual-provider-a'], observed: ['actual-provider-a'] },
  { name: 'observed response and repeated provider ID', models: ['actual-provider-a', 'actual-provider-a'], observed: ['actual-provider-a'] },
  { name: 'absent response model', models: [undefined], observed: [] },
  { name: 'synthetic response', models: ['<synthetic>'], observed: [] },
  { name: 'API error response', models: ['not-provider-evidence'], apiError: true, observed: [] },
  { name: 'conflicting response models including one repeated provider ID', models: ['actual-provider-a', 'actual-provider-b', 'actual-provider-a'], observed: ['actual-provider-a', 'actual-provider-b'] },
  { name: 'partial native token receipt', models: ['actual-provider-a'], observed: ['actual-provider-a'], usage: { input_tokens: 11, output_tokens: 13 } },
  { name: 'absent native usage becomes an explicit estimate', models: ['actual-provider-a'], observed: ['actual-provider-a'], usage: null },
  { name: 'observed zero is measured', models: ['actual-provider-a'], observed: ['actual-provider-a'], usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } },
]) {
  it(`preserves provider evidence through actual Claude child, HTTP and SQLite replay: ${specimen.name}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-provider-evidence-'))
    const bin = join(root, 'native.cjs')
    const nativeUsage = specimen.usage === undefined
      ? { input_tokens: 11, cache_read_input_tokens: 7, cache_creation_input_tokens: 5, output_tokens: 13 }
      : specimen.usage
    await writeFile(bin, nativeProcess)
    await chmod(bin, 0o755)
    await writeFile(join(root, 'native-case.json'), JSON.stringify([
      { type: 'system', subtype: 'init', session_id: 'evidence-session', model: 'init-is-not-an-observation' },
      ...specimen.models.map((model) => ({ type: 'assistant', isApiErrorMessage: specimen.apiError,
        message: { id: 'same-provider-message', model, usage: { input_tokens: 999, output_tokens: 999 }, content: [{ type: 'text', text: 'fixture text' }] } })),
      { type: 'result', subtype: 'success', session_id: 'evidence-session', result: 'fixture text',
        ...(nativeUsage === null ? {} : { usage: nativeUsage }),
        ...(specimen.cost === undefined ? {} : { total_cost_usd: specimen.cost }) },
    ]))
    const body = { model: 'claude-code/requested-only', cwd: root, mode: 'byob', stream: true,
      run_id: 'provider-evidence-run', messages: [{ role: 'user', content: 'only exercise this local executable' }] }
    let server: Awaited<ReturnType<typeof startServer>> | undefined
    try {
      server = await startServer(root, bin)
      const response = await dispatch(server.url, body)
      expect(response.status).toBe(200)
      const initial = frames(await response.text())
      expect([...new Set(initial.flatMap((frame) => frame.provider_models as string[] | undefined ?? []))]).toEqual(specimen.observed)
      expect(initial.filter((frame) => frame.provider_models !== undefined)).toHaveLength(specimen.observed.length)
      expect(initial.some((frame) => frame.provider_model === 'init-is-not-an-observation')).toBe(false)
      const nonstream = await dispatch(server.url, { ...body, stream: false, run_id: 'provider-evidence-nonstream' })
      expect(nonstream.status).toBe(200)
      const completion = await nonstream.json() as {
        model?: string; provider_models?: string[]; provider_model?: string
        usage: { estimated?: boolean; completion_tokens?: number; prompt_tokens?: number; cost_known?: boolean; cost?: number; estimated_cost?: number; cost_provenance?: string; cost_scope?: string }
      }
      expect(completion.model).toBe(specimen.observed.at(-1) ?? body.model)
      expect(completion.provider_models).toEqual(specimen.observed.length ? specimen.observed : undefined)
      expect(completion.provider_model).toBe(specimen.observed.length === 1 ? specimen.observed[0] : undefined)
      const usage = completion.usage
      const streamedUsage = initial.find((frame) => frame.usage !== undefined)?.usage
      for (const receipt of [streamedUsage, usage]) {
        expect(receipt).toMatchObject({ cost_known: false })
        expect(receipt).not.toHaveProperty('cost')
        if (specimen.cost === undefined) {
          expect(receipt).not.toHaveProperty('estimated_cost')
          expect(receipt).not.toHaveProperty('cost_provenance')
        } else expect(receipt).toMatchObject({ estimated_cost: specimen.cost, cost_provenance: 'catalog-estimate', cost_scope: 'total' })
      }
      // The existing trace contract has no estimate amount field. Its costUsd is billed
      // spend, so the locally computed figure must never be written there, even at zero.
      const spans: ContractSpan[] = (await readFile(join(root, 'spans.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      expect(spans).toHaveLength(2)
      for (const span of spans) {
        expect(span.attributes[ATTR.costUsd]).toBeUndefined()
        if (nativeUsage !== null) {
          expect(span.attributes[ATTR.outputTokens]).toBe(nativeUsage.output_tokens)
          if ('cache_read_input_tokens' in nativeUsage && nativeUsage.cache_read_input_tokens !== undefined && nativeUsage.cache_creation_input_tokens !== undefined)
            expect(span.attributes[ATTR.inputTokens]).toBe(nativeUsage.input_tokens + nativeUsage.cache_read_input_tokens + nativeUsage.cache_creation_input_tokens)
        }
      }
      expect(usage.estimated).toBe(nativeUsage === null)
      if (nativeUsage !== null) {
        expect(usage.completion_tokens).toBe(nativeUsage.output_tokens)
        expect(usage.cost_known).toBe(false)
        expect(usage.cost).toBeUndefined()
        if ('cache_read_input_tokens' in nativeUsage && nativeUsage.cache_read_input_tokens !== undefined && nativeUsage.cache_creation_input_tokens !== undefined) expect(usage.prompt_tokens).toBe(
          nativeUsage.input_tokens + nativeUsage.cache_read_input_tokens + nativeUsage.cache_creation_input_tokens)
        else expect(usage.prompt_tokens).toBeUndefined()
        if ('cache_read_input_tokens' in nativeUsage) {
          for (const receipt of [streamedUsage, usage]) expect(receipt).toMatchObject({
            fresh_input_tokens: nativeUsage.input_tokens,
            cache_read_input_tokens: nativeUsage.cache_read_input_tokens,
            cache_write_input_tokens: nativeUsage.cache_creation_input_tokens,
          })
        }
      }
      await server.stop()
      server = await startServer(root, bin)
      const replay = await fetch(`${server.url}/v1/runs/${body.run_id}/events`, { headers: { 'Last-Event-ID': '0' } })
      expect(replay.status).toBe(200)
      const evidence = (values: Array<Record<string, unknown>>) => values.map(({ id, created, model, ...value }) => value)
      expect(evidence(frames(await replay.text()))).toEqual(evidence(initial))
      expect((await readFile(join(root, 'dispatches.txt'), 'utf8')).trim().split('\n')).toHaveLength(2)
    } finally {
      await server?.stop()
      await rm(root, { recursive: true, force: true })
    }
  }, 15000)
}


it('does not promote a Pi configured model plus fingerprint from actual child stdout to provider evidence', async () => {
  const child = spawn(process.execPath, ['-e', `
    console.log(JSON.stringify({ message: { model: 'configured-only', system_fingerprint: 'fp_control' } }));
    console.log(JSON.stringify({ message: { model: 'configured-only', responseModel: 'observed-response', system_fingerprint: 'fp_actual' } }));
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`child exit ${code}`)))
  })
  let stdout = ''
  for await (const bytes of child.stdout) stdout += bytes.toString()
  await closed
  const identities = stdout.trim().split('\n').map((line) => piResponseIdentityFromEvent(JSON.parse(line)))
  expect(identities[0]).toEqual({ model: 'configured-only@fp_control', systemFingerprint: 'fp_control' })
  expect(identities[1]).toEqual({ model: 'observed-response@fp_actual', systemFingerprint: 'fp_actual' })
  const result = await collectNonStreaming((async function* () {
    for (const identity of identities) if (identity) yield { model: identity.model, system_fingerprint: identity.systemFingerprint }
  })(), 'requested-only') as { provider_model?: string; provider_models?: string[] }
  expect(result.provider_models).toBeUndefined()
  expect(result.provider_model).toBeUndefined()
})


it('keeps explicit credentials protected when the route observer adds no historical values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-native-empty-redaction-'))
  const bin = join(root, 'native.cjs')
  const secret = 'native-empty-augmentation-canary-74ad'
  await writeFile(bin, nativeProcess)
  await chmod(bin, 0o755)
  await writeFile(join(root, 'native-case.json'), JSON.stringify([
    { type:'system',subtype:'init',session_id:'native-empty-redaction' },
    { type:'assistant',message:{content:[{type:'text',text:secret}]} },
    { type:'result',subtype:'success',session_id:'native-empty-redaction',usage:{input_tokens:0,output_tokens:0} },
  ]))
  const server = await startServer(root, bin, false, true)
  try {
    const response = await dispatch(server.url, { model:'claude-code/protocol-fixture',cwd:root,mode:'byob',stream:true,
      run_id:'native-empty-redaction-run',session_id:'native-empty-redaction',messages:[{role:'user',content:'echo the native peer output'}],
      env:{AGENT_RUNTIME_COORDINATION_TOKEN:secret} })
    const text = await response.text()
    expect(response.status,text).toBe(200)
    expect(text).toContain('[redacted:MCP]')
    expect(text).not.toContain(secret)
    const snapshot = await fetch(`${server.url}/v1/runs/native-empty-redaction-run`).then(response=>response.text())
    expect(snapshot).not.toContain(secret)
  } finally { await server.stop(); await rm(root,{recursive:true,force:true}) }
})
