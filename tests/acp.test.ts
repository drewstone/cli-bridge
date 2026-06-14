/**
 * AcpBackend tests — drive the backend against a MOCK ACP agent (a fake child whose
 * stdio speaks the ndjson JSON-RPC protocol) so the full flow is covered in CI without
 * a real binary. The live end-to-end against `hermes acp` is verified separately.
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { AcpBackend } from '../src/backends/acp.js'
import type { ChatRequest } from '../src/backends/types.js'

/** A fake child process that answers the ACP handshake + streams updates. */
function mockAcpChild(opts: { permission?: boolean } = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.stdin = stdin
  child.stdout = stdout
  child.stderr = stderr
  child.pid = 999999
  child.kill = () => true
  const reply = (o: unknown) => stdout.write(JSON.stringify(o) + '\n')
  let buf = ''
  stdin.on('data', (d: Buffer) => {
    buf += d.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
      if (!line) continue
      const m = JSON.parse(line)
      if (m.method === 'initialize') reply({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } })
      else if (m.method === 'session/new') reply({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'sess-1' } })
      else if (m.method === 'session/prompt') {
        // a thought chunk (must be SKIPPED) + two message chunks (content) + result
        reply({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'THINKING' } } } })
        if (opts.permission) reply({ jsonrpc: '2.0', id: 100, method: 'session/request_permission', params: { options: [{ optionId: 'allow-once' }] } })
        reply({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } } })
        reply({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } } } })
        reply({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })
      }
    }
  })
  return { child, stdin }
}

const drain = async (be: AcpBackend, req: ChatRequest) => {
  const out: { text: string; finish?: string; sessionId?: string; deltas: number } = { text: '', deltas: 0 }
  for await (const d of be.chat(req, null, new AbortController().signal)) {
    out.deltas++
    if (d.content) out.text += d.content
    if (d.finish_reason) out.finish = d.finish_reason
    if (d.internal_session_id) out.sessionId = d.internal_session_id
  }
  return out
}

describe('AcpBackend', () => {
  const baseReq: ChatRequest = { model: 'hermes', messages: [{ role: 'user', content: 'hi' }], cwd: '/tmp' } as ChatRequest

  it('matches its own model ids', () => {
    const be = new AcpBackend({ name: 'hermes', bin: 'hermes', timeoutMs: 5000 })
    expect(be.matches('hermes')).toBe(true)
    expect(be.matches('hermes/zai/glm-5')).toBe(true)
    expect(be.matches('openclaw')).toBe(false)
    expect(be.matches('claude-code/sonnet')).toBe(false)
  })

  it('drives the ACP handshake and streams MESSAGE chunks as content (thoughts skipped)', async () => {
    const { child } = mockAcpChild()
    const spawner = vi.fn(async () => ({ child, release: () => {}, spawnError: () => null })) as never
    const be = new AcpBackend({ name: 'hermes', bin: 'hermes', timeoutMs: 5000, spawner })
    const r = await drain(be, baseReq)
    expect(r.text).toBe('Hello world')   // thought 'THINKING' was NOT emitted
    expect(r.finish).toBe('stop')        // end_turn → stop
    expect(r.sessionId).toBe('sess-1')
    expect(spawner).toHaveBeenCalledWith('hermes', ['acp'], expect.objectContaining({ cwd: '/tmp' }))
  })

  it('auto-allows session/request_permission (first option) mid-prompt', async () => {
    const { child, stdin } = mockAcpChild({ permission: true })
    const writes: string[] = []
    stdin.on('data', (d: Buffer) => writes.push(d.toString()))
    const spawner = vi.fn(async () => ({ child, release: () => {}, spawnError: () => null })) as never
    const be = new AcpBackend({ name: 'hermes', bin: 'hermes', timeoutMs: 5000, spawner })
    const r = await drain(be, baseReq)
    expect(r.text).toBe('Hello world')
    expect(writes.join('')).toContain('allow-once') // responded to the permission request with the offered option
  })

  it('surfaces a spawn error as a clean BackendError', async () => {
    const child = new EventEmitter() as never
    const spawner = vi.fn(async () => ({ child, release: () => {}, spawnError: () => new Error('ENOENT') })) as never
    const be = new AcpBackend({ name: 'openclaw', bin: 'openclaw', timeoutMs: 5000, spawner })
    await expect(drain(be, { ...baseReq, model: 'openclaw' })).rejects.toThrow(/spawn failed: ENOENT/)
  })
})
