/**
 * One Factory Droid session on Droid's streamed JSON-RPC mode (`droid exec --input-format stream-jsonrpc
 * --output-format stream-jsonrpc`): one process holds one Droid session across Bridge turns. Measured on
 * Droid 1.13.0 and 1.21.0 against the Router's scripted model, with no Factory login:
 *
 * - Every frame carries `jsonrpc`, `factoryApiVersion`, `factoryProtocolVersion` and `type`. A request has a
 *   string `id`, a `method` and `params` and is answered by `{ type: 'response', id, result | error }`; a
 *   numeric id or a missing field is refused (-32700). Droid stamps its own versions on every frame and
 *   accepts a request stamped with an earlier protocol version, so this client answers in Droid's versions
 *   once it has read one and starts with the earliest it was measured on.
 * - `droid.initialize_session { machineId, cwd, modelId, mcpServers }` creates a session and starts the MCP
 *   servers it lists. An unknown `modelId` is replaced by another model with a system notice ("... isn't
 *   available on this machine. Using <model> instead."), so a session whose settings name another model than
 *   the one asked for is refused. `droid.load_session { sessionId, mcpServers }` continues a stored session
 *   in a new process (-32004 when there is none); `droid.update_session_settings { modelId }` refuses an
 *   unknown model (-32602).
 * - A new session titles itself with a model call on its first message, which Droid counts in that turn's
 *   usage, unless it is already named: the Bridge names it (`droid.rename_session`) before the first turn.
 * - `droid.add_user_message { text }` is answered `{}` at once. The turn is reported in
 *   `droid.session_notification` frames and ends with `agent_turn_completed { reason, tokenUsage }`, whose
 *   counts are that turn's own; `reason` is `completed` on success. The user message's `create_message`
 *   carries the request's id as `requestId`.
 * - A message added while a turn runs is queued (`queued_messages_changed`, `queuePlacement: end_of_turn`)
 *   and applied after the running tool call, inside the same turn: its `create_message` follows the tool
 *   result, and the turn ends once.
 * - `droid.interrupt_session` ends the running turn (`reason: cancelled`) within two seconds.
 * - With `--skip-permissions-unsafe` Droid asks the client nothing. Its questions (`droid.request_permission`,
 *   `droid.ask_user`, `droid.pick_options`) would arrive as requests, which this client refuses.
 */

import {
  canonicalCandidateDigest,
  type AgentEnvironmentCapabilities,
  type NativeContextBoundaryProof,
} from '@tangle-network/agent-interface'
import type { McpServerSpec, NativeSession } from './types.js'
import { BackendError } from './types.js'
import { NativeChild } from './native-child.js'
import type { Spawner } from '../executors/types.js'

/** Bridge-made frame ending a turn; Droid never sends this type. */
export const DROID_TURN_SETTLED = 'cli-bridge.droid.turn_settled'
const FIRST_VERSIONS = { factoryApiVersion: '1.0.0', factoryProtocolVersion: '1.350.0' }
const INTERRUPT_GRACE_MS = 2_000
const CLOSE_GRACE_MS = 5_000
const MAX_LINE_CHARS = 8 * 1024 * 1024
const DROID_SESSION_ID = /^[\w.:-]{1,256}$/u

/** Droid's token counts for a turn, by its own names. */
export type DroidUsage = Partial<Record<typeof DROID_USAGE_KEYS[number], number>>
const DROID_USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'thinkingTokens'] as const

/** Droid's MCP server list for `initialize_session` and `load_session`: stdio env is a map, URL headers are pairs. */
export function droidMcpServers(specs: Record<string, McpServerSpec> | null): Array<Record<string, unknown>> {
  return Object.entries(specs ?? {}).flatMap(([name, spec]): Array<Record<string, unknown>> => {
    if (spec.enabled === false) return []
    if ((spec.type === 'http' || spec.type === 'sse') && spec.url) {
      return [{ type: spec.type, name, url: spec.url, headers: Object.entries(spec.headers ?? {}).map(([header, value]) => ({ name: header, value })) }]
    }
    return spec.command ? [{ type: 'stdio', name, command: spec.command, args: spec.args ?? [], ...(spec.env ? { env: spec.env } : {}) }] : []
  })
}

export interface DroidNativeSessionOptions {
  capabilities: AgentEnvironmentCapabilities
  cwd: string
  /** The model Droid's settings name (`custom:<id>` for a custom model), or null for Droid's own default. */
  modelId: string | null
  mcpServers: Array<Record<string, unknown>>
  /** A Droid session id to continue; null creates one. */
  resumeSessionId: string | null
  /** Bound on every request; a turn itself has none. */
  requestTimeoutMs: number
  cleanup: () => void | Promise<void>
}

interface Waiter<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
}

interface TurnState {
  /** Steers sent and not yet applied: request id to operation id. */
  steers: Map<string, string | undefined>
  /** Turns Droid ended within this Bridge turn: a steer Droid queued past its turn's end runs as a turn of its own. */
  ended: number
  usage: DroidUsage
  failure: string | null
  settled: boolean
  whenSettled: Promise<void>
  onSettled: () => void
}

export class DroidNativeSession implements NativeSession {
  readonly capabilities: AgentEnvironmentCapabilities
  private readonly life: NativeChild
  private buffer = ''
  private nextRequest = 1
  private versions = FIRST_VERSIONS
  private readonly requests = new Map<string, Waiter<unknown>>()
  private sessionId: string | null = null
  private turnState: TurnState | null = null
  private completedTurns = 0
  private readonly queue: Record<string, unknown>[] = []
  private readonly readers: Waiter<Record<string, unknown>>[] = []
  private abortInFlight: Promise<void> | null = null

  constructor(spawned: Awaited<ReturnType<Spawner>>, private readonly options: DroidNativeSessionOptions) {
    this.capabilities = options.capabilities
    this.life = new NativeChild(spawned, {
      names: { process: 'droid stream-jsonrpc', session: 'factory-droids native session' },
      onStdout: (chunk) => this.consume(chunk),
      onEnd: (error) => {
        for (const waiters of [this.readers.splice(0), [...this.requests.values()]]) for (const waiter of waiters) waiter.reject(error)
        this.requests.clear()
      },
      cleanup: options.cleanup,
    })
  }

  providerSessionId(): string | null { return this.sessionId }
  isClosed(): boolean { return this.life.closed }
  onClose(listener: (reason: Error) => void): () => void { return this.life.onClose(listener) }
  whenClosed(): Promise<void> { return this.life.whenClosed() }

  /** Continue the given session (load, then select the model asked for), or create and name one. */
  async start(signal?: AbortSignal): Promise<void> {
    const { cwd, modelId, mcpServers, resumeSessionId, requestTimeoutMs } = this.options
    if (resumeSessionId) {
      const loaded = record(await this.call('droid.load_session', { sessionId: resumeSessionId, mcpServers }, 'session load', requestTimeoutMs, signal))
      this.sessionId = resumeSessionId
      if (modelId && record(loaded?.settings)?.modelId !== modelId) {
        await this.call('droid.update_session_settings', { modelId }, 'model selection', requestTimeoutMs, signal)
      }
      return
    }
    const created = record(await this.call('droid.initialize_session', {
      machineId: 'cli-bridge', cwd, mcpServers, autonomyLevel: 'high', ...(modelId ? { modelId } : {}),
    }, 'session creation', requestTimeoutMs, signal))
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || !DROID_SESSION_ID.test(sessionId)) {
      throw new BackendError('droid created a session without a usable id', 'upstream')
    }
    this.sessionId = sessionId
    const selected = record(created?.settings)?.modelId
    if (modelId && selected !== modelId) {
      const notice = (Array.isArray(record(created?.session)?.messages) ? record(created?.session)?.messages as unknown[] : [])
        .flatMap((message) => Array.isArray(record(message)?.content) ? record(message)?.content as unknown[] : [])
        .map((part) => record(part)?.text).find((text): text is string => typeof text === 'string')
      throw new BackendError(`droid has no model ${JSON.stringify(modelId)}; it would run ${JSON.stringify(selected)} instead`
        + `${notice ? ` (${notice.slice(0, 200)})` : ''}. Name the model in Droid's settings (customModels) and request factory-droids/<its id>`, 'not_configured')
    }
    await this.call('droid.rename_session', { title: 'cli-bridge' }, 'session naming', requestTimeoutMs, signal)
  }

  async *turn(prompt: string, signal: AbortSignal): AsyncIterable<unknown> {
    if (this.life.closed || !this.sessionId) throw new BackendError('factory-droids native session is closed', 'upstream')
    if (this.turnState) throw new BackendError('factory-droids native session already has an active turn', 'upstream')
    let onSettled = (): void => {}
    const whenSettled = new Promise<void>((resolve) => { onSettled = resolve })
    const state: TurnState = { steers: new Map(), ended: 0, usage: {}, failure: null, settled: false, whenSettled, onSettled }
    this.turnState = state
    const onAbort = (): void => { void this.abort().catch(() => {}) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      this.send('droid.add_user_message', { text: prompt }).reply.catch((error: unknown) => {
        state.failure ??= error instanceof Error ? error.message : String(error)
        this.settle(state)
      })
      while (true) {
        const event = await this.next(signal)
        yield event
        if (event.type === DROID_TURN_SETTLED) return
      }
    } catch (error) {
      if (signal.aborted) await this.abort()
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (this.turnState === state) this.turnState = null
      this.queue.length = 0
    }
  }

  /**
   * Resolves once Droid has queued the input for the running turn; the turn then carries a raw
   * `{ type: 'steer', operationId, state: 'queued' }`, and `state: 'applied'` when Droid takes it.
   */
  async steer(prompt: string, operationId?: string): Promise<void> {
    const state = this.turnState
    if (this.life.closed || !this.sessionId || !state || state.settled) {
      throw new BackendError('factory-droids native session has no running turn to steer', 'upstream')
    }
    const sent = this.send('droid.add_user_message', { text: prompt, queuePlacement: 'end_of_turn' }, 'steer', this.options.requestTimeoutMs)
    state.steers.set(sent.id, operationId)
    try {
      await sent.reply
    } catch (error) {
      state.steers.delete(sent.id)
      throw error
    }
    if (!state.settled && state.steers.has(sent.id)) this.enqueue({ type: 'steer', ...(operationId ? { operationId } : {}), state: 'queued' })
  }

  /** Ask Droid to end the running turn, then stop the process. */
  async abort(): Promise<void> {
    if (this.life.closed) return this.life.startCleanup()
    this.abortInFlight ??= (async () => {
      try {
        const state = this.turnState
        if (this.sessionId && state && !state.settled) {
          this.send('droid.interrupt_session', {}, 'interrupt', INTERRUPT_GRACE_MS).reply.catch(() => {})
          let timer: NodeJS.Timeout | undefined
          await Promise.race([state.whenSettled, this.life.whenClosed(), new Promise((resolve) => { timer = setTimeout(resolve, INTERRUPT_GRACE_MS) })])
          clearTimeout(timer)
        }
      } catch {
        // The run is cancelled whatever Droid answers.
      } finally {
        await this.life.terminate().catch(() => {})
        this.life.end(new Error('factory-droids native session aborted'))
        try { await this.life.startCleanup() } finally { this.abortInFlight = null }
      }
    })()
    return this.abortInFlight
  }

  async respondToNativeInteraction(): Promise<void> {
    throw new BackendError('factory-droids runs unattended and asks no questions; it has no pending interaction', 'capability_denied')
  }

  /** The Droid session and the number of turns this process has completed in it, read only between turns. */
  async contextBoundary(input: {
    runId: string; provider: string; environmentId: string; sessionId: string; executionId: string; requestDigest: string
  }): Promise<NativeContextBoundaryProof | null> {
    if (this.life.closed || this.turnState || !this.sessionId || this.completedTurns === 0) return null
    const revision = `droid:${this.sessionId}:${this.completedTurns}`
    return {
      ...input,
      requestDigest: input.requestDigest as `sha256:${string}`,
      boundary: { kind: 'revision', revision: revision.length <= 512 ? revision : `id:${canonicalCandidateDigest(revision).slice(7)}` },
      observedAt: new Date().toISOString(),
    }
  }

  /** End stdin so Droid exits on its own, then stop what remains. */
  async close(): Promise<void> {
    if (!this.life.closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_GRACE_MS)
        timer.unref?.()
        this.life.onClose(() => { clearTimeout(timer); resolve() })
        this.life.child.stdin?.end()
      })
    }
    this.life.end(new Error('factory-droids native session closed'))
    await this.life.closing
  }

  private settle(state: TurnState): void {
    if (state.settled) return
    state.settled = true
    state.onSettled()
    if (state.failure === null) this.completedTurns += 1
    if (this.turnState === state) {
      this.enqueue({ type: DROID_TURN_SETTLED, usage: state.usage, ...(state.failure === null ? {} : { error: state.failure }) })
    }
  }

  /** One request; a timeout of zero waits for the answer however long Droid takes. */
  private send(method: string, params: unknown, operation = method, timeoutMs = 0, signal?: AbortSignal): { id: string; reply: Promise<unknown> } {
    const id = String(this.nextRequest++)
    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined
    const reply = new Promise<unknown>((resolve, reject) => {
      const done = (): void => { clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort) }
      this.requests.set(id, {
        resolve: (value) => { done(); resolve(value) },
        reject: (error) => { done(); reject(error) },
      })
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.requests.delete(id)
          reject(new BackendError(`droid did not answer the ${operation} within ${timeoutMs}ms`, 'timeout'))
        }, timeoutMs)
        timer.unref?.()
      }
      if (signal) {
        onAbort = () => {
          this.requests.delete(id)
          reject(new BackendError(`droid ${operation} was cancelled`, 'aborted'))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    this.write({ type: 'request', id, method, params })
    return { id, reply }
  }

  private async call(method: string, params: unknown, operation: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    return await this.send(method, params, operation, timeoutMs, signal).reply
  }

  private write(frame: Record<string, unknown>): void {
    if (!this.life.child.stdin || this.life.closed) throw new BackendError('factory-droids native session stdin is closed', 'upstream')
    this.life.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...this.versions, ...frame })}\n`)
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_LINE_CHARS && !this.buffer.includes('\n')) {
      this.buffer = ''
      void this.life.terminate().catch(() => {})
      this.life.end(new BackendError(`droid wrote a line longer than ${MAX_LINE_CHARS} characters`, 'parse_error'))
      return
    }
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      let value: unknown
      try { value = line ? JSON.parse(line) : null } catch { continue }
      const frame = record(value)
      if (frame) this.observe(frame)
    }
  }

  private observe(frame: Record<string, unknown>): void {
    if (typeof frame.factoryApiVersion === 'string' && typeof frame.factoryProtocolVersion === 'string') {
      this.versions = { factoryApiVersion: frame.factoryApiVersion, factoryProtocolVersion: frame.factoryProtocolVersion }
    }
    const id = typeof frame.id === 'string' ? frame.id : null
    if (frame.type === 'response' && id !== null) {
      const waiter = this.requests.get(id)
      this.requests.delete(id)
      const error = record(frame.error)
      if (!error) { waiter?.resolve(frame.result ?? null); return }
      const message = typeof error.message === 'string' ? error.message.slice(0, 300) : 'error'
      // -32602 answers a model Droid does not have (`Unknown model: <id>`); every other refusal is Droid's.
      const kind = error.code === -32602 && /unknown model/iu.test(message) ? 'not_configured' : 'upstream'
      waiter?.reject(new BackendError(`droid error ${String(error.code)}: ${message}`, kind))
      return
    }
    if (frame.type === 'request' && id !== null) {
      this.write({ type: 'response', id, error: { code: -32601, message: 'cli-bridge runs Droid unattended and answers no questions' } })
      return
    }
    const params = record(frame.params)
    const note = record(params?.notification)
    const state = this.turnState
    if (!note || !state || state.settled) return
    const sessionId = params?.sessionId ?? note.sessionId
    if (sessionId !== undefined && sessionId !== this.sessionId) return
    const type = String(note.type ?? '')
    if (type === 'create_message' && record(note.message)?.role === 'user' && typeof note.requestId === 'string' && state.steers.has(note.requestId)) {
      const operationId = state.steers.get(note.requestId)
      state.steers.delete(note.requestId)
      this.enqueue({ type: 'steer', ...(operationId ? { operationId } : {}), state: 'applied' })
      return
    }
    if (type === 'error') state.failure ??= String(note.message ?? record(note.error)?.message ?? 'droid error').slice(0, 500)
    if (type === 'agent_turn_completed') {
      state.ended += 1
      for (const counts of [record(note.tokenUsage), record(note.childTokenUsage)]) {
        for (const key of DROID_USAGE_KEYS) {
          const count = counts?.[key]
          if (typeof count === 'number' && Number.isFinite(count) && count > 0) state.usage[key] = (state.usage[key] ?? 0) + count
        }
      }
      if (note.reason !== 'completed') state.failure ??= `droid ended the turn: ${String(note.reason ?? 'unknown')}`
      this.enqueue(note)
      // A steer still queued runs as Droid's next turn, which belongs to this one.
      if (state.steers.size === 0 || note.reason !== 'completed') this.settle(state)
      return
    }
    // Idle with a steer still queued after a turn ended: Droid did not take it.
    if (type === 'droid_working_state_changed' && note.newState === 'idle' && state.ended > 0) {
      for (const operationId of state.steers.values()) this.enqueue({ type: 'steer', ...(operationId ? { operationId } : {}), state: 'dropped' })
      state.steers.clear()
      this.settle(state)
      return
    }
    this.enqueue(note)
  }

  private enqueue(message: Record<string, unknown>): void {
    const reader = this.readers.shift()
    if (reader) reader.resolve(message)
    else this.queue.push(message)
  }

  private next(signal: AbortSignal): Promise<Record<string, unknown>> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.life.closed) return Promise.reject(this.life.error ?? new Error('droid stream-jsonrpc process closed'))
    if (signal.aborted) return Promise.reject(new Error('factory-droids native turn aborted'))
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.readers.indexOf(reader)
        if (index >= 0) this.readers.splice(index, 1)
        reject(new Error('factory-droids native turn aborted'))
      }
      const reader: Waiter<Record<string, unknown>> = {
        resolve: (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
        reject: (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
      }
      this.readers.push(reader)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
