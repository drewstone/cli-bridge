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
import type { BridgeMode } from '../modes.js'
import type { AgentProfile } from '@tangle-network/sandbox'

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url' | 'input_image'; image_url: string | { url: string } }
  | { type: 'image'; image: string; mediaType?: string; mimeType?: string }

export type ChatMessageContent = string | ChatContentPart[]

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: ChatMessageContent
  tool_call_id?: string
  name?: string
}

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  /** Reasoning/thinking intensity requested by the caller. Backends map this to their native CLI flag. */
  effort?: ReasoningEffort
  /** External stable session id. If unset, the backend starts fresh. */
  session_id?: string
  /**
   * Execution mode. If unset, the backend picks its default (byob). In
   * `hosted-safe` mode the backend MUST disable every tool that can
   * touch the FS or shell. A backend that cannot enforce hosted-safe
   * for its underlying CLI MUST throw BackendError('not_configured')
   * rather than quietly run with tools enabled.
   */
  mode?: BridgeMode
  /**
   * OpenAI-compatible response-format hint. CLI harnesses have no
   * native JSON-schema mode, so `json_schema` is normalized at the
   * route boundary to this prompt-side `json_object` directive.
   */
  responseFormat?: { type: 'text' | 'json_object' }
  /** Optional caller-declared AgentProfile. Sandbox uses it natively; local harnesses honor a prompt/context subset. */
  agent_profile?: AgentProfile
  /** Optional working directory for the first turn of a session. Persisted into SessionStore when session_id is present. */
  cwd?: string
  /**
   * Where the harness runs. Default `{ kind: 'host' }`. When
   * `{ kind: 'sandbox', repoUrl, ... }` cli-bridge provisions a Tangle
   * sandbox with the matching in-container backend and dispatches the
   * prompt there. Same agent_profile + prompt contract — only the
   * execution location changes.
   */
  execution?:
    | { kind: 'host' }
    | {
        kind: 'sandbox'
        repoUrl?: string
        gitRef?: string
        capability?: string
        ttlSeconds?: number
      }
  /** Extra backend-specific options — opaque passthrough. */
  metadata?: Record<string, unknown>
  /**
   * OpenAI-style tool definitions. CLI harnesses don't natively expose
   * caller-supplied tools to the model; when `BRIDGE_EMULATE_TOOL_CALLS=1`
   * is set, supported backends translate these via prompt-marker emulation
   * (see backends/tool-emulation.ts). Default off.
   */
  tools?: Array<{
    type: 'function'
    function: { name: string; description?: string; parameters?: unknown }
  }>
  /** OpenAI-style tool_choice — passed to the emulation layer. */
  tool_choice?:
    | 'auto' | 'none' | 'required'
    | { type: 'function'; function: { name: string } }
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
  /**
   * Subprocess-liveness signal. Backends emit this when the upstream CLI
   * is silently buffering (no stdout for >N seconds) so the SSE writer
   * can surface a transport-level heartbeat without polluting the
   * OpenAI delta stream. SSE writer renders as a comment
   * (`: keepalive source=<x> elapsed=<ms>\n\n`) — OpenAI clients ignore
   * SSE comments per spec. `collectNonStreaming` drops these entirely.
   *
   * Do NOT use `tool_calls` for liveness — synthetic tool names violate
   * the OpenAI tool_calls contract (every name must be a tool the
   * caller registered) and confuse strict consumers like the Vercel
   * AI SDK.
   */
  keepalive?: { source: string; elapsedMs: number }
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

/**
 * Prompt-side directive emitted when the caller requests
 * `response_format: { type: 'json_object' }`. Claude Code and Kimi CLI
 * have no native json-mode flag, so we inject this instruction and let
 * the model comply. Clients SHOULD still strip ```json fences as a
 * belt-and-suspenders fallback — non-native json mode is best-effort.
 */
export const JSON_MODE_DIRECTIVE =
  'Respond with ONLY a single JSON object. No prose. No markdown fences.'

/** True when the request asked for `json_object` response format. */
export function wantsJsonObject(req: ChatRequest): boolean {
  return req.responseFormat?.type === 'json_object'
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
