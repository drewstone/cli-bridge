import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import { afterEach, test } from 'node:test'
import { canonicalAgentProfileDigest } from '@tangle-network/agent-interface'
import { createBudgetPool, createExecutor } from '@tangle-network/agent-runtime/kernel'
import { ClaudeBackend } from '../../src/backends/claude.js'
import type { ChatDelta, ChatRequest } from '../../src/backends/types.js'
import type { SpawnResult, Spawner } from '../../src/executors/types.js'
import { deltaToOpenAIChunk, makeChunkMeta } from '../../src/streaming/sse.js'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  exitCode: number | null = null
}

const PROFILE = {
  name: 'cache-accounting-consumer-proof',
  harness: 'claude-code',
  model: { provider: 'anthropic', default: 'sonnet' },
} as const
// This loopback fixture tests the wire contract, not the deployed bridge.
// Its model is claude-code/anthropic/sonnet.
// The native production probe used claude-code/anthropic/claude-sonnet-5.
const MODEL = 'claude-code/anthropic/sonnet'

function claudeSpawner(lines: Array<Record<string, unknown>>): Spawner {
  return async (): Promise<SpawnResult> => {
    const child = new FakeChild()
    queueMicrotask(() => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`)
      child.stdout.end()
      child.stderr.end()
      setTimeout(() => {
        child.exitCode = 0
        child.emit('close', 0)
      }, 10)
    })
    return { child: child as never, release() {}, spawnError: () => null }
  }
}

async function collect(deltas: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const result: ChatDelta[] = []
  for await (const delta of deltas) result.push(delta)
  return result
}

async function normalizedClaudeUsageFrame(): Promise<string> {
  const backend = new ClaudeBackend({
    bin: 'claude',
    harness: 'claude-code',
    timeoutMs: 5_000,
    spawner: claudeSpawner([
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: 'done' }] } },
      {
        type: 'result',
        subtype: 'success',
        session_id: 'sess-1',
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 10_753,
          cache_read_input_tokens: 15_269,
          output_tokens: 4,
        },
        total_cost_usd: 0.0470478,
      },
    ]),
  })
  const request: ChatRequest = {
    model: MODEL,
    messages: [{ role: 'user', content: 'account this native Claude receipt' }],
    mode: 'byob',
  }
  const terminal = (await collect(backend.chat(request, null, new AbortController().signal))).at(-1)
  const frame = terminal && deltaToOpenAIChunk(terminal, makeChunkMeta(MODEL))
  assert.ok(frame, 'Claude backend must serialize a terminal usage frame')
  return frame
}

const servers: ReturnType<typeof createServer>[] = []

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null
    && typeof value === 'object'
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    ),
  )
})

test('published Runtime 0.194 debits Claude cache writes without charging cache reads twice', async () => {
  const usageFrame = await normalizedClaudeUsageFrame()
  let requestModel: string | undefined
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        capabilities: {
          profileMaterialization: 'cli-bridge.profile-materialization.v2',
          usageCostProvenance: 'cli-bridge.usage-cost.v1',
        },
      }))
      return
    }
    if (request.method === 'GET' && (request.url?.startsWith('/v1/capabilities') || request.url === '/health')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(request.url === '/health' ? JSON.stringify({ ok: true }) : JSON.stringify({}))
      return
    }

    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/chat/completions')
    let body = ''
    for await (const chunk of request) body += chunk
    const requestBody = JSON.parse(body) as { agent_profile: unknown; model: string; run_id: string }
    requestModel = requestBody.model
    assert.deepEqual(requestBody.agent_profile, PROFILE)
    assert.equal(requestBody.model, MODEL)
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-run-id': requestBody.run_id,
      'x-run-request-digest': `sha256:${'a'.repeat(64)}`,
    })
    response.write(`id: 1\n${usageFrame}`)
    response.write(`id: 2\ndata: ${JSON.stringify({
      profile_materialization: {
        schema: 'cli-bridge.profile-materialization.v2',
        effectiveProfileDigest: canonicalAgentProfileDigest(PROFILE),
        harness: PROFILE.harness,
        provider: PROFILE.model.provider,
        model: requestBody.model,
        reasoningEffort: { requested: null, applied: null },
        workspacePlanDigest: `sha256:${'b'.repeat(64)}`,
        files: [],
        unsupported: [],
      },
    })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('consumer test did not bind a loopback port')

  const executor = createExecutor({
    backend: 'bridge',
    bridgeUrl: `http://127.0.0.1:${address.port}`,
    bridgeBearer: 'test-only',
    sessionId: 'cache-accounting-proof',
  })(
    { profile: PROFILE, harness: null },
    { signal: new AbortController().signal, seams: {} },
  )
  const run = executor.execute('account this native Claude receipt', new AbortController().signal)
  if (!isAsyncIterable(run)) throw new Error('bridge execution did not stream')
  const events: unknown[] = []
  for await (const event of run) {
    events.push(event)
  }
  const spent = executor.resultArtifact().spent

  assert.equal(requestModel, MODEL)
  assert.deepEqual(events.find(event => (event as { kind?: unknown }).kind === 'tokens'), {
    kind: 'tokens',
    input: 26_024,
    output: 4,
    freshInput: 2,
    cacheRead: 15_269,
    cacheWrite: 10_753,
  })
  assert.deepEqual(spent.tokens, {
    input: 26_024,
    output: 4,
    freshInput: 2,
    cacheRead: 15_269,
    cacheWrite: 10_753,
  })
  assert.equal(spent.usd, 0.0470478)

  const budget = createBudgetPool({ maxIterations: 1, maxTokens: 20_000 }, Date.now())
  budget.observe(spent)
  const remaining = budget.readout()
  assert.equal(remaining.tokensLeft, 9_241)
  assert.equal(remaining.tokensKnown, true)
  assert.equal(remaining.cacheBreakdownKnown, true)
  assert.equal(remaining.iterationsLeft, 0)
})
