import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBudgetPool, createExecutor } from '@tangle-network/agent-runtime/kernel'
import { loadConfig, startServer } from '../../src/server.js'

const PROFILE = {
  name: 'cache-accounting-consumer-proof',
  harness: 'claude-code',
  model: { provider: 'anthropic', default: 'sonnet' },
} as const

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === 'object'
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
}

// A real process emits the native wire protocol; no model or account service is called.
// The public Bridge listener and published Runtime consume the complete stream, including exit.
test('published Runtime debits Claude cache writes without charging cache reads twice', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-accounting-consumer-'))
  let bridge: Awaited<ReturnType<typeof startServer>> | undefined
  context.after(async () => { await bridge?.close(); await rm(directory, { recursive: true, force: true }) })
  const bin = join(directory, 'claude-protocol.cjs')
  const answer = JSON.stringify({ ok: true })
  const native = [
    { type: 'system', subtype: 'init', session_id: 'cache-accounting-proof' },
    { type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: answer }] } },
    { type: 'result', subtype: 'success', session_id: 'cache-accounting-proof', result: answer, is_error: false,
      usage: { input_tokens: 2, cache_creation_input_tokens: 10_753, cache_read_input_tokens: 15_269, output_tokens: 4 },
      total_cost_usd: 0.0470478 },
  ]
  await writeFile(bin, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('protocol fixture'); process.exit(0) }
for (const event of ${JSON.stringify(native)}) console.log(JSON.stringify(event))
`, { mode: 0o755 })
  bridge = await startServer({
    config: { ...loadConfig({
      BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(directory, 'state'), BRIDGE_BACKENDS: 'claude',
      BRIDGE_BEARER: 'test-only', BRIDGE_TRACE: 'off', CLAUDE_BIN: bin,
    }), port: 0 },
    handleSignals: false,
    quiet: true,
  })
  const executor = createExecutor({
    backend: 'bridge',
    bridgeUrl: bridge.url,
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

test('published Runtime preserves Codex configured defaults and explicit provider models', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-codex-default-consumer-'))
  const previousHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = join(directory, 'codex-home')
  await mkdir(process.env.CODEX_HOME)
  let bridge: Awaited<ReturnType<typeof startServer>> | undefined
  context.after(async () => {
    await bridge?.close()
    if (previousHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  })
  const argvPath = join(directory, 'argv.json')
  const bin = join(directory, 'codex-protocol.cjs')
  await writeFile(bin, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('protocol fixture'); process.exit(0) }
require('node:fs').writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'default-route-proof' }))
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } }))
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }))
`, { mode: 0o755 })
  bridge = await startServer({
    config: { ...loadConfig({
      BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(directory, 'state'), BRIDGE_BACKENDS: 'codex',
      BRIDGE_BEARER: 'test-only', BRIDGE_TRACE: 'off', CODEX_BIN: bin,
    }), port: 0 },
    handleSignals: false,
    quiet: true,
  })
  for (const [provider, model] of [
    ['openai', 'default'], ['custom', 'default'], ['custom', 'private-model'], ['custom', 'nested/model'],
  ]) {
    await context.test(`${provider}/${model}`, async () => {
      const executor = createExecutor({
        backend: 'bridge', bridgeUrl: bridge!.url, bridgeBearer: 'test-only',
        sessionId: `codex-default-${provider}-${model.replaceAll('/', '-')}`,
      })(
        { profile: { name: 'codex-default-proof', harness: 'codex', model: { provider, default: `${provider}/${model}` } }, harness: null },
        { signal: new AbortController().signal, seams: {} },
      )
      const run = executor.execute('prove the configured route', new AbortController().signal)
      if (!isAsyncIterable(run)) throw new Error('bridge execution did not stream')
      const events: unknown[] = []
      for await (const event of run) events.push(event)
      assert.ok(!events.some(event => (event as { kind?: string }).kind === 'failure'), JSON.stringify(events))
      const argv: string[] = JSON.parse(await readFile(argvPath, 'utf8'))
      assert.ok(argv.includes(`model_provider="${provider}"`), JSON.stringify(argv))
      assert.deepEqual(argv.filter(arg => arg.startsWith('model=')), model === 'default' ? [] : [`model="${model}"`])
    })
  }
})
