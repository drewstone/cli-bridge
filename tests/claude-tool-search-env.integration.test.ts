/**
 * Claude Code defers MCP tools behind its ToolSearch tool unless ENABLE_TOOL_SEARCH says otherwise, so a
 * model endpoint that cannot search first (the Router's scripted test model) never sees a profile's MCP
 * tool. Measured with Claude Code 2.1.326 inside the agent-container box: the turn's request carried
 * ToolSearch and a deferred placeholder, not `mcp__conformance__write_nonce`; with ENABLE_TOOL_SEARCH=false
 * it carried the tool. The operator's setting must reach every Claude the Bridge starts, one-shot and
 * retained; without it Claude keeps its own default.
 *
 * A real Bridge listener and the maintained host spawner; the runner speaks Claude's stream-json and
 * answers with the ENABLE_TOOL_SEARCH it was started with. No model is called.
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig, startServer, type BridgeServer } from '../src/server.js'

const BEARER = 'claude-tool-search-env'
const MODEL = 'claude-code/anthropic/sonnet'

// Answers each prompt (argv one-shot, or each stream-json user message when retained) with what it saw.
const stub = String.raw`
const readline = require('node:readline')
if (process.argv.includes('--version')) { console.log('2.1.326 (Claude Code)'); process.exit(0) }
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const session = '00000000-0000-4000-8000-00000000715e'
const seen = 'ENABLE_TOOL_SEARCH=' + (process.env.ENABLE_TOOL_SEARCH ?? '(unset)')
let n = 0
const answer = (uuid) => {
  n += 1
  if (uuid) emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'queued' })
  if (uuid) emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' })
  emit({ type: 'assistant', uuid: 'a-' + n, message: { id: 'm-' + n, model: 'claude-sonnet', content: [{ type: 'text', text: seen }] } })
  emit({ type: 'result', subtype: 'success', session_id: session, result: seen, is_error: false,
    usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 })
}
emit({ type: 'system', subtype: 'init', session_id: session, model: 'claude-sonnet' })
if (!process.argv.includes('--input-format')) answer()
else readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'user') answer(message.uuid)
})
`

describe('the operator\'s ENABLE_TOOL_SEARCH reaches Claude Code', () => {
  let root: string, bridge: BridgeServer
  let counter = 0

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'claude-tool-search-')))
    const bin = join(root, 'claude.cjs')
    await writeFile(bin, `#!${process.execPath}\n${stub}`, { mode: 0o700 })
    bridge = await startServer({
      config: { ...loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_BEARER: BEARER, BRIDGE_TRACE: 'off',
        BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'claude', CLAUDE_BIN: bin }), port: 0 },
      cwd: root, quiet: true, handleSignals: false,
    })
  }, 60_000)
  afterAll(async () => {
    await bridge?.close()
    await rm(root, { recursive: true, force: true })
  })
  afterEach(() => { vi.unstubAllEnvs() })

  const call = async (path: string, body?: unknown) => await fetch(`${bridge.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  const oneShot = async () => {
    const cwd = await mkdtemp(join(root, 'work-'))
    const response = await call('/v1/chat/completions', { model: MODEL, cwd, stream: false, session_id: `tool-search-${++counter}`,
      messages: [{ role: 'user', content: 'Which tool search setting did you start with?' }] })
    const body = await response.json() as Record<string, any>
    expect(response.status, JSON.stringify(body)).toBe(200)
    return String(body.choices?.[0]?.message?.content ?? '')
  }

  /** One turn of a retained native session; its text read from the run's replayed events. */
  const retained = async () => {
    const id = `tool-search-retained-${++counter}`
    const cwd = await mkdtemp(join(root, 'work-'))
    const created = await call('/v1/sessions', { id, model: MODEL, cwd, interaction_policy: 'unattended-allow' })
    expect(created.status, await created.clone().text()).toBeLessThan(300)
    try {
      const turn = await call(`/v1/sessions/${id}/turns`, { message: 'Which tool search setting did you start with?',
        turn_id: `${id}-turn`, run_id: `${id}-run`, execution_id: `${id}-execution` })
      const body = await turn.json() as Record<string, any>
      expect(turn.status, JSON.stringify(body)).toBeLessThan(300)
      const events = await (await call(`/v1/runs/${encodeURIComponent(String(body.run.id))}/events`)).text()
      let text = ''
      for (const line of events.split('\n')) {
        if (!line.startsWith('data:')) continue
        const event = JSON.parse(line.slice(5)), inner = event.event ?? event
        if (inner.type === 'message.part.updated' && inner.part?.type === 'text' && typeof inner.delta === 'string') text += inner.delta
      }
      return text
    } finally {
      await call(`/v1/sessions/${id}/close`, {})
    }
  }

  it('carries ENABLE_TOOL_SEARCH=false to a one-shot turn and to a retained session', async () => {
    vi.stubEnv('ENABLE_TOOL_SEARCH', 'false')
    expect(await oneShot()).toContain('ENABLE_TOOL_SEARCH=false')
    expect(await retained()).toContain('ENABLE_TOOL_SEARCH=false')
  }, 60_000)

  it('leaves Claude its own default when the operator sets nothing', async () => {
    vi.stubEnv('ENABLE_TOOL_SEARCH', undefined)
    expect(await oneShot()).toContain('ENABLE_TOOL_SEARCH=(unset)')
  }, 60_000)
})
