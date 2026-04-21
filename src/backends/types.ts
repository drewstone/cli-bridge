/**
 * Backend interface — every CLI or passthrough provider implements this.
 *
 * Backends receive an OpenAI-shaped chat request + an external session
 * id. They yield OpenAI-shaped stream chunks. The bridge handles:
 *   - request validation
 *   - SSE framing
 *   - session-id translation (external ↔ backend-internal)
 *   - bearer auth on the outer HTTP layer
 *
 * Backends own:
 *   - subprocess lifecycle + timeouts
 *   - translating their CLI's native output format to OpenAI deltas
 *   - the decision of whether they can serve a given model id
 */

import type { SessionRecord } from '../sessions/store.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  name?: string
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  /** External stable session id. If unset, the backend starts fresh. */
  session_id?: string
  /** Extra backend-specific options — opaque passthrough. */
  metadata?: Record<string, unknown>
}

export interface ChatDelta {
  /** Incremental text appended to the assistant message. */
  content?: string
  /** Tool calls the assistant emitted this delta. Each is appended. */
  tool_calls?: Array<{ id: string; name: string; arguments: string }>
  /** Terminal reason. Emitted once on the final chunk. */
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'error' | 'timeout'
  /** Backend-reported usage. Optional; present on final chunk when known. */
  usage?: { input_tokens?: number; output_tokens?: number }
  /** Backend assigned id for this turn. Written to session store. */
  internal_session_id?: string
}

export interface BackendHealth {
  name: string
  state: 'ready' | 'unavailable' | 'error'
  detail?: string
  version?: string
}

export interface Backend {
  readonly name: string

  /** Does this backend want to handle requests for `model`? */
  matches(model: string): boolean

  /** Sync health check — exit-code probe on the CLI, etc. */
  health(): Promise<BackendHealth>

  /**
   * Stream a chat completion. Must be an async iterator of ChatDelta.
   * Implementations MUST tolerate `signal.aborted` and shut down the
   * underlying subprocess cleanly when it fires.
   */
  chat(
    req: ChatRequest,
    session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta>
}

export class BackendError extends Error {
  constructor(
    message: string,
    public readonly code: 'not_configured' | 'cli_missing' | 'upstream' | 'timeout' | 'aborted' | 'parse_error',
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'BackendError'
  }
}
