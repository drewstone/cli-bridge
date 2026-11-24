/**
 * One retained `claude --print --input-format stream-json` process with stdin
 * held open. Message, steer and permission receipts are the ones measured on
 * Claude Code 2.1.325 with `--replay-user-messages`.
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

/** Bridge-made line ending a turn; Claude never prints this type. */
export const CLAUDE_TURN_SETTLED = 'turn_settled'
const INTERRUPT_GRACE_MS = 1_000
const CLOSE_GRACE_MS = 5_000

interface Waiter<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
}

export class ClaudeNativeSession implements NativeSession {
  private readonly life: NativeChild
  /** Messages written but not yet `started`, `completed` or `cancelled`. */
  private readonly unstarted = new Set<string>()
  private readonly acks = new Map<string, Waiter<string>>()
  private readonly echoes = new Map<string, Waiter<void>>()
  /** Steer uuid -> the caller's control operation id. */
  private readonly steers = new Map<string, string>()
  private readonly permissions = new Map<string, Record<string, unknown>>()
  private readonly queue: Record<string, unknown>[] = []
  private readonly readers: Waiter<Record<string, unknown>>[] = []
  private turnCommands: Set<string> | null = null
  /** A `result` has settled the active turn; nothing more may be written into it. */
  private turnSettling = false
  private lastMessageUuid: string | null = null
  private buffer = ''
  private abortInFlight: Promise<void> | null = null

  constructor(
    spawned: Awaited<ReturnType<Spawner>>,
    readonly capabilities: AgentEnvironmentCapabilities,
    private readonly sessionId: string,
    private readonly ackTimeoutMs: number,
    cleanup: () => void,
  ) {
    this.life = new NativeChild(spawned, {
      names: { process: 'claude', session: 'claude native session' },
      onStdout: (chunk) => this.consume(chunk),
      onEnd: (error) => {
        for (const waiters of [this.readers.splice(0), [...this.acks.values()], [...this.echoes.values()]])
          for (const waiter of waiters) waiter.reject(error)
        this.acks.clear()
        this.echoes.clear()
        this.permissions.clear()
      },
      cleanup,
    })
  }

  providerSessionId(): string { return this.sessionId }
  isClosed(): boolean { return this.life.closed }
  onClose(listener: (reason: Error) => void): () => void { return this.life.onClose(listener) }
  whenClosed(): Promise<void> { return this.life.whenClosed() }

  async *turn(prompt: string, signal: AbortSignal): AsyncIterable<unknown> {
    if (this.life.closed) throw new BackendError('claude native session is closed', 'upstream')
    if (this.turnCommands) throw new BackendError('claude native session already has an active turn', 'upstream')
    const commands = new Set<string>()
    this.turnCommands = commands
    this.turnSettling = false
    const onAbort = (): void => { void this.abort().catch(() => {}) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      this.writeUser(randomUUID(), prompt)
      while (true) {
        const event = await this.next(signal)
        yield event
        if (event.type === CLAUDE_TURN_SETTLED) return
      }
    } catch (error) {
      if (signal.aborted) await this.abort()
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (this.turnCommands === commands) this.turnCommands = null
      this.queue.length = 0
    }
  }

  /**
   * Resolves once Claude has queued the message. When Claude applies it, the
   * turn carries a raw `{ type: 'steer', operationId, state: 'applied' }`.
   */
  async steer(prompt: string, operationId?: string): Promise<void> {
    if (this.life.closed || !this.turnCommands || this.turnSettling)
      throw new BackendError('claude native session has no running turn to steer', 'upstream')
    const uuid = randomUUID()
    if (operationId) this.steers.set(uuid, operationId)
    this.writeUser(uuid, prompt)
    const state = await this.wait(this.acks, uuid, this.ackTimeoutMs).catch((error: unknown) => {
      this.unstarted.delete(uuid) // unacknowledged: effect unknown, and it must not hold the turn open
      throw error
    })
    if (state === 'cancelled') throw new BackendError('claude cancelled the steer before applying it', 'upstream')
  }

  async abort(): Promise<void> {
    if (this.life.closed) return this.life.startCleanup()
    this.abortInFlight ??= (async () => {
      const termination = this.life.terminate().catch(() => {})
      try {
        const id = `cli-bridge-interrupt-${randomUUID()}`
        this.write({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } })
        await this.wait(this.echoes, id, INTERRUPT_GRACE_MS)
      } catch {
        // The run is cancelled whatever Claude answers.
      } finally {
        await termination
        this.life.end(new Error('claude native session aborted'))
        try { await this.life.startCleanup() } finally { this.abortInFlight = null }
      }
    })()
    return this.abortInFlight
  }

  /** Answer one `can_use_tool` request; resolves when Claude echoes the answer it consumed. */
  async respondToNativeInteraction(id: string, response: Record<string, unknown>): Promise<void> {
    const input = this.permissions.get(id)
    if (this.life.closed || !input) throw new BackendError('Claude has no pending permission request with this id', 'capability_denied')
    const decision = response.value === 'allow_once'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'permission denied' }
    try {
      this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response: decision } })
      await this.wait(this.echoes, id, this.ackTimeoutMs)
    } finally {
      this.permissions.delete(id)
    }
  }

  /** The last native message id, read only between turns; it is that message's transcript entry id. */
  async contextBoundary(input: {
    runId: string; provider: string; environmentId: string; sessionId: string; executionId: string; requestDigest: string
  }): Promise<NativeContextBoundaryProof | null> {
    if (this.life.closed || this.turnCommands || !this.lastMessageUuid) return null
    const revision = `claude:${this.sessionId}:${this.lastMessageUuid}`
    return {
      ...input,
      requestDigest: input.requestDigest as `sha256:${string}`,
      boundary: { kind: 'revision', revision: revision.length <= 512 ? revision : `id:${canonicalCandidateDigest(revision).slice(7)}` },
      observedAt: new Date().toISOString(),
    }
  }

  /** End stdin so Claude writes its transcript and exits, then stop what remains. */
  async close(): Promise<void> {
    if (!this.life.closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_GRACE_MS)
        timer.unref?.()
        this.life.onClose(() => { clearTimeout(timer); resolve() })
        this.life.child.stdin?.end()
      })
    }
    this.life.end(new Error('claude native session closed'))
    await this.life.closing
  }

  private writeUser(uuid: string, text: string): void {
    this.unstarted.add(uuid)
    this.turnCommands?.add(uuid)
    this.write({ type: 'user', uuid, session_id: this.sessionId, parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text }] } })
  }

  private write(value: Record<string, unknown>): void {
    if (!this.life.child.stdin || this.life.closed) throw new BackendError('claude stdin is closed', 'upstream')
    this.life.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  /** stdout is read on a later tick than the write, so a waiter registered after it misses nothing. */
  private wait<T>(waiters: Map<string, Waiter<T>>, id: string, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            waiters.delete(id)
            reject(new BackendError(`claude did not acknowledge ${id} within ${timeoutMs}ms`, 'timeout'))
          }, timeoutMs)
        : undefined
      timer?.unref?.()
      waiters.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
    })
  }

  private settle<T>(waiters: Map<string, Waiter<T>>, id: string, value: T): void {
    const waiter = waiters.get(id)
    waiters.delete(id)
    waiter?.resolve(value)
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      let value: unknown
      try { value = line ? JSON.parse(line) : null } catch { continue }
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) this.observe(value as Record<string, unknown>)
    }
  }

  /**
   * Lines are observed one at a time in stdout order, so command state at a
   * `result` reflects only lines before it: a steer started after that result
   * cannot make it settle the turn.
   */
  private observe(message: Record<string, unknown>): void {
    const { type } = message
    if ((type === 'user' || type === 'assistant') && message.isReplay !== true && typeof message.uuid === 'string')
      this.lastMessageUuid = message.uuid
    const uuid = typeof message.command_uuid === 'string' ? message.command_uuid : null
    const state = typeof message.state === 'string' ? message.state : null
    if (type === 'command_lifecycle' && uuid && state) {
      if (state !== 'queued') this.unstarted.delete(uuid)
      this.settle(this.acks, uuid, state)
    }
    const request = record(message.request)
    const requestId = typeof message.request_id === 'string' ? message.request_id : null
    if (type === 'control_response') {
      const id = record(message.response)?.request_id
      if (typeof id === 'string') this.settle(this.echoes, id, undefined)
    } else if (type === 'control_request' && requestId) {
      if (request?.subtype === 'can_use_tool') this.permissions.set(requestId, record(request.input) ?? {})
      else {
        // Claude waits on every control request; refuse the ones the bridge does not implement.
        try {
          this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'not supported by cli-bridge' } })
        } catch {
          // A closed stdin already ends the turn.
        }
      }
    }
    const commands = this.turnCommands
    if (!commands) return
    this.enqueue(message)
    const operationId = uuid ? this.steers.get(uuid) : undefined
    if (uuid && operationId && (state === 'started' || state === 'cancelled')) {
      this.steers.delete(uuid)
      this.enqueue({ type: 'steer', operationId, commandUuid: uuid, state: state === 'started' ? 'applied' : 'cancelled' })
    }
    if (type === 'result' && !this.turnSettling && ![...commands].some((id) => this.unstarted.has(id))) {
      this.turnSettling = true
      this.enqueue({ type: CLAUDE_TURN_SETTLED })
    }
  }

  private enqueue(message: Record<string, unknown>): void {
    const reader = this.readers.shift()
    if (reader) reader.resolve(message)
    else this.queue.push(message)
  }

  private next(signal: AbortSignal): Promise<Record<string, unknown>> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.life.closed) return Promise.reject(this.life.error ?? new Error('claude process closed'))
    if (signal.aborted) return Promise.reject(new Error('claude native turn aborted'))
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.readers.indexOf(reader)
        if (index >= 0) this.readers.splice(index, 1)
        reject(new Error('claude native turn aborted'))
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
