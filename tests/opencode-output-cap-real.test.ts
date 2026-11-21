/**
 * Real-binary proof of the opencode output-token budget: what the provider
 * REQUEST carries, what the bridge reports, and that no capped turn bills
 * above its cap.
 *
 * The backend's capped-call facility rests on native facts measured against
 * opencode 1.18.30 (see src/backends/opencode.ts): the runner reads
 * OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX as a per-call `max_tokens`
 * (`min` with the model catalog's output limit, invalid spellings ignored),
 * the plugin hook `chat.params` mutates request parameters in place before
 * every call, the event bus delivers each step-finish receipt, `--title`
 * removes the title model call, and a provider that stops a completion at the
 * bound ends its step with reason `length`.
 *
 * The per-turn output-budget plugin holds a HARD lease over the cap inside the
 * runner process: every granted ask is reserved synchronously before dispatch,
 * one lease is outstanding at a time, capacity returns only against a receipt
 * attributed to that exact attempt (same session, settled once per part id),
 * and unattributed receipts are charged, never refunded. So these cases must
 * observe, on the wire and in usage:
 *
 * - every request's `max_tokens` ≤ the turn's cap, and each later request
 *   carries exactly the receipt-refunded remainder;
 * - a step receipt at the cap that would continue (tool-calls) ends the turn
 *   `length` with the runner terminated — the failing control;
 * - a hidden retry — after a refused attempt or a lost stream — is refused
 *   BEFORE the wire, and the turn fails honestly instead of re-spending;
 * - reasoning tokens count inside the budget;
 * - fresh, resumed, profiled, and concurrent turns all hold the property;
 * - uncapped turns keep today's launch exactly: no flag, no pinned title,
 *   title model call included, 32000 default bound.
 *
 * Every case drives the installed `opencode` through OpencodeBackend against a
 * disposable local OpenAI-compatible recording server: no paid provider, no
 * credentials, invented input only. Skipped when the binary is absent, and by
 * CLI_BRIDGE_SKIP_REAL_OPENCODE=1.
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { OpencodeBackend } from '../src/backends/opencode.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SessionRecord } from '../src/sessions/store.js'
import { hostSpawner } from '../src/executors/host.js'

const BIN = process.env.OPENCODE_BIN ?? join(homedir(), '.opencode/bin/opencode')
const ENABLED = existsSync(BIN) && process.env.CLI_BRIDGE_SKIP_REAL_OPENCODE !== '1'
const FLAG = 'OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX'

interface Recorded {
  auth: string
  max_tokens?: number
  tools: number
  roles: string[]
}

function sse(chunks: unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
}
function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: { prompt_tokens: number; completion_tokens: number; reasoning_tokens?: number },
): unknown {
  return {
    id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? {
      usage: {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.prompt_tokens + usage.completion_tokens,
        ...(usage.reasoning_tokens !== undefined
          ? { completion_tokens_details: { reasoning_tokens: usage.reasoning_tokens } }
          : {}),
      },
    } : {}),
  }
}

const LONG = ('The harbor porpoise swims along the Atlantic coast. '
  + 'Tides pull cold water over the sandbars twice each day. '.repeat(6)
  + 'Fishing boats return before the evening fog settles over the breakwater.').trim()

function toolCallChunk(id: string, command: string): unknown {
  return chunk({
    role: 'assistant',
    tool_calls: [{ index: 0, id, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command, description: 'Inspect' }) } }],
  })
}

describe.skipIf(!ENABLED)('a real capped opencode turn', () => {
  let server: Server
  let baseURL: string
  const scratch = mkdtempSync(join(tmpdir(), 'opencode-cap-real-'))
  const saved = { ...process.env }
  const recorded: Recorded[] = []
  /** Responses held open on purpose (a case that must be cut mid-run). */
  const held: ServerResponse[] = []
  /** The case-specific script the recording server plays. */
  let script: (request: { messages: Array<{ role?: string }>; tools: number; text: string; attempt: number }) => 'hold' | { chunks: unknown[] } | { refuse: { status: number; retryAfterSeconds: number; message: string } }
    = () => ({ chunks: [chunk({ role: 'assistant', content: LONG }), chunk({}, 'stop', { prompt_tokens: 30, completion_tokens: 141 })] })

  beforeAll(async () => {
    let attempts = 0
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (data: Buffer) => { body += data.toString('utf8') })
      req.on('end', () => {
        attempts += 1
        const request = JSON.parse(body) as { max_tokens?: number; tools?: unknown[]; messages?: Array<{ role?: string; content?: unknown }> }
        recorded.push({
          auth: String(req.headers.authorization ?? ''),
          max_tokens: request.max_tokens,
          tools: request.tools?.length ?? 0,
          roles: (request.messages ?? []).map((message) => String(message.role)),
        })
        const text = JSON.stringify(request.messages ?? [])
        const played = script({ messages: request.messages ?? [], tools: request.tools?.length ?? 0, text, attempt: attempts })
        if (played === 'hold') {
          held.push(res)
          return
        }
        if ('refuse' in played) {
          res.writeHead(played.refuse.status, {
            'content-type': 'application/json',
            'retry-after': String(played.refuse.retryAfterSeconds),
          })
          res.end(JSON.stringify({ error: { message: played.refuse.message, type: 'rate_limit_error' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(sse(played.chunks))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  })

  afterAll(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(scratch, { recursive: true, force: true })
  })

  afterEach(() => {
    while (held.length > 0) held.pop()?.destroy()
  })

  /** One disposable provider per case: its apiKey identifies its own requests, so no other turn's traffic can pollute a case. */
  function providerConfig(id: string, limit?: { context: number; output: number }): string {
    process.env.XDG_CONFIG_HOME = join(scratch, 'config')
    process.env.XDG_DATA_HOME = join(scratch, 'data')
    process.env.XDG_CACHE_HOME = join(scratch, 'cache')
    process.env.XDG_STATE_HOME = join(scratch, 'state')
    const apiKey = `key-${id}`
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      provider: {
        [id]: {
          npm: '@ai-sdk/openai-compatible',
          name: id,
          options: { baseURL, apiKey },
          models: { m: { name: 'm', tool_call: true, ...(limit ? { limit } : {}) } },
        },
      },
    })
    return apiKey
  }

  async function turn(request: ChatRequest, session: SessionRecord | null = null): Promise<{ deltas: ChatDelta[]; elapsedMs: number }> {
    const backend = new OpencodeBackend({ bin: BIN, timeoutMs: 60_000, spawner: hostSpawner })
    const cwd = mkdtempSync(join(scratch, 'cwd-'))
    const started = Date.now()
    const deltas: ChatDelta[] = []
    for await (const delta of backend.chat({ cwd, mode: 'byob', ...request }, session, new AbortController().signal)) {
      deltas.push(delta)
    }
    return { deltas, elapsedMs: Date.now() - started }
  }

  const finish = (deltas: ChatDelta[]): string | undefined => deltas.at(-1)?.finish_reason
  const internalSession = (deltas: ChatDelta[]): string | undefined =>
    deltas.find((delta) => delta.internal_session_id !== undefined)?.internal_session_id
  const forKey = (apiKey: string): Recorded[] => recorded.filter((entry) => entry.auth.includes(apiKey))
  const modelCalls = (deltas: ChatDelta[]): Array<ChatDelta['usage'] & { output_tokens?: number }> =>
    deltas.filter((delta) => delta.usage?.model_call === true).map((delta) => delta.usage!)
  const billed = (deltas: ChatDelta[]): number =>
    modelCalls(deltas).reduce((sum, usage) => sum + (usage.output_tokens ?? 0), 0)

  it('bounds a one-shot answer: one capped request, provider truncation reported as length', async () => {
    const key = providerConfig('probe-small')
    recorded.length = 0
    script = () => ({
      chunks: [
        chunk({ role: 'assistant', content: 'The harbor porpoise swims along the Atlantic coast. Tides pull' }),
        chunk({}, 'length', { prompt_tokens: 30, completion_tokens: 40 }),
      ],
    })

    const { deltas } = await turn({
      model: 'opencode/probe-small/m',
      session_id: 'cap-small',
      messages: [{ role: 'user', content: 'Answer with the long passage.' }],
      max_tokens: 40,
    })

    // The pinned title removed the title call: exactly one provider request.
    const own = forKey(key)
    expect(own).toHaveLength(1)
    expect(own[0]!.max_tokens).toBe(40)
    expect(deltas.some((delta) => typeof delta.content === 'string' && delta.content.length > 0)).toBe(true)
    expect(finish(deltas)).toBe('length')
    expect(billed(deltas)).toBe(40)
    expect(billed(deltas)).toBeLessThanOrEqual(40)
  }, 120_000)

  it('completes under a large cap with the bound on every request', async () => {
    const key = providerConfig('probe-large')
    recorded.length = 0
    script = () => ({
      chunks: [chunk({ role: 'assistant', content: LONG }), chunk({}, 'stop', { prompt_tokens: 30, completion_tokens: 141 })],
    })

    const { deltas } = await turn({
      model: 'opencode/probe-large/m',
      session_id: 'cap-large',
      messages: [{ role: 'user', content: 'Answer with the long passage.' }],
      max_tokens: 16384,
    })

    const own = forKey(key)
    expect(own).toHaveLength(1)
    expect(own[0]!.max_tokens).toBe(16384)
    expect(finish(deltas)).toBe('stop')
    expect(billed(deltas)).toBe(141)
  }, 120_000)

  it('asks a continuing tool run for only the remaining allowance, and finishes under the cap', async () => {
    const key = providerConfig('probe-allow')
    recorded.length = 0
    script = ({ tools, text }) => {
      if (tools === 0) {
        return { chunks: [chunk({ role: 'assistant', content: 'title' }), chunk({}, 'stop', { prompt_tokens: 5, completion_tokens: 2 })] }
      }
      const answered = text.includes('"role":"tool"') || text.includes('"role":"assistant"')
      if (!answered) {
        // First step: one tool call, receipt 48 of the 60-token budget.
        return { chunks: [toolCallChunk('call_one', 'echo one'), chunk({}, 'tool_calls', { prompt_tokens: 20, completion_tokens: 48 })] }
      }
      // Second step: the plugin must ask for exactly the remaining 12.
      return { chunks: [chunk({ role: 'assistant', content: 'Done within budget.' }), chunk({}, 'stop', { prompt_tokens: 25, completion_tokens: 10 })] }
    }

    const { deltas } = await turn({
      model: 'opencode/probe-allow/m',
      session_id: 'cap-allow',
      messages: [{ role: 'user', content: 'Run the command, then answer briefly.' }],
      max_tokens: 60,
    })

    const own = forKey(key)
    // The pinned title removed the title call: the tool step and the answer step.
    expect(own).toHaveLength(2)
    expect(own[0]!.max_tokens).toBe(60)
    expect(own[1]!.max_tokens).toBe(12)
    // The turn used a tool, so its terminal reason is the bridge's `tool_calls`
    // (the pre-existing contract for a turn that emitted tool calls).
    expect(finish(deltas)).toBe('tool_calls')
    // Total billed output stays under the caller's cap.
    expect(billed(deltas)).toBe(58)
    expect(billed(deltas)).toBeLessThanOrEqual(60)
    expect(modelCalls(deltas).map((usage) => usage.output_tokens)).toEqual([48, 10])
  }, 120_000)

  it('cuts a continuation whose first receipt already spent the whole budget', async () => {
    const key = providerConfig('probe-cut')
    recorded.length = 0
    script = ({ tools, text }) => {
      if (tools === 0) {
        return { chunks: [chunk({ role: 'assistant', content: 'title' }), chunk({}, 'stop', { prompt_tokens: 5, completion_tokens: 2 })] }
      }
      const answered = text.includes('"role":"tool"') || text.includes('"role":"assistant"')
      if (!answered) {
        // First step bills exactly the cap and asks for another tool.
        return { chunks: [toolCallChunk('call_one', 'sleep 8 && echo one'), chunk({}, 'tool_calls', { prompt_tokens: 20, completion_tokens: 60 })] }
      }
      // Any further model call would spend past the budget; it never answers.
      return 'hold'
    }

    const { deltas, elapsedMs } = await turn({
      model: 'opencode/probe-cut/m',
      session_id: 'cap-cut',
      messages: [{ role: 'user', content: 'Run the command, then answer with the long passage.' }],
      max_tokens: 60,
    })

    const own = forKey(key)
    expect(own).toHaveLength(1)
    expect(own[0]!.max_tokens).toBe(60)
    // The turn ends truncated — cut before the sleeping tool or any further call.
    expect(finish(deltas)).toBe('length')
    expect(billed(deltas)).toBe(60)
    expect(billed(deltas)).toBeLessThanOrEqual(60)
    expect(elapsedMs).toBeLessThan(20_000)
  }, 120_000)

  it('applies the budget to a resumed session turn', async () => {
    const key = providerConfig('probe-resume')
    recorded.length = 0
    script = () => ({
      chunks: [chunk({ role: 'assistant', content: 'ANCHOR acknowledged.' }), chunk({}, 'stop', { prompt_tokens: 12, completion_tokens: 4 })],
    })

    const first = await turn({
      model: 'opencode/probe-resume/m',
      session_id: 'cap-resume',
      messages: [{ role: 'user', content: 'Remember the word ANCHOR. Answer briefly.' }],
    })
    const internalId = internalSession(first.deltas)
    expect(internalId).toBeTruthy()
    expect(finish(first.deltas)).toBe('stop')

    recorded.length = 0
    script = () => ({
      chunks: [chunk({ role: 'assistant', content: 'Resumed within budget.' }), chunk({}, 'stop', { prompt_tokens: 30, completion_tokens: 40 })],
    })
    // A resumed turn runs in the session's own working directory: opencode
    // stores sessions per project, so the second turn must not move the cwd.
    const firstCwd = first.deltas.reduce<string | null>((found, delta) => delta.runner?.cwd ?? found, null)
    expect(firstCwd).toBeTruthy()
    const session: SessionRecord = {
      externalId: 'cap-resume',
      backend: 'opencode',
      internalId: internalId!,
      cwd: firstCwd,
      turns: 1,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      metadata: {},
    }
    const backend = new OpencodeBackend({ bin: BIN, timeoutMs: 60_000, spawner: hostSpawner })
    const deltas: ChatDelta[] = []
    for await (const delta of backend.chat({
      mode: 'byob',
      model: 'opencode/probe-resume/m',
      session_id: 'cap-resume',
      messages: [{ role: 'user', content: 'Now answer with the long passage.' }],
      max_tokens: 64,
    }, session, new AbortController().signal)) {
      deltas.push(delta)
    }

    const own = forKey(key)
    expect(own).toHaveLength(1)
    expect(own[0]!.max_tokens).toBe(64)
    expect(finish(deltas)).toBe('stop')
    expect(billed(deltas)).toBe(40)
  }, 120_000)

  it('keeps a lower model catalog output limit below the requested cap', async () => {
    const key = providerConfig('probe-limit', { context: 200000, output: 40 })
    recorded.length = 0
    script = () => ({
      chunks: [chunk({ role: 'assistant', content: 'Truncated by the catalog limit.' }), chunk({}, 'stop', { prompt_tokens: 30, completion_tokens: 40 })],
    })

    const { deltas } = await turn({
      model: 'opencode/probe-limit/m',
      session_id: 'cap-model-limit',
      messages: [{ role: 'user', content: 'Answer with the long passage.' }],
      max_tokens: 16384,
    })

    const own = forKey(key)
    expect(own).toHaveLength(1)
    // The runner's own min() keeps the model's lower output limit on the wire.
    expect(own[0]!.max_tokens).toBe(40)
    expect(finish(deltas)).toBe('stop')
    expect(billed(deltas)).toBeLessThanOrEqual(40)
  }, 120_000)

  it('keeps a lower operator flag below the requested cap', async () => {
    const key = providerConfig('probe-op')
    process.env[FLAG] = '48'
    recorded.length = 0
    script = () => ({
      chunks: [chunk({ role: 'assistant', content: 'Within the operator bound.' }), chunk({}, 'stop', { prompt_tokens: 30, completion_tokens: 48 })],
    })

    try {
      const { deltas } = await turn({
        model: 'opencode/probe-op/m',
        session_id: 'cap-operator',
        messages: [{ role: 'user', content: 'Answer with the long passage.' }],
        max_tokens: 16384,
      })

      const own = forKey(key)
      expect(own).toHaveLength(1)
      expect(own[0]!.max_tokens).toBe(48)
      expect(finish(deltas)).toBe('stop')
      expect(billed(deltas)).toBeLessThanOrEqual(48)
    } finally {
      delete process.env[FLAG]
    }
  }, 120_000)

  it('isolates concurrent capped turns in the same bridge process', async () => {
    const keyA = providerConfig('probe-a')
    // Second provider on the same server; providerConfig writes one provider per call,
    // so compose both in one config for this case.
    const keyB = 'key-probe-b'
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      provider: {
        'probe-a': { npm: '@ai-sdk/openai-compatible', name: 'probe-a', options: { baseURL, apiKey: keyA }, models: { m: { name: 'm', tool_call: true } } },
        'probe-b': { npm: '@ai-sdk/openai-compatible', name: 'probe-b', options: { baseURL, apiKey: keyB }, models: { m: { name: 'm', tool_call: true } } },
      },
    })
    recorded.length = 0
    script = () => ({
      chunks: [chunk({ role: 'assistant', content: 'Isolated answer.' }), chunk({}, 'stop', { prompt_tokens: 30, completion_tokens: 12 })],
    })

    const run = (model: string, sessionId: string, maxTokens: number): Promise<{ deltas: ChatDelta[] }> =>
      turn({ model, session_id: sessionId, messages: [{ role: 'user', content: 'Answer briefly.' }], max_tokens: maxTokens })
    const [a, b] = await Promise.all([
      run('opencode/probe-a/m', 'cap-concurrent-a', 24),
      run('opencode/probe-b/m', 'cap-concurrent-b', 48),
    ])

    expect(finish(a.deltas)).toBe('stop')
    expect(finish(b.deltas)).toBe('stop')
    expect(billed(a.deltas)).toBeLessThanOrEqual(24)
    expect(billed(b.deltas)).toBeLessThanOrEqual(48)
    // Each turn's requests carry that turn's cap, identified by its own credential.
    const aRequests = forKey(keyA)
    const bRequests = forKey(keyB)
    expect(aRequests).toHaveLength(1)
    expect(bRequests).toHaveLength(1)
    expect(aRequests[0]!.max_tokens).toBe(24)
    expect(bRequests[0]!.max_tokens).toBe(48)
  }, 120_000)

  it('refuses the hidden retry after a refused attempt, before the wire, and fails honestly', async () => {
    const key = providerConfig('probe-retry')
    recorded.length = 0
    script = ({ tools }) => {
      if (tools === 0) {
        return { chunks: [chunk({ role: 'assistant', content: 'title' }), chunk({}, 'stop', { prompt_tokens: 5, completion_tokens: 2 })] }
      }
      // A pre-flight quota refusal: opencode would retry the call itself.
      return { refuse: { status: 429, retryAfterSeconds: 1, message: 'Rate limit reached for requests' } }
    }

    const { deltas } = await turn({
      model: 'opencode/probe-retry/m',
      session_id: 'cap-retry',
      messages: [{ role: 'user', content: 'Answer briefly.' }],
      max_tokens: 60,
    })

    const own = forKey(key)
    // Exactly one request reached the wire: the refused attempt holds the
    // budget lease (its spend is unknown to the plugin), so opencode's
    // automatic retry is refused before it can dispatch a second request.
    expect(own).toHaveLength(1)
    expect(own[0]!.max_tokens).toBe(60)
    // The turn fails honestly rather than completing above the budget.
    expect(finish(deltas)).toBe('error')
    expect(billed(deltas)).toBe(0)
  }, 120_000)

  it('refuses the automatic retry after a lost stream, before the wire', async () => {
    const key = 'key-probe-lost'
    recorded.length = 0
    let destroyed = false

    // A dedicated response path: stream part of a completion, then destroy the
    // socket with no finish chunk and no usage — the runner must retry, and
    // the budget lease must refuse that retry before the wire.
    const installed = createServer((req, res) => {
      let body = ''
      req.on('data', (data: Buffer) => { body += data.toString('utf8') })
      req.on('end', () => {
        const request = JSON.parse(body) as { max_tokens?: number; tools?: unknown[] }
        recorded.push({
          auth: String(req.headers.authorization ?? ''),
          max_tokens: request.max_tokens,
          tools: request.tools?.length ?? 0,
          roles: [],
        })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(sse([chunk({ role: 'assistant', content: 'partial answer before the stream ' })]).replace('data: [DONE]\n\n', ''))
        destroyed = true
        res.socket?.destroy()
      })
    })
    await new Promise<void>((resolve) => installed.listen(0, '127.0.0.1', resolve))
    const installedPort = (installed.address() as AddressInfo).port
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      provider: { 'probe-lost': { npm: '@ai-sdk/openai-compatible', name: 'probe-lost', options: { baseURL: `http://127.0.0.1:${installedPort}/v1`, apiKey: 'key-probe-lost' }, models: { m: { name: 'm', tool_call: true } } } },
    })

    try {
      const { deltas } = await turn({
        model: 'opencode/probe-lost/m',
        session_id: 'cap-lost',
        messages: [{ role: 'user', content: 'Answer briefly.' }],
        max_tokens: 60,
      })

      // Exactly one request reached the wire; the destroyed stream never
      // delivered a receipt, so the retry never dispatched.
      const own = forKey('key-probe-lost')
      expect(own).toHaveLength(1)
      expect(own[0]!.max_tokens).toBe(60)
      expect(destroyed).toBe(true)
      expect(finish(deltas)).toBe('error')
      expect(billed(deltas)).toBe(0)
    } finally {
      await new Promise<void>((resolve) => installed.close(() => resolve()))
    }
  }, 120_000)

  it('counts reasoning tokens inside the budget', async () => {
    const key = providerConfig('probe-reason')
    recorded.length = 0
    script = ({ tools, text }) => {
      if (tools === 0) {
        return { chunks: [chunk({ role: 'assistant', content: 'title' }), chunk({}, 'stop', { prompt_tokens: 5, completion_tokens: 2 })] }
      }
      const answered = text.includes('"role":"tool"') || text.includes('"role":"assistant"')
      if (!answered) {
        return {
          chunks: [
            chunk({ role: 'assistant', reasoning_content: 'Thinking about the tides carefully. '.repeat(3) }),
            toolCallChunk('call_one', 'echo one'),
            chunk({}, 'tool_calls', { prompt_tokens: 20, completion_tokens: 30, reasoning_tokens: 20 }),
          ],
        }
      }
      return { chunks: [chunk({ role: 'assistant', content: 'Done.' }), chunk({}, 'stop', { prompt_tokens: 25, completion_tokens: 5 })] }
    }

    const { deltas } = await turn({
      model: 'opencode/probe-reason/m',
      session_id: 'cap-reason',
      messages: [{ role: 'user', content: 'Think it through, run the command, then answer briefly.' }],
      max_tokens: 60,
    })

    const own = forKey(key)
    expect(own.length).toBe(2)
    expect(own[0]!.max_tokens).toBe(60)
    // 30 billed completion tokens (20 of them reasoning) leave 30 for the answer step.
    expect(own[1]!.max_tokens).toBe(30)
    const calls = modelCalls(deltas)
    expect(calls[0]?.reasoning_output_tokens).toBe(20)
    expect(calls.map((usage) => usage.output_tokens)).toEqual([30, 5])
    expect(finish(deltas)).toBe('tool_calls')
    expect(billed(deltas)).toBe(35)
    expect(billed(deltas)).toBeLessThanOrEqual(60)
  }, 120_000)

  it('applies the budget to a profiled turn through its own config directory', async () => {
    const key = providerConfig('probe-profiled')
    recorded.length = 0
    script = () => ({
      chunks: [chunk({ role: 'assistant', content: 'Profiled capped answer.' }), chunk({}, 'stop', { prompt_tokens: 30, completion_tokens: 20 })],
    })

    const { deltas } = await turn({
      model: 'opencode/probe-profiled/m',
      session_id: 'cap-profiled',
      messages: [{ role: 'user', content: 'Answer briefly.' }],
      max_tokens: 50,
      agent_profile: {
        name: 'capped-worker',
        harness: 'opencode',
        prompt: { instructions: ['Answer in one short sentence.'] },
      },
    } as ChatRequest)

    const own = forKey(key)
    expect(own).toHaveLength(1)
    expect(own[0]!.max_tokens).toBe(50)
    expect(finish(deltas)).toBe('stop')
    expect(billed(deltas)).toBe(20)
    expect(deltas.some((delta) => typeof delta.content === 'string' && delta.content.includes('Profiled capped answer'))).toBe(true)
  }, 120_000)

  it('keeps an uncapped turn exactly as before: no flag, title call included, default bound', async () => {
    const key = providerConfig('probe-plain')
    const savedFlag = process.env[FLAG]
    delete process.env[FLAG]
    recorded.length = 0
    script = () => ({
      chunks: [chunk({ role: 'assistant', content: LONG }), chunk({}, 'stop', { prompt_tokens: 30, completion_tokens: 141 })],
    })

    try {
      const { deltas } = await turn({
        model: 'opencode/probe-plain/m',
        session_id: 'cap-uncapped',
        messages: [{ role: 'user', content: 'Answer with the long passage.' }],
      })

      // Today's uncapped behavior: a title model call plus the answer, both at
      // the runner's 32000 default, and a plain stop finish.
      const own = forKey(key)
      const titles = own.filter((entry) => entry.tools === 0)
      const answers = own.filter((entry) => entry.tools > 0)
      expect(titles.length).toBeGreaterThanOrEqual(1)
      expect(answers).toHaveLength(1)
      expect(answers[0]!.max_tokens).toBe(32000)
      expect(finish(deltas)).toBe('stop')
    } finally {
      if (savedFlag !== undefined) process.env[FLAG] = savedFlag
    }
  }, 120_000)
})
