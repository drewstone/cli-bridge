/**
 * Kimi ACP large-prompt transport tests — drive KimiBackend against a REAL
 * subprocess speaking the verified kimi 2.7.2 ACP surface (schema-strict
 * session/new|resume, request-schema validation like the installed server),
 * through actual pipes: a >131,071-byte prompt crosses a real 64-KiB pipe
 * buffer with backpressure, and the byte-exactness proof is the SHA-256 of
 * the frame the child received. No model calls.
 *
 * Live end-to-end against the installed kimi binary runs externally on the
 * serving host, through the public HTTP route.
 */
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KimiBackend } from '../src/backends/kimi.js'
import { KIMI_ARGV_PROMPT_MAX_BYTES, kimiAcpPromptBlocks, parsesAsKimiSlashCommand } from '../src/backends/kimi-acp.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SessionRecord } from '../src/sessions/store.js'

/**
 * A schema-strict fake of the kimi 2.7.2 ACP server. Modes (argv[1]):
 *   plain       — happy path: streams thought/message/tool updates
 *   resume      — same, but session/resume is the expected entry
 *   permission  — sends a session/request_permission during the turn
 *   delay       — delays the turn 150ms (keepalive window)
 *   cancel      — delays the turn 4s (caller aborts first)
 *   busy        — session/prompt answers turn.agent_busy
 *   failInit    — initialize answers -32601 (old native)
 *   failAuth    — session/new answers -32000 (authRequired)
 *   slash       — records prompt blocks, streams no message, end_turn
 * Every received frame is appended to $KIMI_ACP_RECORD as JSONL before it is
 * answered, so a kill cannot erase the record.
 */
const AGENT_SOURCE = String.raw`
const fs = require('node:fs')
const readline = require('node:readline')
const rec = process.env.KIMI_ACP_RECORD
const log = (m) => { try { fs.appendFileSync(rec, JSON.stringify(m) + '\n') } catch {} }
const line = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const mode = process.argv[1]
const invalidParams = (id) => line({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params' } })
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (raw) => {
  let m
  try { m = JSON.parse(raw) } catch { return }
  log(m)
  if (m.method === undefined) return
  if (m.method === 'initialize') {
    if (mode === 'failInit') return line({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } })
    return line({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'Kimi Code CLI', version: '2.7.2-test' } } })
  }
  if (m.method === 'session/new') {
    const p = m.params || {}
    if (mode === 'failAuth') return line({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'auth required' } })
    if (typeof p.cwd !== 'string' || !Array.isArray(p.mcpServers)) return invalidParams(m.id)
    return line({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'native-ks-1', configOptions: [], modes: { currentModeId: 'default', availableModes: [] } } })
  }
  if (m.method === 'session/resume') {
    const p = m.params || {}
    if (typeof p.sessionId !== 'string' || typeof p.cwd !== 'string' || !Array.isArray(p.mcpServers)) return invalidParams(m.id)
    return line({ jsonrpc: '2.0', id: m.id, result: { configOptions: [], modes: { currentModeId: 'default', availableModes: [] } } })
  }
  if (m.method === 'session/set_config_option' || m.method === 'session/set_mode') {
    return line({ jsonrpc: '2.0', id: m.id, result: {} })
  }
  if (m.method === 'session/cancel') return
  if (m.method === 'session/prompt') {
    if (mode === 'busy') return line({ jsonrpc: '2.0', id: m.id, error: { code: -32600, message: 'another turn is already in progress', data: { code: 'turn.agent_busy' } } })
    const run = () => {
      line({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-ks-1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'SECRET REASONING' } } } })
      if (mode === 'permission') line({ jsonrpc: '2.0', id: 901, method: 'session/request_permission', params: { sessionId: 'native-ks-1', options: [{ optionId: 'allow-once' }, { optionId: 'deny' }] } })
      if (mode !== 'slash') {
        line({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-ks-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } } })
        line({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-ks-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'kimi' } } } })
        line({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'native-ks-1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', kind: 'execute', status: 'in_progress', rawInput: { command: 'pwd' } } } })
      }
      line({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })
    }
    if (mode === 'delay') return setTimeout(run, 150)
    if (mode === 'cancel') return setTimeout(run, 4000)
    return run()
  }
})
`

interface Harness {
  be: KimiBackend
  record: () => Array<Record<string, unknown>>
  spawnCalls: Array<{ bin: string; args: string[] }>
  cleanup: () => Promise<void>
}

function realChildBackend(mode: string, behavior: { terminateGraceMs?: number } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-acp-test-'))
  const recordPath = join(dir, 'record.jsonl')
  const spawnCalls: Array<{ bin: string; args: string[] }> = []
  const children: ChildProcess[] = []
  const spawner = vi.fn(async (bin: string, args: string[]) => {
    spawnCalls.push({ bin, args })
    const child = spawn(process.execPath, ['-e', AGENT_SOURCE, mode], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, KIMI_ACP_RECORD: recordPath },
    })
    children.push(child)
    return {
      child,
      release: () => {},
      terminate: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return
        // Small grace so a just-sent notification reaches the child's record.
        await new Promise((resolve) => setTimeout(resolve, behavior.terminateGraceMs ?? 0))
        child.kill('SIGKILL')
        await new Promise((resolve) => child.once('close', resolve))
      },
      spawnError: () => null,
    }
  }) as never
  const be = new KimiBackend({ bin: 'kimi', timeoutMs: 15_000, spawner })
  const record = (): Array<Record<string, unknown>> =>
    readFileSync(recordPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  const cleanup = async (): Promise<void> => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await new Promise((resolve) => child.once('close', resolve)).catch(() => {})
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
  return { be, record, spawnCalls, cleanup }
}

interface DrainResult {
  text: string
  finish?: string
  sessionId?: string
  keepalives: number
  toolCalls: Array<{ id: string; name: string; arguments: string }>
}

async function drain(
  be: KimiBackend,
  req: ChatRequest,
  signal?: AbortSignal,
): Promise<DrainResult> {
  const out: DrainResult = { text: '', keepalives: 0, toolCalls: [] }
  for await (const d of be.chat(req, null, signal ?? new AbortController().signal)) {
    if (d.content) out.text += d.content
    if (d.finish_reason) out.finish = d.finish_reason
    if (d.internal_session_id) out.sessionId = d.internal_session_id
    if (d.keepalive) out.keepalives++
    for (const tc of d.tool_calls ?? []) out.toolCalls.push(tc)
  }
  return out
}

/** Deterministic >131,071-byte multibyte prompt with sentinels at three depths. */
function largePrompt(): { text: string; sha: string } {
  const unit = '東京 λ Zürich café — measurement row with multibyte text. '
  const filler = unit.repeat(Math.ceil((150 * 1024) / Buffer.byteLength(unit)))
  const text = `SENTINEL_BEGIN\n${filler.slice(0, Math.floor(filler.length / 2))}SENTINEL_MIDDLE${filler.slice(Math.floor(filler.length / 2))}\nSENTINEL_END`
  if (Buffer.byteLength(text, 'utf8') <= KIMI_ARGV_PROMPT_MAX_BYTES) throw new Error('test prompt too small')
  return { text, sha: createHash('sha256').update(text, 'utf8').digest('hex') }
}

const baseReq = (text: string, extra: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'kimi-code/kimi-for-coding',
  messages: [{ role: 'user', content: text }],
  cwd: '/tmp',
  ...extra,
}) as ChatRequest

const methods = (record: Array<Record<string, unknown>>): string[] =>
  record.filter((m) => m.method !== undefined && typeof m.method === 'string').map((m) => m.method as string)

const frame = (record: Array<Record<string, unknown>>, method: string): Record<string, unknown> | undefined =>
  record.find((m) => m.method === method)

describe('KimiBackend ACP large-prompt transport (real subprocess, real pipes)', () => {
  it('carries an oversized prompt byte-exactly through a real pipe', async () => {
    const h = realChildBackend('plain')
    try {
      const { text, sha } = largePrompt()
      const r = await drain(h.be, baseReq(text))
      expect(h.spawnCalls).toEqual([{ bin: 'kimi', args: ['acp'] }])
      const promptMsg = frame(h.record(), 'session/prompt') as { params?: { prompt?: Array<{ text: string }> } }
      const received = (promptMsg.params?.prompt ?? []).map((b) => b.text).join('')
      expect(createHash('sha256').update(received, 'utf8').digest('hex')).toBe(sha)
      expect(r.text).toBe('Hello kimi')
      expect(r.toolCalls).toEqual([{ id: 't1', name: 'Bash', arguments: '{"command":"pwd"}' }])
      expect(r.sessionId).toBe('native-ks-1')
      expect(r.finish).toBe('tool_calls')
    } finally {
      await h.cleanup()
    }
  })

  it('sends schema-strict session/new and sets model, thinking and auto mode before the single prompt', async () => {
    const h = realChildBackend('plain')
    try {
      const { text } = largePrompt()
      const r = await drain(h.be, baseReq(text, { effort: 'none' }))
      expect(r.finish).toBe('tool_calls')
      expect(methods(h.record())).toEqual([
        'initialize', 'session/new',
        'session/set_config_option', // model
        'session/set_config_option', // thinking off (effort none → --no-thinking)
        'session/set_mode', 'session/prompt',
      ])
      const created = frame(h.record(), 'session/new') as { params?: { cwd?: string; mcpServers?: unknown[] } }
      expect(created.params?.cwd).toBe('/tmp')
      expect(Array.isArray(created.params?.mcpServers)).toBe(true)
      const modelCall = h.record().find((m) => (m.params as { configId?: string } | undefined)?.configId === 'model') as { params?: { value?: string } }
      expect(modelCall.params?.value).toBe('kimi-code/kimi-for-coding')
      const thinkingCall = h.record().find((m) => (m.params as { configId?: string } | undefined)?.configId === 'thinking') as { params?: { value?: string } }
      expect(thinkingCall.params?.value).toBe('off')
      const modeCall = frame(h.record(), 'session/set_mode') as { params?: { modeId?: string } }
      expect(modeCall.params?.modeId).toBe('auto')
      expect(methods(h.record()).filter((m) => m === 'session/prompt')).toHaveLength(1)
    } finally {
      await h.cleanup()
    }
  })

  it('leaves thinking unset when no effort was requested (native default applies)', async () => {
    const h = realChildBackend('plain')
    try {
      const { text } = largePrompt()
      await drain(h.be, baseReq(text))
      expect(h.record().some((m) => (m.params as { configId?: string } | undefined)?.configId === 'thinking')).toBe(false)
    } finally {
      await h.cleanup()
    }
  })

  it('resumes a retained session with schema-strict session/resume and never touches its authorization', async () => {
    const h = realChildBackend('plain')
    try {
      const { text, sha } = largePrompt()
      const session = { externalId: 'ext-1', backend: 'kimi-code', internalId: 'native-ks-existing', cwd: '/tmp', turns: 1, createdAt: 0, lastUsedAt: 0, metadata: {} } as SessionRecord
      const out: DrainResult = { text: '', keepalives: 0, toolCalls: [] }
      for await (const d of h.be.chat(baseReq(text), session, new AbortController().signal)) {
        if (d.content) out.text += d.content
        if (d.internal_session_id) out.sessionId = d.internal_session_id
        if (d.finish_reason) out.finish = d.finish_reason
      }
      const record = h.record()
      expect(record.some((m) => m.method === 'session/new')).toBe(false)
      expect(methods(record).filter((m) => m === 'session/resume')).toHaveLength(1)
      const resumed = frame(record, 'session/resume') as { params?: { sessionId?: string; cwd?: string; mcpServers?: unknown[] } }
      expect(resumed.params?.sessionId).toBe('native-ks-existing')
      expect(resumed.params?.cwd).toBe('/tmp')
      expect(Array.isArray(resumed.params?.mcpServers)).toBe(true)
      // Owner-preserving resume: no set_mode, no permission or plan mutation.
      expect(record.some((m) => m.method === 'session/set_mode')).toBe(false)
      expect(methods(record).filter((m) => m === 'session/prompt')).toHaveLength(1)
      // No history replay: only this turn's own chunks.
      expect(out.text).toBe('Hello kimi')
      expect(out.sessionId).toBe('native-ks-existing')
      const promptMsg = frame(record, 'session/prompt') as { params?: { prompt?: Array<{ text: string }> } }
      expect(createHash('sha256').update((promptMsg.params?.prompt ?? []).map((b) => b.text).join(''), 'utf8').digest('hex')).toBe(sha)
    } finally {
      await h.cleanup()
    }
  })

  it('keeps the no-set_mode invariant on a resumed session after a failed prompt', async () => {
    const h = realChildBackend('busy')
    try {
      const { text } = largePrompt()
      const session = { externalId: 'ext-1', backend: 'kimi-code', internalId: 'native-ks-existing', cwd: '/tmp', turns: 1, createdAt: 0, lastUsedAt: 0, metadata: {} } as SessionRecord
      await expect(
        (async () => {
          for await (const _d of h.be.chat(baseReq(text), session, new AbortController().signal)) { /* drain */ }
        })(),
      ).rejects.toMatchObject({
        code: 'upstream',
        message: expect.stringContaining('turn.agent_busy'),
      })
      const record = h.record()
      expect(record.some((m) => m.method === 'session/set_mode')).toBe(false)
      expect(methods(record).filter((m) => m === 'session/prompt')).toHaveLength(1)
    } finally {
      await h.cleanup()
    }
  })

  it('cancels through session/cancel, keeps the resume invariants, and reports the abort terminal', async () => {
    const h = realChildBackend('cancel', { terminateGraceMs: 150 })
    try {
      const { text } = largePrompt()
      const session = { externalId: 'ext-1', backend: 'kimi-code', internalId: 'native-ks-existing', cwd: '/tmp', turns: 1, createdAt: 0, lastUsedAt: 0, metadata: {} } as SessionRecord
      const controller = new AbortController()
      const seen: string[] = []
      const iter = h.be.chat(baseReq(text), session, controller.signal) as AsyncGenerator<ChatDelta>
      const first = await iter.next()
      if (first.value?.internal_session_id) seen.push(first.value.internal_session_id)
      setTimeout(() => controller.abort(), 20)
      let finish: string | undefined
      for await (const d of iter) {
        if (d.finish_reason) finish = d.finish_reason
      }
      const record = h.record()
      expect(record.some((m) => m.method === 'session/cancel')).toBe(true)
      expect(record.some((m) => m.method === 'session/set_mode')).toBe(false)
      expect(finish).toBe('error')
      expect(seen[0]).toBe('native-ks-existing')
    } finally {
      await h.cleanup()
    }
  })

  it('keeps the short prompt on the ordinary argv path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-argv-test-'))
    const spawnCalls: Array<{ bin: string; args: string[] }> = []
    try {
      const argvSource = "process.stdout.write(JSON.stringify({role:'assistant',content:'hi'})+'\\n')"
      const spawner = vi.fn(async (bin: string, args: string[]) => {
        spawnCalls.push({ bin, args })
        const child = spawn(process.execPath, ['-e', argvSource], { stdio: ['ignore', 'pipe', 'pipe'] })
        return {
          child,
          release: () => {},
          terminate: async () => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
            await new Promise((resolve) => child.once('close', resolve))
          },
          spawnError: () => null,
        }
      }) as never
      const be = new KimiBackend({ bin: 'kimi', timeoutMs: 15_000, spawner })
      const r = await drain(be, baseReq('say hi'))
      expect(spawnCalls).toHaveLength(1)
      expect(spawnCalls[0]?.args).toEqual(expect.arrayContaining(['--prompt', 'say hi', '--output-format', 'stream-json']))
      expect(r.text).toBe('hi')
      expect(r.finish).toBe('stop')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed on session/request_permission without fabricating approval', async () => {
    const h = realChildBackend('permission')
    try {
      const { text } = largePrompt()
      await expect(drain(h.be, baseReq(text))).rejects.toMatchObject({ code: 'capability_denied' })
      const record = h.record()
      const refusal = record.find((m) => m.id === 901 && m.error) as { error?: { code?: number } } | undefined
      expect(refusal?.error?.code).toBe(-32001)
      expect(record.some((m) => {
        const outcome = (m.result as { outcome?: unknown } | undefined)?.outcome
        return outcome !== undefined
      })).toBe(false)
    } finally {
      await h.cleanup()
    }
  })

  it('emits keepalives while the agent buffers', async () => {
    const h = realChildBackend('delay')
    const prev = process.env.KIMI_PROGRESS_MS
    process.env.KIMI_PROGRESS_MS = '20'
    try {
      const { text } = largePrompt()
      const r = await drain(h.be, baseReq(text))
      expect(r.keepalives).toBeGreaterThan(0)
      expect(r.text).toBe('Hello kimi')
    } finally {
      if (prev === undefined) delete process.env.KIMI_PROGRESS_MS
      else process.env.KIMI_PROGRESS_MS = prev
      await h.cleanup()
    }
  })

  it('maps a missing ACP surface to an explicit capability error, not E2BIG', async () => {
    const h = realChildBackend('failInit')
    try {
      const { text } = largePrompt()
      await expect(drain(h.be, baseReq(text))).rejects.toMatchObject({
        code: 'capability_denied',
        message: expect.stringContaining('kimi acp does not implement initialize'),
      })
    } finally {
      await h.cleanup()
    }
  })

  it('maps an auth failure to subscription_required with the login fix', async () => {
    const h = realChildBackend('failAuth')
    try {
      const { text } = largePrompt()
      await expect(drain(h.be, baseReq(text))).rejects.toMatchObject({
        code: 'subscription_required',
        subscription: { cause: 'not_authenticated', fix: expect.stringContaining('kimi login') },
      })
    } finally {
      await h.cleanup()
    }
  })

  it('passes request MCP servers inline to session/new', async () => {
    const h = realChildBackend('plain')
    try {
      const { text } = largePrompt()
      await drain(h.be, baseReq(text, { mcp: { mcpServers: { probe: { command: 'probe-server', args: ['--port', '1'] } } } }))
      const created = frame(h.record(), 'session/new') as { params?: { mcpServers?: Array<Record<string, unknown>> } }
      expect(created.params?.mcpServers).toEqual([{ name: 'probe', command: 'probe-server', args: ['--port', '1'], env: [] }])
    } finally {
      await h.cleanup()
    }
  })

  it('delivers a slash-shaped prompt as split blocks that join to the exact source text', async () => {
    const h = realChildBackend('slash')
    try {
      const source = `/status ${'x'.repeat(140 * 1024)}`.slice(0, 140 * 1024)
      if (Buffer.byteLength(source, 'utf8') <= KIMI_ARGV_PROMPT_MAX_BYTES) throw new Error('test prompt too small')
      const r = await drain(h.be, baseReq(source))
      expect(r.finish).toBe('stop')
      const promptMsg = frame(h.record(), 'session/prompt') as { params?: { prompt?: Array<{ type: string; text: string }> } }
      const blocks = promptMsg.params?.prompt ?? []
      expect(blocks).toHaveLength(2)
      const lead = blocks[0]?.text
      const rest = blocks[1]?.text
      expect(lead).toBe('/')
      expect(`${lead ?? ''}${rest ?? ''}`).toBe(source)
    } finally {
      await h.cleanup()
    }
  })
})

describe('kimi slash-command guard', () => {
  it('detects the prompts ACP would intercept as commands', () => {
    expect(parsesAsKimiSlashCommand('/status now')).toBe(true)
    expect(parsesAsKimiSlashCommand('/etc/hosts is a file')).toBe(true) // unknown commands end the turn with no model call
    expect(parsesAsKimiSlashCommand('/')).toBe(false) // bare slash: no token
    expect(parsesAsKimiSlashCommand('//raw')).toBe(false) // token contains '/'
    expect(parsesAsKimiSlashCommand('/path/only')).toBe(false)
    expect(parsesAsKimiSlashCommand('normal /status text')).toBe(false)
    expect(parsesAsKimiSlashCommand('plain text')).toBe(false)
  })

  it('splits an interceptable prompt so the model-visible text is unchanged', () => {
    const blocks = kimiAcpPromptBlocks('/status hello world')
    expect(blocks).toEqual([{ type: 'text', text: '/' }, { type: 'text', text: 'status hello world' }])
    expect(blocks.map((b) => b.text).join('')).toBe('/status hello world')
    expect(kimiAcpPromptBlocks('ordinary prompt')).toEqual([{ type: 'text', text: 'ordinary prompt' }])
  })
})
