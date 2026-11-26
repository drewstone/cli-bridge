/**
 * One Exo thread on Exo's HTTP service (`exo run <agent file> --serve --bind 127.0.0.1:0`): one process
 * serves the agent its definition file names, and holds one thread across Bridge turns. Measured on Exo
 * 0.1.0-unstable-2026-11-17 (rev d8c78197) against the Router's scripted model:
 *
 * - The process prints `listening: http://127.0.0.1:<port>/exo` once it serves. One service runs per state
 *   root (`EXO_HOME`): a second one on the same root exits ("another agent service is using this root").
 *   `--serve` refuses `--sandbox` and `--mount`; a thread's sandbox is the environment it is created with,
 *   and without one its tools run in Exo's default VM sandbox.
 * - `GET agent` lists the one agent served. `POST agent/<id>/thread { environment }` creates a thread and
 *   `GET agent/<id>/thread/<thread>` reads one, 404 when there is none; a thread made by an earlier process
 *   on the same root continues in a later one.
 * - `POST .../turn { input }` answers 202 with the turn's id at once. `GET .../event/watch?after=<event>` is
 *   the thread's events as Server-Sent Events (`event: exo_event`), each `{ id, turn_id, data }`: a turn
 *   runs `turn_started`, `messages` (the user's input, then each model call's assistant message with its
 *   `usage`), `tool_requested` and `tool_result`, and ends with `turn_ended`, after an `error` when it failed.
 * - A turn sent while one runs waits for it (FIFO). Sent with `attention: interrupt`, it cancels the running
 *   turn at once (`error: harness turn cancelled`, then its `turn_ended`) and runs next: that is the steer.
 * - `POST .../turn/<turn>/cancel` ends the running turn within a second the same way.
 * - The service ends on SIGTERM once its connections close, within five seconds.
 */

import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import {
  canonicalCandidateDigest,
  type AgentEnvironmentCapabilities,
  type NativeContextBoundaryProof,
} from '@tangle-network/agent-interface'
import type { NativeSession } from './types.js'
import { BackendError } from './types.js'
import { NativeChild } from './native-child.js'
import type { Spawner } from '../executors/types.js'

/** Bridge-made event ending a turn; Exo never sends this type. */
export const EXO_TURN_SETTLED = 'cli-bridge.exo.turn_settled'
/** Bridge-made event: a steer cancelled this Exo turn, and the steer's turn carries the Bridge turn on. */
export const EXO_TURN_SUPERSEDED = 'cli-bridge.exo.turn_superseded'
const INTERRUPT_GRACE_MS = 2_000
const RECONNECT_MS = 250
const MAX_FRAME_CHARS = 8 * 1024 * 1024
const EXO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** A turn's token counts summed over its model calls: prompt (cached included), cached and completion. */
export interface ExoUsage { input: number; cacheRead: number; output: number; calls: number }

export interface ExoServeSessionOptions {
  capabilities: AgentEnvironmentCapabilities
  /** The thread's sandbox: a local process on this directory. */
  cwd: string
  /** A thread to continue; null creates one. */
  resumeThreadId: string | null
  /** Bound on every request; a turn itself has none. */
  requestTimeoutMs: number
  cleanup: () => void | Promise<void>
}

interface Waiter<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
}

interface ExoEvent { id?: unknown; turn_id?: unknown; data?: unknown }

interface TurnState {
  /** The Exo turn whose end ends this Bridge turn: the prompt's, then each steer's. */
  current: string | null
  /** Exo turns a steer cancelled. */
  superseded: Set<string>
  /** Steer turns not yet started: Exo turn id to operation id. */
  steers: Map<string, string | undefined>
  /** Turn submissions without an answer yet; their events wait in `early`. */
  posting: number
  early: ExoEvent[]
  /** The current turn ended while a steer was being submitted. */
  currentEnded: boolean
  failures: Map<string, string>
  usage: ExoUsage
  settled: boolean
  whenSettled: Promise<void>
  onSettled: () => void
}

export class ExoServeSession implements NativeSession {
  readonly capabilities: AgentEnvironmentCapabilities
  private readonly life: NativeChild
  private stdout = ''
  private endpoint: string | null = null
  private onListening: ((endpoint: string) => void) | null = null
  private agentId: string | null = null
  private threadId: string | null = null
  private lastEventId: string | null = null
  private watch: ClientRequest | null = null
  private watching = false
  private turnState: TurnState | null = null
  private completedTurns = 0
  private readonly queue: Record<string, unknown>[] = []
  private readonly readers: Waiter<Record<string, unknown>>[] = []
  private abortInFlight: Promise<void> | null = null

  constructor(spawned: Awaited<ReturnType<Spawner>>, private readonly options: ExoServeSessionOptions) {
    this.capabilities = options.capabilities
    this.life = new NativeChild(spawned, {
      names: { process: 'exo serve', session: 'exo native session' },
      onStdout: (chunk) => this.consumeStdout(chunk),
      onEnd: (error) => {
        this.stopWatching()
        for (const reader of this.readers.splice(0)) reader.reject(error)
      },
      cleanup: options.cleanup,
    })
  }

  providerSessionId(): string | null { return this.threadId }
  isClosed(): boolean { return this.life.closed }
  onClose(listener: (reason: Error) => void): () => void { return this.life.onClose(listener) }
  whenClosed(): Promise<void> { return this.life.whenClosed() }

  /** Wait for the service, find its agent, continue or create the thread on the workspace, and watch it. */
  async start(signal?: AbortSignal): Promise<void> {
    const { cwd, resumeThreadId, requestTimeoutMs } = this.options
    this.endpoint = await this.listening(requestTimeoutMs, signal)
    const agents = record(await this.call('GET', 'agent', undefined, 'agent listing', signal))?.agents
    const agentId = Array.isArray(agents) && agents.length === 1 ? record(agents[0])?.id : undefined
    if (typeof agentId !== 'string' || !EXO_ID.test(agentId)) throw new BackendError('exo serves no single agent with a usable id', 'upstream')
    this.agentId = agentId
    const thread = resumeThreadId
      ? record(record(await this.call('GET', `agent/${agentId}/thread/${encodeURIComponent(resumeThreadId)}`, undefined, 'thread read', signal))?.thread)
      : record(record(await this.call('POST', `agent/${agentId}/thread`, {
        environment: {
          name: 'cli-bridge', provider: 'local_process', image: 'local', default_workdir: '/workspace',
          file_system_mounts: [{ host_path: cwd, mount_path: '/workspace', mode: 'rw', internal: null }],
        },
      }, 'thread creation', signal))?.thread)
    const threadId = thread?.id
    if (typeof threadId !== 'string' || !EXO_ID.test(threadId) || (resumeThreadId && threadId !== resumeThreadId)) {
      throw new BackendError('exo answered without the thread it was asked for', 'upstream')
    }
    this.threadId = threadId
    this.lastEventId = typeof thread?.latest_event_id === 'string' ? thread.latest_event_id : null
    this.watching = true
    this.connectWatch()
  }

  async *turn(prompt: string, signal: AbortSignal): AsyncIterable<unknown> {
    if (this.life.closed || !this.threadId) throw new BackendError('exo native session is closed', 'upstream')
    if (this.turnState) throw new BackendError('exo native session already has an active turn', 'upstream')
    let onSettled = (): void => {}
    const whenSettled = new Promise<void>((resolve) => { onSettled = resolve })
    const state: TurnState = { current: null, superseded: new Set(), steers: new Map(), posting: 0, early: [], currentEnded: false,
      failures: new Map(), usage: { input: 0, cacheRead: 0, output: 0, calls: 0 }, settled: false, whenSettled, onSettled }
    this.turnState = state
    const onAbort = (): void => { void this.abort().catch(() => {}) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      state.posting += 1
      this.submit(prompt, false).then((turnId) => this.adopt(state, turnId, false), (error: unknown) => {
        state.failures.set('', error instanceof Error ? error.message : String(error))
        this.settle(state)
      }).finally(() => this.submitted(state))
      while (true) {
        const event = await this.next(signal)
        yield event
        if (event.type === EXO_TURN_SETTLED) return
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
   * Resolves once Exo has accepted the input as a turn that interrupts the running one; the Bridge turn then
   * carries a raw `{ type: 'steer', operationId, state: 'queued' }`, and `state: 'applied'` when that turn starts.
   */
  async steer(prompt: string, operationId?: string): Promise<void> {
    const state = this.turnState
    if (this.life.closed || !this.threadId || !state || state.settled) {
      throw new BackendError('exo native session has no running turn to steer', 'upstream')
    }
    state.posting += 1
    try {
      const turnId = await this.submit(prompt, true)
      if (state.settled) {
        // The turn ended (it was cancelled) while Exo took the steer: its turn has no Bridge turn to run in.
        void this.call('POST', `${this.threadPath()}/turn/${turnId}/cancel`, {}, 'cancel', undefined, INTERRUPT_GRACE_MS).catch(() => {})
        throw new BackendError('exo native session ended its turn before the steer arrived', 'upstream')
      }
      state.steers.set(turnId, operationId)
      this.enqueue({ type: 'steer', ...(operationId ? { operationId } : {}), state: 'queued' })
      this.adopt(state, turnId, true)
    } finally {
      this.submitted(state)
    }
  }

  /** Cancel the running turn, then stop the service. */
  async abort(): Promise<void> {
    if (this.life.closed) return this.life.startCleanup()
    this.abortInFlight ??= (async () => {
      try {
        const state = this.turnState
        if (this.threadId && state && !state.settled && state.current) {
          void this.call('POST', `${this.threadPath()}/turn/${state.current}/cancel`, {}, 'cancel', undefined, INTERRUPT_GRACE_MS).catch(() => {})
          let timer: NodeJS.Timeout | undefined
          await Promise.race([state.whenSettled, this.life.whenClosed(), new Promise((resolve) => { timer = setTimeout(resolve, INTERRUPT_GRACE_MS) })])
          clearTimeout(timer)
        }
      } catch {
        // The run is cancelled whatever Exo answers.
      } finally {
        this.stopWatching()
        await this.life.terminate().catch(() => {})
        this.life.end(new Error('exo native session aborted'))
        try { await this.life.startCleanup() } finally { this.abortInFlight = null }
      }
    })()
    return this.abortInFlight
  }

  async respondToNativeInteraction(): Promise<void> {
    throw new BackendError('exo runs its tools without asking; it has no pending interaction', 'capability_denied')
  }

  /** The thread and the number of turns this process has completed in it, read only between turns. */
  async contextBoundary(input: {
    runId: string; provider: string; environmentId: string; sessionId: string; executionId: string; requestDigest: string
  }): Promise<NativeContextBoundaryProof | null> {
    if (this.life.closed || this.turnState || !this.threadId || this.completedTurns === 0) return null
    const revision = `exo:${this.threadId}:${this.completedTurns}`
    return {
      ...input,
      requestDigest: input.requestDigest as `sha256:${string}`,
      boundary: { kind: 'revision', revision: revision.length <= 512 ? revision : `id:${canonicalCandidateDigest(revision).slice(7)}` },
      observedAt: new Date().toISOString(),
    }
  }

  /** Close the event stream, then stop the service: it ends on SIGTERM once no connection is open. */
  async close(): Promise<void> {
    this.stopWatching()
    if (!this.life.closed) await this.life.terminate().catch(() => {})
    this.life.end(new Error('exo native session closed'))
    await this.life.closing
  }

  private threadPath(): string {
    return `agent/${this.agentId}/thread/${this.threadId}`
  }

  private async submit(prompt: string, interrupt: boolean): Promise<string> {
    const answer = record(await this.call('POST', `${this.threadPath()}/turn`, {
      input: { role: 'user', content: prompt }, ...(interrupt ? { attention: 'interrupt' } : {}),
    }, interrupt ? 'steer' : 'turn submission'))
    const turnId = record(answer?.turn)?.id
    if (typeof turnId !== 'string' || !EXO_ID.test(turnId)) throw new BackendError('exo accepted a turn without a usable id', 'upstream')
    return turnId
  }

  /** The submitted turn is now the one whose end ends the Bridge turn; a steer's cancels the one before it. */
  private adopt(state: TurnState, turnId: string, steer: boolean): void {
    if (state.settled) return
    if (steer && state.current) {
      state.superseded.add(state.current)
      if (state.currentEnded) this.enqueue({ type: EXO_TURN_SUPERSEDED, turnId: state.current })
    }
    state.current = turnId
    state.currentEnded = false
    for (const event of state.early.splice(0)) this.observe(event)
  }

  private submitted(state: TurnState): void {
    state.posting -= 1
    if (state.posting > 0 || state.settled) return
    state.early.length = 0
    if (state.currentEnded) this.settle(state)
  }

  private settle(state: TurnState): void {
    if (state.settled) return
    state.settled = true
    state.onSettled()
    const failure = state.failures.get(state.current ?? '') ?? state.failures.get('') ?? null
    if (failure === null) this.completedTurns += 1
    for (const operationId of state.steers.values()) this.enqueue({ type: 'steer', ...(operationId ? { operationId } : {}), state: 'dropped' })
    if (this.turnState === state) {
      this.enqueue({ type: EXO_TURN_SETTLED, usage: state.usage, ...(failure === null ? {} : { error: failure }) })
    }
  }

  private observe(event: ExoEvent): void {
    if (typeof event.id === 'string') this.lastEventId = event.id
    const state = this.turnState
    const turnId = typeof event.turn_id === 'string' ? event.turn_id : null
    const data = record(event.data)
    if (!state || state.settled || !turnId || !data) return
    const ours = turnId === state.current || state.superseded.has(turnId) || state.steers.has(turnId)
    if (!ours) {
      // Only this session's turns run on its thread: an unknown one is a submission not yet answered.
      if (state.posting > 0) state.early.push(event)
      return
    }
    const type = String(data.type ?? '')
    if (state.superseded.has(turnId)) {
      // The cancellation is the steer working, not a failure.
      if (type === 'turn_ended') this.enqueue({ type: EXO_TURN_SUPERSEDED, turnId })
      else if (type !== 'error' && type !== 'lingua_stream_chunk') this.enqueue({ ...data, turnId })
      return
    }
    if (type === 'turn_started' && state.steers.has(turnId)) {
      const operationId = state.steers.get(turnId)
      state.steers.delete(turnId)
      this.enqueue({ type: 'steer', ...(operationId ? { operationId } : {}), state: 'applied' })
    }
    if (type === 'messages') {
      const usage = record(data.usage)
      if (usage) {
        state.usage.calls += 1
        state.usage.input += count(usage.prompt_tokens)
        state.usage.cacheRead += count(usage.prompt_cached_tokens)
        state.usage.output += count(usage.completion_tokens)
      }
    }
    if (type === 'error' && !state.failures.has(turnId)) state.failures.set(turnId, String(data.message ?? 'exo error').slice(0, 500))
    if (type === 'turn_ended' && turnId === state.current) {
      // A steer being submitted may still cancel this turn, or follow it: its answer decides.
      if (state.posting > 0) state.currentEnded = true
      else this.settle(state)
      return
    }
    // Stream chunks repeat the assistant message that follows them.
    if (type !== 'lingua_stream_chunk') this.enqueue({ ...data, turnId })
  }

  /** Exo's stdout is read until it names its listener, and drained after. */
  private consumeStdout(chunk: string): void {
    if (this.endpoint) return
    this.stdout = (this.stdout + chunk).slice(-64 * 1024)
    const listening = /^listening: (http:\/\/127\.0\.0\.1:\d+\/exo)\s*$/mu.exec(this.stdout)
    if (listening && this.onListening) this.onListening(listening[1]!)
  }

  private listening(timeoutMs: number, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const done = (): void => {
        clearTimeout(timer)
        unsubscribe()
        signal?.removeEventListener('abort', onAbort)
        this.onListening = null
      }
      const onAbort = (): void => { done(); reject(new BackendError('exo service start was cancelled', 'aborted')) }
      const unsubscribe = this.life.onClose((error) => { done(); reject(new BackendError(`exo serve exited before listening: ${error.message}`, 'upstream')) })
      this.onListening = (endpoint) => { done(); resolve(endpoint) }
      timer = setTimeout(() => { done(); reject(new BackendError(`exo serve did not listen within ${timeoutMs}ms`, 'timeout')) }, timeoutMs)
      timer.unref?.()
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
      this.consumeStdout('')
    })
  }

  /** One request on its own connection, so no idle connection holds up the service's shutdown. */
  private call(method: string, path: string, body: unknown, operation: string, signal?: AbortSignal,
    timeoutMs = this.options.requestTimeoutMs): Promise<unknown> {
    const endpoint = this.endpoint
    if (!endpoint || this.life.closed) return Promise.reject(new BackendError('exo native session is closed', 'upstream'))
    return new Promise<unknown>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = httpRequest(new URL(path, `${endpoint}/`), {
        method, agent: false,
        headers: { accept: 'application/json', ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
      }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (part: string) => { if (text.length < MAX_FRAME_CHARS) text += part })
        res.on('end', () => {
          const status = res.statusCode ?? 0
          if (status === 404 && operation === 'thread read') {
            reject(new BackendError(`exo has no thread ${JSON.stringify(this.options.resumeThreadId)} to continue`, 'upstream'))
          } else if (status < 200 || status >= 300) {
            reject(new BackendError(`exo ${operation} answered HTTP ${status}: ${text.slice(0, 300)}`, 'upstream'))
          } else {
            try { resolve(text ? JSON.parse(text) : null) } catch { reject(new BackendError(`exo ${operation} answered unreadable JSON`, 'parse_error')) }
          }
        })
        res.on('error', (error) => reject(new BackendError(`exo ${operation} failed: ${error.message}`, 'upstream')))
      })
      const onAbort = (): void => { req.destroy(new BackendError(`exo ${operation} was cancelled`, 'aborted')) }
      req.setTimeout(timeoutMs, () => req.destroy(new BackendError(`exo did not answer the ${operation} within ${timeoutMs}ms`, 'timeout')))
      req.on('error', (error) => reject(error instanceof BackendError ? error : new BackendError(`exo ${operation} failed: ${error.message}`, 'upstream')))
      req.on('close', () => signal?.removeEventListener('abort', onAbort))
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
      req.end(payload)
    })
  }

  /** The thread's event stream from the last event read; it reconnects from there while the session lives. */
  private connectWatch(): void {
    if (!this.watching || this.life.closed || !this.endpoint) return
    const after = this.lastEventId ? `?after=${encodeURIComponent(this.lastEventId)}` : ''
    const req = httpRequest(new URL(`${this.threadPath()}/event/watch${after}`, `${this.endpoint}/`), {
      method: 'GET', agent: false, headers: { accept: 'text/event-stream' },
    }, (res: IncomingMessage) => {
      if (res.statusCode !== 200) {
        res.resume()
        this.watchFailed(new BackendError(`exo event stream answered HTTP ${res.statusCode}`, 'upstream'))
        return
      }
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (part: string) => {
        buffer += part
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          this.frame(frame)
        }
        if (buffer.length > MAX_FRAME_CHARS) this.watchFailed(new BackendError(`exo sent an event longer than ${MAX_FRAME_CHARS} characters`, 'parse_error'))
      })
      res.on('end', () => this.reconnect(req))
      res.on('error', () => this.reconnect(req))
    })
    req.on('error', () => this.reconnect(req))
    req.end()
    this.watch = req
  }

  private frame(frame: string): void {
    const kind = /^event: (\S+)/mu.exec(frame)?.[1]
    const data = frame.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n')
    if (!data) return
    let value: unknown
    try { value = JSON.parse(data) } catch { return }
    if (kind === 'error') { this.watchFailed(new BackendError(`exo event stream failed: ${String(record(value)?.error ?? '').slice(0, 300)}`, 'upstream')); return }
    const event = record(value)
    if (kind === 'exo_event' && event) this.observe(event)
  }

  private reconnect(req: ClientRequest): void {
    if (this.watch !== req) return
    this.watch = null
    if (!this.watching || this.life.closed) return
    setTimeout(() => this.connectWatch(), RECONNECT_MS).unref?.()
  }

  /** A stream Exo refuses cannot be read again: the session ends. */
  private watchFailed(error: Error): void {
    this.stopWatching()
    void this.life.terminate().catch(() => {})
    this.life.end(error)
  }

  private stopWatching(): void {
    this.watching = false
    const watch = this.watch
    this.watch = null
    watch?.destroy()
  }

  private enqueue(message: Record<string, unknown>): void {
    const reader = this.readers.shift()
    if (reader) reader.resolve(message)
    else this.queue.push(message)
  }

  private next(signal: AbortSignal): Promise<Record<string, unknown>> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.life.closed) return Promise.reject(this.life.error ?? new Error('exo serve process closed'))
    if (signal.aborted) return Promise.reject(new Error('exo native turn aborted'))
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.readers.indexOf(reader)
        if (index >= 0) this.readers.splice(index, 1)
        reject(new Error('exo native turn aborted'))
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

/** The assistant text and reasoning of one `messages` event, in order; tool calls arrive as `tool_requested`. */
export function exoAssistantParts(data: Record<string, unknown>): Array<{ kind: 'text' | 'reasoning'; text: string }> {
  const parts: Array<{ kind: 'text' | 'reasoning'; text: string }> = []
  for (const message of Array.isArray(data.messages) ? data.messages : []) {
    const entry = record(message)
    if (entry?.role !== 'assistant') continue
    if (typeof entry.content === 'string') {
      if (entry.content) parts.push({ kind: 'text', text: entry.content })
      continue
    }
    for (const part of Array.isArray(entry.content) ? entry.content : []) {
      const item = record(part)
      if ((item?.type === 'text' || item?.type === 'reasoning') && typeof item.text === 'string' && item.text) parts.push({ kind: item.type as 'text' | 'reasoning', text: item.text })
    }
  }
  return parts
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}
