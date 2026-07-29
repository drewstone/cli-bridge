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
import { canonicalCandidateDigest } from '@tangle-network/agent-interface'
import type { BackendRegistry } from '../backends/registry.js'
import type { SessionStore } from '../sessions/store.js'
import type { ChatDelta, ChatRequest } from '../backends/types.js'
import { ExecutorConfigurationError } from '../executors/types.js'
import { BackendError } from '../backends/types.js'
import { parseMode, ModeNotSupportedError } from '../modes.js'
import { collectNonStreaming, deltaToOpenAIChunk, deltaToSseComment, makeChunkMeta } from '../streaming/sse.js'
import { estimateMessagesChars, tokensFromChars } from '../backends/content.js'
import { resolveJailSpec } from '../jail/resolve-spec.js'
import { authSourcesFor } from '../jail/auth-preserve.js'
import { AdmissionRejectedError, type AdmissionGate, type AdmissionLease } from '../admission.js'
import {
  type Run,
  RunIdentityConflictError,
  RunReplayCursorError,
  type RunRegistry,
} from '../runs/registry.js'

const DEFAULT_SSE_HEARTBEAT_MS = 15_000

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

    // Durable-run identity and replay cursor are exact claims. Conflicting aliases, malformed ids,
    // and invalid cursors fail closed instead of silently selecting one value or replaying from 0.
    const runIdResult = resolveRunId(bodyRunId, c.req.header('x-run-id'))
    if (!runIdResult.ok) return invalidRequest(c, runIdResult.message)
    const runId = runIdResult.value
    const standardCursor = c.req.header('last-event-id')
    const aliasCursor = c.req.header('x-last-event-id')
    const cursorResult = resolveLastEventId(standardCursor, aliasCursor)
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

    // Bind identity to the normalized caller request above, before reading
    // mutable session defaults. An exact retry must attach even if the live
    // run has already persisted newer session metadata.
    const session = req.session_id
      ? deps.sessions.get(req.session_id, backend.name)
      : null
    if (!req.agent_profile && session?.metadata?.agent_profile && typeof session.metadata.agent_profile === 'object') {
      req.agent_profile = session.metadata.agent_profile as ChatRequest['agent_profile']
    }
    if (!req.cwd && session?.cwd) {
      req.cwd = session.cwd
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
    try {
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
          // Admission is owned by the job. Explicit cancellation can remove
          // a queued job before it ever acquires a process slot.
          admissionLease = await deps.admission.acquire(run.signal)
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
          let failed = false
          let completionChars = 0
          try {
            for await (const delta of source) {
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
                    model: req.model,
                    ...(req.agent_profile ? { agent_profile: req.agent_profile } : {}),
                    ...(req.metadata ?? {}),
                  },
                })
              }
              yield delta.finish_reason && req.profile_materialization_receipt
                ? { ...delta, profile_materialization: req.profile_materialization_receipt }
                : delta
            }
            // Successful backends whose CLI reports no usage (kimi-code, opencode)
            // get a bounded estimate. A failure without measured usage stays unknown:
            // inventing tokens after error/timeout masks the real terminal condition.
            if (!sawUsage && !failed) {
              yield {
                usage: {
                  input_tokens: tokensFromChars(promptChars),
                  output_tokens: tokensFromChars(completionChars),
                  estimated: true,
                },
              } satisfies ChatDelta
            }
          } finally {
            // Errors are NOT caught here. `Run.pump` records a throw that
            // happened before any output as the run's dispatch error, which the
            // reader turns into a real HTTP status carrying the message; a throw
            // mid-stream still becomes a terminal error delta there. Swallowing
            // untyped errors into a bare `finish_reason: 'error'` at this point
            // meant a caller received 200 with an empty error while the only
            // copy of the reason went to the bridge's stdout — measured with a
            // configuration error whose message named the exact env var to set.
            //
            // Admission is released when the job ends. Reader disconnects
            // cannot release a slot that still owns a subprocess.
            admissionLease?.release()
          }
        },
      })

      // The run pumps the source to completion on its own. This connection is only one reader;
      // dropping it never touches `run.signal` or releases job-owned admission.
      void run.pump(wrap(makeSource(run)))
    } catch (error) {
      admissionLease?.release()
      admissionLease = null
      run.failSetup(error)
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
          return failure !== undefined
            ? errorResponse(c, failure)
            : c.json({ error: body.error }, 500)
        }
      }
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
    const readerController = new AbortController()
    stream.onAbort(() => {
      clientGone = true
      readerController.abort()
    })
    const writeRaw = async (chunk: string): Promise<boolean> => {
      if (clientGone || stream.aborted) return false
      try {
        await stream.write(chunk)
        return !stream.aborted
      } catch {
        clientGone = true
        readerController.abort()
        return false
      }
    }
    // SSE `id:` carries the per-run seq so the client's next reconnect can
    // send it back as Last-Event-ID and replay exactly what it missed.
    const writeSse = async (data: string, id?: number): Promise<boolean> => {
      if (clientGone || stream.aborted) return false
      try {
        await stream.writeSSE(id !== undefined ? { data, id: String(id) } : { data })
        return !stream.aborted
      } catch {
        clientGone = true
        readerController.abort()
        return false
      }
    }
    const heartbeat = setInterval(() => {
      void writeRaw(': keepalive\n\n')
    }, heartbeatMs)
    try {
      if (!await writeRaw(': connected\n\n')) return
      for await (const { seq, delta } of run.attach(afterSeq, readerController.signal)) {
        if (clientGone) break
        // The run pump attaches the reason to the terminal delta itself, so a
        // failure at ANY point in the stream — not only before the first delta —
        // becomes one OpenAI error frame here, and a reconnecting reader replays
        // the same reason instead of a bare terminal marker.
        if (delta.finish_reason === 'error' && delta.error) {
          await writeSse(JSON.stringify({ error: delta.error }), seq)
          break
        }
        // Backend-level liveness ping (e.g. kimi/opencode stdout idle):
        // render as SSE comment so the consumer (AI SDK, openai-node)
        // ignores it per spec instead of trying to route a fake tool
        // call. SSE comments also count as transport heartbeats.
        const comment = deltaToSseComment(delta)
        if (comment) {
          // Every buffered delta advances the durable replay cursor, including
          // liveness and bridge-internal metadata that OpenAI clients should
          // otherwise ignore. Carry the id on an SSE comment frame so an exact
          // client can reject a missing sequence instead of silently skipping it.
          if (!await writeRaw(`id: ${seq}\n${comment}`)) break
          continue
        }
        const chunk = deltaToOpenAIChunk(delta, meta)
        // Metadata-only deltas (e.g. internal_session_id) yield null —
        // consumed by the run/session store. Emit an id-only comment frame so
        // the replay sequence remains gap-free without exposing a fake chunk.
        if (!chunk) {
          if (!await writeRaw(`id: ${seq}\n: bridge-metadata\n\n`)) break
          continue
        }
        // deltaToOpenAIChunk returns a complete "data: …\n\n" line. Strip
        // the framing so streamSSE can re-add it (with the seq as id).
        const payload = chunk.slice('data: '.length).replace(/\n\n$/, '')
        if (!await writeSse(payload, seq)) break
      }
    } catch (err) {
      if (clientGone) return
      const message = err instanceof Error ? err.message : String(err)
      const type = err instanceof RunReplayCursorError ? err.code : 'server_error'
      await writeSse(JSON.stringify({ error: { message, type } }))
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

function resolveLastEventId(
  standardValue: string | undefined,
  aliasValue: string | undefined,
): ParsedHeader<number> {
  const parse = (value: string | undefined): ParsedHeader<number | undefined> => {
    if (value === undefined) return { ok: true, value: undefined }
    if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
      return { ok: false, message: 'Last-Event-ID must be a non-negative base-10 integer' }
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
      return { ok: false, message: 'Last-Event-ID exceeds the safe integer range' }
    }
    return { ok: true, value: parsed }
  }
  const standard = parse(standardValue)
  if (!standard.ok) return standard
  const alias = parse(aliasValue)
  if (!alias.ok) return alias
  if (
    standard.value !== undefined &&
    alias.value !== undefined &&
    standard.value !== alias.value
  ) {
    return {
      ok: false,
      message: 'Last-Event-ID and X-Last-Event-Id must match when both are provided',
    }
  }
  return { ok: true, value: standard.value ?? alias.value ?? 0 }
}

/** Bind a run id to execution semantics, not response representation. `stream` and runtime-owned
 * materialization fields do not change the backend job and are deliberately excluded. */
function durableRunRequestDigest(req: ChatRequest, backend: string): string {
  const {
    stream: _stream,
    jailSpec: _jailSpec,
    profile_materialization_receipt: _materialization,
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
  })) as Parameters<typeof canonicalCandidateDigest>[0]
  return canonicalCandidateDigest(normalized)
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
