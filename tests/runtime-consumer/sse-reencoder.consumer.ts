import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { encodeSSEFrame, streamSSEFrames } from '@tangle-network/agent-core/sse'
import { createExecutor } from '@tangle-network/agent-runtime/kernel'
import { loadConfig, startServer } from '../../src/server.js'

const PROFILE = {
  name: 'sse-reencoder-consumer-proof',
  harness: 'claude-code',
  model: { provider: 'anthropic', default: 'sonnet' },
} as const

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === 'object'
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
}

/**
 * A proxy that decodes every event stream with agent-core's spec-compliant parser and writes
 * each dispatched frame back out, the way a test proxy or an SSE-aware gateway does. A frame the
 * SSE rules never dispatch (no data line) does not survive it. Every raw upstream frame is
 * recorded so the test can prove the stream it relayed held the frame kinds under test; a
 * relay that fails destroys its response so the client sees the failure.
 */
async function startReencodingProxy(upstream: string, rawFrames: string[]): Promise<{
  url: string
  server: Server
  settled: () => Promise<unknown>
}> {
  const relays = new Set<Promise<void>>()
  const relay = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || key === 'host' || key === 'content-length') continue
      headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    }
    const answer = await fetch(new URL(req.url ?? '/', upstream), {
      method: req.method,
      headers,
      body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
    })
    const out: Record<string, string> = {}
    answer.headers.forEach((value, key) => {
      if (key !== 'content-length' && key !== 'transfer-encoding' && key !== 'content-encoding') out[key] = value
    })
    res.writeHead(answer.status, out)
    if (!answer.body) return void res.end()
    if (!answer.headers.get('content-type')?.includes('text/event-stream')) {
      res.end(Buffer.from(await answer.arrayBuffer()))
      return
    }
    const [forParser, forRecord] = answer.body.tee()
    const recorded = (async () => {
      let text = ''
      const decoder = new TextDecoder()
      for await (const chunk of forRecord) text += decoder.decode(chunk, { stream: true })
      rawFrames.push(...text.split(/\n\n/u).filter(frame => frame.length > 0))
    })()
    for await (const frame of streamSSEFrames(forParser)) res.write(encodeSSEFrame(frame))
    await recorded
    res.end()
  }
  const server = createServer((req, res) => {
    const done = relay(req, res).catch(() => { res.destroy() })
    relays.add(done)
    void done.finally(() => relays.delete(done))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('proxy did not bind')
  return { url: `http://127.0.0.1:${address.port}`, server, settled: () => Promise.all(relays) }
}

// A real process emits the native wire protocol, including a silent pause that the bridge reports
// as a keepalive and a session-start line that is bridge metadata. The published Runtime reads the
// stream through the published agent-core re-encoder and must see every numbered event.
test('published Runtime completes a Bridge run relayed through a spec-compliant SSE re-encoder', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-sse-reencoder-consumer-'))
  const previousProgress = process.env.CLAUDE_PROGRESS_MS
  process.env.CLAUDE_PROGRESS_MS = '20'
  let bridge: Awaited<ReturnType<typeof startServer>> | undefined
  let proxy: Server | undefined
  context.after(async () => {
    proxy?.closeAllConnections()
    await new Promise(resolve => proxy ? proxy.close(resolve) : resolve(undefined))
    await bridge?.close()
    if (previousProgress === undefined) delete process.env.CLAUDE_PROGRESS_MS
    else process.env.CLAUDE_PROGRESS_MS = previousProgress
    await rm(directory, { recursive: true, force: true })
  })
  const bin = join(directory, 'claude-protocol.cjs')
  const answer = JSON.stringify({ ok: true })
  await writeFile(bin, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('protocol fixture'); process.exit(0) }
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sse-reencoder-proof' }))
setTimeout(() => {
  console.log(JSON.stringify({ type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: ${JSON.stringify(answer)} }] } }))
  console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sse-reencoder-proof', result: ${JSON.stringify(answer)},
    is_error: false, usage: { input_tokens: 2, output_tokens: 4 } }))
}, 200)
`, { mode: 0o755 })
  bridge = await startServer({
    config: { ...loadConfig({
      BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(directory, 'state'), BRIDGE_BACKENDS: 'claude',
      BRIDGE_BEARER: 'test-only', BRIDGE_TRACE: 'off', CLAUDE_BIN: bin,
    }), port: 0 },
    handleSignals: false,
    quiet: true,
  })
  const rawFrames: string[] = []
  const relay = await startReencodingProxy(bridge.url, rawFrames)
  proxy = relay.server
  const executor = createExecutor({
    backend: 'bridge',
    bridgeUrl: relay.url,
    bridgeBearer: 'test-only',
    sessionId: 'sse-reencoder-proof',
  })(
    { profile: PROFILE, harness: null },
    { signal: new AbortController().signal, seams: {} },
  )
  const run = executor.execute('relay this run through a re-encoder', new AbortController().signal)
  if (!isAsyncIterable(run)) throw new Error('bridge execution did not stream')
  for await (const _event of run) { /* drain */ }
  // Runtime stops at [DONE]; wait until the proxy has recorded the whole upstream stream.
  await relay.settled()

  const numbered = rawFrames.filter(frame => /^id: /mu.test(frame))
  assert.ok(numbered.some(frame => frame.includes(': keepalive source=claude')), 'the relayed stream held a numbered keepalive')
  assert.ok(numbered.some(frame => frame.includes(': bridge-metadata')), 'the relayed stream held a numbered metadata frame')
  for (const frame of numbered) assert.match(frame, /^data: /mu, `numbered frame without data: ${JSON.stringify(frame)}`)
  // A keepalive must not reach Runtime as a chunk: a chunk resets Runtime's model-silence bound.
  for (const frame of numbered.filter(frame => frame.includes(': keepalive'))) assert.doesNotMatch(frame, /"model"/u)
})
