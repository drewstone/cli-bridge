/**
 * One retained Claude Code process: `--print --input-format stream-json` with
 * stdin held open, so every turn, steer and permission answer reaches the same
 * native conversation.
 *
 * Measured against Claude Code 2.1.325 (`--replay-user-messages`):
 *   - A user message written while a turn runs is acknowledged at once with
 *     `command_lifecycle` `queued` for its `uuid`, enters the conversation at
 *     the next tool boundary (`started`, plus the message echoed with
 *     `isReplay`), and changes what the agent does in that same turn; one
 *     `result` closes both.
 *   - A repeated `uuid` is echoed but starts nothing.
 *   - A `control_response` to a `can_use_tool` request is echoed once on
 *     stdout when Claude consumes it; a repeat is not echoed.
 *   - The `interrupt` control request answers `success` and the process stays
 *     usable.
 * The retained-session service owns durable ids, replay and the public events;
 * this class owns the process protocol and proves each native effect before
 * returning.
 */

import { randomUUID } from 'node:crypto'
import {
  canonicalCandidateDigest,
  type AgentEnvironmentCapabilities,
  type NativeContextBoundaryProof,
} from '@tangle-network/agent-interface'
import type { NativeSession } from './types.js'
import { BackendError } from './types.js'
import type { Spawner } from '../executors/types.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'
import { redactedStderrTail } from './pi-native-session.js'
import { retryCleanupUntilSuccessful, terminateSpawned } from '../executors/process-tree.js'

export interface ClaudeNativeSessionOptions {
  capabilities: AgentEnvironmentCapabilities
  /** Bound on each native acknowledgement (queued steer, echoed answer, interrupt). */
  requestTimeoutMs: number
  providerSessionId: string
  cleanup(): void | Promise<void>
}

/** Where a stdin message is in Claude's command queue. */
type CommandState = 'written' | 'queued' | 'started' | 'completed' | 'cancelled'

interface CommandWaiter {
  readonly states: ReadonlySet<CommandState>
  resolve: (state: CommandState) => void
  reject: (error: Error) => void
}

interface EchoWaiter {
  resolve: () => void
  reject: (error: Error) => void
}

/** A `can_use_tool` request awaiting the host's answer. */
interface PendingPermission {
  readonly input: Record<string, unknown>
}

/**
 * The bridge's own turn boundary, yielded after the `result` that leaves no
 * message of this turn waiting. Claude never emits this type.
 */
export const CLAUDE_TURN_SETTLED = 'turn_settled'
/** The bridge's receipt that a steer entered (or never entered) the conversation. Claude never emits this type. */
export const CLAUDE_STEER_RECEIPT = 'steer'

const CLOSE_GRACE_MS = 5_000
const INTERRUPT_GRACE_MS = 1_000
const STDERR_DRAIN_GRACE_MS = 500

export class ClaudeNativeSession implements NativeSession {
  readonly capabilities: AgentEnvironmentCapabilities
  private readonly child: Awaited<ReturnType<Spawner>>['child']
  private readonly release: () => void
  private readonly terminate: () => Promise<void>
  private readonly cleanup: () => void | Promise<void>
  private readonly requestTimeoutMs: number
  private readonly sessionId: string
  private readonly stderr = new BoundedDiagnosticBuffer()
  private readonly commands = new Map<string, CommandState>()
  private readonly commandWaiters = new Map<string, Set<CommandWaiter>>()
  /** Steer uuid -> the Fleet operation id it carries. */
  private readonly steers = new Map<string, string>()
  private readonly permissions = new Map<string, PendingPermission>()
  private readonly echoWaiters = new Map<string, EchoWaiter>()
  private readonly queue: Record<string, unknown>[] = []
  private readonly waiters: Array<{
    resolve: (value: Record<string, unknown>) => void
    reject: (error: Error) => void
  }> = []
  private readonly closeListeners = new Set<(reason: Error) => void>()
  private turnCommands: Set<string> | null = null
  private lastMessageUuid: string | null = null
  private buffer = ''
  private closed = false
  private closing: Promise<void> | null = null
  private childError: Error | null = null
  private abortInFlight: Promise<void> | null = null
  private terminationInFlight: Promise<void> | null = null
  private readonly retryStartCleanup = (): Promise<void> => this.startCleanup()

  constructor(spawned: Awaited<ReturnType<Spawner>>, options: ClaudeNativeSessionOptions) {
    this.capabilities = options.capabilities
    this.requestTimeoutMs = options.requestTimeoutMs
    this.sessionId = options.providerSessionId
    this.child = spawned.child
    this.release = spawned.release
    this.cleanup = options.cleanup
    this.terminate = async () => {
      if (this.terminationInFlight) return this.terminationInFlight
      this.terminationInFlight = spawned.terminate
        ? spawned.terminate()
        : terminateSpawned(spawned).then((outcome) => {
            if (outcome !== 'stopped') throw new Error(`claude native session termination ${outcome}`)
          })
      try {
        await this.terminationInFlight
      } finally {
        this.terminationInFlight = null
      }
    }
    this.child.stdout?.on('data', (chunk) => this.consume(chunk.toString()))
    this.child.stderr?.on('data', (chunk) => this.stderr.append(chunk))
    this.child.stdin?.on('error', (error) => this.end(error))
    this.child.stdout?.on('end', () => this.endAfterStderrDrains('claude stdout ended'))
    this.child.on('error', (error) => {
      this.childError = error
      this.end(error)
    })
    this.child.on('close', () => this.end(this.childError ?? this.exitError('claude process closed')))
  }

  providerSessionId(): string | null {
    return this.sessionId
  }

  isClosed(): boolean {
    return this.closed
  }

  onClose(listener: (reason: Error) => void): () => void {
    if (this.closed) {
      queueMicrotask(() => {
        try {
          listener(this.childError ?? new Error('claude process closed'))
        } catch {
          // A late owner cannot break child cleanup.
        }
      })
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  whenClosed(): Promise<void> {
    if (this.closed) return this.startCleanup()
    return new Promise<void>((resolve, reject) => {
      const unsubscribe = this.onClose(() => {
        unsubscribe()
        this.startCleanup().then(resolve, reject)
      })
    })
  }

  /**
   * Write one user message and yield Claude's lines until a `result` leaves no
   * message of this turn queued. A steer that Claude only reaches after that
   * `result` runs as the next native turn inside this same bridge turn.
   */
  async *turn(prompt: string, signal: AbortSignal): AsyncIterable<unknown> {
    if (this.closed) throw new BackendError('claude native session is closed', 'upstream')
    if (this.turnCommands) throw new BackendError('claude native session already has an active turn', 'upstream')
    const commands = new Set<string>()
    this.turnCommands = commands
    const onAbort = (): void => {
      void this.abort().catch(() => {
        // The explicit turn path observes the failure.
      })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      this.writeUser(randomUUID(), prompt)
      while (true) {
        const event = await this.nextEvent(signal)
        yield event
        if (event.type === 'result' && ![...commands].some((uuid) => this.waiting(uuid))) {
          yield { type: CLAUDE_TURN_SETTLED }
          return
        }
      }
    } catch (error) {
      if (signal.aborted) await this.abort()
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (this.turnCommands === commands) this.turnCommands = null
      // Nothing outside a turn reads the queue; keep no stale lines for the next one.
      this.queue.length = 0
    }
  }

  /**
   * Send a message into the running turn. Resolves once Claude has queued it
   * (`command_lifecycle` `queued` for its uuid). The turn's events then carry
   * a `steer` receipt with this `operationId` when Claude applies it.
   */
  async steer(prompt: string, operationId?: string): Promise<void> {
    if (this.closed) throw new BackendError('claude native session is closed', 'upstream')
    if (!this.turnCommands) throw new BackendError('claude native session has no active turn to steer', 'upstream')
    const uuid = randomUUID()
    if (operationId) this.steers.set(uuid, operationId)
    this.writeUser(uuid, prompt)
    let state: CommandState
    try {
      state = await this.waitForCommand(uuid, ['queued', 'started', 'completed', 'cancelled'])
    } catch (error) {
      // Unacknowledged: its effect is unknown, and it must not hold the turn open.
      this.commands.delete(uuid)
      throw error
    }
    if (state === 'cancelled') throw new BackendError('claude cancelled the steer before applying it', 'upstream')
  }

  async abort(): Promise<void> {
    if (this.closed) return this.startCleanup()
    if (this.abortInFlight) return this.abortInFlight
    this.abortInFlight = (async () => {
      // Interrupt is a courtesy; the hard stop runs beside it because the run
      // is being cancelled whatever Claude answers.
      const termination = this.terminate().catch(() => {})
      try {
        const requestId = `cli-bridge-interrupt-${randomUUID()}`
        // stdout is read on a later tick, so waiting after the write misses nothing.
        this.write({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } })
        await this.waitForEcho(requestId, Math.min(this.requestTimeoutMs || INTERRUPT_GRACE_MS, INTERRUPT_GRACE_MS))
      } catch {
        // The owned run turns an abort into a cancelled terminal state either way.
      } finally {
        await termination
        this.end(new Error('claude native session aborted'))
        try {
          await this.startCleanup()
        } finally {
          this.abortInFlight = null
        }
      }
    })()
    return this.abortInFlight
  }

  /** Answer one `can_use_tool` request; resolves when Claude echoes the answer it consumed. */
  async respondToNativeInteraction(id: string, response: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new BackendError('claude native session is closed', 'upstream')
    const pending = this.permissions.get(id)
    if (!pending) throw new BackendError('Claude interaction is not a pending permission request', 'capability_denied')
    const decision = response.value === 'allow_once'
      ? { behavior: 'allow', updatedInput: pending.input }
      : { behavior: 'deny', message: response.cancelled === true ? 'permission request cancelled' : 'permission denied' }
    try {
      this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response: decision } })
      await this.waitForEcho(id, this.requestTimeoutMs)
    } finally {
      this.permissions.delete(id)
    }
  }

  /**
   * The last native message id Claude printed, read only while no turn runs.
   * It is the transcript entry id of that message, so any native activity
   * between two turns changes it.
   */
  async contextBoundary(input: {
    runId: string
    provider: string
    environmentId: string
    sessionId: string
    executionId: string
    requestDigest: string
  }): Promise<NativeContextBoundaryProof | null> {
    if (this.closed || this.turnCommands || !this.lastMessageUuid) return null
    return {
      runId: input.runId,
      provider: input.provider,
      environmentId: input.environmentId,
      sessionId: input.sessionId,
      executionId: input.executionId,
      requestDigest: input.requestDigest as `sha256:${string}`,
      boundary: { kind: 'revision', revision: boundedId(`claude:${this.sessionId}:${this.lastMessageUuid}`) },
      observedAt: new Date().toISOString(),
    }
  }

  /** End stdin so Claude flushes its transcript and exits, then stop whatever remains. */
  async close(): Promise<void> {
    if (!this.closed) {
      const exited = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_GRACE_MS)
        timer.unref?.()
        this.onClose(() => {
          clearTimeout(timer)
          resolve()
        })
      })
      try {
        this.child.stdin?.end()
      } catch {
        // The hard stop below still runs.
      }
      await exited
    }
    this.end(new Error('claude native session closed'))
    await this.closing
  }

  private writeUser(uuid: string, text: string): void {
    this.commands.set(uuid, 'written')
    this.turnCommands?.add(uuid)
    this.write({
      type: 'user',
      uuid,
      session_id: this.sessionId,
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text }] },
    })
  }

  private waiting(uuid: string): boolean {
    const state = this.commands.get(uuid)
    return state === 'written' || state === 'queued'
  }

  private write(value: Record<string, unknown>): void {
    if (!this.child.stdin || this.closed) throw new BackendError('claude stdin is closed', 'upstream')
    this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      this.observe(value as Record<string, unknown>)
    }
  }

  private observe(message: Record<string, unknown>): void {
    const type = message.type
    if ((type === 'user' || type === 'assistant') && message.isReplay !== true && typeof message.uuid === 'string') {
      this.lastMessageUuid = message.uuid
    }
    if (type === 'command_lifecycle' && typeof message.command_uuid === 'string') {
      this.advanceCommand(message.command_uuid, message.state)
    }
    if (type === 'control_response') {
      const response = record(message.response)
      const requestId = typeof response?.request_id === 'string' ? response.request_id : null
      const waiter = requestId ? this.echoWaiters.get(requestId) : undefined
      if (requestId && waiter) {
        this.echoWaiters.delete(requestId)
        waiter.resolve()
      }
    }
    if (type === 'control_request') {
      const request = record(message.request)
      const requestId = typeof message.request_id === 'string' ? message.request_id : null
      if (requestId && request?.subtype === 'can_use_tool') {
        this.permissions.set(requestId, { input: record(request.input) ?? {} })
      } else if (requestId) {
        // Claude waits for every control request it sends. Refuse the ones
        // the bridge does not implement so a turn can never hang on them.
        try {
          this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'not supported by cli-bridge' } })
        } catch {
          // A closed stdin already ends the turn.
        }
      }
    }
    if (!this.turnCommands) return
    this.enqueue(message)
    if (type === 'command_lifecycle' && typeof message.command_uuid === 'string') {
      const operationId = this.steers.get(message.command_uuid)
      if (operationId && (message.state === 'started' || message.state === 'cancelled')) {
        this.steers.delete(message.command_uuid)
        this.enqueue({
          type: CLAUDE_STEER_RECEIPT,
          operationId,
          commandUuid: message.command_uuid,
          state: message.state === 'started' ? 'applied' : 'cancelled',
        })
      }
    }
  }

  private advanceCommand(uuid: string, rawState: unknown): void {
    const state = rawState === 'queued' || rawState === 'started' || rawState === 'completed' || rawState === 'cancelled'
      ? rawState
      : null
    if (!state || !this.commands.has(uuid)) return
    // A finished message no longer holds a turn open; forget it.
    if (state === 'completed' || state === 'cancelled') this.commands.delete(uuid)
    else this.commands.set(uuid, state)
    const waiters = this.commandWaiters.get(uuid)
    if (!waiters) return
    for (const waiter of waiters) {
      if (!waiter.states.has(state)) continue
      waiters.delete(waiter)
      waiter.resolve(state)
    }
    if (waiters.size === 0) this.commandWaiters.delete(uuid)
  }

  private waitForCommand(uuid: string, states: CommandState[]): Promise<CommandState> {
    const current = this.commands.get(uuid)
    if (current && states.includes(current)) return Promise.resolve(current)
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const waiters = this.commandWaiters.get(uuid) ?? new Set<CommandWaiter>()
      this.commandWaiters.set(uuid, waiters)
      const waiter: CommandWaiter = {
        states: new Set(states),
        resolve: (state) => {
          if (timer) clearTimeout(timer)
          resolve(state)
        },
        reject: (error) => {
          if (timer) clearTimeout(timer)
          reject(error)
        },
      }
      waiters.add(waiter)
      if (this.requestTimeoutMs > 0) {
        timer = setTimeout(() => {
          waiters.delete(waiter)
          reject(new BackendError(`claude did not acknowledge message ${uuid} within ${this.requestTimeoutMs}ms`, 'timeout'))
        }, this.requestTimeoutMs)
        timer.unref?.()
      }
    })
  }

  private waitForEcho(requestId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(this.childError ?? new Error('claude process closed'))
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      this.echoWaiters.set(requestId, {
        resolve: () => {
          if (timer) clearTimeout(timer)
          resolve()
        },
        reject: (error) => {
          if (timer) clearTimeout(timer)
          reject(error)
        },
      })
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.echoWaiters.delete(requestId)
          reject(new BackendError(`claude did not consume control message ${requestId} within ${timeoutMs}ms`, 'timeout'))
        }, timeoutMs)
        timer.unref?.()
      }
    })
  }

  private enqueue(message: Record<string, unknown>): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve(message)
    else this.queue.push(message)
  }

  private nextEvent(signal: AbortSignal): Promise<Record<string, unknown>> {
    if (signal.aborted) return Promise.reject(new Error('claude native turn aborted'))
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.closed) return Promise.reject(this.childError ?? new Error('claude process closed'))
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error('claude native turn aborted'))
      }
      this.waiters.push({
        resolve: (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Claude may print its fatal reason on stderr just before stdout closes. */
  private endAfterStderrDrains(reason: string): void {
    const stderr = this.child.stderr
    if (this.closed || !stderr || stderr.readableEnded || stderr.destroyed) {
      this.end(this.exitError(reason))
      return
    }
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stderr.off('end', finish)
      stderr.off('close', finish)
      this.end(this.exitError(reason))
    }
    const timer = setTimeout(finish, STDERR_DRAIN_GRACE_MS)
    timer.unref?.()
    stderr.once('end', finish)
    stderr.once('close', finish)
  }

  private exitError(reason: string): Error {
    const tail = redactedStderrTail(this.stderr.render())
    return new Error(tail ? `${reason}: ${tail}` : reason)
  }

  private end(error: Error): void {
    const firstClose = !this.closed
    if (firstClose) this.closed = true
    this.childError ??= error
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.childError)
    for (const [uuid, waiters] of this.commandWaiters) {
      this.commandWaiters.delete(uuid)
      for (const waiter of waiters) waiter.reject(this.childError)
    }
    for (const [id, waiter] of this.echoWaiters) {
      this.echoWaiters.delete(id)
      waiter.reject(this.childError)
    }
    this.permissions.clear()
    const cleanup = this.startCleanup()
    if (firstClose) {
      for (const listener of [...this.closeListeners]) {
        try {
          listener(this.childError)
        } catch {
          // A session owner cannot break child cleanup.
        }
      }
      this.closeListeners.clear()
    }
    void cleanup.catch((cleanupError) => {
      this.childError ??= cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
    })
  }

  private startCleanup(): Promise<void> {
    if (this.closing) return this.closing
    const attempt = (async () => {
      try {
        await this.terminate()
      } catch (error) {
        // Keep the lease and private files until the owned workload stops.
        retryCleanupUntilSuccessful(this.retryStartCleanup)
        throw error
      }
      const failures: unknown[] = []
      try {
        await this.cleanup()
      } catch (error) {
        failures.push(error)
        retryCleanupUntilSuccessful(this.cleanup)
      }
      try {
        this.release()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'claude native session cleanup failed')
    })()
    this.closing = attempt
    void attempt.catch(() => {
      if (this.closing === attempt) this.closing = null
    })
    return attempt
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function boundedId(candidate: string): string {
  const trimmed = candidate.trim()
  if (trimmed.length > 0 && trimmed.length <= 512) return trimmed
  return `id:${canonicalCandidateDigest(candidate).slice('sha256:'.length)}`
}
