import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import * as traceContract from '@tangle-network/agent-trace-contract'
import {
  ATTR,
  contractSpan,
  deriveHexId,
  validateTraceSpans,
  type Capability,
  type ContractSpan,
} from '@tangle-network/agent-trace-contract'
import {
  EXPECTED_MAX_SPANS_READ,
  traceContractBuildId,
  verifyInstalledTraceContract,
} from '../src/trace/contract-build.js'
import { AdmissionGate } from '../src/admission.js'
import { BackendRegistry } from '../src/backends/registry.js'
import { BackendError, type Backend, type BackendHealth, type ChatDelta, type ChatRequest } from '../src/backends/types.js'
import { loadConfig } from '../src/config.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { RunRegistry } from '../src/runs/registry.js'
import { SessionStore } from '../src/sessions/store.js'
import { BRIDGE_ATTR, TraceEmitter } from '../src/trace/emitter.js'
import { normalizeSpanId, normalizeTraceId, parseTraceparent, resolveCallerTrace } from '../src/trace/ids.js'
import { JsonlSpanSink, type SpanSink } from '../src/trace/sink.js'

const CHAT_PATH = '/v1/chat/completions'
const CALLER_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const CALLER_SPAN_ID = '00f067aa0ba902b7'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

abstract class TestBackend implements Backend {
  constructor(readonly name = 'kimi-code') {}

  matches(model: string): boolean {
    return model === this.name || model.startsWith(`${this.name}/`)
  }

  async health(): Promise<BackendHealth> {
    return { name: this.name, state: 'ready' }
  }

  abstract chat(
    req: ChatRequest,
    session: unknown,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta>
}

/** A turn that reads a file, calls a tool, and reports measured usage plus cost. */
class ToolUsingBackend extends TestBackend {
  calls = 0

  async *chat(): AsyncIterable<ChatDelta> {
    this.calls += 1
    yield { internal_session_id: 'harness-session-9' }
    yield { content: 'looking at the repo' }
    yield { tool_calls: [{ id: 'call_1', name: 'Read', arguments: '{"path":"/etc/hosts"}' }] }
    yield { tool_calls: [{ id: 'call_2', name: 'Bash', arguments: '{"cmd":"ls"}' }] }
    yield {
      finish_reason: 'tool_calls',
      usage: { input_tokens: 1200, output_tokens: 340, cost: 0.0042, cost_scope: 'total' },
    }
  }
}

/** A backend whose CLI reports no usage — the route synthesises an estimate. */
class SilentBackend extends TestBackend {
  async *chat(): AsyncIterable<ChatDelta> {
    yield { content: 'done' }
    yield { finish_reason: 'stop' }
  }
}

/** Reports usage with tokens but never a cost, so the sum is a floor. */
class NoCostBackend extends TestBackend {
  async *chat(): AsyncIterable<ChatDelta> {
    yield { content: 'ok' }
    yield { finish_reason: 'stop', usage: { input_tokens: 10, output_tokens: 5 } }
  }
}

class ThrowingBackend extends TestBackend {
  // eslint-disable-next-line require-yield
  async *chat(): AsyncIterable<ChatDelta> {
    throw new BackendError('kimi CLI not found on PATH', 'cli_missing')
  }
}

/** Fails partway through, the way a CLI that dies mid-stream does. */
class MidStreamFailureBackend extends TestBackend {
  async *chat(): AsyncIterable<ChatDelta> {
    yield { content: 'partial' }
    yield { finish_reason: 'error', error: { message: 'upstream refused the request', type: 'upstream' } }
  }
}

/** Emits the shapes a misbehaving CLI parser produces: NaN usage, no tool name. */
class HostileDeltaBackend extends TestBackend {
  async *chat(): AsyncIterable<ChatDelta> {
    yield { tool_calls: [{ id: '', name: '', arguments: 'x'.repeat(5_000) }] }
    yield {
      finish_reason: 'stop',
      usage: { input_tokens: Number.NaN, output_tokens: -5, cost: Number.POSITIVE_INFINITY },
    }
  }
}

class ManyToolsBackend extends TestBackend {
  constructor(private readonly count: number) { super() }

  async *chat(): AsyncIterable<ChatDelta> {
    for (let i = 0; i < this.count; i++) {
      yield { tool_calls: [{ id: `call_${i}`, name: 'Read', arguments: '{}' }] }
    }
    yield { finish_reason: 'tool_calls', usage: { input_tokens: 1, output_tokens: 1 } }
  }
}

interface Fixture {
  app: Hono
  spans: () => ContractSpan[]
  file: string
  logs: string[]
}

function fixture(
  backend: Backend,
  options: { sink?: SpanSink; maxToolSpans?: number; admission?: AdmissionGate } = {},
): Fixture {
  const dir = tempDir('cli-bridge-trace-')
  const file = join(dir, 'traces', 'spans.jsonl')
  const logs: string[] = []
  const sink = options.sink ?? new JsonlSpanSink({
    file,
    maxBytes: 1024 * 1024,
    maxFiles: 3,
    log: (message) => logs.push(message),
  })
  const trace = new TraceEmitter({
    sink,
    maxToolSpans: options.maxToolSpans ?? 512,
    log: (message) => logs.push(message),
  })
  const app = new Hono()
  mountChatCompletions(app, {
    registry: new BackendRegistry().register(backend),
    sessions: new SessionStore(dir),
    runs: new RunRegistry(),
    trace,
    ...(options.admission ? { admission: options.admission } : {}),
  })
  return { app, file, logs, spans: () => readSpans(file) }
}

function readSpans(file: string): ContractSpan[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ContractSpan)
}

async function postChat(
  app: Hono,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await app.request(CHAT_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function chatBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'kimi-code/kimi-k2',
    messages: [{ role: 'user', content: 'refactor the parser' }],
    ...extra,
  }
}

function capability(capabilities: Capability[], name: string): Capability {
  const found = capabilities.find((entry) => entry.name === name)
  if (!found) throw new Error(`capability ${name} missing from validation result`)
  return found
}

function requestSpan(spans: ContractSpan[]): ContractSpan {
  const found = spans.find((span) => span.kind === 'LLM')
  if (!found) throw new Error('no LLM span emitted')
  return found
}

describe('caller trace correlation', () => {
  it('accepts a W3C traceparent', () => {
    const resolved = resolveCallerTrace({
      traceparent: `00-${CALLER_TRACE_ID}-${CALLER_SPAN_ID}-01`,
    })
    expect(resolved).toEqual({
      caller: { traceId: CALLER_TRACE_ID, parentSpanId: CALLER_SPAN_ID },
      correlation: 'traceparent',
    })
  })

  it('reads a future traceparent version by its first four fields', () => {
    expect(parseTraceparent(`01-${CALLER_TRACE_ID}-${CALLER_SPAN_ID}-01-extra`)).toEqual({
      traceId: CALLER_TRACE_ID,
      parentSpanId: CALLER_SPAN_ID,
    })
  })

  it('rejects the traceparent spellings the W3C spec calls invalid', () => {
    const cases = [
      `00-${CALLER_TRACE_ID}-${CALLER_SPAN_ID}-01-extra`, // version 00 is exactly 4 fields
      `ff-${CALLER_TRACE_ID}-${CALLER_SPAN_ID}-01`, // version ff is reserved
      `00-${'0'.repeat(32)}-${CALLER_SPAN_ID}-01`, // all-zero trace id
      `00-${CALLER_TRACE_ID}-${'0'.repeat(16)}-01`, // all-zero span id
      `00-${CALLER_TRACE_ID.toUpperCase()}-${CALLER_SPAN_ID}-01`, // spec requires lowercase
      `00-${CALLER_TRACE_ID}-${CALLER_SPAN_ID}`, // truncated
      'not-a-traceparent',
      '',
    ]
    for (const value of cases) expect(parseTraceparent(value), value).toBeNull()
  })

  it('falls back to explicit headers and accepts a dashed UUID trace id', () => {
    expect(resolveCallerTrace({
      traceId: '4bf92f35-77b3-4da6-a3ce-929d0e0e4736',
      parentSpanId: CALLER_SPAN_ID.toUpperCase(),
    })).toEqual({
      caller: { traceId: CALLER_TRACE_ID, parentSpanId: CALLER_SPAN_ID },
      correlation: 'headers',
    })
  })

  it('prefers a valid traceparent over the explicit headers', () => {
    expect(resolveCallerTrace({
      traceparent: `00-${CALLER_TRACE_ID}-${CALLER_SPAN_ID}-01`,
      traceId: 'a'.repeat(32),
      parentSpanId: 'b'.repeat(16),
    }).caller).toEqual({ traceId: CALLER_TRACE_ID, parentSpanId: CALLER_SPAN_ID })
  })

  it('reports supplied-but-unusable as invalid and absent as none', () => {
    expect(resolveCallerTrace({ traceparent: 'garbage' }).correlation).toBe('invalid')
    // A parent span id with no trace id names a span nothing can reach.
    expect(resolveCallerTrace({ parentSpanId: CALLER_SPAN_ID })).toEqual({
      caller: null,
      correlation: 'invalid',
    })
    expect(resolveCallerTrace({})).toEqual({ caller: null, correlation: 'none' })
  })

  it('refuses the OTLP all-zero sentinels', () => {
    expect(normalizeTraceId('0'.repeat(32))).toBeNull()
    expect(normalizeSpanId('0'.repeat(16))).toBeNull()
    expect(normalizeTraceId('abc')).toBeNull()
    expect(normalizeSpanId(undefined)).toBeNull()
  })
})

describe('span shape conformance', () => {
  it('emits one conforming LLM span with child TOOL spans', async () => {
    const ctx = fixture(new ToolUsingBackend())
    const response = await postChat(ctx.app, chatBody({ session_id: 'caller-session-1', run_id: 'run-abc' }))
    expect(response.status).toBe(200)

    const spans = ctx.spans()
    expect(spans).toHaveLength(3)

    const llm = requestSpan(spans)
    expect(llm.name).toBe('chat kimi-code')
    expect(llm.parent_span_id).toBeNull()
    expect(llm.status).toEqual({ code: 'STATUS_CODE_OK' })
    expect(llm.resource).toEqual({ attributes: { 'service.name': 'cli-bridge' } })
    expect(llm.attributes).toMatchObject({
      [ATTR.spanKind]: 'LLM',
      [ATTR.model]: 'kimi-code/kimi-k2',
      [ATTR.system]: 'kimi-code',
      [ATTR.inputTokens]: 1200,
      [ATTR.outputTokens]: 340,
      [ATTR.costUsd]: 0.0042,
      [BRIDGE_ATTR.runId]: 'run-abc',
      [BRIDGE_ATTR.sessionId]: 'caller-session-1',
      [BRIDGE_ATTR.backendSessionId]: 'harness-session-9',
      [BRIDGE_ATTR.mode]: 'byob',
      [BRIDGE_ATTR.execution]: 'host',
      [BRIDGE_ATTR.correlation]: 'none',
      [BRIDGE_ATTR.finishReason]: 'tool_calls',
      [BRIDGE_ATTR.toolCallsObserved]: 2,
    })
    expect(llm.attributes[BRIDGE_ATTR.usageEstimated]).toBeUndefined()
    expect(Date.parse(llm.end_time)).toBeGreaterThanOrEqual(Date.parse(llm.start_time))

    const tools = spans.filter((span) => span.kind === 'TOOL')
    expect(tools.map((span) => span.name)).toEqual(['Read', 'Bash'])
    for (const tool of tools) {
      expect(tool.trace_id).toBe(llm.trace_id)
      expect(tool.parent_span_id).toBe(llm.span_id)
      // The bridge sees the DECISION to call a tool and never the call finishing,
      // so the span is an instant and claims no outcome.
      expect(tool.end_time).toBe(tool.start_time)
      expect(tool.status).toEqual({ code: 'STATUS_CODE_UNSET' })
    }
    expect(tools[0]?.attributes).toMatchObject({
      [ATTR.toolName]: 'Read',
      [BRIDGE_ATTR.toolCallId]: 'call_1',
    })

    // Tool ARGUMENTS carry prompts, paths and file contents; they must not land
    // in a trace file that outlives the request.
    expect(readFileSync(ctx.file, 'utf8')).not.toContain('/etc/hosts')

    const validation = validateTraceSpans(spans)
    expect(validation.findings).toEqual([])
    expect(validation.ok).toBe(true)
    for (const name of ['token-accounting', 'cost-attribution', 'tool-usage', 'latency-analysis']) {
      expect(capability(validation.capabilities, name)).toMatchObject({ available: true })
    }
  })

  it('flags estimated tokens and withholds a cost nobody reported', async () => {
    const ctx = fixture(new SilentBackend())
    expect((await postChat(ctx.app, chatBody())).status).toBe(200)

    const llm = requestSpan(ctx.spans())
    expect(llm.attributes[BRIDGE_ATTR.usageEstimated]).toBe(true)
    expect(llm.attributes[ATTR.inputTokens]).toBeGreaterThan(0)
    expect(llm.attributes[ATTR.costUsd]).toBeUndefined()
    expect(llm.status).toEqual({ code: 'STATUS_CODE_OK' })
  })

  it('withholds cost when a contributing record reported none, so a floor is never read as a total', async () => {
    const ctx = fixture(new NoCostBackend())
    expect((await postChat(ctx.app, chatBody())).status).toBe(200)

    const llm = requestSpan(ctx.spans())
    expect(llm.attributes[ATTR.inputTokens]).toBe(10)
    expect(llm.attributes[ATTR.outputTokens]).toBe(5)
    expect(llm.attributes[ATTR.costUsd]).toBeUndefined()
    expect(validateTraceSpans(ctx.spans()).ok).toBe(true)
  })

  it('records a mid-stream backend failure as an ERROR span carrying the reason', async () => {
    const ctx = fixture(new MidStreamFailureBackend())
    const response = await postChat(ctx.app, chatBody())
    expect(response.status).toBe(200)

    const llm = requestSpan(ctx.spans())
    expect(llm.status.code).toBe('STATUS_CODE_ERROR')
    expect(llm.status.message).toContain('upstream refused the request')
    expect(llm.attributes[BRIDGE_ATTR.finishReason]).toBe('error')
  })

  it('records a request that never reached the backend', async () => {
    const ctx = fixture(new ThrowingBackend())
    const response = await postChat(ctx.app, chatBody())
    expect(response.status).toBe(503)

    const spans = ctx.spans()
    const llm = requestSpan(spans)
    expect(llm.status.code).toBe('STATUS_CODE_ERROR')
    expect(llm.status.message).toContain('kimi CLI not found on PATH')
    expect(llm.attributes[ATTR.inputTokens]).toBeUndefined()
    // The failure path closes the span in a catch AND in a finally. Closing twice
    // would duplicate the run in every count that reads this file.
    expect(spans.filter((span) => span.kind === 'LLM')).toHaveLength(1)

    // A request that never ran has no tokens to report, and the validator says so
    // as a warning rather than inventing zeros — the trace stays usable.
    const validation = validateTraceSpans(spans)
    expect(validation.ok).toBe(true)
    expect(validation.findings.map((finding) => finding.code)).toEqual(['no-usage'])
    expect(capability(validation.capabilities, 'token-accounting')).toMatchObject({ available: false })
  })

  it('records a request refused at admission', async () => {
    const admission = new AdmissionGate({ maxActive: 1, maxQueue: 0, queueTimeoutMs: 0 })
    const lease = await admission.acquire()
    const ctx = fixture(new SilentBackend(), { admission })
    try {
      const response = await postChat(ctx.app, chatBody())
      expect(response.status).toBe(503)
      const llm = requestSpan(ctx.spans())
      expect(llm.status.code).toBe('STATUS_CODE_ERROR')
    } finally {
      lease.release()
    }
  })

  it('emits exactly one span per run, not one per reader', async () => {
    const backend = new ToolUsingBackend()
    const ctx = fixture(backend)
    const body = chatBody({ run_id: 'shared-run' })
    await Promise.all([postChat(ctx.app, body), postChat(ctx.app, body)])
    await postChat(ctx.app, body)

    // Three HTTP requests, one durable run: the reattaching readers replayed the
    // same job, so counting spans per reader would triple every token total.
    expect(backend.calls).toBe(1)
    expect(ctx.spans().filter((span) => span.kind === 'LLM')).toHaveLength(1)
  })

  it('caps TOOL spans per request while still reporting how many calls happened', async () => {
    const ctx = fixture(new ManyToolsBackend(50), { maxToolSpans: 5 })
    expect((await postChat(ctx.app, chatBody())).status).toBe(200)

    const spans = ctx.spans()
    expect(spans.filter((span) => span.kind === 'TOOL')).toHaveLength(5)
    expect(requestSpan(spans).attributes).toMatchObject({
      [BRIDGE_ATTR.toolCallsObserved]: 50,
      [BRIDGE_ATTR.toolCallsDropped]: 45,
    })
  })

  it('emits the same span for a streaming request', async () => {
    const ctx = fixture(new ToolUsingBackend())
    const response = await postChat(ctx.app, chatBody({ stream: true }))
    expect(response.status).toBe(200)
    await response.text()

    const spans = ctx.spans()
    expect(requestSpan(spans).attributes).toMatchObject({
      [BRIDGE_ATTR.finishReason]: 'tool_calls',
      [ATTR.inputTokens]: 1200,
    })
    expect(spans.filter((span) => span.kind === 'TOOL')).toHaveLength(2)
  })

  it('never lets a malformed delta escape as a request failure', async () => {
    const ctx = fixture(new HostileDeltaBackend())
    const response = await postChat(ctx.app, chatBody({ model: `kimi-code/${'z'.repeat(400)}` }))
    expect(response.status).toBe(200)

    const spans = ctx.spans()
    const llm = requestSpan(spans)
    // NaN, negative and infinite usage are producer bugs. Each is omitted rather
    // than written, because a poisoned sum is unrecoverable and an absence is not.
    expect(llm.attributes[ATTR.inputTokens]).toBeUndefined()
    expect(llm.attributes[ATTR.outputTokens]).toBeUndefined()
    expect(llm.attributes[ATTR.costUsd]).toBeUndefined()
    expect(String(llm.attributes[ATTR.model])).toHaveLength(256)

    const tool = spans.find((span) => span.kind === 'TOOL')
    expect(tool?.attributes[ATTR.toolName]).toBeUndefined()
    expect(tool?.attributes[BRIDGE_ATTR.toolCallId]).toBeUndefined()
    expect(tool?.name).toBe('unnamed tool call')
    // Tool arguments never reach the file, however large they are.
    expect(statSync(ctx.file).size).toBeLessThan(2_000)

    const validation = validateTraceSpans(spans)
    expect(validation.ok).toBe(true)
    expect(capability(validation.capabilities, 'tool-usage')).toMatchObject({ available: false })
  })
})

describe('traceparent propagation', () => {
  it('nests the bridge span under the caller span from traceparent', async () => {
    const ctx = fixture(new ToolUsingBackend())
    await postChat(ctx.app, chatBody(), {
      traceparent: `00-${CALLER_TRACE_ID}-${CALLER_SPAN_ID}-01`,
    })

    const spans = ctx.spans()
    const llm = requestSpan(spans)
    expect(llm.trace_id).toBe(CALLER_TRACE_ID)
    expect(llm.parent_span_id).toBe(CALLER_SPAN_ID)
    expect(llm.attributes[BRIDGE_ATTR.correlation]).toBe('traceparent')
    for (const tool of spans.filter((span) => span.kind === 'TOOL')) {
      expect(tool.trace_id).toBe(CALLER_TRACE_ID)
    }

    // The bridge's file is a FRAGMENT: on its own the parent is absent. Those spans
    // still parse, so the fragment is a degraded trace rather than a rejected one —
    // the validator keeps it analysable and names the analyses the missing parent
    // costs. Merged with the caller's export — the whole point of correlating — the
    // tree attaches and validates clean.
    const alone = validateTraceSpans(spans)
    expect(alone.ok).toBe(true)
    const orphan = alone.findings.find((finding) => finding.code === 'orphan-parent')
    expect(orphan?.severity).toBe('warn')
    expect(orphan?.blocks).toEqual(['cost-attribution'])
    expect(capability(alone.capabilities, 'cost-attribution')).toMatchObject({ available: false })

    const callerSpan = contractSpan({
      traceId: CALLER_TRACE_ID,
      spanId: CALLER_SPAN_ID,
      name: 'vb round 1',
      kind: 'CHAIN',
      startTime: new Date(Date.parse(llm.start_time) - 10).toISOString(),
      endTime: new Date(Date.parse(llm.end_time) + 10).toISOString(),
    })
    const merged = validateTraceSpans([callerSpan, ...spans])
    expect(merged.findings).toEqual([])
    expect(merged.ok).toBe(true)
    expect(capability(merged.capabilities, 'cost-attribution')).toMatchObject({ available: true })
  })

  it('nests under the explicit x-trace-id / x-parent-span-id headers', async () => {
    const ctx = fixture(new SilentBackend())
    await postChat(ctx.app, chatBody(), {
      'x-trace-id': CALLER_TRACE_ID,
      'x-parent-span-id': CALLER_SPAN_ID,
    })

    const llm = requestSpan(ctx.spans())
    expect(llm.trace_id).toBe(CALLER_TRACE_ID)
    expect(llm.parent_span_id).toBe(CALLER_SPAN_ID)
    expect(llm.attributes[BRIDGE_ATTR.correlation]).toBe('headers')
  })

  it('joins the trace without a parent when only a trace id is supplied', async () => {
    const ctx = fixture(new SilentBackend())
    await postChat(ctx.app, chatBody(), { 'x-trace-id': CALLER_TRACE_ID })

    const llm = requestSpan(ctx.spans())
    expect(llm.trace_id).toBe(CALLER_TRACE_ID)
    expect(llm.parent_span_id).toBeNull()
    expect(validateTraceSpans(ctx.spans()).ok).toBe(true)
  })

  it('mints a fresh root trace when correlation is malformed, and says so on the span', async () => {
    const ctx = fixture(new SilentBackend())
    const response = await postChat(ctx.app, chatBody(), { traceparent: 'totally-bogus' })
    expect(response.status).toBe(200)

    const llm = requestSpan(ctx.spans())
    expect(llm.trace_id).toMatch(/^[0-9a-f]{32}$/u)
    expect(llm.trace_id).not.toBe(CALLER_TRACE_ID)
    expect(llm.parent_span_id).toBeNull()
    expect(llm.attributes[BRIDGE_ATTR.correlation]).toBe('invalid')
  })

  /**
   * The joint case this whole design exists for.
   *
   * VerticalBench names its work in HUMAN ids — `oc-glm52@generic-…-r0` — which a
   * `traceparent` cannot carry, so VB derives the wire ids from them with the
   * contract's `deriveHexId` and keeps the readable name as an attribute. Two
   * processes that never talk therefore mint the same ids for the same unit of
   * work. These tests pin the receiving half: whatever that shared derivation
   * produces, the bridge accepts and nests under. If the derivation ever changed
   * shape — a different width, uppercase, a non-hex encoding — this file goes red
   * here, in the consumer, instead of quietly splitting every VB run into two
   * unrelated traces that nobody notices until they need the trace.
   */
  describe('VerticalBench ids hashed into the OTLP id space', () => {
    const VB_RUN = 'oc-glm52@generic-fhenix-sealed-bid-auction-r0'
    const VB_CELL = `${VB_RUN}::fhenix-sealed-bid-auction.leaf`

    it('accepts every id the shared derivation produces', () => {
      const inputs = [
        VB_RUN,
        VB_CELL,
        `${VB_CELL}::shot-2`,
        'oc-kimi@web-grounded-ai-sdk-renames-r11::shot-1',
        // The derivation has to be total: VB ids come from vertical files that
        // an author types, so an empty, unicode or very long id is a real input,
        // and each still has to land inside the hex space the bridge parses.
        '',
        'vertical/日本語-leaf::r0',
        'x'.repeat(4096),
      ]
      for (const input of inputs) {
        const traceId = deriveHexId(input, 16)
        const spanId = deriveHexId(input, 8)
        expect(normalizeTraceId(traceId)).toBe(traceId)
        expect(normalizeSpanId(spanId)).toBe(spanId)
        expect(parseTraceparent(`00-${traceId}-${spanId}-01`)).toEqual({
          traceId,
          parentSpanId: spanId,
        })
      }
    })

    it('joins a VB round and the bridge request it caused into one tree', async () => {
      const traceId = deriveHexId(VB_RUN, 16)
      const runSpanId = deriveHexId(`${VB_RUN}::run`, 8)
      const cellSpanId = deriveHexId(VB_CELL, 8)
      const traceparent = `00-${traceId}-${cellSpanId}-01`

      expect(resolveCallerTrace({ traceparent })).toEqual({
        caller: { traceId, parentSpanId: cellSpanId },
        correlation: 'traceparent',
      })

      const ctx = fixture(new ToolUsingBackend())
      await postChat(ctx.app, chatBody(), { traceparent })

      const bridgeSpans = ctx.spans()
      const llm = requestSpan(bridgeSpans)
      expect(llm.trace_id).toBe(traceId)
      expect(llm.parent_span_id).toBe(cellSpanId)
      expect(llm.attributes[BRIDGE_ATTR.correlation]).toBe('traceparent')
      for (const tool of bridgeSpans.filter((span) => span.kind === 'TOOL')) {
        expect(tool.trace_id).toBe(traceId)
      }

      const start = new Date(Date.parse(llm.start_time) - 10).toISOString()
      const end = new Date(Date.parse(llm.end_time) + 10).toISOString()
      // VB's half: the readable id is not lost, it moves to an attribute.
      const vbRun = contractSpan({
        traceId,
        spanId: runSpanId,
        name: VB_RUN,
        kind: 'CHAIN',
        startTime: start,
        endTime: end,
        attributes: { 'vb.run.id': VB_RUN },
      })
      const vbCell = contractSpan({
        traceId,
        spanId: cellSpanId,
        parentSpanId: runSpanId,
        name: VB_CELL,
        kind: 'CHAIN',
        startTime: start,
        endTime: end,
        attributes: { 'vb.cell.id': VB_CELL },
      })

      const merged = validateTraceSpans([vbRun, vbCell, ...bridgeSpans])
      expect(merged.findings).toEqual([])
      expect(merged.ok).toBe(true)
      expect(capability(merged.capabilities, 'cost-attribution')).toMatchObject({ available: true })
    })

    it('still joins when a multi-shot cell re-declares its ancestors per shot', async () => {
      // Every shot file carries the run and cell spans again, so a concatenated
      // VB export legitimately repeats them. Identical copies describe the same
      // work once; they must not read as a broken tree, and must not double the
      // tokens the bridge reported.
      const traceId = deriveHexId(VB_RUN, 16)
      const runSpanId = deriveHexId(`${VB_RUN}::run`, 8)
      const cellSpanId = deriveHexId(VB_CELL, 8)

      const ctx = fixture(new ToolUsingBackend())
      await postChat(ctx.app, chatBody(), { traceparent: `00-${traceId}-${cellSpanId}-01` })
      const bridgeSpans = ctx.spans()
      const llm = requestSpan(bridgeSpans)

      const start = new Date(Date.parse(llm.start_time) - 10).toISOString()
      const end = new Date(Date.parse(llm.end_time) + 10).toISOString()
      const ancestors = [
        contractSpan({
          traceId, spanId: runSpanId, name: VB_RUN, kind: 'CHAIN',
          startTime: start, endTime: end, attributes: { 'vb.run.id': VB_RUN },
        }),
        contractSpan({
          traceId, spanId: cellSpanId, parentSpanId: runSpanId, name: VB_CELL, kind: 'CHAIN',
          startTime: start, endTime: end, attributes: { 'vb.cell.id': VB_CELL },
        }),
      ]

      const merged = validateTraceSpans([...ancestors, ...ancestors, ...bridgeSpans])
      expect(merged.ok).toBe(true)
      expect(capability(merged.capabilities, 'cost-attribution')).toMatchObject({ available: true })
      expect(merged.findings.filter((finding) => finding.severity === 'error')).toEqual([])
    })

    it('reports a VB id that was sent RAW instead of derived, and still serves the request', async () => {
      // The failure mode the derivation exists to prevent. If VB regresses to
      // sending its human id on the wire, the bridge must not silently invent a
      // join: the request succeeds, the span roots itself, and the correlation
      // attribute says `invalid` so the break is readable off the trace.
      const ctx = fixture(new SilentBackend())
      const response = await postChat(ctx.app, chatBody(), { 'x-trace-id': VB_RUN })
      expect(response.status).toBe(200)

      const llm = requestSpan(ctx.spans())
      expect(llm.trace_id).toMatch(/^[0-9a-f]{32}$/u)
      expect(llm.parent_span_id).toBeNull()
      expect(llm.attributes[BRIDGE_ATTR.correlation]).toBe('invalid')
    })
  })

  it('gives concurrent requests distinct trace and span ids', async () => {
    const ctx = fixture(new SilentBackend())
    await Promise.all([
      postChat(ctx.app, chatBody({ run_id: 'a' })),
      postChat(ctx.app, chatBody({ run_id: 'b' })),
      postChat(ctx.app, chatBody({ run_id: 'c' })),
    ])

    const spans = ctx.spans()
    expect(new Set(spans.map((span) => span.trace_id)).size).toBe(3)
    expect(new Set(spans.map((span) => span.span_id)).size).toBe(3)
    expect(validateTraceSpans(spans).ok).toBe(true)
  })
})

describe('RequestSpanRecorder', () => {
  function recorder(sink: SpanSink) {
    return new TraceEmitter({ sink, maxToolSpans: 8, log: () => {} }).beginRequest({
      runId: 'r1',
      model: 'kimi-code/kimi-k2',
      backend: 'kimi-code',
      caller: resolveCallerTrace({}),
    })
  }

  it('closes exactly once however many times it is closed', () => {
    const written: ContractSpan[][] = []
    const rec = recorder({ write: (spans) => { written.push([...spans]) } })
    rec.observe({ finish_reason: 'stop', usage: { input_tokens: 3, output_tokens: 4 } })
    rec.fail(new Error('first'))
    rec.fail(new Error('second'))
    rec.end()
    rec.end()

    expect(written).toHaveLength(1)
    expect(written[0]?.[0]?.status).toEqual({ code: 'STATUS_CODE_ERROR', message: 'first' })
  })

  it('records a thrown non-Error, including undefined, as a failure', () => {
    const written: ContractSpan[][] = []
    const rec = recorder({ write: (spans) => { written.push([...spans]) } })
    rec.observe({ finish_reason: 'stop' })
    rec.fail(undefined)

    expect(written[0]?.[0]?.status.code).toBe('STATUS_CODE_ERROR')
  })

  it('leaves status UNSET when the stream ended without saying how', () => {
    const written: ContractSpan[][] = []
    const rec = recorder({ write: (spans) => { written.push([...spans]) } })
    rec.observe({ content: 'partial' })
    rec.end()

    expect(written[0]?.[0]?.status).toEqual({ code: 'STATUS_CODE_UNSET' })
  })

  it('ignores keepalive deltas so liveness pings never count as work', () => {
    const written: ContractSpan[][] = []
    const rec = recorder({ write: (spans) => { written.push([...spans]) } })
    rec.observe({ keepalive: { source: 'stdout-idle', elapsedMs: 5_000 } })
    rec.observe({ finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } })
    rec.end()

    expect(written[0]).toHaveLength(1)
    expect(written[0]?.[0]?.attributes[BRIDGE_ATTR.toolCallsObserved]).toBe(0)
  })

  it('replaces the running cost when a record declares itself the total', () => {
    const written: ContractSpan[][] = []
    const rec = recorder({ write: (spans) => { written.push([...spans]) } })
    rec.observe({ usage: { input_tokens: 5, output_tokens: 5, cost: 0.01 } })
    rec.observe({ finish_reason: 'stop', usage: { cost: 0.04, cost_scope: 'total' } })
    rec.end()

    expect(written[0]?.[0]?.attributes).toMatchObject({
      [ATTR.costUsd]: 0.04,
      [ATTR.inputTokens]: 5,
      [ATTR.outputTokens]: 5,
    })
  })
})

describe('a failing sink never fails a request', () => {
  it('serves the completion when the sink throws', async () => {
    const ctx = fixture(new ToolUsingBackend(), {
      sink: { write() { throw new Error('sink exploded') } },
    })
    const response = await postChat(ctx.app, chatBody())

    expect(response.status).toBe(200)
    const body = await response.json() as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toBe('looking at the repo')
    expect(ctx.logs.join('\n')).toContain('sink exploded')
  })

  it('serves the completion when the trace path cannot be created', async () => {
    const dir = tempDir('cli-bridge-trace-blocked-')
    const blocker = join(dir, 'blocked')
    writeFileSync(blocker, 'not a directory')
    const logs: string[] = []
    const ctx = fixture(new SilentBackend(), {
      sink: new JsonlSpanSink({
        // `blocked` is a regular file, so creating `blocked/traces` fails ENOTDIR.
        file: join(blocker, 'traces', 'spans.jsonl'),
        maxBytes: 1024,
        maxFiles: 2,
        log: (message) => logs.push(message),
      }),
    })

    expect((await postChat(ctx.app, chatBody())).status).toBe(200)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('trace sink write failed')

    // Repeated failures log once, so a broken sink cannot bury the bridge's output.
    expect((await postChat(ctx.app, chatBody({ run_id: 'second' }))).status).toBe(200)
    expect(logs).toHaveLength(1)
  })
})

describe('JsonlSpanSink retention', () => {
  const span = (id: string): ContractSpan => contractSpan({
    traceId: 'a'.repeat(32),
    spanId: id,
    name: 'x'.repeat(400),
    kind: 'LLM',
    startTime: '2026-01-01T00:00:00.000Z',
  })

  it('rotates generations and bounds total bytes on disk', () => {
    const dir = tempDir('cli-bridge-trace-rotate-')
    const file = join(dir, 'spans.jsonl')
    const sink = new JsonlSpanSink({ file, maxBytes: 1024, maxFiles: 3 })

    for (let i = 0; i < 60; i++) sink.write([span(i.toString(16).padStart(16, '0'))])

    expect(statSync(file).size).toBeLessThanOrEqual(1024)
    expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(1024)
    expect(statSync(`${file}.2`).size).toBeLessThanOrEqual(1024)
    // maxFiles=3 retains exactly three generations, so a long-lived bridge's
    // trace footprint stops growing instead of filling the disk.
    expect(() => statSync(`${file}.3`)).toThrow()
    expect(readSpans(file).length).toBeGreaterThan(0)
  })

  it('keeps only the active file when one generation is configured', () => {
    const dir = tempDir('cli-bridge-trace-single-')
    const file = join(dir, 'spans.jsonl')
    const sink = new JsonlSpanSink({ file, maxBytes: 700, maxFiles: 1 })

    for (let i = 0; i < 10; i++) sink.write([span(i.toString(16).padStart(16, '0'))])

    expect(statSync(file).size).toBeLessThanOrEqual(700)
    expect(() => statSync(`${file}.1`)).toThrow()
  })

  it('writes nothing for an empty span list', () => {
    const dir = tempDir('cli-bridge-trace-empty-')
    const file = join(dir, 'spans.jsonl')
    new JsonlSpanSink({ file, maxBytes: 1024, maxFiles: 2 }).write([])
    expect(() => statSync(file)).toThrow()
  })
})

describe('trace configuration', () => {
  it('defaults to on, under BRIDGE_DATA_DIR', () => {
    const dir = tempDir('cli-bridge-trace-cfg-')
    const config = loadConfig({ BRIDGE_DATA_DIR: dir })
    expect(config.trace).toEqual({
      enabled: true,
      file: join(dir, 'traces', 'spans.jsonl'),
      maxBytes: 16 * 1024 * 1024,
      maxFiles: 2,
      maxToolSpans: 512,
    })
  })

  it('bounds the unconfigured on-disk trace footprint at 32 MiB', () => {
    // Tracing is on by default, so this product is what an operator who never
    // touched the settings silently pays on a long-lived bridge. Pinned so a
    // future default bump has to be a deliberate edit to this number.
    const config = loadConfig({ BRIDGE_DATA_DIR: tempDir('cli-bridge-trace-cap-') })
    expect(config.trace.maxBytes * config.trace.maxFiles).toBe(32 * 1024 * 1024)
  })

  it('honours explicit overrides', () => {
    const dir = tempDir('cli-bridge-trace-cfg-')
    const config = loadConfig({
      BRIDGE_DATA_DIR: dir,
      BRIDGE_TRACE: 'off',
      BRIDGE_TRACE_FILE: join(dir, 'custom.jsonl'),
      BRIDGE_TRACE_MAX_BYTES: '2048',
      BRIDGE_TRACE_MAX_FILES: '5',
      BRIDGE_TRACE_MAX_TOOL_SPANS: '0',
    })
    expect(config.trace).toEqual({
      enabled: false,
      file: join(dir, 'custom.jsonl'),
      maxBytes: 2048,
      maxFiles: 5,
      maxToolSpans: 0,
    })
  })

  it('refuses a value it cannot interpret rather than guessing', () => {
    expect(() => loadConfig({ BRIDGE_TRACE: 'maybe' })).toThrow(/invalid BRIDGE_TRACE/u)
    expect(() => loadConfig({ BRIDGE_TRACE_MAX_FILES: '0' })).toThrow()
  })
})

/**
 * WHICH BUILD of the contract this suite ran against.
 *
 * Two builds of `@tangle-network/agent-trace-contract` declare version `1.0.2`
 * and behave differently, so every assertion in this file is worth exactly as
 * much as the build it ran on and a version comparison establishes nothing.
 * These cases pin the build three ways: the symbol `MAX_SPANS_READ` and the
 * bound it names, the `truncated-input` finding an oversized export must raise,
 * and byte-for-byte identity with the one build the repo's own pnpm-lock.yaml
 * pins — an allowlist derived from the lockfile, so ANY other tree fails, not
 * just one remembered bad one.
 */
describe('the installed contract build is the one with the bounded read', () => {
  // Read off the namespace, not as a named import: a named import of a symbol a
  // build lacks fails at link time and takes the whole FILE down before any
  // assertion runs, which reports as "cannot load" instead of "wrong build".
  const declaredBound: unknown = traceContract.MAX_SPANS_READ

  it('exports MAX_SPANS_READ, and it is the expected bound', () => {
    expect(
      typeof declaredBound,
      'the installed build does not export MAX_SPANS_READ, so it reads an export in full however large its length claims to be',
    ).toBe('number')
    expect(declaredBound).toBe(EXPECTED_MAX_SPANS_READ)
  })

  it('reports truncated-input when an export declares more entries than are read', () => {
    // Falls back to the pinned bound rather than deriving the probe size from
    // the module under test: a build with no bound would otherwise choose the
    // probe that lets it pass.
    const probeLength =
      (typeof declaredBound === 'number' && Number.isSafeInteger(declaredBound)
        ? declaredBound
        : EXPECTED_MAX_SPANS_READ) + 1
    // Sparse on purpose — `length` is a number a producer wrote, and the bound
    // exists so that number cannot decide how long this call runs.
    const oversized = new Array(probeLength)
    oversized[0] = { span_id: 'a'.repeat(16), name: 'probe' }
    const codes = validateTraceSpans(oversized as unknown as ContractSpan[]).findings.map(
      (entry) => entry.code,
    )
    expect(
      codes,
      `an export declaring ${probeLength} entries produced no truncated-input finding, so this build reads the whole declared length`,
    ).toContain('truncated-input')
  })

  it('is byte-identical to the build the lockfile pins', { timeout: 30_000 }, async () => {
    const provenance = await verifyInstalledTraceContract()
    expect(provenance.integrity).toMatch(/^sha512-/)
    expect(
      { missing: provenance.missing, extra: provenance.extra, mismatched: provenance.mismatched },
      `the installed tree at ${provenance.packageDir} is not the ${provenance.version} build pinned by pnpm-lock.yaml (${provenance.integrity})`,
    ).toEqual({ missing: [], extra: [], mismatched: [] })
    // The tree digest is what the emitter stamps; it must exist for the locked build.
    expect(traceContractBuildId()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('stamps that digest on the request span, so a trace records its own producer', () => {
    const written: ContractSpan[] = []
    const rec = new TraceEmitter({
      sink: { write: (spans) => { written.push(...spans) } },
      maxToolSpans: 8,
      log: () => {},
    }).beginRequest({
      runId: 'run-contract-build',
      model: 'kimi-code/kimi-k2',
      backend: 'kimi-code',
      caller: resolveCallerTrace({}),
    })
    rec.end()

    const requestSpan = written.find((span) => span.name.startsWith('chat '))
    expect(requestSpan?.attributes?.[BRIDGE_ATTR.traceContractBuild]).toBe(traceContractBuildId())
  })
})
