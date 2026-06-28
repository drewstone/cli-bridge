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
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import type { BackendRegistry } from '../backends/registry.js'
import type { SessionStore } from '../sessions/store.js'
import type { ChatDelta, ChatRequest } from '../backends/types.js'
import { BackendError } from '../backends/types.js'
import { parseMode, ModeNotSupportedError } from '../modes.js'
import { collectNonStreaming, deltaToOpenAIChunk, deltaToSseComment, makeChunkMeta } from '../streaming/sse.js'
import { estimateMessagesChars, tokensFromChars } from '../backends/content.js'
import { resolveJailSpec } from '../jail/resolve-spec.js'
import { authSourcesFor } from '../jail/auth-preserve.js'
import { AdmissionRejectedError, type AdmissionGate, type AdmissionLease } from '../admission.js'
import type { Run, RunRegistry } from '../runs/registry.js'

const DEFAULT_SSE_HEARTBEAT_MS = 15_000

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
  run_id: z.string().optional(),
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
     * When kind=host, an optional per-request write-jail override.
     *   mode: 'write-jail' turns confinement ON for this request. NOTE:
     *         `BRIDGE_JAIL_MODE=write-jail` is an operator FLOOR — a
     *         per-request 'off' can NOT disable it (a request can only add
     *         confinement, never weaken the server policy). 'off' takes
     *         effect only when no env floor is set.
     *   root: writable jail root (default <cwd>/.agent-home), clamped
     *         inside the request cwd.
     * Layered over the BRIDGE_JAIL_MODE / BRIDGE_JAIL_ROOT env defaults.
     */
    jail: z.object({
      mode: z.enum(['off', 'write-jail']).optional(),
      root: z.string().optional(),
    }).optional(),
  }).optional(),
})

export function mountChatCompletions(
  app: Hono,
  deps: { registry: BackendRegistry; sessions: SessionStore; runs: RunRegistry; admission?: AdmissionGate },
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
    // Pull response_format off so it doesn't bleed through the spread
    // as an unknown extra field — we translate snake_case → camelCase
    // here to match the ChatRequest type.
    const { response_format, agent_profile, cwd, execution, mcp: bodyMcp, run_id: bodyRunId, ...rest } = parsed.data
    // MCP can arrive in the body OR the `X-Mcp-Config` header. Body
    // wins on conflict — header is for callers that can't extend the
    // request body (e.g. forwarding through a third-party gateway that
    // strips unknown JSON fields).
    const mcpHeader = parseMcpHeader(c.req.header('x-mcp-config'))
    const mergedMcp = mergeMcpInputs(mcpHeader, bodyMcp as ChatRequest['mcp'] | undefined)
    const req: ChatRequest = {
      ...rest,
      session_id: bodySession ?? headerSession,
      mode,
      ...(response_format ? { responseFormat: normalizeResponseFormat(response_format) } : {}),
      ...(agent_profile ? { agent_profile: agent_profile as ChatRequest['agent_profile'] } : {}),
      ...(mergedMcp ? { mcp: mergedMcp } : {}),
      ...(cwd ? { cwd } : {}),
      ...(execution ? { execution: execution as ChatRequest['execution'] } : {}),
      metadata: {
        ...(parsed.data.metadata ?? {}),
        ...(tangleClient ? { tangleClient } : {}),
        ...(tangleSource ? { tangleSource } : {}),
        ...(forwardedAuthz ? { forwardedAuthorization: forwardedAuthz } : {}),
      },
    }

    const backend = deps.registry.resolve(req.model)
    if (!backend) {
      return c.json({
        error: {
          message: `no backend matches model "${req.model}". Check /health for registered backends.`,
          type: 'not_found_error',
        },
      }, 404)
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

    // Durable-run id: connection-independent job identity. A reconnect or
    // retry reusing this id RE-ATTACHES to the same in-flight subprocess.
    const runId = bodyRunId ?? c.req.header('x-run-id') ?? crypto.randomUUID()
    // Last-Event-ID (standard SSE reconnect header) or the X-Last-Event-Id
    // alias: the highest seq the client already saw. Replay starts after it.
    const afterSeq = parseLastEventId(
      c.req.header('last-event-id') ?? c.req.header('x-last-event-id'),
    )

    // Idempotent dispatch. A known run id re-attaches with zero new work —
    // no second subprocess, no second admission slot. Only a genuinely new
    // id reaches the setup-and-pump path below.
    const existing = deps.runs.get(runId)
    if (existing) {
      return respondFromRun(c, existing, req, runId, afterSeq, false)
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
    let admissionLease: AdmissionLease | null = null
    let makeSource: ((run: Run) => AsyncIterable<ChatDelta>) | null = null
    if (req.execution?.kind === 'sandbox' && backend.name !== 'sandbox') {
      const sandboxBackend = deps.registry.byName('sandbox')
      if (!sandboxBackend) {
        return c.json({
          error: {
            message: 'execution=sandbox requested but the sandbox backend is not registered. Set TANGLE_API_KEY/SANDBOX_API_KEY + SANDBOX_BASE_URL.',
            type: 'not_found_error',
          },
        }, 503)
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
      makeSource = (run) => sandboxBackend.chat(delegatedReq, session, run.signal)
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
      if (deps.admission && shouldApplyHostAdmission(backend.name, req)) {
        try {
          // Admission is held by the JOB, not the connection — release it
          // when the run finishes, not when the client drops. Acquire is
          // cancellable only by an explicit shutdown, so pass no signal.
          admissionLease = await deps.admission.acquire()
        } catch (err) {
          return admissionErrorResponse(c, err)
        }
      }
      makeSource = (run) => backend.chat(req, session, run.signal)
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
        let completionChars = 0
        try {
          for await (const delta of source) {
            if (delta.usage) sawUsage = true
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
                  model: req.model,
                  ...(req.agent_profile ? { agent_profile: req.agent_profile } : {}),
                  ...(req.metadata ?? {}),
                },
              })
            }
            yield delta
          }
          // Backends whose CLI reports no usage (kimi-code, opencode) would leave
          // every reader with zero tokens, indistinguishable from a stub. Estimate
          // from the text (~4 chars/token) and emit a usage delta flagged `estimated`
          // so cost ledgers approximate spend without mistaking it for measured truth.
          // It is buffered in the run, so reconnecting readers receive it too.
          if (!sawUsage) {
            yield {
              usage: {
                input_tokens: tokensFromChars(promptChars),
                output_tokens: tokensFromChars(completionChars),
                estimated: true,
              },
            } satisfies ChatDelta
          }
        } catch (err) {
          if (err instanceof ModeNotSupportedError || err instanceof BackendError) {
            throw err
          }
          yield { finish_reason: 'error' } satisfies ChatDelta
          console.error(`[cli-bridge] backend ${backend.name} failed:`, err)
        } finally {
          // Admission is released when the JOB ends — pump() consumes this
          // source to completion regardless of client connection state.
          admissionLease?.release()
        }
      },
    })

    // Register + start the durable run. getOrCreate is idempotent: a
    // racing duplicate (same run_id arriving twice) re-attaches to the
    // first run and never invokes the factory twice. The run pumps the
    // source to completion on its own — the client connection below is
    // just one of possibly many readers.
    const run = deps.runs.getOrCreate(runId, (r) => {
      void r.pump(wrap(makeSource!(r)))
    })

    return respondFromRun(c, run, req, runId, afterSeq, true)
  })
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
  isFresh: boolean,
): Promise<Response> {
  // Surface mode + run id so clients can reconnect/cancel by run id.
  c.header('X-Bridge-Mode', req.mode ?? 'byob')
  c.header('X-Run-Id', runId)

  // OpenAI's /v1/chat/completions defaults `stream: false` when the field
  // is omitted. Only stream when the caller asked for it (`stream: true`);
  // otherwise drain the run's buffer to a single completion body.
  if (req.stream !== true) {
    // A non-streaming response is a single JSON body, so a dispatch-time
    // typed error (mode rejected, spawn/config failure — thrown before any
    // delta) must become a real HTTP status, not a 200 with an error
    // payload. Only the fresh dispatcher does this; a re-attaching client
    // (run already known) drains the buffered terminal error instead. The
    // gate resolves the moment output starts or the run settles, so a
    // healthy long job is never blocked past its first delta.
    if (isFresh) {
      await run.whenStarted()
      const dispatchErr = run.dispatchError()
      if (dispatchErr !== undefined) return errorResponse(c, dispatchErr)
    }
    try {
      const deltas = mapSeq(run.attach(afterSeq))
      const body = await collectNonStreaming(deltas, req.model)
      return c.json(body)
    } catch (err) {
      return errorResponse(c, err)
    }
  }

  return streamSSE(c, async (stream) => {
    const meta = makeChunkMeta(req.model)
    const heartbeatMs = resolveSseHeartbeatMs()
    // `clientGone` ends THIS reader on a write failure (socket closed). It
    // does NOT cancel the run — that is the whole point of the decoupling.
    let clientGone = false
    const writeRaw = async (chunk: string): Promise<boolean> => {
      if (clientGone) return false
      try {
        await stream.write(chunk)
        return true
      } catch {
        clientGone = true
        return false
      }
    }
    // SSE `id:` carries the per-run seq so the client's next reconnect can
    // send it back as Last-Event-ID and replay exactly what it missed.
    const writeSse = async (data: string, id?: number): Promise<boolean> => {
      if (clientGone) return false
      try {
        await stream.writeSSE(id !== undefined ? { data, id: String(id) } : { data })
        return true
      } catch {
        clientGone = true
        return false
      }
    }
    const heartbeat = setInterval(() => {
      void writeRaw(': keepalive\n\n')
    }, heartbeatMs)
    try {
      if (!await writeRaw(': connected\n\n')) return
      for await (const { seq, delta } of run.attach(afterSeq)) {
        if (clientGone) break
        // Backend-level liveness ping (e.g. kimi/opencode stdout idle):
        // render as SSE comment so the consumer (AI SDK, openai-node)
        // ignores it per spec instead of trying to route a fake tool
        // call. SSE comments also count as transport heartbeats.
        const comment = deltaToSseComment(delta)
        if (comment) {
          if (!await writeRaw(comment)) break
          continue
        }
        const chunk = deltaToOpenAIChunk(delta, meta)
        // Metadata-only deltas (e.g. internal_session_id) yield null —
        // consumed by the run/session store; nothing to write here.
        if (!chunk) continue
        // deltaToOpenAIChunk returns a complete "data: …\n\n" line. Strip
        // the framing so streamSSE can re-add it (with the seq as id).
        const payload = chunk.slice('data: '.length).replace(/\n\n$/, '')
        if (!await writeSse(payload, seq)) break
      }
    } catch (err) {
      if (clientGone) return
      const message = err instanceof Error ? err.message : String(err)
      await writeSse(JSON.stringify({ error: { message, type: 'server_error' } }))
    } finally {
      clearInterval(heartbeat)
    }
    await writeSse('[DONE]')
  })
}

/** Unwrap SeqDelta → ChatDelta for the non-streaming collector. */
async function* mapSeq(iter: AsyncIterable<{ delta: ChatDelta }>): AsyncIterable<ChatDelta> {
  for await (const { delta } of iter) yield delta
}

/**
 * Parse a `Last-Event-ID` / `X-Last-Event-Id` reconnect header into a
 * seq. Non-numeric / absent → 0 (replay from the start of the buffer).
 */
function parseLastEventId(value: string | undefined): number {
  if (!value) return 0
  const n = Number.parseInt(value, 10)
  return Number.isInteger(n) && n >= 0 ? n : 0
}

function resolveSseHeartbeatMs(): number {
  const raw = Number(process.env.BRIDGE_SSE_HEARTBEAT_MS)
  return Number.isFinite(raw) && raw >= 10 ? raw : DEFAULT_SSE_HEARTBEAT_MS
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
  if (err instanceof AdmissionRejectedError) {
    return admissionErrorResponse(c, err)
  }
  if (err instanceof ModeNotSupportedError) {
    return c.json({ error: { message: err.message, type: 'mode_not_supported' } }, 501)
  }
  if (err instanceof BackendError) {
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

function admissionErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof AdmissionRejectedError)) {
    return errorResponse(c, err)
  }
  c.header('Retry-After', '5')
  return c.json({
    error: {
      message: err.message,
      type: 'admission_rejected',
      reason: err.reason,
      admission: err.snapshot,
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
