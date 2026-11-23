import { randomUUID } from 'node:crypto'
import {
  canonicalCandidateDigest,
  type AgentEnvironmentCapabilities,
  type NativeContextBoundaryProof,
} from '@tangle-network/agent-interface'
import type { NativeSession } from './types.js'
import { BackendError } from './types.js'
import type { Spawner } from '../executors/types.js'
import { NativeChild } from './native-child.js'
import { piPermissionMarker, piPermissionTokenFromTitle, piSelectedValue } from './pi-interaction.js'

export interface PiNativeSessionOptions {
  capabilities: AgentEnvironmentCapabilities
  requestTimeoutMs: number
  cleanup(): void | Promise<void>
  providerSessionId?: string
}

interface PiRpcResponse {
  type?: string
  id?: string | number
  command?: string
  success?: boolean
  error?: string
  data?: unknown
}

interface PiRpcWaiter {
  resolve: (value: PiRpcResponse) => void
  reject: (error: Error) => void
}

interface PiRpcRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

interface PiMarkerWaiter {
  readonly marker: string
  readonly afterSequence: number
  resolve: () => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export { redactedStderrTail } from './native-child.js'

/** A single Pi RPC child; the retained-session service owns the public events. */
export class PiNativeSession implements NativeSession {
  readonly capabilities: AgentEnvironmentCapabilities
  private readonly life: NativeChild
  private readonly requestTimeoutMs: number
  private readonly pending = new Map<string | number, PiRpcWaiter>()
  private readonly queue: Record<string, unknown>[] = []
  private readonly waiters: Array<{
    resolve: (value: Record<string, unknown>) => void
    reject: (error: Error) => void
  }> = []
  private readonly markerWaiters = new Set<PiMarkerWaiter>()
  private readonly interactionMarkers = new Map<string, string>()
  private buffer = ''
  private eventSequence = 0
  private providerSession: string | null
  private turnActive = false
  private abortInFlight: Promise<void> | null = null

  constructor(spawned: Awaited<ReturnType<Spawner>>, options: PiNativeSessionOptions) {
    this.capabilities = options.capabilities
    this.requestTimeoutMs = options.requestTimeoutMs
    this.providerSession = options.providerSessionId ?? null
    this.life = new NativeChild(spawned, {
      names: { process: 'pi RPC', session: 'pi native session' },
      onStdout: (chunk) => this.consume(chunk),
      onEnd: (error) => this.settleWaiters(error),
      cleanup: options.cleanup,
    })
  }

  private get closed(): boolean {
    return this.life.closed
  }

  private get childError(): Error | null {
    return this.life.error
  }

  private get child(): NativeChild['child'] {
    return this.life.child
  }

  providerSessionId(): string | null {
    return this.providerSession
  }

  isClosed(): boolean {
    return this.closed
  }

  onClose(listener: (reason: Error) => void): () => void {
    return this.life.onClose(listener)
  }

  whenClosed(): Promise<void> {
    return this.life.whenClosed()
  }

  async *turn(prompt: string, signal: AbortSignal): AsyncIterable<unknown> {
    if (this.closed) throw new BackendError('pi native session is closed', 'upstream')
    if (this.turnActive) throw new BackendError('pi native session already has an active turn', 'upstream')
    this.turnActive = true
    const requestId = `prompt-${randomUUID()}`
    const onAbort = (): void => {
      void this.abort().catch(() => {
        // The explicit turn path observes the failure. The signal listener
        // must also settle its own promise so Node cannot exit on rejection.
      })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await this.request(
        { id: requestId, type: 'prompt', message: prompt },
        { signal, timeoutMs: this.requestTimeoutMs },
      )
      while (!this.closed) {
        const event = await this.nextEvent(signal)
        // A handled prompt starts no agent run. Its response is queued after
        // any extension events it emitted, so those stay in this turn.
        if (event.type === 'session' && typeof event.id === 'string') this.providerSession = event.id
        yield event
        if (event === response) return
        // `agent_end` closes one low-level model attempt and may be followed by
        // an automatic retry or compaction. `agent_settled` is Pi's documented
        // session-level terminal boundary for prompts that started a run.
        if (event.type === 'agent_settled') return
      }
      throw this.childError ?? new Error('pi native session ended before agent_settled')
    } catch (error) {
      if (signal.aborted || (error instanceof BackendError && (error.code === 'timeout' || error.code === 'aborted'))) {
        // A prompt can be accepted by the OS while Pi never acknowledges it.
        // Try the native abort command within the same bounded window, then
        // close the child so the retained session cannot keep a lease.
        await this.abort()
      }
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.turnActive = false
    }
  }

  async steer(prompt: string): Promise<void> {
    await this.request({ id: `steer-${randomUUID()}`, type: 'steer', message: prompt })
  }

  async abort(): Promise<void> {
    if (this.closed) return this.life.startCleanup()
    if (this.abortInFlight) return this.abortInFlight
    this.abortInFlight = (async () => {
      // Keep the hard-stop running while the courtesy RPC uses its bounded
      // window. A failed first stop is retried by startCleanup below.
      const termination = this.life.terminate().catch(() => {})
      try {
        await this.request(
          { id: `abort-${randomUUID()}`, type: 'abort' },
          // Abort is a courtesy protocol message. The executor hard-stop runs
          // in parallel because Pi may ignore it or stop answering JSON-RPC.
          { timeoutMs: Math.min(this.requestTimeoutMs, 1_000) },
        )
      } catch {
        // The owned Run turns an abort into a cancelled terminal state even when
        // Pi closes the RPC pipe before acknowledging the command.
      } finally {
        await termination
        this.life.end(new Error('pi native session aborted'))
        try {
          await this.life.startCleanup()
        } finally {
          this.abortInFlight = null
        }
      }
    })()
    return this.abortInFlight
  }

  async respondToNativeInteraction(id: string, response: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new BackendError('pi native session is closed', 'upstream')
    const token = this.interactionMarkers.get(id)
    if (!token) {
      throw new BackendError('Pi interaction is not an instrumented permission dialog', 'capability_denied')
    }
    const marker = piPermissionMarker(token, piSelectedValue(response))
    const afterSequence = this.eventSequence
    const waitForMarker = this.waitForMarkerAfter(marker, afterSequence)
    try {
      this.write({ type: 'extension_ui_response', id, ...response })
      // Pi 0.83 does not acknowledge extension_ui_response on the command
      // channel. The injected extension's exact notify marker is the only
      // proof that this specific select response was applied.
      await waitForMarker
    } finally {
      this.interactionMarkers.delete(id)
    }
  }

  async contextBoundary(input: {
    runId: string
    provider: string
    environmentId: string
    sessionId: string
    executionId: string
    requestDigest: string
  }): Promise<NativeContextBoundaryProof | null> {
    if (this.closed) return null
    let response: PiRpcResponse
    try {
      response = await this.request({ type: 'get_state' }, { timeoutMs: this.requestTimeoutMs })
    } catch (error) {
      if (error instanceof BackendError && error.code === 'timeout') await this.close()
      throw error
    }
    const data = record(response.data)
    const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : this.providerSession
    const messageCount = typeof data?.messageCount === 'number' ? data.messageCount : null
    if (!sessionId || messageCount === null || !Number.isSafeInteger(messageCount) || messageCount < 0) return null
    this.providerSession = sessionId
    return {
      runId: input.runId,
      provider: input.provider,
      environmentId: input.environmentId,
      sessionId: input.sessionId,
      executionId: input.executionId,
      requestDigest: input.requestDigest as `sha256:${string}`,
      boundary: { kind: 'revision', revision: boundedPiId(`pi:${sessionId}:${messageCount}`) },
      observedAt: new Date().toISOString(),
    }
  }

  async close(): Promise<void> {
    this.life.end(new Error('pi native session closed'))
    await this.life.closing
  }

  private request(command: Record<string, unknown>, options: PiRpcRequestOptions = {}): Promise<PiRpcResponse> {
    const id = (command.id as string | number | undefined) ?? `rpc-${randomUUID()}`
    const wireCommand = { ...command, id }
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('pi RPC process is closed'))
        return
      }
      if (options.signal?.aborted) {
        reject(new BackendError(`pi RPC ${String(command.type ?? 'request')} aborted`, 'aborted'))
        return
      }

      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      let onAbort: (() => void) | undefined
      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        if (onAbort && options.signal) options.signal.removeEventListener('abort', onAbort)
      }
      const settle = (callback: () => void): void => {
        if (settled) return
        settled = true
        this.pending.delete(id)
        cleanup()
        callback()
      }
      const waiter: PiRpcWaiter = {
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error)),
      }
      this.pending.set(id, waiter)
      onAbort = (): void =>
        settle(() => reject(new BackendError(`pi RPC ${String(command.type ?? 'request')} aborted`, 'aborted')))
      options.signal?.addEventListener('abort', onAbort, { once: true })
      // AbortSignal does not invoke a listener added after the signal became
      // aborted. Re-check after registration so a prompt cannot slip into a
      // child after its owning run has already been cancelled.
      if (options.signal?.aborted) {
        onAbort()
        return
      }
      const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs
      if (timeoutMs > 0) {
        timer = setTimeout(
          () =>
            settle(() =>
              reject(
                new BackendError(
                  `pi RPC ${String(command.type ?? 'request')} timed out after ${timeoutMs}ms`,
                  'timeout',
                ),
              ),
            ),
          timeoutMs,
        )
        timer.unref?.()
      }
      try {
        if (settled) return
        this.write(wireCommand)
      } catch (error) {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))))
        this.life.end(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private write(value: Record<string, unknown>): void {
    if (!this.child.stdin || this.closed) throw new Error('pi RPC stdin is closed')
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
      const message = record(value)
      if (!message) continue
      const id = message.id as string | number | undefined
      if (message.type === 'response' && id !== undefined && this.pending.has(id)) {
        const waiter = this.pending.get(id)!
        this.pending.delete(id)
        if (message.success === false) waiter.reject(new Error(String(message.error ?? 'pi RPC command failed')))
        else {
          if (message.command === 'prompt' && message.success === true && record(message.data)?.disposition === 'handled') {
            // Pi's handled disposition is the terminal boundary when no
            // agent_settled event will follow (Pi RPC run-lifecycle contract).
            this.queue.push(message)
          }
          waiter.resolve(message as PiRpcResponse)
        }
        continue
      }
      this.eventSequence += 1
      this.observeInteractionMarker(message)
      const waiter = this.waiters.shift()
      if (waiter) waiter.resolve(message)
      else this.queue.push(message)
    }
  }

  private waitForMarkerAfter(marker: string, afterSequence: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(this.childError ?? new Error('pi RPC process closed'))
        return
      }
      const waiter: PiMarkerWaiter = { marker, afterSequence, resolve, reject }
      const timeoutMs = this.requestTimeoutMs > 0 ? this.requestTimeoutMs : 30_000
      waiter.timer = setTimeout(() => {
        this.markerWaiters.delete(waiter)
        reject(new BackendError(`pi RPC interaction response produced no exact marker after ${timeoutMs}ms`, 'timeout'))
      }, timeoutMs)
      waiter.timer.unref?.()
      this.markerWaiters.add(waiter)
    })
  }

  private observeInteractionMarker(message: Record<string, unknown>): void {
    if (message.type === 'extension_ui_request' && message.method === 'select') {
      const id = typeof message.id === 'string' ? message.id : null
      const token = typeof message.title === 'string' ? piPermissionTokenFromTitle(message.title) : null
      if (id && token) this.interactionMarkers.set(id, token)
    }
    if (message.type !== 'extension_ui_request' || message.method !== 'notify' || typeof message.message !== 'string')
      return
    for (const waiter of this.markerWaiters) {
      if (this.eventSequence <= waiter.afterSequence || message.message !== waiter.marker) continue
      this.markerWaiters.delete(waiter)
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve()
    }
  }

  private nextEvent(signal: AbortSignal): Promise<Record<string, unknown>> {
    if (signal.aborted) return Promise.reject(new Error('pi native turn aborted'))
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.closed) return Promise.reject(this.childError ?? new Error('pi RPC process closed'))
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve)
        if (index >= 0) this.waiters.splice(index, 1)
        signal.removeEventListener('abort', onAbort)
        reject(new Error('pi native turn aborted'))
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

  private settleWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id)
      waiter.reject(error)
    }
    for (const waiter of this.markerWaiters) {
      this.markerWaiters.delete(waiter)
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.interactionMarkers.clear()
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function boundedPiId(candidate: string): string {
  const trimmed = candidate.trim()
  if (trimmed.length > 0 && trimmed.length <= 512) return trimmed
  return `id:${canonicalCandidateDigest(candidate).slice('sha256:'.length)}`
}
