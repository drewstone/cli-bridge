/**
 * POST /v1/chat/completions — OpenAI-compatible.
 *
 * Accepts the standard OpenAI chat request, plus an optional
 * `X-Session-Id` header (or `session_id` field in the body) for
 * session-resume across turns. If absent, starts a fresh session.
 *
 * Non-native JSON mode: callers may pass
 * `response_format: { type: 'json_object' }` on the wire. CLI harnesses
 * (claude-code, kimi-code) have no native json-mode flag, so backends
 * honor the hint prompt-side — they inject a "reply with a single JSON
 * object, no prose, no fences" directive. Content may still need
 * markdown-fence stripping by the client; treat fence-stripping as a
 * belt-and-suspenders fallback.
 */

import type { Context, Hono } from 'hono'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  canonicalAgentProfileDigest,
  canonicalCandidateDigest,
} from '@tangle-network/agent-interface'
import type { BackendRegistry } from '../backends/registry.js'
import {
  SessionExecutionAbortedError,
  type SessionExecutionLease,
  type SessionRecord,
  type SessionStore,
} from '../sessions/store.js'
import type { Backend, ChatDelta, ChatRequest, ProtectedModelCredential } from '../backends/types.js'
import { ExecutorConfigurationError } from '../executors/types.js'
import { BackendError } from '../backends/types.js'
import { parseMode, ModeNotSupportedError } from '../modes.js'
import { collectNonStreaming } from '../streaming/sse.js'
import { estimateMessagesChars, tokensFromChars } from '../backends/content.js'
import { resolveJailSpec } from '../jail/resolve-spec.js'
import { resolveNetJailSpec } from '../jail/resolve-net-spec.js'
import { assertNetJailEnforced, type NetJailRegistry } from '../jail/enforce-net-jail.js'
import { authSourcesFor } from '../jail/auth-preserve.js'
import { AdmissionRejectedError, type AdmissionClass, type AdmissionGate, type AdmissionSlot } from '../admission.js'
import {
  type Run,
  RunIdentityConflictError,
  RunReplayCursorError,
  type RunRegistry,
} from '../runs/registry.js'
import { BackendReportedFailureError } from '../runs/error-shape.js'
import type { RequestSpanRecorder, TraceEmitter } from '../trace/emitter.js'
import { resolveCallerTrace } from '../trace/ids.js'
import {
  assertProfileRequestAuthority,
  resolveAgentProfile,
  resolveRequestedReasoningEffort,
} from '../backends/profile-support.js'
import { resolveRunEventCursor, streamRunEvents } from './run-events.js'
import { isLoopbackRequest } from '../http/request-source.js'

/** Header accepted only from the local Runtime → cli-bridge transport. */
export const PROTECTED_MODEL_CREDENTIAL_HEADER = 'x-cli-bridge-model-credential'
/** Exact HTTPS gateway header paired with {@link PROTECTED_MODEL_CREDENTIAL_HEADER}. */
export const PROTECTED_MODEL_BASE_URL_HEADER = 'x-cli-bridge-model-base-url'
const protectedCredentialMaxLength = 16 * 1024
const protectedModelBaseUrlMaxLength = 2 * 1024

class SandboxBackendUnavailableError extends Error {
  readonly code = 'not_found_error' as const
  constructor(message: string) {
    super(message)
    this.name = 'SandboxBackendUnavailableError'
  }
}

const durableRunIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
    'run id must be URL-safe: letters, digits, dot, underscore, colon, or hyphen',
  )

// Node timers above this value overflow to an almost-immediate callback. This
// is the implementation limit, not a product policy; omitting the field means
// no deadline.
const maxExecutionTimeoutMs = 2_147_483_647

const chatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    // Per OpenAI Chat Completions: `content` is nullable when
    // `tool_calls` is present on an assistant message. Accepting null
    // here is the difference between "agent loops work" and "every
    // assistant tool-call round trips back as invalid chat request".
    content: z.union([
      z.string(),
      z.null(),
      z.array(z.union([
        z.object({ type: z.literal('text'), text: z.string() }),
        z.object({
          type: z.union([z.literal('image_url'), z.literal('input_image')]),
          image_url: z.union([z.string(), z.object({ url: z.string() })]),
        }),
        z.object({
          type: z.literal('image'),
          image: z.string(),
          mediaType: z.string().optional(),
          mimeType: z.string().optional(),
        }),
      ])),
    ]),
    // Assistant messages from the model carry `tool_calls` so the
    // server-side history retains the decision the model made. Without
    // this field declared, Zod's default strip-mode silently drops it
    // and the model's loop loses its own prior decisions.
    tool_calls: z.array(z.object({
      id: z.string(),
      type: z.literal('function'),
      function: z.object({
        name: z.string(),
        arguments: z.string(),
      }),
    })).optional(),
    tool_call_id: z.string().optional(),
    name: z.string().optional(),
  })).min(1),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  // Mirrors the canonical ReasoningEffort ladder in @tangle-network/agent-interface.
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultracode']).optional(),
  session_id: z.string().optional(),
  resume_id: z.string().optional(), // alias for session_id
  /**
   * Durable-run id. Decouples the JOB from this HTTP connection. A
   * client disconnect never kills the run; a reconnect/retry that reuses
   * the same `run_id` RE-ATTACHES to the same in-flight subprocess
   * (idempotent dispatch) instead of cold-starting a second one.
   *
   * Absent → a fresh run id is minted per request (today's behavior,
   * minus the kill-on-disconnect). Also accepted via `X-Run-Id`.
   *
   * Reconnect replay: send `Last-Event-ID: <seq>` (or `X-Last-Event-Id`)
   * with the same run_id to replay only the deltas missed since `seq`.
   */
  run_id: durableRunIdSchema.optional(),
  mode: z.enum(['byob', 'hosted-safe', 'hosted-sandboxed']).optional(),
  // OpenAI-compatible shape — wire is snake_case, TS is camelCase. We
  // translate to responseFormat when we build the ChatRequest below.
  response_format: z.object({
    type: z.enum(['text', 'json_object', 'json_schema']),
    json_schema: z.unknown().optional(),
  }).optional(),
  agent_profile: z.unknown().optional(),
  /**
   * Standardised MCP passthrough. Shape mirrors Claude Code's
   * `mcp-config.json` so the same JSON can be forwarded to every
   * backend that supports MCP natively (claude `--mcp-config`, codex
   * `CODEX_HOME/config.toml`, kimi `--mcp-config-file`, opencode
   * `OPENCODE_CONFIG`). Validation is permissive (`z.unknown()` for
   * each spec) so callers can pass backend-specific fields without
   * cli-bridge silently stripping them — the per-backend
   * materializers normalize. Use the canonical `command/args/env`
   * (stdio) or `url/headers` (http) layout for cross-backend
   * portability.
   *
   * Also accepted via the `X-Mcp-Config` request header (JSON-encoded
   * same shape). Body wins on conflict.
   */
  mcp: z.object({
    mcpServers: z.record(z.unknown()).optional(),
  }).passthrough().optional(),
  cwd: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  /**
   * Where the harness runs.
   *
   *   `host` (default)  — spawn the chosen harness CLI (claude/kimi/...)
   *                       on the host. Uses cli-bridge's local executor
   *                       and the operator's CLI subscription auth.
   *
   *   `sandbox`         — provision a Tangle sandbox with the equivalent
   *                       in-container backend (kimi-code, claude-code,
   *                       codex, opencode, ...) and dispatch the prompt
   *                       there via SubagentRunner-style sidecar.
   *
   * Same agent_profile + prompt + cwd contract regardless. Switching
   * targets is a one-field change for the caller.
   */
  execution: z.object({
    kind: z.enum(['host', 'sandbox']),
    /** When kind=sandbox, the repoUrl to clone into /workspace before dispatch. */
    repoUrl: z.string().optional(),
    /** When kind=sandbox, the git ref to check out post-clone. */
    gitRef: z.string().optional(),
    /** When kind=sandbox, the sandbox capability tier (defaults to 'base'). */
    capability: z.string().optional(),
    /** When kind=sandbox, the sandbox TTL in seconds (default 30 min). */
    ttlSeconds: z.number().int().positive().optional(),
    /**
     * When kind=host, an optional per-request jail override.
     *   mode: 'write-jail' confines WRITES to the jail root; 'fs-jail' also
     *         confines READS to a minimal system+toolchain allowlist so the
     *         CLI cannot read the host repo or sibling run scratch dirs. NOTE:
     *         the operator env floor (`BRIDGE_JAIL_MODE`, or `WORKER_FS_JAIL=1`
     *         for fs-jail) can only be RAISED by a request, never lowered — a
     *         per-request 'off' or 'write-jail' cannot weaken a higher floor.
     *         'off' takes effect only when no env floor is set.
     *   root: writable jail root (default <cwd>/.agent-home), clamped
     *         inside the request cwd.
     * Layered over the BRIDGE_JAIL_MODE / WORKER_FS_JAIL / BRIDGE_JAIL_ROOT env defaults.
     */
    jail: z.object({
      mode: z.enum(['off', 'write-jail', 'fs-jail']).optional(),
      root: z.string().optional(),
    }).optional(),
    /**
     * Deny-by-default EGRESS for the worker process tree — the network sibling
     * of `jail` above.
     *   mode: 'net-jail' requires that the worker run with no route off its
     *         network except an allowlist that always contains the backend's
     *         own model endpoint. The operator floor (`BRIDGE_NET_JAIL_MODE`,
     *         or `WORKER_NET_JAIL=1`) can only be RAISED by a request. A
     *         request the bridge cannot enforce FAILS with 501 naming the
     *         execution mode; it is never accepted and quietly not applied.
     *   allow: asserts the exact `host:port` allowlist in force. It does not
     *         change the allowlist — a pooled worker joined its network when
     *         the bridge started — so a list that differs from the enforced one
     *         is a failure, not a silent widening.
     */
    netJail: z.object({
      mode: z.enum(['off', 'net-jail']).optional(),
      allow: z.array(z.string()).optional(),
    }).optional(),
    timeoutMs: z.number().int().positive().max(maxExecutionTimeoutMs).optional(),
  }).optional(),
})

/**
 * Run one backend against the caller's deadline. Backend configuration is only
 * a fallback for direct bridge clients that omitted `execution.timeoutMs`;
 * an explicit caller value always wins. The derived signal belongs to the
 * durable run, not its current HTTP reader, so disconnect/replay cannot cancel
 * or restart the process.
 */
function backendChatWithDeadline(
  backend: Backend,
  request: ChatRequest,
  session: SessionRecord | null,
  runSignal: AbortSignal,
  receiptTarget: ChatRequest = request,
): AsyncIterable<ChatDelta> {
  const timeoutMs = request.execution?.timeoutMs ?? backend.defaultExecutionTimeoutMs ?? 0
  if (timeoutMs === 0) {
    return relayProfileMaterialization(
      backend.chat(request, session, runSignal),
      request,
      receiptTarget,
    )
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxExecutionTimeoutMs) {
    throw new BackendError(
      `${backend.name} execution timeout must be an integer from 1 to ${maxExecutionTimeoutMs}ms`,
      'not_configured',
    )
  }

  const execution = request.execution ?? { kind: 'host' as const }
  const effectiveRequest: ChatRequest = {
    ...request,
    execution: { ...execution, timeoutMs },
  }

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<ChatDelta> {
      const controller = new AbortController()
      const timeoutError = new BackendError(
        `${backend.name} execution timed out after ${timeoutMs}ms`,
        'timeout',
      )
      let timedOut = false
      const onRunAbort = (): void => controller.abort(runSignal.reason)
      if (runSignal.aborted) onRunAbort()
      else runSignal.addEventListener('abort', onRunAbort, { once: true })
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort(timeoutError)
      }, timeoutMs)

      try {
        const source = relayProfileMaterialization(
          backend.chat(effectiveRequest, session, controller.signal),
          effectiveRequest,
          receiptTarget,
        )
        for await (const delta of source) {
          if (timedOut) throw timeoutError
          yield delta
        }
        if (timedOut) throw timeoutError
      } catch (error) {
        if (timedOut) throw timeoutError
        throw error
      } finally {
        clearTimeout(timer)
        runSignal.removeEventListener('abort', onRunAbort)
      }
    },
  }
}

/** Keep a backend-owned acknowledgment attached to the route-owned request across request copies. */
function relayProfileMaterialization(
  source: AsyncIterable<ChatDelta>,
  sourceRequest: ChatRequest,
  targetRequest: ChatRequest,
): AsyncIterable<ChatDelta> {
  const transfer = (): void => {
    if (sourceRequest.profile_materialization_receipt) {
      targetRequest.profile_materialization_receipt = sourceRequest.profile_materialization_receipt
    }
  }
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<ChatDelta> {
      try {
        for await (const delta of source) {
          transfer()
          yield delta
        }
      } finally {
        // A backend may materialize successfully and then produce no deltas.
        transfer()
      }
    },
  }
}

export function mountChatCompletions(
  app: Hono,
  deps: {
    registry: BackendRegistry
    sessions: SessionStore
    runs: RunRegistry
    admission?: AdmissionGate
    /**
     * `x-tangle-client` prefixes routed to the reserved admission lane.
     * Absent = every caller is `bulk`.
     */
    admissionReservedClients?: string[]
    /** Backends with a provisioned, verified net-jail. Absent map = none. */
    netJail?: NetJailRegistry
    /** Emits one conforming span per request. Absent = no tracing. */
    trace?: TraceEmitter
  },
): void {
  app.post('/v1/chat/completions', async (c) => {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: { message: 'invalid JSON body', type: 'invalid_request_error' } }, 400)
    }

    const parsed = chatRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({
        error: {
          message: 'invalid chat request',
          type: 'invalid_request_error',
          details: parsed.error.flatten(),
        },
      }, 400)
    }

    // Session id resolution — accept several aliases so clients with
    // different conventions all work:
    //   body.session_id                (canonical)
    //   body.resume_id                 (alias)
    //   header X-Session-Id            (canonical)
    //   header X-Resume                (alias — ergonomic single-word form)
    //   header X-Conversation-Id       (alias — matches OpenAI Assistants vocab)
    const headerSession =
      c.req.header('x-session-id')
      ?? c.req.header('x-resume')
      ?? c.req.header('x-conversation-id')
      ?? undefined
    const bodySession = parsed.data.session_id ?? parsed.data.resume_id

    let mode
    try {
      mode = parseMode({
        body: parsed.data.mode,
        bridgeModeHeader: c.req.header('x-bridge-mode'),
        sandboxHeader: c.req.header('x-sandbox'),
      })
    } catch (err) {
      return c.json({
        error: {
          message: err instanceof Error ? err.message : String(err),
          type: 'invalid_request_error',
        },
      }, 400)
    }

    // Forward the user's identity (when the upstream router supplied
    // it) into request metadata so backends like sandbox can re-use the
    // user's own auth when calling downstream services. This keeps
    // billing accountable to the actual user, not cli-bridge's service
    // identity. Header is `X-Tangle-Forwarded-Authorization` and is set
    // by tangle-router on bridge dispatch (sandbox path).
    const forwardedAuthz = c.req.header('x-tangle-forwarded-authorization')
    const tangleClient = c.req.header('x-tangle-client')
    const tangleSource = c.req.header('x-tangle-source')
    const protectedCredentialHeader = c.req.header(PROTECTED_MODEL_CREDENTIAL_HEADER)
    const protectedBaseUrlHeader = c.req.header(PROTECTED_MODEL_BASE_URL_HEADER)
    // Pull response_format off so it doesn't bleed through the spread
    // as an unknown extra field — we translate snake_case → camelCase
    // here to match the ChatRequest type.
    const {
      response_format,
      agent_profile,
      cwd,
      execution,
      mcp: bodyMcp,
      run_id: bodyRunId,
      session_id: _bodySessionId,
      resume_id: _bodyResumeId,
      ...rest
    } = parsed.data
    // Without an exact AgentProfile, MCP can arrive in the body OR the
    // `X-Mcp-Config` header and the body wins on conflict. When a profile is
    // present, any body/header MCP is refused before execution; the profile is
    // the only behavioral authority.
    const mcpHeader = parseMcpHeader(c.req.header('x-mcp-config'))
    const mergedMcp = mergeMcpInputs(mcpHeader, bodyMcp as ChatRequest['mcp'] | undefined)
    let protectedModelCredential: ProtectedModelCredential | undefined
    const backend = deps.registry.resolve(rest.model)
    if (!backend) {
      return c.json({
        error: {
          message: `no backend matches model "${rest.model}". Check /health for registered backends.`,
          type: 'not_found_error',
        },
      }, 404)
    }
    if (protectedCredentialHeader !== undefined || protectedBaseUrlHeader !== undefined) {
      if (!isLoopbackRequest(c.req.raw)) {
        return c.json({
          error: {
            message: `${PROTECTED_MODEL_CREDENTIAL_HEADER} and ${PROTECTED_MODEL_BASE_URL_HEADER} are accepted only on a loopback connection`,
            type: 'invalid_authentication_error',
          },
        }, 403)
      }
      if (backend.name !== 'pi' || execution?.kind === 'sandbox') {
        return invalidRequest(
          c,
          `${PROTECTED_MODEL_CREDENTIAL_HEADER} is supported only by host Pi execution`,
        )
      }
      if (
        protectedCredentialHeader === undefined
        || protectedBaseUrlHeader === undefined
        || protectedCredentialHeader.length === 0
        || protectedCredentialHeader.length > protectedCredentialMaxLength
        || /[\r\n\0]/u.test(protectedCredentialHeader)
        || protectedBaseUrlHeader.length === 0
        || protectedBaseUrlHeader.length > protectedModelBaseUrlMaxLength
        || /[\r\n\0]/u.test(protectedBaseUrlHeader)
      ) {
        return invalidRequest(c, `${PROTECTED_MODEL_CREDENTIAL_HEADER} and ${PROTECTED_MODEL_BASE_URL_HEADER} must be provided as a pair`)
      }
      const protectedBaseUrl = canonicalProtectedModelBaseUrl(protectedBaseUrlHeader)
      if (protectedBaseUrl === undefined) {
        return invalidRequest(c, `${PROTECTED_MODEL_BASE_URL_HEADER} must be an HTTPS URL without credentials, query, or fragment`)
      }
      protectedModelCredential = {
        token: protectedCredentialHeader,
        digest: protectedCredentialDigest(protectedCredentialHeader),
        baseUrl: protectedBaseUrl,
        baseUrlDigest: protectedCredentialDigest(protectedBaseUrl),
      }
    }
    const req: ChatRequest = {
      ...rest,
      session_id: bodySession ?? headerSession,
      mode,
      ...(response_format ? { responseFormat: normalizeResponseFormat(response_format) } : {}),
      ...(agent_profile ? { agent_profile: agent_profile as ChatRequest['agent_profile'] } : {}),
      ...(mergedMcp ? { mcp: mergedMcp } : {}),
      ...(cwd ? { cwd } : {}),
      ...(execution ? { execution: execution as ChatRequest['execution'] } : {}),
      ...(protectedModelCredential ? { protectedModelCredential } : {}),
      metadata: {
        ...(parsed.data.metadata ?? {}),
        ...(tangleClient ? { tangleClient } : {}),
        ...(tangleSource ? { tangleSource } : {}),
        ...(forwardedAuthz ? { forwardedAuthorization: forwardedAuthz } : {}),
      },
    }

    // Durable-run identity and replay cursor are exact claims. Conflicting aliases, malformed ids,
    // and invalid cursors fail closed instead of silently selecting one value or replaying from 0.
    const runIdResult = resolveRunId(bodyRunId, c.req.header('x-run-id'))
    if (!runIdResult.ok) return invalidRequest(c, runIdResult.message)
    const runId = runIdResult.value
    const standardCursor = c.req.header('last-event-id')
    const aliasCursor = c.req.header('x-last-event-id')
    const cursorResult = resolveRunEventCursor(standardCursor, aliasCursor)
    if (!cursorResult.ok) return invalidRequest(c, cursorResult.message)
    const afterSeq = cursorResult.value
    if ((standardCursor !== undefined || aliasCursor !== undefined) && req.stream !== true) {
      return invalidRequest(c, 'Last-Event-ID is only valid for stream:true replay')
    }

    let requestDigest: string
    try {
      requestDigest = durableRunRequestDigest(req, backend.name)
    } catch {
      return invalidRequest(c, 'chat request cannot be canonicalized as durable-run identity')
    }
    let claim: ReturnType<RunRegistry['claim']>
    try {
      claim = deps.runs.claim(runId, requestDigest)
    } catch (error) {
      if (error instanceof RunIdentityConflictError) return runIdentityConflict(c, error)
      throw error
    }
    const run = claim.run

    // Atomic claim happens BEFORE admission or backend setup. An identical racing request attaches
    // to this run and cannot acquire a second slot; a different request under the same id was
    // refused above. The creator alone owns setup and pump.
    if (!claim.created) {
      return respondFromRun(c, run, req, runId, afterSeq)
    }

    // Execution router: when the caller asks for `execution: 'sandbox'`
    // on a host harness (claude/kimi/gemini/codex/...), delegate to the
    // SandboxBackend instead of spawning the local CLI. The agent_profile
    // + prompt + cwd contract is identical — only the execution location
    // changes. Map the host harness → in-container backend type via
    // `harnessToSandboxBackendType`.
    //
    // `run.signal` (NOT the HTTP socket) drives the backend's abort
    // contract. A client disconnect leaves this signal untouched, so the
    // subprocess keeps running; only an explicit cancel aborts it.
    // One span per RUN, opened by its creator. A reconnecting reader attaches to
    // the run above and never reaches here, so replay cannot double-count a
    // request that only ran once.
    const callerTrace = resolveCallerTrace({
      traceparent: c.req.header('traceparent'),
      traceId: c.req.header('x-trace-id'),
      parentSpanId: c.req.header('x-parent-span-id'),
    })
    const recorder: RequestSpanRecorder | null = deps.trace?.beginRequest({
      runId,
      model: req.model,
      backend: backend.name,
      sessionId: req.session_id ?? null,
      mode: req.mode ?? 'byob',
      execution: req.execution?.kind ?? 'host',
      caller: callerTrace,
    }) ?? null

    // The harness child inherits this over its environment (`TRACEPARENT` +
    // the legacy `TRACE_ID` / `PARENT_SPAN_ID` pair), so the spans it emits
    // join the caller's trace instead of opening an orphan root. The parent
    // span is the bridge's own request span when one records — the child
    // then nests under the node that actually spawned it — else the caller's
    // ids travel through verbatim. A request with no correlation stamps
    // nothing: the child env stays byte-identical to the pre-channel bridge.
    req.childTrace = callerTrace.caller === null
      ? null
      : recorder !== null
        ? { traceId: recorder.traceId, parentSpanId: recorder.spanId }
        : callerTrace.caller

    let admissionSlot: AdmissionSlot | null = null
    let sessionLease: SessionExecutionLease | null = null
    try {
      // Distinct runs that continue one backend session must own its full
      // read → execute → update interval. The duplicate-run attachment path
      // above intentionally happens first and never enters this queue.
      if (req.session_id) {
        try {
          sessionLease = await deps.sessions.acquireExecution(
            req.session_id,
            backend.name,
            run.signal,
          )
        } catch (error) {
          if (error instanceof SessionExecutionAbortedError) {
            throw new BackendError(error.message, 'aborted', error)
          }
          throw error
        }
      }

      const session = req.session_id
        ? deps.sessions.get(req.session_id, backend.name)
        : null
      if (!req.agent_profile && session?.metadata?.agent_profile && typeof session.metadata.agent_profile === 'object') {
        req.agent_profile = session.metadata.agent_profile as ChatRequest['agent_profile']
      }
      if (!req.cwd && session?.cwd) {
        req.cwd = session.cwd
      }
      assertProfileRequestAuthority(req, session)
      const sessionProfileBinding = exactSessionProfileBinding(req, session)
      if (session) {
        assertSessionProfileBinding(session, sessionProfileBinding)
      }

      // Deny-by-default egress, gated before any execution path is chosen so a
      // net-jail cannot be requested of a mode that would not apply it.
      const netJailSpec = resolveNetJailSpec({
        execMode: req.execution?.netJail?.mode,
        ...(req.execution?.netJail?.allow ? { execAllow: req.execution.netJail.allow } : {}),
        env: process.env,
      })
      if (netJailSpec) {
        assertNetJailEnforced({
          backend: backend.name,
          executionKind: req.execution?.kind ?? 'host',
          spec: netJailSpec,
          registry: deps.netJail ?? new Map(),
        })
      }

      let makeSource: ((run: Run) => AsyncIterable<ChatDelta>) | null = null
      if (req.execution?.kind === 'sandbox' && backend.name !== 'sandbox') {
        const sandboxBackend = deps.registry.byName('sandbox')
        if (!sandboxBackend) {
          throw new SandboxBackendUnavailableError(
            'execution=sandbox requested but the sandbox backend is not registered. Set TANGLE_API_KEY/SANDBOX_API_KEY + SANDBOX_BASE_URL.',
          )
        }
        const sandboxBackendType = harnessToSandboxBackendType(backend.name)
        // Stash the desired in-container backend type on metadata so
        // SandboxBackend.chat() picks it up. Same path as
        // forwardedAuthorization — opaque metadata field that backends
        // honour by convention.
        const delegatedReq: ChatRequest = {
          ...req,
          metadata: {
            ...(req.metadata ?? {}),
            sandboxBackendType,
          },
        }
        makeSource = (run) => backendChatWithDeadline(
          sandboxBackend,
          delegatedReq,
          session,
          run.signal,
          req,
        )
      } else {
        // Host execution: resolve the write-jail spec from execution.jail
        // (host variant) layered over the BRIDGE_JAIL_* env defaults, using
        // the same cwd the backend will spawn in (req.cwd already folds in
        // session.cwd above; backends fall back to process.cwd()). The
        // resolved spec rides on req.jailSpec down to the spawn seam; null
        // means no jail and the spawn is unchanged.
        req.jailSpec = resolveJailSpec({
          execMode: req.execution?.kind === 'host' ? req.execution.jail?.mode : undefined,
          execRoot: req.execution?.kind === 'host' ? req.execution.jail?.root : undefined,
          cwd: req.cwd ?? process.cwd(),
          env: process.env,
        })
        // Preserve this backend's host credentials inside the jail so the
        // confined CLI still authenticates as the operator.
        if (req.jailSpec) req.jailSpec.authSources = authSourcesFor(backend.name)
        // The lane rides on the request so the scoped-host executor honours the
        // same reservation. Set even when this bridge has no admission gate:
        // the executor semaphore exists either way.
        req.admissionClass = admissionClassFor(req, deps.admissionReservedClients)
        if (deps.admission && shouldApplyHostAdmission(backend.name, req)) {
          // Admission is owned by the job. Explicit cancellation can remove
          // a queued job before it ever acquires a process slot. The slot is
          // bound to the job's lifetime below; the run's terminal state is the
          // gate's independent proof that the job is over.
          admissionSlot = await deps.admission.acquire({
            work: { id: run.id, isFinished: () => run.isTerminal() },
            admissionClass: req.admissionClass,
            signal: run.signal,
          })
        }
        makeSource = (run) => backendChatWithDeadline(backend, req, session, run.signal)
      }

      // Approximate input size once (content + tool-call structures), for backends that
      // report no usage. Estimated in wrap; tool calls are included so tool-heavy turns
      // are not systematically undercounted.
      const promptChars = estimateMessagesChars(req.messages)

      // Persist internal session id as it flows in. Returns a new
      // AsyncIterable<ChatDelta> so the typed boundary stays clean.
      // Typed backend/mode errors are converted to a terminal error delta
      // INSIDE the run buffer (the run owns the stream now — there is no
      // outer iterator to re-throw to). The route reader surfaces the right
      // HTTP/SSE shape from the buffered finish_reason.
      const wrap = (source: AsyncIterable<ChatDelta>): AsyncIterable<ChatDelta> => ({
        [Symbol.asyncIterator]: async function* () {
          let sawUsage = false
          let failed = false
          let emittedProfileMaterialization = false
          let completionChars = 0
          try {
            for await (const delta of source) {
              recorder?.observe(delta)
              if (delta.usage) sawUsage = true
              if (delta.finish_reason === 'error' || delta.finish_reason === 'timeout') failed = true
              completionChars += (delta.content?.length ?? 0)
                + (delta.tool_calls?.reduce(
                  (s, tc) => s + (tc.id?.length ?? 0) + (tc.name?.length ?? 0) + (tc.arguments?.length ?? 0),
                  0,
                ) ?? 0)
              if (delta.internal_session_id && req.session_id) {
                deps.sessions.upsert({
                  externalId: req.session_id,
                  backend: backend.name,
                  internalId: delta.internal_session_id,
                  cwd: req.cwd ?? session?.cwd ?? null,
                  metadata: {
                    ...(req.metadata ?? {}),
                    model: req.model,
                    ...(req.agent_profile ? { agent_profile: req.agent_profile } : {}),
                    ...(sessionProfileBinding
                      ? { agent_profile_binding: sessionProfileBinding }
                      : {}),
                    ...(req.profile_materialization_receipt
                      ? { profile_materialization: req.profile_materialization_receipt }
                      : {}),
                  },
                })
              }
              // An error/timeout terminal is rendered on the SSE wire as a bare
              // `{error}` event and parsed as nothing else by agent-runtime's
              // bridge executor — a receipt folded INTO that delta never
              // reaches the caller, which then misreads the failure as
              // "completed without receipt" transport trouble. Acknowledge the
              // materialization on its own buffered event FIRST (its own seq),
              // then pass the terminal through unchanged.
              const failedTerminal = delta.finish_reason === 'error' || delta.finish_reason === 'timeout'
              if (
                failedTerminal
                && req.profile_materialization_receipt
                && !emittedProfileMaterialization
                && !delta.profile_materialization
              ) {
                const acknowledgment = {
                  profile_materialization: req.profile_materialization_receipt,
                } satisfies ChatDelta
                recorder?.observe(acknowledgment)
                emittedProfileMaterialization = true
                yield acknowledgment
              }
              const committed = delta.finish_reason && !failedTerminal && req.profile_materialization_receipt
                ? { ...delta, profile_materialization: req.profile_materialization_receipt }
                : delta
              if (committed.profile_materialization) emittedProfileMaterialization = true
              yield committed
            }
            if (req.profile_materialization_receipt && !emittedProfileMaterialization) {
              const acknowledgment = {
                profile_materialization: req.profile_materialization_receipt,
              } satisfies ChatDelta
              recorder?.observe(acknowledgment)
              yield acknowledgment
            }
            // Successful backends whose CLI reports no usage (kimi-code, opencode)
            // get a bounded estimate. A failure without measured usage stays unknown:
            // inventing tokens after error/timeout masks the real terminal condition.
            if (!sawUsage && !failed) {
              const estimated = {
                usage: {
                  input_tokens: tokensFromChars(promptChars),
                  output_tokens: tokensFromChars(completionChars),
                  estimated: true,
                },
              } satisfies ChatDelta
              recorder?.observe(estimated)
              yield estimated
            }
          } catch (error) {
            // Recorded, then RETHROWN unchanged. Errors are still NOT handled
            // here: `Run.pump` records a throw that happened before any output as
            // the run's dispatch error, which the reader turns into a real HTTP
            // status carrying the message; a throw mid-stream still becomes a
            // terminal error delta there. Swallowing untyped errors into a bare
            // `finish_reason: 'error'` at this point meant a caller received 200
            // with an empty error while the only copy of the reason went to the
            // bridge's stdout — measured with a configuration error whose message
            // named the exact env var to set. This catch exists solely to close
            // the span with that reason; adding anything else to it re-opens the
            // defect above.
            recorder?.fail(error)
            throw error
          }
        },
      })

      // The run pumps the source to completion on its own. This connection is only one reader;
      // dropping it never touches `run.signal` or releases job-owned admission.
      //
      // Every job-owned resource is released from the JOB'S promise, never from
      // the delta stream's `finally`: a stream that is never consumed never runs
      // that `finally`, and `Run.pump` returns without consuming its source when
      // the run is already committed terminal. `pump()` always settles — it
      // returns the settled promise on that path — so this binding has no exit
      // to skip.
      const endJobResources = (): void => {
        sessionLease?.release()
        sessionLease = null
        // No-op when the stream's catch already closed the span.
        recorder?.end()
      }
      // The receipt supplier is read at FAILURE time: the backend retains the
      // receipt on `req` during materialization (before spawn), so a thrown
      // subprocess failure still acknowledges the profile instead of letting
      // the caller misread the whole run as a missing-receipt transport fault.
      const job = run.pump(wrap(makeSource(run)), {
        terminalReceipt: () => req.profile_materialization_receipt,
      })
      admissionSlot?.holdUntil(job)
      admissionSlot = null
      void job.then(endJobResources, endJobResources)
    } catch (error) {
      // Setup failed, so this slot's job is already over — the same one-call
      // contract, with a lifetime that has settled. Nothing here can leak the
      // slot: had this line been skipped, the gate would reclaim it once
      // `run.failSetup` commits the run terminal.
      admissionSlot?.holdUntil(Promise.resolve())
      sessionLease?.release()
      sessionLease = null
      run.failSetup(error)
      // A request rejected at admission or misconfigured before spawn never
      // reaches the wrapped stream, and it is exactly the request an operator
      // goes looking for. The span records why it never ran.
      recorder?.fail(error)
      return errorResponse(c, error)
    }

    return respondFromRun(c, run, req, runId, afterSeq)
  })
}

/** The subset of the non-streaming completion body this route reasons about. */
interface CollectedCompletion {
  error?: { message: string; type: string }
  choices?: Array<{ message?: { content?: string; tool_calls?: unknown[] } }>
}

/** True when the run produced something a caller can use. */
function completionHasOutput(body: CollectedCompletion): boolean {
  const message = body.choices?.[0]?.message
  return Boolean(message?.content) || (message?.tool_calls?.length ?? 0) > 0
}

/**
 * Render a (possibly already-running) durable run to this request. The
 * client attaches as a reader from `afterSeq`; a disconnect ends the
 * reader but NEVER the run. Streaming and non-streaming both read the
 * same buffered, seq-numbered delta log.
 */
async function respondFromRun(
  c: Context,
  run: Run,
  req: ChatRequest,
  runId: string,
  afterSeq: number,
): Promise<Response> {
  try {
    run.assertReplayCursor(afterSeq)
  } catch (error) {
    if (error instanceof RunReplayCursorError) return replayCursorError(c, error)
    throw error
  }
  // Surface mode + run id so clients can reconnect/cancel by run id.
  c.header('X-Bridge-Mode', req.mode ?? 'byob')
  c.header('X-Run-Id', runId)
  c.header('X-Run-Request-Digest', run.requestDigest)

  // OpenAI's /v1/chat/completions defaults `stream: false` when the field
  // is omitted. Only stream when the caller asked for it (`stream: true`);
  // otherwise drain the run's buffer to a single completion body.
  if (req.stream !== true) {
    // A non-streaming response is a single JSON body, so a dispatch-time
    // typed error (mode rejected, spawn/config failure — thrown before any
    // delta) must become a real HTTP status, not a 200 with an error
    // payload. Re-attaching readers receive the same typed error, and the
    // check resolves once output starts or the run settles.
    await run.whenStarted()
    const dispatchErr = run.dispatchError()
    if (dispatchErr !== undefined) return errorResponse(c, dispatchErr)
    try {
      const deltas = mapSeq(run.attach(afterSeq))
      const body = await collectNonStreaming(deltas, req.model) as CollectedCompletion
      if (body.error) {
        // A failure AFTER output began is still a failure. With nothing to show
        // for the run, answer with the same status the identical pre-output
        // failure would have produced — a caller cannot tell where in the
        // stream a fault happened and must not have to. With partial output,
        // keep the real work and carry the reason in the body: measured, this
        // was a 200 whose whole explanation was `finish_reason: "error"`.
        const failure = run.failure()
        if (!completionHasOutput(body)) {
          if (failure !== undefined) return errorResponse(c, failure)
          // No recorded failure and no output: the only way to get here is a
          // run the CALLER cancelled. That is not a server fault, so it must not
          // wear a 5xx — but it must not wear a 200 with an empty message
          // either, which is what a benchmark harness would score 0.000.
          return c.json({ error: body.error }, run.snapshot().status === 'cancelled' ? 409 : 500)
        }
      }
      return c.json(body)
    } catch (err) {
      return errorResponse(c, err)
    }
  }

  return streamRunEvents(c, run, req.model, afterSeq)
}

/** Unwrap SeqDelta → ChatDelta for the non-streaming collector. */
async function* mapSeq(iter: AsyncIterable<{ delta: ChatDelta }>): AsyncIterable<ChatDelta> {
  for await (const { delta } of iter) yield delta
}

type ParsedHeader<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

function resolveRunId(
  bodyValue: string | undefined,
  headerValue: string | undefined,
): ParsedHeader<string> {
  if (bodyValue !== undefined && headerValue !== undefined && bodyValue !== headerValue) {
    return { ok: false, message: 'run_id and X-Run-Id must match when both are provided' }
  }
  const candidate = bodyValue ?? headerValue ?? crypto.randomUUID()
  const parsed = durableRunIdSchema.safeParse(candidate)
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'invalid run id' }
  }
  return { ok: true, value: parsed.data }
}

/** Bind a run id to execution semantics, not response representation. `stream` and runtime-owned
 * materialization fields do not change the backend job and are deliberately excluded. */
function durableRunRequestDigest(req: ChatRequest, backend: string): string {
  const {
    stream: _stream,
    jailSpec: _jailSpec,
    profile_materialization_receipt: _materialization,
    protectedModelCredential,
    ...executionRequest
  } = req
  // The request originated as JSON, but object spreads can reintroduce
  // optional `undefined` properties. A JSON round trip restores exact wire
  // semantics before RFC 8785 canonicalization (undefined object fields are
  // absent; array values retain their JSON form).
  const normalized = JSON.parse(JSON.stringify({
    schema: 'cli-bridge.durable-run-request.v1',
    backend,
    request: executionRequest,
    ...(protectedModelCredential
      ? {
          protectedModelCredentialDigest: protectedModelCredential.digest,
          protectedModelBaseUrlDigest: protectedModelCredential.baseUrlDigest,
        }
      : {}),
  })) as Parameters<typeof canonicalCandidateDigest>[0]
  return canonicalCandidateDigest(normalized)
}

function protectedCredentialDigest(token: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`
}

function canonicalProtectedModelBaseUrl(value: string): string | undefined {
  let target: URL
  try {
    target = new URL(value)
  } catch {
    return undefined
  }
  if (
    target.protocol !== 'https:'
    || target.username
    || target.password
    || target.search
    || target.hash
  ) {
    return undefined
  }
  return target.toString().replace(/\/$/u, '')
}

interface SessionProfileBinding {
  schema: 'cli-bridge.session-agent-profile.v1'
  effectiveProfileDigest: `sha256:${string}`
  provider: string | null
  model: string
  requestedReasoningEffort: string | null
}

function exactSessionProfileBinding(
  req: ChatRequest,
  session: SessionRecord | null,
): SessionProfileBinding | null {
  const profile = resolveAgentProfile(req, session)
  if (!profile) return null
  const parts = req.model.split('/')
  const provider = parts.length >= 3 && parts[1]
    ? parts[1]
    : profile.model?.provider ?? null
  return {
    schema: 'cli-bridge.session-agent-profile.v1',
    effectiveProfileDigest: canonicalAgentProfileDigest(profile),
    provider,
    model: req.model,
    requestedReasoningEffort: resolveRequestedReasoningEffort(req, session),
  }
}

function assertSessionProfileBinding(
  session: SessionRecord,
  received: SessionProfileBinding | null,
): void {
  const stored = session.metadata.agent_profile_binding
  if (!stored || typeof stored !== 'object') {
    if (received) {
      throw new BackendError(
        `session ${JSON.stringify(session.externalId)} predates exact AgentProfile binding; start a new session`,
        'parse_error',
      )
    }
    return
  }
  if (!received || JSON.stringify(stored) !== JSON.stringify(received)) {
    throw new BackendError(
      `session ${JSON.stringify(session.externalId)} is bound to a different AgentProfile/model`,
      'parse_error',
    )
  }
}

function invalidRequest(c: Context, message: string): Response {
  return c.json({ error: { message, type: 'invalid_request_error' } }, 400)
}

function runIdentityConflict(c: Context, error: RunIdentityConflictError): Response {
  return c.json(
    {
      error: {
        message: error.message,
        type: error.code,
        run_id: error.runId,
        expected_request_digest: error.expectedRequestDigest,
        received_request_digest: error.receivedRequestDigest,
      },
    },
    409,
  )
}

function replayCursorError(c: Context, error: RunReplayCursorError): Response {
  return c.json(
    {
      error: {
        message: error.message,
        type: error.code,
        run_id: error.runId,
        last_event_id: error.lastSeq,
        first_available_event_id: error.firstAvailableSeq,
      },
    },
    error.reason === 'expired' ? 410 : 409,
  )
}

/**
 * Parse the `X-Mcp-Config` request header. Accepts the canonical
 * `{ mcpServers: { … } }` shape; invalid JSON is silently dropped
 * rather than 400-ing the whole request so callers can opportunistically
 * set the header without it becoming a brittle hard dep.
 */
function parseMcpHeader(value: string | undefined): ChatRequest['mcp'] | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object') return parsed as ChatRequest['mcp']
  } catch {
    // ignore — malformed header is best-effort
  }
  return undefined
}

/**
 * Merge MCP inputs from the header and the body, with body winning on
 * per-server name collisions. Either side can be undefined.
 */
function mergeMcpInputs(
  fromHeader: ChatRequest['mcp'] | undefined,
  fromBody: ChatRequest['mcp'] | undefined,
): ChatRequest['mcp'] | undefined {
  if (!fromHeader && !fromBody) return undefined
  const headerServers = (fromHeader?.mcpServers ?? {}) as Record<string, unknown>
  const bodyServers = (fromBody?.mcpServers ?? {}) as Record<string, unknown>
  const merged = { ...headerServers, ...bodyServers }
  if (Object.keys(merged).length === 0) return undefined
  return { mcpServers: merged } as ChatRequest['mcp']
}

function normalizeResponseFormat(format: { type: 'text' | 'json_object' | 'json_schema' }): ChatRequest['responseFormat'] {
  return format.type === 'json_schema'
    ? { type: 'json_object' }
    : { type: format.type }
}

function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof RunReplayCursorError) return replayCursorError(c, err)
  if (err instanceof SandboxBackendUnavailableError) {
    return c.json({ error: { message: err.message, type: err.code } }, 503)
  }
  if (err instanceof AdmissionRejectedError) {
    return admissionErrorResponse(c, err)
  }
  if (err instanceof ModeNotSupportedError) {
    return c.json({ error: { message: err.message, type: 'mode_not_supported' } }, 501)
  }
  // An executor that cannot serve the request as configured: 501 (this bridge is
  // not set up for that) rather than 500 (this bridge broke). The message names
  // the setting to change, so it must reach the caller and not only the log.
  if (err instanceof ExecutorConfigurationError) {
    return c.json({ error: { message: err.message, type: err.code } }, 501)
  }
  // A failure the backend YIELDED as a terminal error delta rather than throwing.
  // It reaches here through `run.failure()`, and it is an upstream fault by
  // construction — the CLI ran and ended badly — so 502, or 504 when the reason
  // is a timeout. Falling through to the generic 500 below would have relabelled
  // every upstream fault as a bridge fault.
  if (err instanceof BackendReportedFailureError) {
    return c.json({ error: { message: err.message, type: err.code } }, err.code === 'timeout' ? 504 : 502)
  }
  if (err instanceof BackendError) {
    if (err.code === 'parse_error') {
      return c.json({ error: { message: err.message, type: err.code } }, 400)
    }
    // Hono's typed status gate treats 499 as an unofficial code; collapse
    // that one to 504 and keep the rest as documented codes.
    const status: 500 | 501 | 502 | 503 | 504 =
      err.code === 'not_configured' ? 501
      : err.code === 'cli_missing' ? 503
      : err.code === 'timeout' ? 504
      : err.code === 'aborted' ? 504
      : 502
    return c.json({ error: { message: err.message, type: err.code } }, status)
  }
  const message = err instanceof Error ? err.message : String(err)
  return c.json({ error: { message, type: 'server_error' } }, 500)
}

/**
 * Route a request to an admission lane by `x-tangle-client` (already folded
 * into request metadata). Matching is on the segment before `/`, so the
 * caller can keep versioning its client string (`pr-reviewer/1`).
 *
 * Unknown callers are `bulk`: a new caller must not be able to claim the
 * reserved lane by accident, and the lane is only useful while it stays small.
 */
function admissionClassFor(req: ChatRequest, reservedClients?: string[]): AdmissionClass {
  if (!reservedClients || reservedClients.length === 0) return 'bulk'
  const client = req.metadata?.tangleClient
  if (typeof client !== 'string' || client === '') return 'bulk'
  const name = client.split('/')[0]?.trim().toLowerCase() ?? ''
  return reservedClients.includes(name) ? 'reserved' : 'bulk'
}

function admissionErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof AdmissionRejectedError)) {
    return errorResponse(c, err)
  }
  const s = err.snapshot
  // Saturation was previously invisible: nothing logged a rejection, so the
  // only record of a starved caller lived in that caller's own error string.
  console.warn(
    `[cli-bridge] admission rejected: class=${err.admissionClass} reason=${err.reason} ` +
    `active=${s.active}/${s.maxActive} (reserved=${s.activeByClass.reserved} bulk=${s.activeByClass.bulk}/${s.bulkMaxActive}) ` +
    `queued=${s.queued} (reserved=${s.queuedByClass.reserved} bulk=${s.queuedByClass.bulk}) maxQueue=${s.maxQueue}/class`,
  )
  c.header('Retry-After', '5')
  return c.json({
    error: {
      // `capacity` is the field a caller should branch on. An admission
      // rejection means the bridge never started the model; conflating it with
      // an upstream model failure is what let a review that could not run be
      // reported as a review that ran and found nothing.
      capacity: true,
      message: err.message,
      type: 'admission_rejected',
      reason: err.reason,
      admissionClass: err.admissionClass,
      admission: s,
    },
  }, 503)
}

function shouldApplyHostAdmission(backendName: string, req: ChatRequest): boolean {
  if (req.execution?.kind === 'sandbox') return false
  return backendName !== 'sandbox' && backendName !== 'passthrough'
}

/**
 * Map a host harness name (the `Backend.name` field — `claude`,
 * `kimi-code`, `gemini`, `codex`, `opencode`, `amp`, `factory`, `forge`) to the
 * matching in-container backend type the sandbox SDK accepts. The two
 * sets are mostly 1:1; the only divergence today is `factory` (host)
 * vs `factory-droids` (sandbox), which mirrors the upstream package
 * naming conventions.
 *
 * Unknown harnesses fall through as-is — sandbox-api will 400 if it
 * doesn't recognise the type, which is the right loud failure.
 */
function harnessToSandboxBackendType(harnessName: string): string {
  switch (harnessName) {
    case 'claude': return 'claude-code'
    case 'claudish': return 'claude-code'
    case 'factory': return 'factory-droids'
    default: return harnessName
  }
}
