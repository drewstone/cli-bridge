/**
 * Caller-executed tools: a chat-completions request that carries OpenAI `tools` runs one harness turn with those tools as MCP
 * tools this Bridge serves. When the harness calls one, the Bridge does not execute it: it parks the MCP call and answers the
 * caller's pending request with that call (`finish_reason: "tool_calls"`). The caller executes it and sends its next request
 * with the tool result; the Bridge matches the `tool_call_id`, resolves the parked call, and the same harness turn goes on until
 * it ends and the caller gets the final text. One harness turn spans several caller requests.
 *
 * The MCP endpoint is `/caller-tools/<token>` on this Bridge's own listener; the unguessable token is the credential, as with
 * Hub grants, and every output filter removes it. The harness keeps its own native tools: this measures the agent with its own
 * loop, calling the caller's tools where it chooses to.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { AgentProfileMcpServer } from '@tangle-network/agent-interface'
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { ChatDelta, ChatRequest } from './backends/types.js'
import { protectExecutionValues } from './private-mcp.js'
import type { Run } from './runs/run.js'

/** One OpenAI function tool, as the caller declared it. */
export interface CallerTool {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

interface ParkedCall {
  id: string
  name: string
  arguments: string
  resolve(result: { content: string; isError: boolean }): void
}

/** The request option: OpenAI function tools the CALLER executes; the route reads it from `tools`. */
export const callerToolsRequestSchema = z.array(z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
}))

/** How long a parked call waits for the caller's next request before the harness sees a tool error. */
export const CALLER_TOOL_TIMEOUT_MS = 10 * 60_000
/**
 * How long the Bridge waits for the caller's next request after answering with tool calls. A caller that stops mid-turn
 * (a benchmark runner at its step limit) never sends one, and the harness, handed a tool error, would park again and hold
 * its executor slot indefinitely; past this the caller has gone and the turn is cancelled. `BRIDGE_CALLER_TOOLS_IDLE_MS`
 * overrides it.
 */
export const CALLER_IDLE_TIMEOUT_MS = 5 * 60_000
const callerIdleMs = () => Number(process.env.BRIDGE_CALLER_TOOLS_IDLE_MS) || CALLER_IDLE_TIMEOUT_MS
/** The MCP server name the harness sees; Claude Code shows the tools as `mcp__caller__<name>`. */
export const CALLER_TOOLS_SERVER = 'caller'

export class CallerToolsTurn {
  readonly token = randomBytes(24).toString('base64url')
  runId: string | undefined
  /** The run's last sequence already answered to the caller; the next reader starts after it. */
  resumeSeq = 0
  settled = false
  private readonly unanswered = new Map<string, ParkedCall>()
  private reported: ParkedCall[] = []
  private parkWaiters: Array<() => void> = []
  private idle: ReturnType<typeof setTimeout> | undefined

  constructor(readonly tools: readonly CallerTool[]) {}

  /** The caller now holds tool calls: if its next request does not come in time, `gone` runs. */
  awaitCaller(gone: () => void): void {
    clearTimeout(this.idle)
    this.idle = setTimeout(gone, callerIdleMs())
    this.idle.unref?.()
  }

  /** The harness called a caller tool: hold it until the caller answers. */
  park(name: string, args: unknown): Promise<{ content: string; isError: boolean }> {
    return new Promise((resolve) => {
      const call: ParkedCall = { id: `call_${randomUUID().replace(/-/g, '')}`, name, arguments: JSON.stringify(args ?? {}), resolve }
      this.unanswered.set(call.id, call)
      this.reported.push(call)
      for (const wake of this.parkWaiters.splice(0)) wake()
    })
  }

  /** Resolves once at least one parked call has not been reported to the caller yet. */
  nextPark(): Promise<void> {
    if (this.reported.length) return Promise.resolve()
    return new Promise((resolve) => this.parkWaiters.push(resolve))
  }

  /** The parked calls the caller has not seen yet, in the order the harness made them. */
  takeReported(): Array<{ id: string; name: string; arguments: string }> {
    return this.reported.splice(0).map(({ id, name, arguments: args }) => ({ id, name, arguments: args }))
  }

  owns(toolCallId: string): boolean {
    return this.unanswered.has(toolCallId)
  }

  answer(toolCallId: string, content: string): boolean {
    const call = this.unanswered.get(toolCallId)
    if (!call) return false
    clearTimeout(this.idle)
    this.unanswered.delete(toolCallId)
    call.resolve({ content, isError: false })
    return true
  }

  /** The harness turn ended or the caller went away: release every call still parked. */
  settle(reason: string): void {
    this.settled = true
    clearTimeout(this.idle)
    for (const call of this.unanswered.values()) call.resolve({ content: reason, isError: true })
    this.unanswered.clear()
    this.reported = []
    for (const wake of this.parkWaiters.splice(0)) wake()
  }
}

type ToolMessage = { role: string; content?: unknown; tool_call_id?: string }

export function mountCallerTools(app: Hono) {
  const turns = new Map<string, CallerToolsTurn>()
  let listener: string | undefined

  // Streamable HTTP without a server-initiated stream: GET is not offered.
  app.get('/caller-tools/:token', (c) => c.body(null, 405))
  app.post('/caller-tools/:token', async (c) => {
    const turn = turns.get(c.req.param('token'))
    if (!turn || turn.settled) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unknown caller-tools turn' } }, 404)
    let message: { id?: unknown; method?: unknown; params?: Record<string, unknown> }
    try { message = await c.req.json() } catch { return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400) }
    const id = message.id ?? null
    const reply = (result: unknown) => c.json({ jsonrpc: '2.0', id, result })
    if (message.id === undefined) return c.body(null, 202) // a notification, such as notifications/initialized
    switch (message.method) {
      case 'initialize':
        return reply({
          protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'cli-bridge-caller-tools', version: '1.0.0' },
        })
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: turn.tools.map((tool) => ({
          name: tool.name, ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.parameters ?? { type: 'object', properties: {} },
        })) })
      case 'tools/call': {
        const name = message.params?.name
        if (typeof name !== 'string' || !turn.tools.some((tool) => tool.name === name)) {
          return c.json({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${String(name)}` } })
        }
        const result = await turn.park(name, message.params?.arguments)
        return reply({ content: [{ type: 'text', text: result.content }], isError: result.isError })
      }
      default:
        return c.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(message.method)}` } })
    }
  })

  return {
    bindListener(url: string) { listener = new URL(url).origin },
    get listener() { return listener },

    /** A new harness turn: the request's runtime MCP gains the caller-tools server; returns the turn and its release. */
    open(req: ChatRequest, tools: readonly CallerTool[]): { turn: CallerToolsTurn; release: () => void } {
      if (!listener) throw new Error('caller-executed tools need this Bridge\'s own HTTP listener')
      const turn = new CallerToolsTurn(tools)
      turns.set(turn.token, turn)
      const existing = req.runtime_attachments?.mcp ?? {}
      if (Object.hasOwn(existing, CALLER_TOOLS_SERVER)) throw new Error(`MCP alias ${CALLER_TOOLS_SERVER} collides with a runtime attachment`)
      // `timeout` is the per-server tool-call timeout every MCP materializer forwards (backends/profile-mcp.ts).
      const server = { transport: 'http', url: `${listener}/caller-tools/${turn.token}`, timeout: CALLER_TOOL_TIMEOUT_MS } as unknown as AgentProfileMcpServer
      req.runtime_attachments = { mcp: { ...existing, [CALLER_TOOLS_SERVER]: server } }
      const releaseProtected = protectExecutionValues(req, [turn.token])
      let released = false
      const release = () => { if (released) return; released = true; try { releaseProtected() } finally { turns.delete(turn.token); turn.settle('the harness turn ended') } }
      // A request that returns before its run starts (a refusal, a conflict) leaves no run to release the turn.
      setTimeout(() => { if (!turn.runId) release() }, 60_000).unref?.()
      return { turn, release }
    },

    /** A request whose tool messages answer parked calls: resolve them and return their turn. */
    resume(messages: readonly ToolMessage[]): CallerToolsTurn | undefined {
      const answers = messages.filter((message) => message.role === 'tool' && typeof message.tool_call_id === 'string')
      for (const turn of turns.values()) {
        const mine = answers.filter((message) => turn.owns(message.tool_call_id!))
        if (!mine.length) continue
        for (const message of mine) turn.answer(message.tool_call_id!, toolText(message.content))
        return turn
      }
      return undefined
    },
  }
}

export type CallerTools = ReturnType<typeof mountCallerTools>

function toolText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : '').join('')
  return content === undefined || content === null ? '' : JSON.stringify(content)
}

/**
 * Read the run from the turn's resume point until the harness parks a caller tool call or the turn ends, and answer the caller
 * with the text produced so far plus the parked calls (`tool_calls`), or with the final text (`stop`).
 */
export async function respondCallerTurn(c: Context, run: Run, turn: CallerToolsTurn, req: Pick<ChatRequest, 'model' | 'stream'>): Promise<Response> {
  const iterator = run.attach(turn.resumeSeq)[Symbol.asyncIterator]()
  let text = ''
  let finalText: string | undefined
  let failure: string | undefined
  let lastSeq = turn.resumeSeq
  const consume = (item: { seq: number; delta: ChatDelta }) => {
    lastSeq = item.seq
    const { delta } = item
    if (typeof delta.content === 'string') text += delta.content
    if (typeof delta.final_text === 'string') finalText = delta.final_text
    if (delta.error?.message) failure = delta.error.message
  }
  let next = iterator.next()
  const parked = turn.nextPark().then(() => 'park' as const)
  for (;;) {
    const winner = await Promise.race([next.then((result) => ({ result })), parked])
    if (winner === 'park' && !turn.settled) {
      // Everything the harness emitted before it called the tool is already in the log.
      const target = run.snapshot().lastSeq
      while (lastSeq < target) {
        const result = await next
        if (result.done) break
        consume(result.value)
        next = iterator.next()
      }
      const calls = turn.takeReported()
      turn.resumeSeq = lastSeq
      turn.awaitCaller(() => { turn.settle('the caller did not answer its tool calls'); run.cancel() })
      void iterator.return?.(undefined as never)
      return answer(c, req, text, calls, 'tool_calls')
    }
    if (winner === 'park') continue
    if (winner.result.done) break
    consume(winner.result.value)
    next = iterator.next()
  }
  turn.settle('the harness turn ended')
  if (failure && !text && finalText === undefined) return c.json({ error: { message: failure, type: 'server_error' } }, 502)
  return answer(c, req, text || finalText || '', [], 'stop')
}

function answer(
  c: Context, req: Pick<ChatRequest, 'model' | 'stream'>, text: string,
  calls: Array<{ id: string; name: string; arguments: string }>, finishReason: 'tool_calls' | 'stop',
): Response {
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const toolCalls = calls.map((call) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.arguments } }))
  if (req.stream !== true) {
    return c.json({
      id, object: 'chat.completion', created, model: req.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finishReason }],
    })
  }
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: req.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const body = [
    chunk({ role: 'assistant', ...(text ? { content: text } : {}) }, null),
    ...(toolCalls.length ? [chunk({ tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }, null)] : []),
    chunk({}, finishReason),
    'data: [DONE]\n\n',
  ].join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
}

/** A new turn's hold on its run: bind it once the run exists, release it if the run never starts, answer from it. */
export interface CallerToolsGrant {
  turn: CallerToolsTurn
  bind(run: Run, job: Promise<unknown>): void
  release(): void
  respond(c: Context, run: Run): Promise<Response>
}

/**
 * The route's single entry. Without tools: undefined. Tool results that answer parked calls: the resumed turn's response.
 * Declared tools: a grant for a new turn whose MCP attachment is already on the request. A refusal is a Response.
 */
export async function admitCallerTools(
  c: Context, callerTools: CallerTools | undefined, req: ChatRequest,
  tools: z.infer<typeof callerToolsRequestSchema> | undefined, runs: { get(id: string): Run | undefined },
): Promise<Response | CallerToolsGrant | undefined> {
  if (!tools?.length) return undefined
  const refuse = (message: string, status: 400 | 409 = 400) => c.json({ error: { message, type: 'invalid_request_error' } }, status)
  if (!callerTools) return refuse('tools need this Bridge\'s caller-tools endpoint')
  if (req.toolChoice === 'none') return refuse('tools and tool_choice "none" cannot be combined')
  const resumed = callerTools.resume(req.messages as readonly ToolMessage[])
  if (resumed) {
    const run = resumed.runId ? runs.get(resumed.runId) : undefined
    return run ? respondCallerTurn(c, run, resumed, req) : refuse('the harness turn these tool results answer is no longer running', 409)
  }
  let opened: { turn: CallerToolsTurn; release: () => void }
  try { opened = callerTools.open(req, tools.map(({ function: tool }) => tool)) } catch (error) { return refuse(error instanceof Error ? error.message : String(error)) }
  const { turn, release } = opened
  return {
    turn, release,
    bind(run, job) { turn.runId = run.snapshot().id; void job.then(release, release) },
    respond: (context, run) => respondCallerTurn(context, run, turn, req),
  }
}
