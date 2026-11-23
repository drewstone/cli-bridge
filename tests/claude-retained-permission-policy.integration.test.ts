/**
 * A retained Claude Code session through the real Bridge listener and a real stream-json process
 * that asks permission before it writes. No model is called. Covers the three answerers of a
 * permission prompt: the Bridge under `interaction_policy: unattended-allow` (session default or
 * per turn), the Bridge denying a prompt the turn did not admit, and an interactive caller.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canonicalCandidateDigest, interactionResponseCommandDigest } from '@tangle-network/agent-interface'
import { loadConfig, startServer, type BridgeServer } from '../src/server.js'

const BEARER = 'claude-retained-permission-policy'
const MODEL = 'claude-code/anthropic/sonnet'

// One retained process: each user message asks to Write <cwd>/<file>, waits for the answer,
// echoes the consumed control_response as Claude does, writes only when allowed, then answers.
const stub = String.raw`
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline')
if (process.argv.includes('--version')) { console.log('2.1.326 (Claude Code)'); process.exit(0) }
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const session = '00000000-0000-4000-8000-000000000372'
let pending = null, n = 0
emit({ type: 'system', subtype: 'init', session_id: session, model: 'claude-sonnet' })
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'user') {
    n += 1
    const file = String(message.message.content[0].text).match(/write (\S+)/)[1]
    emit({ type: 'command_lifecycle', command_uuid: message.uuid, state: 'queued' })
    emit({ type: 'command_lifecycle', command_uuid: message.uuid, state: 'started' })
    pending = { id: 'perm-' + n, file }
    emit({ type: 'control_request', request_id: pending.id, request: { subtype: 'can_use_tool', tool_name: 'Write',
      input: { file_path: path.join(process.cwd(), file), content: 'written' } } })
  } else if (message.type === 'control_response' && pending && message.response.request_id === pending.id) {
    emit({ type: 'control_response', response: { request_id: pending.id } })
    const allowed = message.response.subtype === 'success' && message.response.response.behavior === 'allow'
    if (allowed) fs.writeFileSync(path.join(process.cwd(), pending.file), 'written')
    const text = allowed ? 'WROTE' : 'REFUSED'
    emit({ type: 'assistant', uuid: 'a-' + n, message: { id: 'm-' + n, model: 'claude-sonnet', content: [{ type: 'text', text }] } })
    emit({ type: 'result', subtype: 'success', session_id: session, result: text, is_error: false,
      usage: { input_tokens: 2, output_tokens: 1 }, total_cost_usd: 0 })
    pending = null
  }
})
`

describe('retained Claude session: who answers a permission prompt', () => {
  let root: string, bridge: BridgeServer
  let counter = 0

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'claude-permission-policy-')))
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

  const call = async (path: string, body?: unknown) => await fetch(`${bridge.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  /** Read a run's canonical events as they arrive until the stream ends at the run's terminal; `onEvent` may answer one. */
  const settle = async (runId: string, onEvent?: (event: Record<string, any>) => Promise<void>) => {
    const events: Array<Record<string, any>> = []
    const response = await fetch(`${bridge.url}/v1/runs/${encodeURIComponent(runId)}/events`, {
      headers: { authorization: `Bearer ${BEARER}` }, signal: AbortSignal.timeout(45_000),
    })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('data:')) continue
        let event: Record<string, any>
        try { event = JSON.parse(line.slice(5)) } catch { continue }
        events.push(event)
        await onEvent?.(event)
      }
    }
    const snapshot = await (await call(`/v1/runs/${encodeURIComponent(runId)}`)).json() as { status?: string }
    return { events, status: snapshot.status }
  }

  const session = async (policy?: string) => {
    const id = `permission-policy-${++counter}`
    const cwd = await mkdtemp(join(root, 'work-'))
    const created = await call('/v1/sessions', { id, model: MODEL, cwd, ...(policy ? { interaction_policy: policy } : {}) })
    expect(created.status, await created.clone().text()).toBeLessThan(300)
    return { id, cwd }
  }

  const turn = async (id: string, file: string, extra: Record<string, unknown> = {}) => {
    const n = ++counter
    const response = await call(`/v1/sessions/${id}/turns`, {
      message: `write ${file}`, turn_id: `${id}-turn-${n}`, run_id: `${id}-run-${n}`, execution_id: `${id}-execution-${n}`, ...extra,
    })
    const body = await response.json() as Record<string, any>
    expect(response.status, JSON.stringify(body)).toBeLessThan(300)
    return String(body.run.id)
  }

  const kinds = (events: Array<Record<string, any>>) => events.map((event) => event.event ?? event)

  it('advertises Claude native sessions for claude-code', async () => {
    const document = await (await call(`/v1/capabilities?model=${encodeURIComponent(MODEL)}`)).json() as Record<string, any>
    expect(document.interactions?.kinds).toContain('permission')
  })

  it('answers every prompt with allow under a session unattended-allow policy', async () => {
    const { id, cwd } = await session('unattended-allow')
    const { events, status } = await settle(await turn(id, 'session-policy.txt'))
    expect(status).toBe('done')
    expect(existsSync(join(cwd, 'session-policy.txt'))).toBe(true)
    expect(kinds(events).some((event) => event.type === 'interaction')).toBe(false)
    expect(kinds(events)).toContainEqual(expect.objectContaining({ type: 'warning', code: 'interaction_answered_by_policy' }))
  }, 60_000)

  it('lets one turn name unattended-allow on an interactive session', async () => {
    const { id, cwd } = await session()
    const { status } = await settle(await turn(id, 'turn-policy.txt', { interaction_policy: 'unattended-allow' }))
    expect(status).toBe('done')
    expect(existsSync(join(cwd, 'turn-policy.txt'))).toBe(true)
  }, 60_000)

  it('denies a prompt the turn did not admit and writes nothing', async () => {
    const { id, cwd } = await session()
    const { events } = await settle(await turn(id, 'denied.txt', { interactions: { permission: false } }))
    expect(existsSync(join(cwd, 'denied.txt'))).toBe(false)
    expect(kinds(events)).toContainEqual(expect.objectContaining({ type: 'warning', code: 'interaction_not_requested' }))
  }, 60_000)

  it('publishes the prompt to an interactive caller, whose allow writes the file', async () => {
    const { id, cwd } = await session()
    const runId = await turn(id, 'interactive.txt', { interactions: { permission: true } })
    let answered = false
    const { status } = await settle(runId, async (event) => {
      const inner = event.event ?? event
      if (inner.type !== 'interaction' || answered) return
      answered = true
      const request = inner.request
      const binding = { ...request.binding, requestDigest: request.requestDigest }
      const response = { id: String(request.id), outcome: 'accepted' as const, data: { grant: 'allow_once' } }
      const reply = await call(`/v1/runs/${encodeURIComponent(runId)}/interactions/${encodeURIComponent(request.id)}/respond`, {
        operationId: canonicalCandidateDigest({ kind: 'test-allow', binding }),
        binding,
        response,
        commandDigest: interactionResponseCommandDigest({ binding, response }),
      })
      expect(reply.status, await reply.clone().text()).toBeLessThan(300)
    })
    expect(answered).toBe(true)
    expect(status).toBe('done')
    expect(existsSync(join(cwd, 'interactive.txt'))).toBe(true)
  }, 60_000)
})
