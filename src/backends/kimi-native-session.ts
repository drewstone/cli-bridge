/**
 * One retained Kimi Code session on Kimi's own local server (`kimi web`, the Kimi Agent Protocol), reached through
 * the stdio bridge in kimi-kap-stdio.mjs. Measured on Kimi Code 2.7.3:
 *
 * - `POST /sessions/{id}/prompts` opens a turn; `turn.*`, `item.*` and `interaction` WebSocket frames report it.
 * - `POST /sessions/{id}/steer` delivers input to the running turn. Kimi waits for the next safe injection point
 *   (after the running tool call), and may end the current Kimi turn there and open a continuation turn whose
 *   opener is the steer. One Bridge turn therefore lasts until no submitted prompt or steer is still unstarted
 *   and the last Kimi turn has ended.
 * - `kimi acp` cannot steer: a second `session/prompt` during a turn answers `turn.agent_busy`.
 *
 * The session runs in Kimi's `manual` permission mode, so every approval Kimi asks for reaches the Bridge, which
 * answers it by the turn's interaction policy.
 */

import { randomUUID } from 'node:crypto'
import {
  canonicalCandidateDigest,
  type AgentEnvironmentCapabilities,
  type NativeContextBoundaryProof,
} from '@tangle-network/agent-interface'
import type { NativeSession } from './types.js'
import { BackendError } from './types.js'
import { NativeChild } from './native-child.js'
import type { Spawner } from '../executors/types.js'

/** Bridge-made frame ending a turn; Kimi never sends this type. */
export const KIMI_TURN_SETTLED = 'cli-bridge.kimi.turn_settled'
const CANCEL_GRACE_MS = 1_000
const CLOSE_GRACE_MS = 5_000

interface Waiter<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
}

/** Kimi's own session settings: the permission mode, the model alias and the thinking level. */
export interface KimiAgentConfig {
  permission_mode: 'manual'
  model?: string
  thinking?: 'on' | 'off'
}

export interface KimiNativeSessionOptions {
  capabilities: AgentEnvironmentCapabilities
  cwd: string
  agentConfig: KimiAgentConfig
  /** A Kimi session id to continue; null creates one. */
  resumeSessionId: string | null
  /** Bound on every request except a steer, which Kimi holds until it can apply the input. */
  requestTimeoutMs: number
  cleanup: () => void | Promise<void>
}

interface TurnState {
  /** Prompt and steer ids submitted for this turn whose `user_message` item has not appeared. */
  unstarted: Set<string>
  /** Steer prompt id -> the caller's control operation id. */
  steers: Map<string, string>
  /** The Kimi turn now running, if any. */
  running: string | null
  /** A Kimi turn of this Bridge turn has ended. */
  ended: boolean
  /** The settle frame is queued; nothing more may be written into this turn. */
  settling: boolean
}

export class KimiNativeSession implements NativeSession {
  readonly capabilities: AgentEnvironmentCapabilities
  private readonly life: NativeChild
  private buffer = ''
  private nextRequest = 1
  private readonly requests = new Map<number, Waiter<{ status: number; body: Record<string, unknown> }>>()
  private readonly subscriptions = new Map<string, Waiter<void>>()
  private readonly ready: Promise<void>
  private readyWaiter: Waiter<void> | null = null
  private sessionId: string | null = null
  private turnState: TurnState | null = null
  private lastTurnId: string | null = null
  /** Interactions Kimi is waiting on, by id. */
  private readonly interactions = new Map<string, 'approval' | 'question'>()
  private readonly queue: Record<string, unknown>[] = []
  private readonly readers: Waiter<Record<string, unknown>>[] = []
  private abortInFlight: Promise<void> | null = null

  constructor(spawned: Awaited<ReturnType<Spawner>>, private readonly options: KimiNativeSessionOptions) {
    this.capabilities = options.capabilities
    this.ready = new Promise<void>((resolve, reject) => { this.readyWaiter = { resolve, reject } })
    this.ready.catch(() => {})
    this.life = new NativeChild(spawned, {
      names: { process: 'kimi web', session: 'kimi native session' },
      onStdout: (chunk) => this.consume(chunk),
      onEnd: (error) => {
        this.readyWaiter?.reject(error)
        this.readyWaiter = null
        for (const waiters of [this.readers.splice(0), [...this.requests.values()], [...this.subscriptions.values()]])
          for (const waiter of waiters) waiter.reject(error)
        this.requests.clear()
        this.subscriptions.clear()
        this.interactions.clear()
      },
      cleanup: options.cleanup,
    })
  }

  providerSessionId(): string | null { return this.sessionId }
  isClosed(): boolean { return this.life.closed }
  onClose(listener: (reason: Error) => void): () => void { return this.life.onClose(listener) }
  whenClosed(): Promise<void> { return this.life.whenClosed() }

  /** Wait for the server, create or continue the Kimi session, and subscribe to its main agent's frames. */
  async start(signal?: AbortSignal): Promise<void> {
    await this.bounded(this.ready, 'the local server did not start', signal)
    const { cwd, agentConfig, resumeSessionId } = this.options
    if (resumeSessionId) {
      // Applying the session's settings loads it from Kimi's store; an unknown id is refused, never replaced.
      await this.call('POST', `sessions/${encodeURIComponent(resumeSessionId)}/profile`, { agent_config: agentConfig }, 'session resume')
      this.sessionId = resumeSessionId
    } else {
      // `metadata.cwd` names the workspace on Kimi Code 2.6 and 2.7 alike; only 2.7 also reads a top-level `cwd`.
      const created = await this.call('POST', 'sessions', { metadata: { cwd }, agent_config: agentConfig }, 'session creation')
      const id = typeof created.id === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/u.test(created.id) ? created.id : null
      if (!id) throw new BackendError('Kimi created a session without an id', 'upstream')
      this.sessionId = id
    }
    const requestId = `cli-bridge-${randomUUID()}`
    const subscribed = new Promise<void>((resolve, reject) => this.subscriptions.set(requestId, { resolve, reject }))
    await this.send({ type: 'subscribe', request_id: requestId, session_id: this.sessionId, agent_ids: ['main'] })
    await this.bounded(subscribed, 'Kimi did not confirm the session subscription', signal)
  }

  async *turn(prompt: string, signal: AbortSignal): AsyncIterable<unknown> {
    if (this.life.closed || !this.sessionId) throw new BackendError('kimi native session is closed', 'upstream')
    if (this.turnState) throw new BackendError('kimi native session already has an active turn', 'upstream')
    const promptId = `cli-bridge-${randomUUID()}`
    const state: TurnState = { unstarted: new Set([promptId]), steers: new Map(), running: null, ended: false, settling: false }
    this.turnState = state
    const onAbort = (): void => { void this.abort().catch(() => {}) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await this.call('POST', `sessions/${this.sessionId}/prompts`, { prompt_id: promptId, content: [{ type: 'text', text: prompt }] },
        'prompt submission')
      while (true) {
        const event = await this.next(signal)
        yield event
        if (event.type === KIMI_TURN_SETTLED) return
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
   * Resolves once Kimi has taken the input into the running turn. The turn then carries a raw
   * `{ type: 'steer', operationId, state: 'applied' }` when its `user_message` item appears.
   */
  async steer(prompt: string, operationId?: string): Promise<void> {
    const state = this.turnState
    if (this.life.closed || !this.sessionId || !state || state.settling)
      throw new BackendError('kimi native session has no running turn to steer', 'upstream')
    const promptId = `cli-bridge-steer-${randomUUID()}`
    state.unstarted.add(promptId)
    if (operationId) state.steers.set(promptId, operationId)
    try {
      await this.call('POST', `sessions/${this.sessionId}/steer`, { prompt_id: promptId, content: [{ type: 'text', text: prompt }] },
        'steer', 0)
    } catch (error) {
      // Refused: the input never entered the turn, and it must not hold the turn open.
      state.unstarted.delete(promptId)
      state.steers.delete(promptId)
      this.settleIfDone(state)
      throw error
    }
  }

  async abort(): Promise<void> {
    if (this.life.closed) return this.life.startCleanup()
    this.abortInFlight ??= (async () => {
      const termination = this.life.terminate().catch(() => {})
      try {
        if (this.sessionId) await this.call('POST', `sessions/${this.sessionId}:cancel`, { include_background: true }, 'cancel', CANCEL_GRACE_MS)
      } catch {
        // The run is cancelled whatever Kimi answers.
      } finally {
        await termination
        this.life.end(new Error('kimi native session aborted'))
        try { await this.life.startCleanup() } finally { this.abortInFlight = null }
      }
    })()
    return this.abortInFlight
  }

  /** Answer one pending approval (allowed only by `allow_once`); a question is dismissed. */
  async respondToNativeInteraction(id: string, response: Record<string, unknown>): Promise<void> {
    const kind = this.interactions.get(id)
    if (this.life.closed || !kind || !this.sessionId) throw new BackendError('Kimi has no pending interaction with this id', 'capability_denied')
    const answer = kind === 'question' ? { kind: 'question', dismissed: true }
      : { kind: 'approval', decision: response.value === 'allow_once' ? 'approved' : response.cancelled === true ? 'cancelled' : 'rejected' }
    try {
      await this.call('POST', `sessions/${this.sessionId}/interactions/${encodeURIComponent(id)}`, answer, 'interaction answer')
    } finally {
      this.interactions.delete(id)
    }
  }

  /** The last Kimi turn id, read only between turns. */
  async contextBoundary(input: {
    runId: string; provider: string; environmentId: string; sessionId: string; executionId: string; requestDigest: string
  }): Promise<NativeContextBoundaryProof | null> {
    if (this.life.closed || this.turnState || !this.sessionId || !this.lastTurnId) return null
    const revision = `kimi:${this.sessionId}:${this.lastTurnId}`
    return {
      ...input,
      requestDigest: input.requestDigest as `sha256:${string}`,
      boundary: { kind: 'revision', revision: revision.length <= 512 ? revision : `id:${canonicalCandidateDigest(revision).slice(7)}` },
      observedAt: new Date().toISOString(),
    }
  }

  /** End stdin so the bridge stops Kimi with SIGTERM and Kimi saves its session, then stop what remains. */
  async close(): Promise<void> {
    if (!this.life.closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_GRACE_MS)
        timer.unref?.()
        this.life.onClose(() => { clearTimeout(timer); resolve() })
        this.life.child.stdin?.end()
      })
    }
    this.life.end(new Error('kimi native session closed'))
    await this.life.closing
  }

  /** One local-server call; Kimi's `{ code: 0, data }` envelope or a typed error naming the operation. */
  private async call(method: 'GET' | 'POST', path: string, body: unknown, operation: string,
    timeoutMs = this.options.requestTimeoutMs): Promise<Record<string, unknown>> {
    const id = this.nextRequest++
    const reply = new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.requests.delete(id)
            reject(new BackendError(`Kimi did not answer the ${operation} within ${timeoutMs}ms`, 'timeout'))
          }, timeoutMs)
        : undefined
      timer?.unref?.()
      this.requests.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
    })
    this.write({ id, method, path, body })
    const { status, body: envelope } = await reply
    if (status >= 300 || envelope.code !== 0) {
      const code = typeof envelope.code === 'number' ? String(envelope.code) : 'unknown'
      const message = typeof envelope.msg === 'string' ? `: ${envelope.msg.slice(0, 300)}` : ''
      throw new BackendError(`Kimi refused the ${operation} (HTTP ${status}, native code ${code})${message}`, 'upstream')
    }
    return envelope.data !== null && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
      ? envelope.data as Record<string, unknown> : {}
  }

  private async send(frame: Record<string, unknown>): Promise<void> {
    const id = this.nextRequest++
    const sent = new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => this.requests.set(id, { resolve, reject }))
    this.write({ id, send: frame })
    await sent
  }

  private write(value: Record<string, unknown>): void {
    if (!this.life.child.stdin || this.life.closed) throw new BackendError('kimi native session stdin is closed', 'upstream')
    this.life.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  private async bounded<T>(promise: Promise<T>, failure: string, signal?: AbortSignal): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new BackendError(`${failure} within ${this.options.requestTimeoutMs}ms`, 'timeout')),
            this.options.requestTimeoutMs)
          timer.unref?.()
          onAbort = () => reject(new BackendError('kimi native session start was cancelled', 'aborted'))
          if (signal?.aborted) onAbort()
          signal?.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    } finally {
      clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      let value: unknown
      try { value = line ? JSON.parse(line) : null } catch { continue }
      const message = record(value)
      if (!message) continue
      if (message.type === 'ready') {
        this.readyWaiter?.resolve()
        this.readyWaiter = null
      } else if (typeof message.id === 'number') {
        const waiter = this.requests.get(message.id)
        this.requests.delete(message.id)
        waiter?.resolve({ status: typeof message.status === 'number' ? message.status : 0, body: record(message.body) ?? {} })
      } else if (record(message.frame)) this.observe(record(message.frame)!)
    }
  }

  /** Frames are observed one at a time in WebSocket order, so turn state at a `turn.ended` reflects only frames before it. */
  private observe(frame: Record<string, unknown>): void {
    const type = String(frame.type ?? '')
    if (type === 'response') {
      const id = typeof frame.request_id === 'string' ? frame.request_id : ''
      const waiter = this.subscriptions.get(id)
      this.subscriptions.delete(id)
      if (frame.code === 0) waiter?.resolve()
      else waiter?.reject(new BackendError(`Kimi refused the session subscription (native code ${String(frame.code)})`, 'upstream'))
      return
    }
    if (!this.sessionId || frame.session_id !== this.sessionId) return
    if (frame.agent_id !== undefined && frame.agent_id !== 'main') return
    const interactionId = typeof frame.interaction_id === 'string' ? frame.interaction_id : null
    if (type === 'interaction' && interactionId) {
      if (frame.status === 'pending') this.interactions.set(interactionId, frame.kind === 'question' ? 'question' : 'approval')
      else this.interactions.delete(interactionId)
    }
    const turnId = typeof record(frame.turn)?.turn_id === 'string' ? record(frame.turn)!.turn_id as string : null
    if (turnId && (type === 'turn.started' || type === 'turn.ended')) this.lastTurnId = turnId
    const state = this.turnState
    if (!state || state.settling) return
    if (type === 'turn.started') {
      state.running = turnId
      state.ended = false
    }
    this.enqueue(frame)
    const item = record(frame.item)
    if ((type === 'item.started' || type === 'item.ended') && item?.type === 'user_message' && Array.isArray(item.prompt_ids)) {
      for (const id of item.prompt_ids) {
        if (typeof id !== 'string' || !state.unstarted.delete(id)) continue
        const operationId = state.steers.get(id)
        state.steers.delete(id)
        if (operationId) this.enqueue({ type: 'steer', operationId, promptId: id, state: 'applied' })
      }
    }
    if (type === 'turn.ended') {
      if (!state.running || state.running === turnId) state.running = null
      state.ended = true
      this.settleIfDone(state)
    }
  }

  /** A Bridge turn ends when a Kimi turn has ended, none runs, and nothing submitted is still waiting to start. */
  private settleIfDone(state: TurnState): void {
    if (state.settling || !state.ended || state.running !== null || state.unstarted.size > 0 || this.turnState !== state) return
    state.settling = true
    this.enqueue({ type: KIMI_TURN_SETTLED })
  }

  private enqueue(message: Record<string, unknown>): void {
    const reader = this.readers.shift()
    if (reader) reader.resolve(message)
    else this.queue.push(message)
  }

  private next(signal: AbortSignal): Promise<Record<string, unknown>> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.life.closed) return Promise.reject(this.life.error ?? new Error('kimi web process closed'))
    if (signal.aborted) return Promise.reject(new Error('kimi native turn aborted'))
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.readers.indexOf(reader)
        if (index >= 0) this.readers.splice(index, 1)
        reject(new Error('kimi native turn aborted'))
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
