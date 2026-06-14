/**
 * Generic ACP (Agent Client Protocol) backend — drives any agent that exposes an
 * `<bin> acp` stdio server: hermes, openclaw, and future ACP agents. cli-bridge had
 * no ACP client; the existing backends spawn a CLI and parse stdout, but ACP agents
 * speak JSON-RPC 2.0 over ndjson stdio with a stateful session.
 *
 * Wire flow (verified live against `hermes acp`, protocol v1):
 *   spawn `<bin> acp`  (cwd = req.cwd, so the agent discovers workspace skills/context)
 *   → initialize {protocolVersion, clientCapabilities}
 *   → session/new {cwd, mcpServers}            → { sessionId }
 *   → session/prompt {sessionId, prompt:[{type:'text',text}]}
 *   ← stream session/update {update:{content:{type:'text',text}}}  → ChatDelta.content
 *   ← session/request_permission               → auto-allow (first option)
 *   ← session/prompt result {stopReason}        → finish_reason
 *
 * One bin per backend instance (hermes→`hermes acp`, openclaw→`openclaw acp`).
 */

import type { Backend, BackendHealth, ChatDelta, ChatMessage, ChatRequest } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import type { Spawner } from '../executors/types.js'
import { scopedHostSpawner } from '../executors/scoped-host.js'
import { killTree } from '../executors/process-tree.js'
import { contentToText } from './content.js'
import { resolvePromptMessages } from './profile-support.js'

export interface AcpBackendOptions {
  /** Registry/backend name + model-id prefix, e.g. 'hermes'. */
  name: string
  /** Binary to spawn, e.g. 'hermes'. */
  bin: string
  /** Subcommand args that start the ACP server. Default ['acp']. */
  acpArgs?: string[]
  /** Per-request wall cap (ms). */
  timeoutMs: number
  /** Subprocess spawner; defaults to the scoped host spawner. */
  spawner?: Spawner
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

/** ACP stopReason → OpenAI finish_reason. */
function mapStopReason(reason: unknown): ChatDelta['finish_reason'] {
  switch (reason) {
    case 'max_tokens': return 'length'
    case 'cancelled': return 'stop'
    case 'refusal': return 'stop'
    default: return 'stop' // end_turn, max_turn_requests, unknown
  }
}

/** Render the (profile-preamble-prefixed) conversation into a single prompt string. */
function renderPrompt(messages: ChatMessage[]): string {
  if (messages.length === 1) return contentToText(messages[0]?.content ?? '')
  return messages
    .map((m) => (m.role === 'user' ? contentToText(m.content) : `[${m.role}] ${contentToText(m.content)}`))
    .join('\n\n')
}

export class AcpBackend implements Backend {
  readonly name: string
  private readonly bin: string
  private readonly acpArgs: string[]
  private readonly timeoutMs: number
  private readonly spawner: Spawner

  constructor(opts: AcpBackendOptions) {
    this.name = opts.name
    this.bin = opts.bin
    this.acpArgs = opts.acpArgs ?? ['acp']
    this.timeoutMs = opts.timeoutMs
    this.spawner = opts.spawner ?? scopedHostSpawner
  }

  matches(model: string): boolean {
    return model === this.name || model.startsWith(`${this.name}/`)
  }

  async health(): Promise<BackendHealth> {
    let release: (() => void) | null = null
    try {
      const spawned = await this.spawner(this.bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      release = spawned.release
      const child = spawned.child
      const early = spawned.spawnError?.()
      if (early) return { name: this.name, state: 'unavailable', detail: `spawn failed: ${early.message}` }
      let out = ''
      child.stdout?.on('data', (b) => { out += b.toString() })
      child.stderr?.on('data', (b) => { out += b.toString() })
      const code = await new Promise<number>((resolve) => {
        const t = setTimeout(() => { void killTree(child); resolve(124) }, 5000)
        child.on('exit', (c) => { clearTimeout(t); resolve(c ?? 0) })
        child.on('error', () => { clearTimeout(t); resolve(1) })
      })
      if (code !== 0 && !out.trim()) return { name: this.name, state: 'error', detail: `${this.bin} --version exit ${code}` }
      return { name: this.name, state: 'ready', version: out.split('\n')[0]?.trim() || this.bin }
    } catch (err) {
      return { name: this.name, state: 'error', detail: `health probe failed: ${(err as Error).message}` }
    } finally {
      release?.()
    }
  }

  async *chat(req: ChatRequest, session: SessionRecord | null, signal: AbortSignal): AsyncIterable<ChatDelta> {
    const cwd = req.cwd ?? session?.cwd ?? process.cwd()
    const promptText = renderPrompt(resolvePromptMessages(req, session))

    const spawned = await this.spawner(this.bin, this.acpArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: process.env,
      ...(req.session_id ? { sessionId: req.session_id } : {}),
    })
    const child = spawned.child
    const release = spawned.release
    let spawnErrorMessage = spawned.spawnError?.()?.message ?? ''
    child.on('error', (err) => { spawnErrorMessage = err.message })

    const timeoutHandle = setTimeout(() => { void killTree(child) }, this.timeoutMs)
    const onAbort = (): void => { void killTree(child) }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      if (spawnErrorMessage) throw new BackendError(`${this.name} acp spawn failed: ${spawnErrorMessage}`, 'upstream')
      if (!child.stdin || !child.stdout) throw new BackendError(`${this.name} acp subprocess has no stdio pipes`, 'upstream')
      const stdin = child.stdin
      const stdout = child.stdout

      // ── ndjson JSON-RPC client over the child's stdio ──
      let nextId = 1
      const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
      const queue: ChatDelta[] = []
      let wake: (() => void) | null = null
      let streamEnded = false
      let driverError: Error | null = null
      const push = (d: ChatDelta): void => { queue.push(d); wake?.() }
      const send = (msg: JsonRpcMessage): void => { stdin.write(JSON.stringify(msg) + '\n') }
      const request = (method: string, params: unknown): Promise<unknown> =>
        new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); send({ jsonrpc: '2.0', id, method, params }) })

      let buf = ''
      stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          let m: JsonRpcMessage
          try { m = JSON.parse(line) } catch { continue } // hermes also logs to stderr; ignore non-JSON
          if (m.id !== undefined && pending.has(m.id as number)) {
            const p = pending.get(m.id as number)!
            pending.delete(m.id as number)
            if (m.error) p.reject(new BackendError(`${this.name} acp error: ${JSON.stringify(m.error).slice(0, 160)}`, 'upstream'))
            else p.resolve(m.result)
          } else if (m.method === 'session/update') {
            const update = (m.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } })?.update
            const kind = update?.sessionUpdate
            const c = update?.content
            // Emit the agent's MESSAGE text as content; skip thought/plan/tool chunks
            // so reasoning never pollutes the OpenAI content stream. `undefined` kind
            // (older agents that only send content) is treated as a message chunk.
            if (c?.type === 'text' && c.text && (kind === undefined || kind === 'agent_message_chunk')) {
              push({ content: c.text })
            }
          } else if (m.method === 'session/request_permission' && m.id !== undefined) {
            // auto-allow: pick the first offered option (cli-bridge runs in a trusted scope).
            const opts = (m.params as { options?: Array<{ optionId?: string }> })?.options
            const optionId = opts?.[0]?.optionId ?? 'allow'
            send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId } } })
          } else if (m.method && m.id !== undefined) {
            // any other agent→client request (fs reads we declined in capabilities, etc.): refuse cleanly.
            send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not supported by cli-bridge ACP client' } })
          }
        }
      })
      stdout.on('end', () => { streamEnded = true; wake?.() })

      // Drive the protocol; deltas flow through `queue` as session/update arrives.
      const driver = (async () => {
        await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } })
        const sess = (await request('session/new', { cwd, mcpServers: [] })) as { sessionId?: string }
        const sessionId = sess?.sessionId
        if (sessionId) push({ internal_session_id: sessionId })
        const result = (await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: promptText }] })) as { stopReason?: unknown }
        push({ finish_reason: mapStopReason(result?.stopReason) })
      })()
      driver.catch((e: Error) => { driverError = e instanceof BackendError ? e : new BackendError(`${this.name} acp: ${e.message}`, 'upstream') })

      // Yield deltas as they arrive; finish_reason ends the turn.
      while (true) {
        while (queue.length) {
          const d = queue.shift()!
          yield d
          if (d.finish_reason) return
        }
        if (driverError) throw driverError
        if (streamEnded) {
          yield { finish_reason: 'error' }
          throw new BackendError(`${this.name} acp stream ended before session/prompt completed`, 'upstream')
        }
        await new Promise<void>((resolve) => { wake = () => { wake = null; resolve() } })
      }
    } finally {
      clearTimeout(timeoutHandle)
      signal.removeEventListener('abort', onAbort)
      void killTree(child)
      release()
    }
  }
}
