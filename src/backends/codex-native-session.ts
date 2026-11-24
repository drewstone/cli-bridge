/**
 * One retained Codex thread on `codex app-server --listen stdio://`, Codex's JSON-RPC server over stdio.
 * Measured on Codex 0.169.0 (https://developers.openai.com/codex/app-server):
 *
 * - `thread/start`, or `thread/resume` with a recorded thread id, opens the thread. The Bridge's jail is the
 *   boundary, as for one-shot `codex exec --dangerously-bypass-approvals-and-sandbox`, so Codex's own sandbox is
 *   `danger-full-access`; its approval policy is `untrusted`, so every approval Codex asks for (a command, a file
 *   change, an MCP tool call, which it asks as an `mcpServer/elicitation/request`) reaches the Bridge, which answers
 *   it by the turn's interaction policy.
 * - `turn/start` opens a turn; `turn/started`, `item/*`, `thread/tokenUsage/updated` and `turn/completed` report it.
 * - `turn/steer` delivers input to the running turn (its `expectedTurnId` must be that turn). Codex accepts it at
 *   once and applies it at its next model call, after the running tool call, as a `userMessage` item of the same
 *   turn whose `clientId` is the steer's `clientUserMessageId`.
 * - `turn/interrupt` stops the running turn.
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

/** Bridge-made frame ending a turn; Codex never sends this type. */
export const CODEX_TURN_SETTLED = 'cli-bridge.codex.turn_settled'
/** Server requests Codex makes for an approval, answered through {@link CodexNativeSession.respondToNativeInteraction}. */
export const CODEX_APPROVAL_REQUESTS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'mcpServer/elicitation/request',
])
const INTERRUPT_GRACE_MS = 1_000
const CLOSE_GRACE_MS = 5_000
const MAX_LINE_CHARS = 8 * 1024 * 1024

interface Waiter<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
}

export interface CodexNativeSessionOptions {
  capabilities: AgentEnvironmentCapabilities
  cwd: string
  /** A Codex thread id to continue; null starts one. */
  resumeThreadId: string | null
  /** Bound on every request. */
  requestTimeoutMs: number
  cleanup: () => void | Promise<void>
}

interface TurnState {
  /** Codex's id for the running turn, from the `turn/start` answer or `turn/started`, whichever comes first. */
  turnId: string | null
  /** Steer `clientUserMessageId` -> the caller's control operation id. */
  steers: Map<string, string>
  /** `turn/completed` has been seen; nothing more may be written into this turn. */
  settling: boolean
}

/** An approval Codex is waiting on: its JSON-RPC id and what it asked. */
interface PendingApproval {
  rpcId: string | number
  method: string
  params: Record<string, unknown>
}

export class CodexNativeSession implements NativeSession {
  readonly capabilities: AgentEnvironmentCapabilities
  private readonly life: NativeChild
  private buffer = ''
  private nextRequest = 1
  private readonly requests = new Map<number, Waiter<Record<string, unknown>>>()
  private threadId: string | null = null
  private turnState: TurnState | null = null
  private lastTurnId: string | null = null
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly queue: Record<string, unknown>[] = []
  private readonly readers: Waiter<Record<string, unknown>>[] = []
  private abortInFlight: Promise<void> | null = null

  constructor(spawned: Awaited<ReturnType<Spawner>>, private readonly options: CodexNativeSessionOptions) {
    this.capabilities = options.capabilities
    this.life = new NativeChild(spawned, {
      names: { process: 'codex app-server', session: 'codex native session' },
      onStdout: (chunk) => this.consume(chunk),
      onEnd: (error) => {
        for (const waiters of [this.readers.splice(0), [...this.requests.values()]])
          for (const waiter of waiters) waiter.reject(error)
        this.requests.clear()
        this.approvals.clear()
      },
      cleanup: options.cleanup,
    })
  }

  providerSessionId(): string | null { return this.threadId }
  isClosed(): boolean { return this.life.closed }
  onClose(listener: (reason: Error) => void): () => void { return this.life.onClose(listener) }
  whenClosed(): Promise<void> { return this.life.whenClosed() }

  /** Initialize the server, then start a thread or resume the recorded one; an unknown id is refused, never replaced. */
  async start(signal?: AbortSignal): Promise<void> {
    await this.call('initialize', { clientInfo: { name: 'cli-bridge', title: 'CLI Bridge', version: '0.3.0' } }, 'initialization', signal)
    this.write({ method: 'initialized', params: {} })
    const { cwd, resumeThreadId } = this.options
    const thread = { cwd, approvalPolicy: 'untrusted', sandbox: 'danger-full-access' }
    const opened = resumeThreadId
      ? await this.call('thread/resume', { threadId: resumeThreadId, ...thread, excludeTurns: true }, 'thread resume', signal)
      : await this.call('thread/start', { ...thread, ephemeral: false }, 'thread start', signal)
    const id = record(opened.thread)?.id
    if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(id) || (resumeThreadId && id !== resumeThreadId))
      throw new BackendError(resumeThreadId ? 'Codex resumed a different thread' : 'Codex started a thread without an id', 'upstream')
    this.threadId = id
  }

  async *turn(prompt: string, signal: AbortSignal): AsyncIterable<unknown> {
    if (this.life.closed || !this.threadId) throw new BackendError('codex native session is closed', 'upstream')
    if (this.turnState) throw new BackendError('codex native session already has an active turn', 'upstream')
    const state: TurnState = { turnId: null, steers: new Map(), settling: false }
    this.turnState = state
    const onAbort = (): void => { void this.abort().catch(() => {}) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const started = await this.call('turn/start', { threadId: this.threadId, input: textInput(prompt) }, 'turn start', signal)
      state.turnId ??= stringField(record(started.turn)?.id)
      while (true) {
        const event = await this.next(signal)
        yield event
        if (event.type === CODEX_TURN_SETTLED) return
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
   * Resolves once Codex has taken the input into the running turn. The turn then carries a raw
   * `{ type: 'steer', operationId, state: 'applied' }` when its `userMessage` item appears.
   */
  async steer(prompt: string, operationId?: string): Promise<void> {
    const state = this.turnState
    if (this.life.closed || !this.threadId || !state?.turnId || state.settling)
      throw new BackendError('codex native session has no running turn to steer', 'upstream')
    const clientId = `cli-bridge-steer-${randomUUID()}`
    if (operationId) state.steers.set(clientId, operationId)
    try {
      await this.call('turn/steer', { threadId: this.threadId, expectedTurnId: state.turnId, clientUserMessageId: clientId,
        input: textInput(prompt) }, 'steer')
    } catch (error) {
      // Refused: the input never entered the turn.
      state.steers.delete(clientId)
      throw error
    }
  }

  async abort(): Promise<void> {
    if (this.life.closed) return this.life.startCleanup()
    this.abortInFlight ??= (async () => {
      const turnId = this.turnState?.turnId
      try {
        if (this.threadId && turnId) await this.call('turn/interrupt', { threadId: this.threadId, turnId }, 'interrupt', undefined, INTERRUPT_GRACE_MS)
      } catch {
        // The run is cancelled whatever Codex answers.
      } finally {
        await this.life.terminate().catch(() => {})
        this.life.end(new Error('codex native session aborted'))
        try { await this.life.startCleanup() } finally { this.abortInFlight = null }
      }
    })()
    return this.abortInFlight
  }

  /** Answer one pending approval: `allow_once` accepts it; anything else declines it. */
  async respondToNativeInteraction(id: string, response: Record<string, unknown>): Promise<void> {
    const approval = this.approvals.get(id)
    if (this.life.closed || !approval) throw new BackendError('Codex has no pending approval with this id', 'capability_denied')
    try {
      this.write({ id: approval.rpcId, result: approvalAnswer(approval, response.value === 'allow_once') })
    } finally {
      this.approvals.delete(id)
    }
  }

  /** The last completed Codex turn id, read only between turns. */
  async contextBoundary(input: {
    runId: string; provider: string; environmentId: string; sessionId: string; executionId: string; requestDigest: string
  }): Promise<NativeContextBoundaryProof | null> {
    if (this.life.closed || this.turnState || !this.threadId || !this.lastTurnId) return null
    const revision = `codex:${this.threadId}:${this.lastTurnId}`
    return {
      ...input,
      requestDigest: input.requestDigest as `sha256:${string}`,
      boundary: { kind: 'revision', revision: revision.length <= 512 ? revision : `id:${canonicalCandidateDigest(revision).slice(7)}` },
      observedAt: new Date().toISOString(),
    }
  }

  /** End stdin so the server flushes its thread and exits, then stop what remains. */
  async close(): Promise<void> {
    if (!this.life.closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_GRACE_MS)
        timer.unref?.()
        this.life.onClose(() => { clearTimeout(timer); resolve() })
        this.life.child.stdin?.end()
      })
    }
    this.life.end(new Error('codex native session closed'))
    await this.life.closing
  }

  /** One JSON-RPC request; Codex's error answer is a typed failure naming the operation. */
  private call(method: string, params: Record<string, unknown>, operation: string, signal?: AbortSignal,
    timeoutMs = this.options.requestTimeoutMs): Promise<Record<string, unknown>> {
    if (signal?.aborted) return Promise.reject(new BackendError(`codex ${operation} was cancelled`, 'aborted'))
    const id = this.nextRequest++
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const finish = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.requests.delete(id)
      }
      const onAbort = (): void => { finish(); reject(new BackendError(`codex ${operation} was cancelled`, 'aborted')) }
      const timer = timeoutMs > 0
        ? setTimeout(() => { finish(); reject(new BackendError(`Codex did not answer the ${operation} within ${timeoutMs}ms`, 'timeout')) }, timeoutMs)
        : undefined
      timer?.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      this.requests.set(id, {
        resolve: (value) => { finish(); resolve(value) },
        reject: (error) => { finish(); reject(error) },
      })
      try {
        this.write({ id, method, params })
      } catch (error) {
        finish()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }).catch((error: unknown) => {
      const native = record((error as { native?: unknown } | null)?.native)
      if (!native) throw error
      const message = typeof native.message === 'string' ? `: ${native.message.slice(0, 300)}` : ''
      throw new BackendError(`Codex refused the ${operation} (JSON-RPC ${String(native.code ?? 'error')})${message}`, 'upstream')
    })
  }

  private write(value: Record<string, unknown>): void {
    if (!this.life.child.stdin || this.life.closed) throw new BackendError('codex app-server stdin is closed', 'upstream')
    this.life.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_LINE_CHARS && !this.buffer.includes('\n')) {
      this.buffer = ''
      this.life.end(new Error('codex app-server sent a line over the Bridge bound'))
      return
    }
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      let value: unknown
      try { value = line ? JSON.parse(line) : null } catch { continue }
      const message = record(value)
      if (message) this.observe(message)
    }
  }

  /** Messages are observed one at a time in stdout order, so turn state at `turn/completed` reflects only what came before. */
  private observe(message: Record<string, unknown>): void {
    const method = typeof message.method === 'string' ? message.method : null
    const rpcId = typeof message.id === 'number' || typeof message.id === 'string' ? message.id : null
    if (!method && typeof rpcId === 'number') {
      const waiter = this.requests.get(rpcId)
      const error = record(message.error)
      if (error) waiter?.reject(Object.assign(new Error('codex JSON-RPC error'), { native: error }))
      else waiter?.resolve(record(message.result) ?? {})
      return
    }
    if (!method) return
    const params = record(message.params) ?? {}
    const state = this.turnState
    if (rpcId !== null) {
      // Codex waits on every server request. An approval of the running turn goes to the Bridge; the rest are refused.
      if (state && !state.settling && CODEX_APPROVAL_REQUESTS.has(method) && params.threadId === this.threadId) {
        this.approvals.set(String(rpcId), { rpcId, method, params })
        this.enqueue(message)
        return
      }
      try {
        this.write({ id: rpcId, error: { code: -32601, message: `${method} is not supported by cli-bridge` } })
      } catch {
        // A closed stdin already ends the turn.
      }
      if (state && !state.settling) this.enqueue({ type: 'warning', code: 'unsupported_interaction', method })
      return
    }
    const threadId = params.threadId ?? record(params.thread)?.id
    if (threadId !== undefined && threadId !== this.threadId) return
    const turnId = stringField(params.turnId) ?? stringField(record(params.turn)?.id)
    if (method === 'turn/completed' && turnId) this.lastTurnId = turnId
    if (!state || state.settling) return
    if (method === 'turn/started') state.turnId ??= turnId
    this.enqueue(message)
    const item = record(params.item)
    if (method === 'item/started' && item?.type === 'userMessage' && typeof item.clientId === 'string') {
      const operationId = state.steers.get(item.clientId)
      state.steers.delete(item.clientId)
      if (operationId) this.enqueue({ type: 'steer', operationId, clientUserMessageId: item.clientId, state: 'applied' })
    }
    if (method === 'turn/completed' && (!state.turnId || state.turnId === turnId)) {
      state.settling = true
      this.enqueue({ type: CODEX_TURN_SETTLED })
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
    if (this.life.closed) return Promise.reject(this.life.error ?? new Error('codex app-server process closed'))
    if (signal.aborted) return Promise.reject(new Error('codex native turn aborted'))
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.readers.indexOf(reader)
        if (index >= 0) this.readers.splice(index, 1)
        reject(new Error('codex native turn aborted'))
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

/** The answer Codex expects for one approval: accept it, or decline it. */
function approvalAnswer(approval: PendingApproval, allowed: boolean): Record<string, unknown> {
  if (approval.method === 'mcpServer/elicitation/request')
    return allowed ? { action: 'accept', content: {}, _meta: null } : { action: 'decline', content: null, _meta: null }
  if (allowed) return { decision: 'accept' }
  // A command approval lists the decisions it takes; decline when offered, else cancel.
  const offered = approval.params.availableDecisions
  return { decision: !Array.isArray(offered) || offered.includes('decline') ? 'decline' : 'cancel' }
}

/** Whether an elicitation is Codex asking approval for an MCP tool call, rather than an MCP server's own form. */
export function isCodexToolApproval(params: Record<string, unknown>): boolean {
  return record(params._meta)?.codex_approval_kind === 'mcp_tool_call'
}

function textInput(text: string): Record<string, unknown>[] {
  return [{ type: 'text', text, text_elements: [] }]
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
