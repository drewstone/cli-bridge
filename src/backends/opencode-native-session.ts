/**
 * One retained `opencode serve` process, driven over its v1 HTTP API on a unix socket
 * (see opencode-serve-socket.mjs for why a socket).
 *
 * Measured on opencode 1.19.6 against a local scripted model:
 * - `POST /session/:id/prompt_async` admits the user message at once (`message.updated`, role user)
 *   and runs the agent loop; the session reports `session.status` busy, then idle and `session.idle`.
 * - A second `prompt_async` while the loop runs is a steer: its user message is admitted at once,
 *   and the running loop's next model call carries it as the last user message. The answer is an
 *   assistant message whose `parentID` is the steer's message, inside the same busy period.
 * - `POST /session/:id/abort` ends the loop with `session.error` MessageAbortedError, then idle.
 * - `permission.asked` waits on `POST /permission/:id/reply` `{ reply: "once" | "reject" }`.
 * - The v2 `/api/session/:id/prompt` (`delivery: "steer"`) drives a separate runtime that ignores
 *   the session's configured model, so this session uses the v1 API only.
 */

import { request as httpRequest, type ClientRequest } from 'node:http'
import {
  canonicalCandidateDigest,
  type AgentEnvironmentCapabilities,
  type NativeContextBoundaryProof,
} from '@tangle-network/agent-interface'
import type { NativeSession } from './types.js'
import { BackendError } from './types.js'
import { NativeChild } from './native-child.js'
import type { Spawner } from '../executors/types.js'

/** Bridge-made event ending a turn; opencode never sends this type. */
export const OPENCODE_TURN_SETTLED = 'cli-bridge.opencode.turn_settled'
const READY_LINE = 'cli-bridge.opencode-serve'
const READY_TIMEOUT_MS = 60_000
const CONTROL_TIMEOUT_MS = 30_000
const ABORT_GRACE_MS = 1_000
/** After idle, how long an admitted steer the loop did not answer may take to start the next loop. */
const STEER_IDLE_GRACE_MS = 2_000
/** opencode's question and plan tools wait on a person; a Bridge session has none to ask. */
const UNATTENDED_TOOL_RULES = ['question', 'plan_enter', 'plan_exit']
  .map((permission) => ({ permission, pattern: '*', action: 'deny' }))

export interface OpencodeModelRef {
  providerID: string
  modelID: string
}

export interface OpencodeNativeSessionOptions {
  capabilities: AgentEnvironmentCapabilities
  socketPath: string
  /** The server's basic-auth header value. */
  authorization: string
  model: OpencodeModelRef | null
  variant?: string
  /** opencode session to continue; a new one is created when absent. */
  resumeSessionId?: string | null
  cleanup(): void | Promise<void>
}

interface Waiter<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
}

interface Admission extends Waiter<string> {
  kind: 'prompt' | 'steer'
  operationId?: string
  timer?: ReturnType<typeof setTimeout>
}

interface ActiveTurn {
  /** Posted messages whose user message opencode has not reported yet, in posting order. */
  readonly admissions: Admission[]
  /** Set when the prompt's own user message arrives; events before it belong to an earlier turn. */
  started: boolean
  promptAdmitted: Promise<string>
  /** Steer message id -> the caller's operation id. */
  readonly steers: Map<string, string | undefined>
  readonly applied: Set<string>
  settling: boolean
  grace?: ReturnType<typeof setTimeout>
}

type OpencodeEvent = Record<string, unknown> & { type: string; properties: Record<string, unknown> }

export class OpencodeNativeSession implements NativeSession {
  readonly capabilities: AgentEnvironmentCapabilities
  private readonly life: NativeChild
  private readonly options: OpencodeNativeSessionOptions
  private stdout = ''
  private ready: Waiter<void> | null = null
  private isReady = false
  private sessionID: string | null = null
  /** This session and its subagent sessions; a subagent's permission prompt also waits on the Bridge. */
  private readonly family = new Set<string>()
  private readonly knownMessages = new Set<string>()
  private readonly permissions = new Set<string>()
  private events: ClientRequest | null = null
  private connected: Waiter<void> | null = null
  private turnState: ActiveTurn | null = null
  private readonly queue: Record<string, unknown>[] = []
  private readonly readers: Waiter<Record<string, unknown>>[] = []
  private abortInFlight: Promise<void> | null = null

  constructor(spawned: Awaited<ReturnType<Spawner>>, options: OpencodeNativeSessionOptions) {
    this.capabilities = options.capabilities
    this.options = options
    this.life = new NativeChild(spawned, {
      names: { process: 'opencode serve', session: 'opencode native session' },
      onStdout: (chunk) => this.consumeStdout(chunk),
      onEnd: (error) => {
        this.ready?.reject(error)
        this.connected?.reject(error)
        for (const reader of this.readers.splice(0)) reader.reject(error)
        for (const admission of this.turnState?.admissions.splice(0) ?? []) admission.reject(error)
        this.permissions.clear()
        this.events?.destroy()
      },
      cleanup: options.cleanup,
    })
  }

  providerSessionId(): string | null { return this.sessionID }
  isClosed(): boolean { return this.life.closed }
  onClose(listener: (reason: Error) => void): () => void { return this.life.onClose(listener) }
  whenClosed(): Promise<void> { return this.life.whenClosed() }

  /** Wait for the server, subscribe to its events, then create (or find) the opencode session. */
  async start(signal?: AbortSignal): Promise<void> {
    await this.bounded('opencode serve readiness', READY_TIMEOUT_MS, signal, (waiter) => {
      if (this.isReady) waiter.resolve()
      else this.ready = waiter
    })
    await this.bounded('opencode event stream', CONTROL_TIMEOUT_MS, signal, (waiter) => {
      this.connected = waiter
      this.subscribe()
    })
    const resume = this.options.resumeSessionId
    const response = resume
      ? await this.call('GET', `/session/${encodeURIComponent(resume)}`)
      : await this.call('POST', '/session', { title: 'cli-bridge', permission: UNATTENDED_TOOL_RULES })
    const id = record(parseJson(response.text))?.id
    if (response.status !== 200 || typeof id !== 'string' || (resume && id !== resume)) {
      throw new BackendError(`opencode serve did not ${resume ? 'find' : 'create'} the session: HTTP ${response.status}`, 'upstream')
    }
    this.sessionID = id
    this.family.add(id)
  }

  async *turn(prompt: string, signal: AbortSignal): AsyncIterable<unknown> {
    if (this.life.closed || !this.sessionID) throw new BackendError('opencode native session is closed', 'upstream')
    if (this.turnState) throw new BackendError('opencode native session already has an active turn', 'upstream')
    const turn: ActiveTurn = {
      admissions: [], started: false, promptAdmitted: Promise.resolve(''), steers: new Map(), applied: new Set(), settling: false,
    }
    turn.promptAdmitted = this.expectUserMessage(turn, { kind: 'prompt' })
    turn.promptAdmitted.catch(() => {})
    this.turnState = turn
    const onAbort = (): void => { void this.abort().catch(() => {}) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await this.postPrompt(prompt)
      await turn.promptAdmitted
      while (true) {
        const event = await this.next(signal)
        yield event
        if (event.type === OPENCODE_TURN_SETTLED) return
      }
    } catch (error) {
      if (signal.aborted) await this.abort()
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (turn.grace) clearTimeout(turn.grace)
      for (const admission of turn.admissions.splice(0)) admission.reject(new BackendError('the opencode turn ended', 'upstream'))
      if (this.turnState === turn) this.turnState = null
      this.queue.length = 0
    }
  }

  /**
   * Resolves once opencode has admitted the message into the running session. When the loop
   * answers it, the turn carries a raw `{ type: 'steer', operationId, state: 'applied' }`.
   */
  async steer(prompt: string, operationId?: string): Promise<void> {
    const turn = this.turnState
    const refuse = () => new BackendError('opencode native session has no running turn to steer', 'upstream')
    if (this.life.closed || !turn || turn.settling) throw refuse()
    await turn.promptAdmitted
    if (this.turnState !== turn || turn.settling) throw refuse()
    const admitted = this.expectUserMessage(turn, { kind: 'steer', ...(operationId ? { operationId } : {}) })
    admitted.catch(() => {})
    try {
      await this.postPrompt(prompt)
    } catch (error) {
      const index = turn.admissions.findIndex((admission) => admission.kind === 'steer' && admission.operationId === operationId)
      if (index >= 0) turn.admissions.splice(index, 1)[0]!.reject(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
    await admitted
  }

  async abort(): Promise<void> {
    if (this.life.closed) return this.life.startCleanup()
    this.abortInFlight ??= (async () => {
      const termination = this.life.terminate().catch(() => {})
      try {
        if (this.sessionID) await this.call('POST', `/session/${encodeURIComponent(this.sessionID)}/abort`, {}, ABORT_GRACE_MS)
      } catch {
        // The run is cancelled whatever opencode answers.
      } finally {
        await termination
        this.life.end(new Error('opencode native session aborted'))
        try { await this.life.startCleanup() } finally { this.abortInFlight = null }
      }
    })()
    return this.abortInFlight
  }

  /** Answer one `permission.asked`; resolves when opencode accepts the reply. */
  async respondToNativeInteraction(id: string, response: Record<string, unknown>): Promise<void> {
    if (this.life.closed || !this.permissions.has(id))
      throw new BackendError('opencode has no pending permission request with this id', 'capability_denied')
    const reply = response.value === 'allow_once' ? 'once' : 'reject'
    const result = await this.call('POST', `/permission/${encodeURIComponent(id)}/reply`, { reply })
    if (result.status !== 200) throw new BackendError(`opencode refused the permission reply: HTTP ${result.status}`, 'upstream')
    this.permissions.delete(id)
  }

  /** The session's last message id, read only between turns. */
  async contextBoundary(input: {
    runId: string; provider: string; environmentId: string; sessionId: string; executionId: string; requestDigest: string
  }): Promise<NativeContextBoundaryProof | null> {
    if (this.life.closed || this.turnState || !this.sessionID) return null
    const response = await this.call('GET', `/session/${encodeURIComponent(this.sessionID)}/message?limit=1`)
    const messages = parseJson(response.text)
    const last = Array.isArray(messages) ? record(record(messages.at(-1))?.info)?.id : undefined
    if (response.status !== 200 || typeof last !== 'string') return null
    const revision = `opencode:${this.sessionID}:${last}`
    return {
      ...input,
      requestDigest: input.requestDigest as `sha256:${string}`,
      boundary: { kind: 'revision', revision: revision.length <= 512 ? revision : `id:${canonicalCandidateDigest(revision).slice(7)}` },
      observedAt: new Date().toISOString(),
    }
  }

  async close(): Promise<void> {
    if (!this.life.closed && this.turnState && this.sessionID) {
      await this.call('POST', `/session/${encodeURIComponent(this.sessionID)}/abort`, {}, ABORT_GRACE_MS).catch(() => {})
    }
    this.life.end(new Error('opencode native session closed'))
    await this.life.closing
  }

  private async postPrompt(text: string): Promise<void> {
    const { model, variant } = this.options
    const response = await this.call('POST', `/session/${encodeURIComponent(this.sessionID!)}/prompt_async`, {
      parts: [{ type: 'text', text }],
      ...(model ? { model } : {}),
      ...(variant ? { variant } : {}),
    })
    if (response.status < 200 || response.status >= 300) {
      throw new BackendError(`opencode refused the message: HTTP ${response.status} ${response.text.slice(0, 200)}`, 'upstream')
    }
  }

  private expectUserMessage(turn: ActiveTurn, item: Pick<Admission, 'kind' | 'operationId'>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const admission: Admission = {
        ...item,
        resolve: (id) => { clearTimeout(admission.timer); resolve(id) },
        reject: (error) => { clearTimeout(admission.timer); reject(error) },
      }
      admission.timer = setTimeout(() => {
        const index = turn.admissions.indexOf(admission)
        if (index >= 0) turn.admissions.splice(index, 1)
        reject(new BackendError(`opencode did not admit the ${item.kind} within ${CONTROL_TIMEOUT_MS}ms`, 'timeout'))
      }, CONTROL_TIMEOUT_MS)
      admission.timer.unref?.()
      turn.admissions.push(admission)
    })
  }

  /** Events arrive in server order on one stream, so each is classified before the next. */
  private observe(event: OpencodeEvent): void {
    if (event.type === 'server.connected') {
      this.connected?.resolve()
      this.connected = null
      return
    }
    const props = event.properties
    const info = record(props.info)
    const session = sessionOf(props)
    if (event.type === 'session.created' && info && typeof info.parentID === 'string' && this.family.has(info.parentID)
      && typeof info.id === 'string') this.family.add(info.id)
    if (!session || !this.family.has(session)) return
    if (event.type === 'permission.asked' && typeof props.id === 'string') this.permissions.add(props.id)
    if (event.type === 'permission.replied' && typeof props.requestID === 'string') this.permissions.delete(props.requestID)
    if (session !== this.sessionID && event.type !== 'permission.asked') return
    const turn = this.turnState
    if (event.type === 'message.updated' && info && typeof info.id === 'string') {
      const fresh = !this.knownMessages.has(info.id)
      this.knownMessages.add(info.id)
      if (turn && fresh && info.role === 'user') {
        const admission = turn.admissions.shift()
        if (admission?.kind === 'prompt') turn.started = true
        if (admission?.kind === 'steer') turn.steers.set(info.id, admission.operationId)
        admission?.resolve(info.id)
      }
      const parent = typeof info.parentID === 'string' ? info.parentID : null
      if (turn?.started && info.role === 'assistant' && parent && turn.steers.has(parent) && !turn.applied.has(parent)) {
        turn.applied.add(parent)
        this.enqueue({ type: 'steer', operationId: turn.steers.get(parent), messageID: parent, state: 'applied' })
      }
    }
    if (!turn?.started || turn.settling) return
    const status = record(props.status)?.type
    if (event.type === 'session.status' && status === 'busy' && turn.grace) {
      clearTimeout(turn.grace)
      turn.grace = undefined
    }
    if (event.type === 'session.idle' || (event.type === 'session.status' && status === 'idle')) {
      this.onIdle(turn)
      return
    }
    this.enqueue(event)
  }

  /**
   * The loop went idle. A steer posted but not yet admitted starts the next loop, so the turn
   * waits for it; one admitted but unanswered gets a short grace for its loop, then is reported
   * not applied.
   */
  private onIdle(turn: ActiveTurn): void {
    if (turn.admissions.length > 0) return
    if ([...turn.steers.keys()].some((id) => !turn.applied.has(id))) {
      if (turn.grace) clearTimeout(turn.grace)
      turn.grace = setTimeout(() => this.settle(turn), STEER_IDLE_GRACE_MS)
      turn.grace.unref?.()
      return
    }
    this.settle(turn)
  }

  private settle(turn: ActiveTurn): void {
    if (turn.settling || this.turnState !== turn) return
    turn.settling = true
    for (const [messageID, operationId] of turn.steers) {
      if (!turn.applied.has(messageID)) this.enqueue({ type: 'steer', operationId, messageID, state: 'not_applied' })
    }
    this.enqueue({ type: OPENCODE_TURN_SETTLED })
  }

  private subscribe(): void {
    const request = httpRequest({
      socketPath: this.options.socketPath,
      method: 'GET',
      path: '/event',
      headers: { authorization: this.options.authorization, accept: 'text/event-stream' },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        this.connected?.reject(new BackendError(`opencode event stream answered HTTP ${response.statusCode}`, 'upstream'))
        return
      }
      response.setEncoding('utf8')
      let buffer = ''
      response.on('data', (chunk: string) => {
        buffer += chunk
        let boundary: RegExpExecArray | null
        while ((boundary = /\r?\n\r?\n/u.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.index + boundary[0].length)
          const data = frame.split(/\r?\n/u).filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5)).join('\n')
          const event = record(parseJson(data))
          const type = event?.type
          if (event && typeof type === 'string') this.observe({ ...event, type, properties: record(event.properties) ?? {} })
        }
      })
      response.on('close', () => {
        if (!this.life.closed) this.life.end(new Error('opencode serve closed its event stream'))
      })
    })
    request.on('error', (error) => {
      this.connected?.reject(error)
      if (!this.life.closed) this.life.end(error)
    })
    request.end()
    this.events = request
  }

  private call(method: string, path: string, body?: unknown, timeoutMs = CONTROL_TIMEOUT_MS): Promise<{ status: number; text: string }> {
    if (this.life.closed) return Promise.reject(this.life.error ?? new BackendError('opencode native session is closed', 'upstream'))
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        socketPath: this.options.socketPath,
        method,
        path,
        headers: {
          authorization: this.options.authorization,
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        },
      }, (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => { text += chunk })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, text }))
        response.on('error', reject)
      })
      request.setTimeout(timeoutMs, () => {
        request.destroy(new BackendError(`opencode ${method} ${path.split('?')[0]} timed out after ${timeoutMs}ms`, 'timeout'))
      })
      request.on('error', reject)
      request.end(payload)
    })
  }

  private consumeStdout(chunk: string): void {
    if (this.isReady) return
    this.stdout = `${this.stdout}${chunk}`.slice(-8_192)
    for (const line of this.stdout.split('\n')) {
      if (record(parseJson(line.trim()))?.type !== READY_LINE) continue
      this.isReady = true
      this.stdout = ''
      this.ready?.resolve()
      this.ready = null
      return
    }
  }

  private bounded(what: string, timeoutMs: number, signal: AbortSignal | undefined, arm: (waiter: Waiter<void>) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.life.closed) return reject(this.life.error ?? new Error('opencode serve closed'))
      const onAbort = (): void => settle(() => reject(new BackendError(`${what} was cancelled`, 'aborted')))
      const timer = setTimeout(() => settle(() => reject(new BackendError(`${what} timed out after ${timeoutMs}ms`, 'timeout'))), timeoutMs)
      timer.unref?.()
      let settled = false
      const settle = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        callback()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) return onAbort()
      arm({ resolve: () => settle(resolve), reject: (error) => settle(() => reject(error)) })
    })
  }

  private enqueue(message: Record<string, unknown>): void {
    const reader = this.readers.shift()
    if (reader) reader.resolve(message)
    else this.queue.push(message)
  }

  private next(signal: AbortSignal): Promise<Record<string, unknown>> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.life.closed) return Promise.reject(this.life.error ?? new Error('opencode serve closed'))
    if (signal.aborted) return Promise.reject(new Error('opencode native turn aborted'))
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.readers.indexOf(reader)
        if (index >= 0) this.readers.splice(index, 1)
        reject(new Error('opencode native turn aborted'))
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

/** The opencode session an event belongs to, wherever its shape puts it. */
function sessionOf(props: Record<string, unknown>): string | null {
  for (const candidate of [props.sessionID, record(props.info)?.sessionID, record(props.part)?.sessionID]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return null
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
