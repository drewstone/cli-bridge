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
import type { JailSpec } from '../jail/index.js'
import type { CallerTrace } from '../trace/ids.js'
import type {
  AgentEnvironmentCapabilities,
  AgentProfile,
  NativeContextBoundaryProof,
  ReasoningEffort,
  RequestedInteractions,
} from '@tangle-network/agent-interface'

/** Request-scoped model credential supplied only by the trusted local bridge caller. */
export interface ProtectedModelCredential {
  /** The raw token lives only for this in-memory request. */
  token: string
  /** The token digest binds durable run identity without retaining the secret. */
  digest: `sha256:${string}`
  /** The exact HTTPS gateway selected for this request. */
  baseUrl: string
  /** The gateway URL digest binds durable run identity without retaining the URL. */
  baseUrlDigest: `sha256:${string}`
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'file'
      filename?: string
      mediaType?: string
      url?: string
      path?: string
      content?: string
    }
  | {
      type: 'image'
      image?: string
      filename?: string
      mediaType?: string
      mimeType?: string
      url?: string
      path?: string
    }
  | { type: 'image_url' | 'input_image'; image_url: string | { url: string } }

export type ChatMessageContent = string | ChatContentPart[] | null

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** OpenAI allows null content on assistant messages with tool_calls. */
  content: ChatMessageContent
  /** Assistant tool-call decisions, kept verbatim across rounds. */
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

// The canonical reasoning ladder lives in @tangle-network/agent-interface (none → ultracode);
// cli-bridge re-exports it so the wire contract speaks one vocabulary across the stack.
export type { ReasoningEffort }

/**
 * One MCP server entry. Matches Claude Code's `mcp-config.json` so the
 * same JSON loaded by Claude can be passed straight through cli-bridge.
 * `type` is optional — when missing, stdio is implied if `command` is
 * set and http is implied if `url` is set.
 */
export interface McpServerSpec {
  type?: 'stdio' | 'http' | 'sse'
  /** stdio: executable to spawn. */
  command?: string
  /** stdio: argv (after `command`). */
  args?: string[]
  /** stdio: environment overrides for the spawned MCP server. */
  env?: Record<string, string>
  /** http/sse: endpoint URL. */
  url?: string
  /** http/sse: extra request headers (auth, etc.). */
  headers?: Record<string, string>
  /** Disable without removing the entry — drop at materialization. */
  enabled?: boolean
  /** Per-tool-call timeout in milliseconds. */
  timeout?: number
}

/**
 * Top-level `mcp` field on the chat request. Mirrors Claude Code's
 * config file shape so callers can carry the same JSON to every
 * backend. See ChatRequest.mcp for the full contract.
 */
export interface McpRequestConfig {
  mcpServers?: Record<string, McpServerSpec>
}

/** Safe proof of the exact AgentProfile workspace plan applied before spawn. */
export interface ProfileMaterializationReceipt {
  schema: 'cli-bridge.profile-materialization.v2'
  /** Canonical identity of the immutable AgentProfile that was actually materialized. */
  effectiveProfileDigest: `sha256:${string}`
  harness: string
  /** Provider selected for execution when it can be determined before spawn. */
  provider: string | null
  /** Exact bridge wire model selected for execution, including its harness prefix. */
  model: string
  /** Canonical intent and the exact native control passed after backend mapping/clamping. */
  reasoningEffort: {
    requested: ReasoningEffort | null
    applied: string | null
  }
  /** Covers planned file contents/modes, flags, environment, and unsupported dimensions. */
  workspacePlanDigest: string
  /** Relative paths only; profile contents and environment values never cross the API. */
  files: Array<{ path: string; mode: number }>
  unsupported: Array<{ dimension: string; reason: string }>
  /** Exact model transport selected before the agent process started. */
  inference?: {
    /** The upstream endpoint reached by the bridge-owned transport. */
    effectiveEndpoint: string
    /** Provider wire protocol used by the selected model. */
    apiMode: string
    /** Authentication stayed in a request-scoped loopback forwarder. */
    transport: 'scoped-loopback'
    /** Exact completion-token cap lowered from the AgentProfile into this run's model catalog. */
    appliedMaxTokens?: number
    /** Filled after Pi exits; absent while materialization is still in progress. */
    observation?: {
      requests: number
      generationRequests: number
      auxiliaryRequests: number
      usageReceipts: number
      rejectedRequests: number
      failedRequests: number
      inFlightRequests: number
      accountingMatched: boolean
      usage: {
        inputTokens?: number
        freshInputTokens?: number
        cacheReadInputTokens?: number
        cacheWriteInputTokens?: number
        outputTokens?: number
        /** Provider-billed dollars are not reported by Pi or the proxy. */
        costKnown: false
        /** Pi's local catalog estimate, never billed spend. */
        estimatedCost?: number
      }
    }
  }
}

/**
 * Per-request net-jail requirement — the network sibling of `execution.jail`.
 *
 * `mode: 'net-jail'` requires deny-by-default egress for the worker process
 * tree, with an allowlist that always contains the backend's own model
 * endpoint. `allow` ASSERTS the exact enforced `host:port` list rather than
 * changing it, because a pooled worker joined its network when the bridge
 * started and cannot be re-jailed per request.
 *
 * No resolved form travels onward to the backends the way `jailSpec` does:
 * enforcement lives in the network the container was created on, so the chat
 * route either proves the jail is in force or fails the request.
 */
export interface NetJailRequest {
  mode?: 'off' | 'net-jail'
  allow?: string[]
}

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
  /** Approval policy for native interaction-capable retained or one-shot turns. */
  interaction_policy?: 'interactive' | 'unattended-deny' | 'unattended-allow'
  /** Exact interaction kinds admitted for this turn. */
  interactions?: RequestedInteractions
  /**
   * OpenAI-compatible response-format hint. CLI harnesses have no
   * native JSON-schema mode, so `json_schema` is normalized at the
   * route boundary to this prompt-side `json_object` directive.
   */
  responseFormat?: { type: 'text' | 'json_object' }
  /** Optional canonical AgentProfile materialized through the selected harness's native controls. */
  agent_profile?: AgentProfile
  /**
   * Standard MCP server passthrough. Canonical shape mirrors the
   * Claude Code `mcp-config.json` schema so the same JSON can be fed to
   * every MCP-capable backend. Each backend translates
   * this into its native loader (claude `--mcp-config`, codex
   * `CODEX_HOME/config.toml`, opencode `OPENCODE_CONFIG`, kimi
   * `--mcp-config-file`).
   *
   * This channel is available only when `agent_profile` is absent. With an
   * exact profile, declare every MCP server in `agent_profile.mcp`; a second
   * body/header MCP channel is refused before spawn.
   *
   * Also accepted via the `X-Mcp-Config` request header (JSON-encoded
   * same shape) for callers that cannot extend the body.
   *
   * Servers a given backend cannot load locally (e.g. Gemini before a
   * verified per-invocation MCP contract, or `http`/`sse` transport on
   * a CLI that only supports stdio) are dropped at materialization time
   * by the backend materializer — fail loud, no silent fallback.
   */
  mcp?: McpRequestConfig
  /** Optional working directory for the first turn of a session. Persisted into SessionStore when session_id is present. */
  cwd?: string
  /** Public, non-secret environment entries requested for this execution. */
  env?: Record<string, string>
  /** Canonical portable context defaults and per-turn overrides. */
  context?: Record<string, unknown>
  /** Canonical provider options preserved across retained-session restart. */
  providerOptions?: Record<string, unknown>
  /**
   * Where the harness runs. Default `{ kind: 'host' }`. When
   * `{ kind: 'sandbox', repoUrl, ... }` cli-bridge provisions a Tangle
   * sandbox with the matching in-container backend and dispatches the
   * prompt there. Same agent_profile + prompt contract — only the
   * execution location changes.
   */
  execution?:
    | {
        kind: 'host'
        /**
         * Per-request write-jail override. `mode: 'write-jail'` confines
         * the spawned CLI's writes to `root` (default `<cwd>/.agent-home`),
         * `'off'` disables jailing even when `BRIDGE_JAIL_MODE` defaults it
         * on. `root` is clamped inside the request cwd. Resolved to a
         * {@link JailSpec} on `jailSpec` by the chat route.
         */
        jail?: { mode?: 'off' | 'write-jail' | 'fs-jail'; root?: string }
        netJail?: NetJailRequest
        /** Caller-owned process deadline. Omit to allow the operator fallback, if configured. */
        timeoutMs?: number
      }
    | {
        kind: 'sandbox'
        repoUrl?: string
        gitRef?: string
        capability?: string
        ttlSeconds?: number
        // Declared on this variant too so a net-jail asked of the sandbox mode
        // reaches the gate and is REFUSED by name. Dropping it from the type
        // would make the request parse and the requirement disappear.
        netJail?: NetJailRequest
        /** Caller-owned task deadline. Omit to allow the operator fallback, if configured. */
        timeoutMs?: number
      }
  /**
   * Resolved write-jail spec for this turn, set by the chat route from
   * `execution.jail` layered over the `BRIDGE_JAIL_*` env defaults (see
   * `resolveJailSpec`). NOT part of the wire schema — the wire field is
   * `execution.jail`. When present, the host/scoped-host spawners wrap the
   * CLI in an OS write-jail; null/absent = no jail.
   */
  jailSpec?: JailSpec | null
  /**
   * Trace context the spawned harness child inherits over its environment
   * (`TRACEPARENT` + legacy `TRACE_ID` / `PARENT_SPAN_ID`), set by the chat
   * route from the request's trace correlation headers. NOT part of the wire
   * schema — the wire is `traceparent` / `x-trace-id` / `x-parent-span-id`.
   * It rides on the request to the spawn seam the way `jailSpec` does.
   * null/absent = the caller sent no correlation and the child env is
   * unchanged.
   */
  childTrace?: CallerTrace | null
  /**
   * Admission lane this turn was granted, set by the chat route. NOT part of
   * the wire schema — it is derived from `x-tangle-client`.
   *
   * It has to travel with the request because the host admission gate is not
   * the only limiter in the path: the scoped-host executor holds its own
   * concurrency semaphore. A lane honoured at only one of them relocates the
   * starvation instead of removing it.
   */
  admissionClass?: 'reserved' | 'bulk'
  /** Extra backend-specific options — opaque passthrough. */
  metadata?: Record<string, unknown>
  /**
   * Internal loopback-only credential. The route never copies this into the
   * body, session metadata, trace, or durable run record.
   */
  protectedModelCredential?: ProtectedModelCredential
  /** Internal receipt populated by profile provisioning before the harness spawns. */
  profile_materialization_receipt?: ProfileMaterializationReceipt
}

/**
 * The terminal `finish_reason` for a CLI stream that ended on its own, plus the
 * reason when the CLI reported one.
 *
 * Every JSON-event backend held the same expression — `sawError ? 'error' :
 * (emittedToolCall ? 'tool_calls' : 'stop')` — and every one of them DROPPED
 * `sawError`'s text on the floor. The CLI had said exactly what went wrong one
 * event earlier; the bridge turned it into a bare `finish_reason: 'error'` and
 * the caller got HTTP 200 with an empty completion. One implementation, so the
 * next backend inherits the reason instead of the bug.
 *
 * `Run.pump` still guarantees a non-empty reason on any terminal error delta;
 * this is what makes that reason the CLI's own words rather than the bridge's
 * admission that it cannot attribute the failure.
 */
export function terminalOutcome(
  label: string,
  sawError: string | null,
  emittedToolCall: boolean,
): Pick<ChatDelta, 'finish_reason' | 'error'> {
  if (sawError !== null) {
    return { finish_reason: 'error', error: { message: `${label}: ${sawError}`, type: 'upstream' } }
  }
  return { finish_reason: emittedToolCall ? 'tool_calls' : 'stop' }
}

export interface ChatDelta {
  /** Incremental text appended to the assistant message. */
  content?: string
  /** Provider-reported response model. This is distinct from the requested route model. */
  model?: string
  /** Provider response fingerprint, when the upstream protocol exposes one. */
  system_fingerprint?: string
  /** Tool calls the assistant emitted this delta. Each is appended. */
  tool_calls?: Array<{ id: string; name: string; arguments: string }>
  /** Terminal reason. Emitted once on the final chunk. */
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'error' | 'timeout'
  /**
   * Why a terminal `error`/`timeout` happened, carried ON the delta so it
   * survives buffering and replay. Without it a failure that happened after the
   * first delta reached the caller as `finish_reason: 'error'` with an empty
   * completion and no reason at all, while the only copy of the message went to
   * the bridge's stdout — an infrastructure failure that reads as a model
   * problem. Set by the run pump; backends may set it directly when they
   * terminate a stream without throwing.
   */
  error?: {
    message: string
    type: string
    /** Router-owned proof that the request stopped before provider dispatch. */
    provider_dispatch?: 'not_started'
  }
  /**
   * Token usage. Optional; a backend may emit one metadata-only record per
   * model call. `estimated` is set when the bridge derived it from text
   * (~4 chars/token) because the backend CLI reported none.
   */
  usage?: {
    /** Provider inference requests represented by this record. */
    model_requests?: number
    input_tokens?: number
    /** Fresh, non-cached input tokens when the backend reports the split. */
    fresh_input_tokens?: number
    /** Input tokens served from a provider cache. */
    cache_read_input_tokens?: number
    /** Input tokens written into a provider cache. */
    cache_write_input_tokens?: number
    output_tokens?: number
    /**
     * Billed USD cost. Valid only with `cost_known: true` and trusted provenance;
     * serializers refuse to promote an unclassified number to billed spend.
     */
    cost?: number
    /** Local catalog estimate. Never used as billed spend or a dollar-budget truth. */
    estimated_cost?: number
    /** True only when `cost` is backed by a provider or billing receipt. */
    cost_known?: boolean
    /** Where the dollar number came from. */
    cost_provenance?: 'provider-receipt' | 'billing-receipt' | 'catalog-estimate'
    /**
     * Incremental by default. `total` proves the cost covers all usage emitted
     * through this record and replaces any incomplete incremental sum.
     */
    cost_scope?: 'incremental' | 'total'
    estimated?: boolean
  }
  /** Safe proof of the AgentProfile files applied before this run. */
  profile_materialization?: ProfileMaterializationReceipt
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
  /** Operator-selected fallback used only when `execution.timeoutMs` is absent. Zero/absent means no deadline. */
  readonly defaultExecutionTimeoutMs?: number

  /** Does this backend want to handle requests for `model`? */
  matches(model: string): boolean

  /** Sync health check — exit-code probe on the CLI, etc. */
  health(signal?: AbortSignal): Promise<BackendHealth>

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
 * A provider-native session that remains owned across retained turns.
 *
 * The bridge owns routing and durable events. The provider owns this handle's
 * process protocol and must prove every native side effect before returning.
 */
export interface NativeSession {
  readonly capabilities: AgentEnvironmentCapabilities
  isClosed(): boolean
  onClose(listener: (reason: Error) => void): () => void
  whenClosed(): Promise<void>
  providerSessionId(): string | null
  turn(prompt: string, signal: AbortSignal): AsyncIterable<unknown>
  steer?(prompt: string): Promise<void>
  abort(): Promise<void>
  respondToNativeInteraction(id: string, response: Record<string, unknown>): Promise<void>
  contextBoundary(input: {
    runId: string
    provider: string
    environmentId: string
    sessionId: string
    executionId: string
    requestDigest: string
  }): Promise<NativeContextBoundaryProof | null>
  close(): Promise<void>
}

/** Backend extension for exact, retained provider-native sessions. */
export interface NativeSessionBackend extends Backend {
  readonly nativeModes: readonly NonNullable<ChatRequest['mode']>[]
  nativeCapabilities?(): AgentEnvironmentCapabilities
  startNativeSession(
    req: ChatRequest,
    session: SessionRecord | null,
    signal?: AbortSignal,
  ): Promise<NativeSession>
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
  readonly providerDispatch?: 'not_started'

  constructor(
    message: string,
    public readonly code: 'not_configured' | 'cli_missing' | 'upstream' | 'timeout' | 'aborted' | 'parse_error' | 'capability_denied',
    public readonly cause?: unknown,
    options?: { providerDispatch?: 'not_started' },
  ) {
    super(message)
    this.name = 'BackendError'
    this.providerDispatch = options?.providerDispatch
  }
}
