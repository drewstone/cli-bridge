/**
 * ACP turns (hermes, openclaw) through a real Bridge listener and the host spawner, against a
 * synthetic `<bin> acp` agent that keeps its sessions on disk like hermes 0.23 does: it stays up
 * after refusing a request, replays a resumed session's history as `session/update` before
 * answering `session/resume`, reports token usage on the `session/prompt` result, holds a `wait`
 * prompt until `session/cancel`, and applies a concurrent `/steer <text>` to it. No model is called.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig, startServer, type BridgeServer } from '../src/server.js'

const agent = String.raw`
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline')
if (process.argv.includes('--version')) { console.log('0.0.0-fixture'); process.exit(0) }
const state = path.join(__dirname, 'state')
fs.mkdirSync(state, { recursive: true })
const transcript = (id) => path.join(state, id + '.json')
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
// Model text carries a messageId; the agent's own reply to a command does not (as hermes 0.23 sends them).
const say = (sessionId, text, messageId = 'm-' + Math.random().toString(16).slice(2)) => send({ method: 'session/update', params: { sessionId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...(messageId ? { messageId } : {}) } } })
let waiting = null
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  fs.appendFileSync(path.join(state, 'calls.jsonl'), JSON.stringify({ method: message.method, params: message.params }) + '\n')
  const params = message.params || {}
  if (message.method === 'initialize') return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } } })
  if (message.method === 'session/new') {
    if (path.basename(params.cwd).startsWith('refuse')) return send({ id: message.id, error: { code: -32603, message: 'Internal error', data: { details: 'storage_unavailable' } } })
    const sessionId = 'fixture-' + Date.now() + '-' + Math.random().toString(16).slice(2)
    fs.writeFileSync(transcript(sessionId), '[]')
    return send({ id: message.id, result: { sessionId } })
  }
  if (message.method === 'session/resume') {
    for (const text of JSON.parse(fs.readFileSync(transcript(params.sessionId), 'utf8'))) say(params.sessionId, 'REPLAYED ' + text)
    return send({ id: message.id, result: {} })
  }
  if (message.method === 'session/cancel') {
    if (waiting !== null) send({ id: waiting, result: { stopReason: 'cancelled' } })
    waiting = null
    return
  }
  if (message.method === 'session/prompt') {
    const text = params.prompt[0].text, past = JSON.parse(fs.readFileSync(transcript(params.sessionId), 'utf8'))
    if (text === 'wait') { waiting = message.id; return }
    // hermes's /steer: answered at once with a receipt that repeats the text, applied to the running prompt after it.
    if (text.startsWith('/steer ') && waiting !== null) {
      const steer = text.slice('/steer '.length), held = waiting
      waiting = null
      say(params.sessionId, 'Steer queued for the active turn: ' + steer, null)
      send({ id: message.id, result: { stopReason: 'end_turn' } })
      return void setTimeout(() => { say(params.sessionId, 'steered: ' + steer); send({ id: held, result: { stopReason: 'end_turn' } }) }, 100)
    }
    const answer = text === 'repeat' ? (past[past.length - 1] || 'nothing') : 'echo ' + text
    fs.writeFileSync(transcript(params.sessionId), JSON.stringify([...past, answer]))
    say(params.sessionId, answer)
    return send({ id: message.id, result: { stopReason: 'end_turn', usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } } })
  }
})
`

describe('an ACP turn through the Bridge', () => {
  let root: string, bin: string, bridge: BridgeServer
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'acp-turn-')))
    await mkdir(join(root, 'bin'))
    bin = join(root, 'bin', 'hermes.cjs')
    await writeFile(bin, `#!${process.execPath}\n${agent}`, { mode: 0o700 })
    const config = loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'hermes', HERMES_BIN: bin,
      BRIDGE_TRACE: 'off', BRIDGE_JAIL_MODE: 'off' })
    bridge = await startServer({ config: { ...config, port: 0 }, cwd: root, quiet: true, handleSignals: false })
  })
  afterAll(async () => {
    await bridge?.close()
    await rm(root, { recursive: true, force: true })
  })

  const workspace = async (name: string) => {
    const cwd = join(root, `${name}-${randomBytes(3).toString('hex')}`)
    await mkdir(cwd)
    return cwd
  }
  const chat = async (cwd: string, content: string, extra: Record<string, unknown> = {}) => {
    const response = await fetch(`${bridge.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hermes', cwd, stream: false, messages: [{ role: 'user', content }], ...extra }),
      signal: AbortSignal.timeout(15_000) })
    const body = await response.json() as { choices?: Array<{ message: { content: string } }>; usage?: Record<string, unknown>; error?: { message: string; type: string } }
    return { status: response.status, text: body.choices?.[0]?.message.content ?? '', usage: body.usage, error: body.error }
  }
  const calls = async () => (await readFile(join(root, 'bin', 'state', 'calls.jsonl'), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })

  it('answers a refused session/new at once, though the agent stays up', async () => {
    const started = Date.now()
    const turn = await chat(await workspace('refuse'), 'hello', { session_id: `refused-${randomBytes(3).toString('hex')}` })
    expect(turn.status).toBeGreaterThanOrEqual(500)
    expect(turn.error?.message).toContain('storage_unavailable')
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 20_000)

  it('continues the agent session on a later turn, without the replayed history, and reports its usage', async () => {
    const cwd = await workspace('resume'), session = `resume-${randomBytes(3).toString('hex')}`
    const first = await chat(cwd, 'first', { session_id: session })
    expect(first.status, JSON.stringify(first.error)).toBe(200)
    expect(first.text).toBe('echo first')
    expect(first.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 4 })
    const second = await chat(cwd, 'repeat', { session_id: session })
    expect(second.status, JSON.stringify(second.error)).toBe(200)
    expect(second.text).toBe('echo first')
    const mine = (await calls()).filter((call) => call.params?.cwd === cwd)
    const created = mine.filter((call) => call.method === 'session/new')
    const resumed = mine.filter((call) => call.method === 'session/resume')
    expect(created).toHaveLength(1)
    expect(resumed).toHaveLength(1)
    expect(resumed[0]!.params.sessionId).toMatch(/^fixture-/u)
  }, 30_000)

  it('refuses a named model instead of running the configured one', async () => {
    const before = (await calls()).length
    const response = await fetch(`${bridge.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hermes/some-other-model', cwd: await workspace('model'), stream: false, messages: [{ role: 'user', content: 'hi' }] }) })
    const body = await response.json() as { error?: { type?: string; message?: string } }
    expect(response.status).toBe(501)
    expect(body.error?.type).toBe('not_configured')
    expect((await calls()).length).toBe(before)
  })

  it('retains one agent session across turns and steers its running turn with /steer', async () => {
    const cwd = await workspace('native'), id = `native-${randomBytes(3).toString('hex')}`
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${bridge.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
      return { status: response.status, body: await response.json() as Record<string, any> }
    }
    const runText = async (runId: string) => {
      const response = await fetch(`${bridge.url}/v1/runs/${encodeURIComponent(runId)}/events`, { signal: AbortSignal.timeout(15_000) })
      let text = ''
      for (const line of (await response.text()).split('\n')) {
        if (!line.startsWith('data:')) continue
        const event = JSON.parse(line.slice(5)) as Record<string, any>
        const inner = event.event ?? event
        if (inner.type === 'message.part.updated' && inner.part?.type === 'text' && typeof inner.delta === 'string') text += inner.delta
      }
      return text
    }
    const turn = async (n: number, message: string) => {
      const begun = await post(`/v1/sessions/${id}/turns`, { message, turn_id: `${id}-${n}`, run_id: `${id}-${n}-run`, execution_id: `${id}-${n}-execution` })
      expect(begun.status, JSON.stringify(begun.body)).toBeLessThan(300)
      return String(begun.body.run.id)
    }
    const created = await post('/v1/sessions', { id, model: 'hermes', cwd, interaction_policy: 'unattended-allow' })
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300)
    expect(await runText(await turn(1, 'first'))).toBe('echo first')

    const running = await turn(2, 'wait')
    const status = await fetch(`${bridge.url}/v1/runs/${encodeURIComponent(running)}`)
    const header = (name: string) => status.headers.get(`x-run-${name}`)
    const steered = await post(`/v1/sessions/${id}/steer`, { operationId: `steer-${randomBytes(3).toString('hex')}`, message: 'turn left',
      run: { runId: header('id'), requestDigest: header('request-digest'), provider: header('provider'), environmentId: header('environment-id'),
        sessionId: header('session-id'), executionId: header('execution-id') } })
    expect(steered.status, JSON.stringify(steered.body)).toBeLessThan(300)
    // The receipt repeats the steer's text; only the agent's answer is the turn's text.
    expect(await runText(running)).toBe('steered: turn left')
    const prompts = (await calls()).filter((call) => call.method === 'session/prompt' && (call.params.prompt as Array<{ text: string }>)[0]?.text !== undefined)
    const mine = prompts.filter((call) => ['first', 'wait', '/steer turn left'].includes((call.params.prompt as Array<{ text: string }>)[0]!.text))
    expect(mine).toHaveLength(3)
    expect(new Set(mine.map((call) => call.params.sessionId)).size).toBe(1)
    await post(`/v1/sessions/${id}/close`, {})
  }, 40_000)

  it('cancels a running turn through session/cancel', async () => {
    const cwd = await workspace('cancel'), runId = `cancel-run-${randomBytes(3).toString('hex')}`
    const pending = chat(cwd, 'wait', { session_id: `cancel-${randomBytes(3).toString('hex')}`, run_id: runId }).catch(() => undefined)
    const waitPrompt = async () => (await calls()).find((call) => call.method === 'session/prompt'
      && (call.params.prompt as Array<{ text: string }>)[0]?.text === 'wait')
    let prompt: Awaited<ReturnType<typeof waitPrompt>>
    for (const end = Date.now() + 10_000; !prompt && Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 50))) prompt = await waitPrompt()
    expect(prompt).toBeDefined()
    const cancelled = await fetch(`${bridge.url}/v1/runs/${runId}/cancel?wait_ms=10000`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(cancelled.status).toBeLessThan(300)
    await pending
    expect((await calls()).filter((call) => call.method === 'session/cancel').map((call) => call.params.sessionId)).toContain(prompt!.params.sessionId)
  }, 30_000)
})
