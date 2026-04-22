/**
 * Sandbox backend — wraps the Tangle sandbox-api as a cli-bridge harness.
 *
 * Model id schemes (both first-class):
 *
 *   sandbox/<profile-id>          # cataloged profile (loaded from disk)
 *   sandbox                       # inline profile required in body field
 *
 * Inline profiles arrive in the request body's `agent_profile` field as
 * a full AgentProfile object. The sandbox-api handles provisioning of
 * skills/plugins/MCP servers/packages declared in the profile — we
 * just forward the profile + the user message and stream back deltas.
 *
 * Wire path:
 *   bridge/sandbox/<id>  →  cli-bridge SandboxBackend
 *                        →  POST sandbox-api `/batch/run` with
 *                           { tasks: [{ id, message }], backend: { type, profile } }
 *                        →  consume SSE stream
 *                        →  yield OpenAI-shaped ChatDelta chunks
 *
 * Sessions: cli-bridge's external session id maps to sandbox `taskId`.
 * Subsequent calls with the same external id reuse the sandbox provisioned
 * for that task — sandbox-api handles warm-pool semantics internally.
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import type { AgentProfile } from '@tangle-network/sandbox'

export interface SandboxBackendOptions {
  /** Tangle sandbox-api base URL, e.g. `https://sandbox.tangle.tools`. */
  apiUrl: string
  /** Bearer token for sandbox-api. */
  apiKey: string
  /** Per-task timeout in ms forwarded to sandbox-api. */
  timeoutMs: number
  /** Profile resolver — returns the AgentProfile for a cataloged id, or null if unknown. */
  resolveProfile: (id: string) => AgentProfile | null
  /** Optional override of fetch (for tests). */
  fetchImpl?: typeof fetch
}

interface ChatRequestWithProfile extends ChatRequest {
  agent_profile?: AgentProfile
}

const HARNESS = 'sandbox'
const PREFIX = `${HARNESS}/`

export class SandboxBackend implements Backend {
  readonly name = HARNESS

  constructor(private readonly opts: SandboxBackendOptions) {}

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === HARNESS || m.startsWith(PREFIX)
  }

  async health(): Promise<BackendHealth> {
    try {
      const fetchImpl = this.opts.fetchImpl ?? fetch
      const res = await fetchImpl(`${this.opts.apiUrl.replace(/\/+$/, '')}/health`, {
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      })
      if (res.ok) return { name: this.name, state: 'ready' }
      return { name: this.name, state: 'error', detail: `health ${res.status}` }
    } catch (err) {
      return { name: this.name, state: 'unavailable', detail: (err as Error).message }
    }
  }

  async *chat(
    req: ChatRequest,
    session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    const reqWithProfile = req as ChatRequestWithProfile
    const profile = this.resolveProfileForRequest(reqWithProfile)

    // Single-task batch — cli-bridge calls are single-shot from the
    // OpenAI-compat surface. The taskId is stable for the session so
    // sandbox-api can reuse the warm sandbox across follow-up turns.
    const taskId = session?.internalId ?? `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const message = flattenPrompt(req.messages)

    const requestBody = {
      tasks: [{ id: taskId, message, timeoutMs: this.opts.timeoutMs }],
      backend: { type: 'opencode' as const, profile },
      timeoutMs: this.opts.timeoutMs,
      scalingMode: 'balanced' as const,
      persistent: Boolean(session),
    }

    // Auth choice for sandbox-api:
    //   1. If the caller forwarded a user authorization header (via the
    //      router on bridge dispatch), use it. sandbox-api will verify
    //      the user's sk-tan-* and bill against the actual end user
    //      via /v1/billing/deduct on the platform — same credit pool
    //      the router uses for direct chat. ONE meter, ONE bill.
    //   2. Otherwise fall back to cli-bridge's own SANDBOX_API_KEY (a
    //      service identity). Used in dev/test where no router fronts
    //      the call. Billing in this case is on the service account.
    const forwardedAuthz = (req.metadata as Record<string, unknown> | undefined)?.forwardedAuthorization
    const authHeader = typeof forwardedAuthz === 'string' && forwardedAuthz.length > 0
      ? forwardedAuthz
      : `Bearer ${this.opts.apiKey}`

    const fetchImpl = this.opts.fetchImpl ?? fetch
    const res = await fetchImpl(`${this.opts.apiUrl.replace(/\/+$/, '')}/batch/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        Authorization: authHeader,
      },
      body: JSON.stringify(requestBody),
      signal,
    })

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      throw new BackendError(`sandbox-api ${res.status}: ${detail.slice(0, 300)}`, 'upstream')
    }

    yield { internal_session_id: taskId }

    let sawError: string | null = null
    let usage: { input_tokens?: number; output_tokens?: number } | undefined
    let lastEmittedLen = 0

    for await (const ev of parseSSE(res.body, signal)) {
      if (ev.type === 'task.completed') {
        const data = ev.data as {
          taskId?: string
          resultSummary?: string
          response?: string
          usage?: { inputTokens?: number; outputTokens?: number }
        }
        const text = data.resultSummary ?? data.response ?? ''
        if (text.length > lastEmittedLen) {
          yield { content: text.slice(lastEmittedLen) }
          lastEmittedLen = text.length
        }
        if (data.usage) {
          usage = { input_tokens: data.usage.inputTokens, output_tokens: data.usage.outputTokens }
        }
        yield { finish_reason: 'stop', usage, internal_session_id: taskId }
        return
      }
      if (ev.type === 'task.progress' || ev.type === 'task.delta') {
        const data = ev.data as { taskId?: string; chunk?: string; content?: string }
        const chunk = data.chunk ?? data.content ?? ''
        if (chunk) {
          yield { content: chunk }
          lastEmittedLen += chunk.length
        }
      }
      if (ev.type === 'task.failed') {
        const data = ev.data as { error?: string; message?: string }
        sawError = data.error ?? data.message ?? 'sandbox task failed'
        yield { finish_reason: 'error', internal_session_id: taskId }
        throw new BackendError(`sandbox: ${sawError}`, 'upstream')
      }
    }

    // Stream ended without a terminal event — treat as a soft success
    // when we emitted anything, otherwise a timeout.
    if (lastEmittedLen > 0) {
      yield { finish_reason: 'stop', usage, internal_session_id: taskId }
    } else {
      yield { finish_reason: 'timeout', internal_session_id: taskId }
    }
  }

  /** Resolve the profile to use for this request: inline first, then catalog. */
  private resolveProfileForRequest(req: ChatRequestWithProfile): AgentProfile | string {
    if (req.agent_profile && typeof req.agent_profile === 'object') {
      return req.agent_profile
    }
    if (req.model.toLowerCase() === HARNESS) {
      throw new BackendError(
        'sandbox: model id `sandbox` requires an inline `agent_profile` body field — or use `sandbox/<id>` for a cataloged profile',
        'parse_error',
      )
    }
    const id = req.model.slice(PREFIX.length)
    const profile = this.opts.resolveProfile(id)
    if (!profile) {
      throw new BackendError(`sandbox: profile not found in catalog: ${id}`, 'parse_error')
    }
    return profile
  }
}

function flattenPrompt(messages: ChatRequest['messages']): string {
  if (messages.length === 1) return messages[0]?.content ?? ''
  return messages.map((m) => `[${m.role}] ${m.content}`).join('\n\n')
}

interface SSEEvent {
  type: string
  data: unknown
}

/**
 * Minimal SSE parser. Reads the response body as text chunks, splits on
 * blank-line message boundaries, and yields { type, data } per message.
 */
async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  try {
    while (true) {
      if (signal.aborted) return
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      // Split on blank line — each message is a sequence of fields ending in \n\n.
      let blank: number
      while ((blank = buf.indexOf('\n\n')) >= 0) {
        const message = buf.slice(0, blank)
        buf = buf.slice(blank + 2)
        const ev = parseMessage(message)
        if (ev) yield ev
      }
    }
    // Flush any trailing message on close.
    if (buf.trim()) {
      const ev = parseMessage(buf)
      if (ev) yield ev
    }
  } finally {
    try { reader.releaseLock() } catch { /* noop */ }
  }
}

function parseMessage(message: string): SSEEvent | null {
  let type = 'message'
  const dataLines: string[] = []
  for (const line of message.split('\n')) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      type = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim())
    }
  }
  if (dataLines.length === 0) return null
  const raw = dataLines.join('\n')
  try {
    return { type, data: JSON.parse(raw) }
  } catch {
    return { type, data: raw }
  }
}
