/**
 * One retained ACP agent session: a `<bin> acp` process (JSON-RPC 2.0 over ndjson stdio) holding one
 * agent session across Bridge turns. Measured on hermes 0.23.2:
 *
 * - The agent serves requests concurrently, so a `session/prompt` sent while another runs is answered
 *   on its own. hermes's ACP command `/steer <text>` gives guidance to the running turn: it is answered
 *   at once ("Steer queued for the active turn"), and hermes applies the text after the running tool
 *   call, inside the same prompt, whose answer then follows it.
 * - hermes posts its own reply to a command as an `agent_message_chunk` without a `messageId`; model
 *   text carries one. A chunk without one while a steer is in flight is that steer's receipt, not text.
 * - `session/resume` of a stored session replays its history as `session/update` before answering;
 *   updates outside a turn are never a turn's output.
 *
 * Measured on Gemini CLI 0.68 (`gemini --acp`):
 *
 * - The agent has no command that adds guidance to a running prompt. A second `session/prompt` ends
 *   the running one: its tool call is reported `failed` ("Tool call aborted"), it is answered
 *   `stopReason: cancelled`, and the agent answers the new prompt in the same session, with the
 *   earlier turns still in its history.
 * - Its message chunks carry no `messageId`, and each tool call asks `session/request_permission`.
 *
 * Copilot CLI, Qwen Code and Grok CLI are measured in acp-agents.ts.
 *
 * Every `session/request_permission` reaches the Bridge, which answers it by the turn's interaction
 * policy; `session/cancel` stops the running prompt.
 */

import {
  canonicalCandidateDigest,
  type AgentEnvironmentCapabilities,
  type NativeContextBoundaryProof,
} from '@tangle-network/agent-interface'
import type { NativeSession } from './types.js'
import { BackendError } from './types.js'
import { NativeChild } from './native-child.js'
import type { Spawner } from '../executors/types.js'

/** Bridge-made frame ending a turn; ACP agents never send this type. */
export const ACP_TURN_SETTLED = 'cli-bridge.acp.turn_settled'
/** A permission request the agent is waiting on, as the turn reads it. */
export const ACP_PERMISSION = 'cli-bridge.acp.permission'
const CANCEL_GRACE_MS = 2_000
const CLOSE_GRACE_MS = 5_000

interface Waiter<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
}

interface AcpCapabilities {
  loadSession?: boolean
  sessionCapabilities?: { resume?: unknown }
}

/** How an agent takes input for its running turn. */
export type AcpSteer =
  /**
   * A command of the agent's own (`/steer` for hermes), sent as a concurrent `session/prompt`. The
   * agent answers it at once and applies the text after the running tool call, inside the same prompt.
   */
  | { command: string }
  /**
   * The input is itself a second `session/prompt` (Gemini CLI). The agent ends the running prompt,
   * aborting its tool call, and answers the input; the Bridge turn goes on with that answer.
   */
  | 'prompt'
  /**
   * As `prompt`, for an agent that queues a second `session/prompt` behind the running one (Grok CLI):
   * the Bridge sends `session/cancel` first, so the agent ends the running prompt and answers the input.
   */
  | 'interrupt'

/** ACP's token counts for a prompt, by the protocol's names. */
export type AcpUsage = Partial<Record<typeof ACP_USAGE_KEYS[number], number>>
const ACP_USAGE_KEYS = ['inputTokens', 'outputTokens', 'thoughtTokens', 'cachedReadTokens', 'cachedWriteTokens'] as const

function acpUsageCounts(value: unknown): AcpUsage | undefined {
  const source = record(value)
  if (!source) return undefined
  const counts: AcpUsage = {}
  for (const key of ACP_USAGE_KEYS) {
    const count = source[key]
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) counts[key] = count
  }
  return Object.keys(counts).length > 0 ? counts : undefined
}

/**
 * The tokens one prompt used, where the agent reports them: ACP's `usage` on the `session/prompt`
 * result (hermes, Copilot CLI), else `_meta.usage` on it (Grok CLI), else the sum of the `_meta.usage`
 * its message chunks carry, one per model call (Qwen Code).
 */
export function acpPromptUsage(result: unknown, chunkUsage: readonly unknown[]): AcpUsage | undefined {
  const answer = record(result)
  const reported = acpUsageCounts(answer?.usage) ?? acpUsageCounts(record(answer?._meta)?.usage)
  if (reported) return reported
  const summed: AcpUsage = {}
  for (const counts of chunkUsage.map((usage) => acpUsageCounts(usage))) {
    for (const key of ACP_USAGE_KEYS) {
      const count = counts?.[key]
      if (count !== undefined) summed[key] = (summed[key] ?? 0) + count
    }
  }
  return Object.keys(summed).length > 0 ? summed : undefined
}

/** The `_meta.usage` a message chunk carries (Qwen Code reports each model call's usage this way). */
export function acpChunkUsage(update: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return update?.sessionUpdate === 'agent_message_chunk' ? record(record(update._meta)?.usage) : undefined
}

export interface AcpNativeSessionOptions {
  /** Backend name, used in errors. */
  name: string
  capabilities: AgentEnvironmentCapabilities
  cwd: string
  mcpServers: Array<Record<string, unknown>>
  /** An agent session id to continue; null creates one. */
  resumeSessionId: string | null
  /** How the agent takes input for its running turn, or null when it takes none. */
  steer: AcpSteer | null
  /** True when a prompt result's usage totals every prompt the process has answered (Copilot CLI). */
  cumulativeUsage?: boolean
  /** Bound on every request except a prompt. */
  requestTimeoutMs: number
  cleanup: () => void | Promise<void>
}

interface TurnState {
  /** Steer commands sent and not yet answered. */
  steering: number
  settled: boolean
  /** Prompts sent in this turn. The answer to the last one settles it; one a steer replaced does not. */
  prompts: number
  /** Steers waiting for the prompt they replaced to be answered, oldest first. */
  replacing: Array<() => void>
  /** The `_meta.usage` of the turn's message chunks. */
  chunkUsage: Record<string, unknown>[]
}

interface Permission {
  rpcId: number | string
  options: Array<{ optionId: string; kind: string }>
}

export class AcpNativeSession implements NativeSession {
  readonly capabilities: AgentEnvironmentCapabilities
  private readonly life: NativeChild
  private buffer = ''
  private nextRequest = 1
  private readonly requests = new Map<number, Waiter<unknown>>()
  private sessionId: string | null = null
  private turnState: TurnState | null = null
  private completedTurns = 0
  private readonly permissions = new Map<string, Permission>()
  private readonly queue: Record<string, unknown>[] = []
  private readonly readers: Waiter<Record<string, unknown>>[] = []
  private abortInFlight: Promise<void> | null = null
  /** The usage totals of the process's last answered prompt, for an agent that reports totals. */
  private usageTotals: AcpUsage = {}

  constructor(spawned: Awaited<ReturnType<Spawner>>, private readonly options: AcpNativeSessionOptions) {
    this.capabilities = options.capabilities
    this.life = new NativeChild(spawned, {
      names: { process: `${options.name} acp`, session: `${options.name} native session` },
      onStdout: (chunk) => this.consume(chunk),
      onEnd: (error) => {
        for (const waiters of [this.readers.splice(0), [...this.requests.values()]]) for (const waiter of waiters) waiter.reject(error)
        this.requests.clear()
        this.permissions.clear()
      },
      cleanup: options.cleanup,
    })
  }

  providerSessionId(): string | null { return this.sessionId }
  isClosed(): boolean { return this.life.closed }
  onClose(listener: (reason: Error) => void): () => void { return this.life.onClose(listener) }
  whenClosed(): Promise<void> { return this.life.whenClosed() }

  /** Initialize the agent, then continue the given session (resume, else load) or create one. */
  async start(signal?: AbortSignal): Promise<void> {
    const init = await this.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
      'initialize', this.options.requestTimeoutMs, signal) as { agentCapabilities?: AcpCapabilities } | null
    const capabilities = init?.agentCapabilities
    const { cwd, mcpServers, resumeSessionId } = this.options
    if (resumeSessionId && (capabilities?.sessionCapabilities?.resume || capabilities?.loadSession)) {
      const method = capabilities.sessionCapabilities?.resume ? 'session/resume' : 'session/load'
      await this.call(method, { sessionId: resumeSessionId, cwd, mcpServers }, 'session resume', this.options.requestTimeoutMs, signal)
      this.sessionId = resumeSessionId
      return
    }
    const created = await this.call('session/new', { cwd, mcpServers }, 'session creation', this.options.requestTimeoutMs, signal) as { sessionId?: unknown } | null
    if (typeof created?.sessionId !== 'string' || !/^[\w.:-]{1,256}$/u.test(created.sessionId)) {
      throw new BackendError(`${this.options.name} acp created a session without a usable id`, 'upstream')
    }
    this.sessionId = created.sessionId
  }

  async *turn(prompt: string, signal: AbortSignal): AsyncIterable<unknown> {
    const sessionId = this.sessionId
    if (this.life.closed || !sessionId) throw new BackendError(`${this.options.name} native session is closed`, 'upstream')
    if (this.turnState) throw new BackendError(`${this.options.name} native session already has an active turn`, 'upstream')
    const state: TurnState = { steering: 0, settled: false, prompts: 0, replacing: [], chunkUsage: [] }
    this.turnState = state
    const onAbort = (): void => { void this.abort().catch(() => {}) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      this.prompt(state, sessionId, prompt)
      while (true) {
        const event = await this.next(signal)
        yield event
        if (event.type === ACP_TURN_SETTLED) return
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
   * Resolves once the agent has accepted the input for the running turn. With a steer command the
   * turn then carries a raw `{ type: 'steer', operationId, state: 'queued' }` and the agent applies
   * the input at its next safe point. With a steer that is a prompt, the agent has accepted it when it
   * answers the prompt it replaced, and the turn carries `state: 'applied'`.
   */
  async steer(prompt: string, operationId?: string): Promise<void> {
    const state = this.turnState
    const steer = this.options.steer
    if (!steer) {
      throw new BackendError(`${this.options.name} acp takes no input for a running turn`, 'capability_denied')
    }
    if (this.life.closed || !this.sessionId || !state || state.settled) {
      throw new BackendError(`${this.options.name} native session has no running turn to steer`, 'upstream')
    }
    const receipt = { type: 'steer', ...(operationId ? { operationId } : {}) }
    if (steer === 'prompt' || steer === 'interrupt') {
      let timer: NodeJS.Timeout | undefined
      const replaced = new Promise<void>((resolve, reject) => {
        // The receipt is queued as the replaced prompt's answer is read, so it never follows the turn's end.
        state.replacing.push(() => {
          if (!state.settled) this.enqueue({ ...receipt, state: 'applied' })
          resolve()
        })
        timer = setTimeout(() => reject(new BackendError(
          `${this.options.name} acp did not end its running prompt within ${this.options.requestTimeoutMs}ms of the steer`, 'timeout')), this.options.requestTimeoutMs)
        timer.unref?.()
      })
      if (steer === 'interrupt') this.notify('session/cancel', { sessionId: this.sessionId })
      this.prompt(state, this.sessionId, prompt)
      try { await replaced } finally { clearTimeout(timer) }
      return
    }
    state.steering += 1
    try {
      await this.call('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: `${steer.command} ${prompt}` }] },
        'steer', this.options.requestTimeoutMs)
    } finally {
      state.steering -= 1
    }
    if (!state.settled) this.enqueue({ ...receipt, state: 'queued' })
  }

  /**
   * Send one prompt of the turn. The answer to the turn's last prompt settles it; the answer to one a
   * steer replaced is that steer's receipt.
   */
  private prompt(state: TurnState, sessionId: string, text: string): void {
    const sent = ++state.prompts
    const answered = (outcome: { result?: unknown; error?: string }): void => {
      if (sent === state.prompts) this.settle(state, outcome)
      else state.replacing.shift()?.()
    }
    this.call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 'prompt', 0).then(
      (result) => answered({ result }),
      (error: unknown) => answered({ error: error instanceof Error ? error.message : String(error) }),
    )
  }

  /** Ask the agent to cancel the running prompt, then stop the process. */
  async abort(): Promise<void> {
    if (this.life.closed) return this.life.startCleanup()
    this.abortInFlight ??= (async () => {
      try {
        if (this.sessionId) {
          this.notify('session/cancel', { sessionId: this.sessionId })
          const state = this.turnState
          if (state && !state.settled) await new Promise((resolve) => { const timer = setTimeout(resolve, CANCEL_GRACE_MS); timer.unref?.() })
        }
      } catch {
        // The run is cancelled whatever the agent answers.
      } finally {
        await this.life.terminate().catch(() => {})
        this.life.end(new Error(`${this.options.name} native session aborted`))
        try { await this.life.startCleanup() } finally { this.abortInFlight = null }
      }
    })()
    return this.abortInFlight
  }

  /** Answer one pending permission request: `allow_once` selects the agent's allow-once option, anything else rejects. */
  async respondToNativeInteraction(id: string, response: Record<string, unknown>): Promise<void> {
    const permission = this.permissions.get(id)
    if (this.life.closed || !permission) {
      throw new BackendError(`${this.options.name} has no pending interaction with this id`, 'capability_denied')
    }
    this.permissions.delete(id)
    const pick = (kinds: string[]) => permission.options.find((option) => kinds.includes(option.kind))
    const option = response.cancelled === true ? undefined
      : response.value === 'allow_once' ? pick(['allow_once']) : pick(['reject_once', 'reject_always'])
    this.write({ jsonrpc: '2.0', id: permission.rpcId,
      result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } })
  }

  /** The agent session and the number of turns this process has completed in it, read only between turns. */
  async contextBoundary(input: {
    runId: string; provider: string; environmentId: string; sessionId: string; executionId: string; requestDigest: string
  }): Promise<NativeContextBoundaryProof | null> {
    if (this.life.closed || this.turnState || !this.sessionId || this.completedTurns === 0) return null
    const revision = `acp:${this.sessionId}:${this.completedTurns}`
    return {
      ...input,
      requestDigest: input.requestDigest as `sha256:${string}`,
      boundary: { kind: 'revision', revision: revision.length <= 512 ? revision : `id:${canonicalCandidateDigest(revision).slice(7)}` },
      observedAt: new Date().toISOString(),
    }
  }

  /** End stdin so the agent exits on its own, then stop what remains. */
  async close(): Promise<void> {
    if (!this.life.closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_GRACE_MS)
        timer.unref?.()
        this.life.onClose(() => { clearTimeout(timer); resolve() })
        this.life.child.stdin?.end()
      })
    }
    this.life.end(new Error(`${this.options.name} native session closed`))
    await this.life.closing
  }

  private settle(state: TurnState, outcome: { result?: unknown; error?: string }): void {
    if (state.settled) return
    state.settled = true
    // The turn's last prompt is answered, so the agent has taken every steer before it.
    for (const accepted of state.replacing.splice(0)) accepted()
    if (outcome.error === undefined) this.completedTurns += 1
    const result = outcome.result !== null && typeof outcome.result === 'object' ? outcome.result as Record<string, unknown> : {}
    let usage = acpPromptUsage(result, state.chunkUsage)
    if (this.options.cumulativeUsage && usage) {
      const totals = usage, delta: AcpUsage = {}
      for (const key of ACP_USAGE_KEYS) {
        const count = totals[key]
        if (count !== undefined) delta[key] = Math.max(0, count - (this.usageTotals[key] ?? 0))
      }
      usage = delta
      this.usageTotals = totals
    }
    if (this.turnState === state) {
      this.enqueue({ type: ACP_TURN_SETTLED, stopReason: result.stopReason, usage,
        ...(outcome.error === undefined ? {} : { error: outcome.error }) })
    }
  }

  /** One request; a timeout of zero waits for the answer however long the agent takes. */
  private async call(method: string, params: unknown, operation: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextRequest++
    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined
    const reply = new Promise<unknown>((resolve, reject) => {
      const settle = (): void => { clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort) }
      this.requests.set(id, {
        resolve: (value) => { settle(); resolve(value) },
        reject: (error) => { settle(); reject(error) },
      })
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.requests.delete(id)
          reject(new BackendError(`${this.options.name} acp did not answer the ${operation} within ${timeoutMs}ms`, 'timeout'))
        }, timeoutMs)
        timer.unref?.()
      }
      if (signal) {
        onAbort = () => {
          this.requests.delete(id)
          reject(new BackendError(`${this.options.name} acp ${operation} was cancelled`, 'aborted'))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    this.write({ jsonrpc: '2.0', id, method, params })
    return await reply
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(value: Record<string, unknown>): void {
    if (!this.life.child.stdin || this.life.closed) throw new BackendError(`${this.options.name} native session stdin is closed`, 'upstream')
    this.life.child.stdin.write(`${JSON.stringify(value)}\n`)
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
      if (message) this.observe(message)
    }
  }

  private observe(message: Record<string, unknown>): void {
    const method = typeof message.method === 'string' ? message.method : null
    const rpcId = typeof message.id === 'number' || typeof message.id === 'string' ? message.id : null
    if (!method && typeof rpcId === 'number') {
      const waiter = this.requests.get(rpcId)
      this.requests.delete(rpcId)
      const error = record(message.error)
      if (error) {
        const wire = JSON.stringify({ code: error.code, message: error.message, data: error.data }).slice(0, 300)
        waiter?.reject(new BackendError(`${this.options.name} acp error: ${wire}`, 'upstream'))
      } else waiter?.resolve(message.result ?? null)
      return
    }
    const params = record(message.params) ?? {}
    const state = this.turnState
    if (method === 'session/update') {
      // Outside a turn an update is a resumed session's replay, or a late frame of a settled turn.
      if (!state || state.settled || params.sessionId !== this.sessionId) return
      const update = record(params.update)
      const chunkUsage = acpChunkUsage(update)
      if (chunkUsage) state.chunkUsage.push(chunkUsage)
      if (state.steering > 0 && update?.sessionUpdate === 'agent_message_chunk' && update.messageId === undefined) {
        this.enqueue({ type: 'steer.receipt', update })
        return
      }
      this.enqueue({ type: 'session/update', update })
      return
    }
    if (method === 'session/request_permission' && rpcId !== null) {
      if (!state || state.settled) {
        this.write({ jsonrpc: '2.0', id: rpcId, result: { outcome: { outcome: 'cancelled' } } })
        return
      }
      const id = `permission-${String(rpcId)}`
      const options = (Array.isArray(params.options) ? params.options : []).flatMap((option) => {
        const entry = record(option)
        return typeof entry?.optionId === 'string' && typeof entry.kind === 'string' ? [{ optionId: entry.optionId, kind: entry.kind }] : []
      })
      this.permissions.set(id, { rpcId, options })
      this.enqueue({ type: ACP_PERMISSION, id, toolCall: record(params.toolCall) ?? {} })
      return
    }
    // Any other agent request (file system or terminal methods this client declined): refuse it.
    if (method && rpcId !== null) this.write({ jsonrpc: '2.0', id: rpcId, error: { code: -32601, message: 'method not supported by cli-bridge ACP client' } })
  }

  private enqueue(message: Record<string, unknown>): void {
    const reader = this.readers.shift()
    if (reader) reader.resolve(message)
    else this.queue.push(message)
  }

  private next(signal: AbortSignal): Promise<Record<string, unknown>> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.life.closed) return Promise.reject(this.life.error ?? new Error(`${this.options.name} acp process closed`))
    if (signal.aborted) return Promise.reject(new Error(`${this.options.name} native turn aborted`))
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.readers.indexOf(reader)
        if (index >= 0) this.readers.splice(index, 1)
        reject(new Error(`${this.options.name} native turn aborted`))
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
