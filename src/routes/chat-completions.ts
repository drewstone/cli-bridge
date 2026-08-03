import type { Hono } from 'hono'
import { canonicalCandidateDigest } from '@tangle-network/agent-interface'
import type { BackendRegistry } from '../backends/registry.js'
import {
  SessionExecutionAbortedError,
  SessionIdentityConflictError,
  type SessionExecutionLease,
  type SessionStore,
} from '../sessions/store.js'
import type { ChatDelta, ChatRequest } from '../backends/types.js'
import { BackendError } from '../backends/types.js'
import { parseMode } from '../modes.js'
import { estimateMessagesChars, tokensFromChars } from '../backends/content.js'
import { resolveJailSpec } from '../jail/resolve-spec.js'
import { resolveNetJailSpec } from '../jail/resolve-net-spec.js'
import { assertNetJailEnforced, type NetJailRegistry } from '../jail/enforce-net-jail.js'
import { authSourcesFor } from '../jail/auth-preserve.js'
import { writableEnvironmentFor } from '../jail/backend-state.js'
import { type AdmissionGate, type AdmissionLease } from '../admission.js'
import { type Run, RunIdentityConflictError, RunAdmissionClosedError, type RunRegistry } from '../runs/registry.js'
import type { RequestSpanRecorder, TraceEmitter } from '../trace/emitter.js'
import { resolveCallerTrace } from '../trace/ids.js'
import {
  chatRequestSchema,
  durableRunRequestDigest,
  harnessToSandboxBackendType,
  invalidRequest,
  mergeMcpInputs,
  normalizeResponseFormat,
  parseMcpHeader,
  resolveLastEventId,
  resolveRunId,
  resolveSessionId,
  SandboxBackendUnavailableError,
  shouldApplyHostAdmission,
} from './chat-contract.js'
import { errorResponse, respondFromRun, runIdentityConflict } from './chat-response.js'
export function mountChatCompletions(
  app: Hono,
  deps: {
    registry: BackendRegistry
    sessions: SessionStore
    runs: RunRegistry
    admission?: AdmissionGate
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
      return c.json(
        {
          error: {
            message: 'invalid chat request',
            type: 'invalid_request_error',
            details: parsed.error.flatten(),
          },
        },
        400,
      )
    }

    // Session id resolution — accept several aliases so clients with
    // different conventions all work:
    //   body.session_id                (canonical)
    //   body.resume_id                 (alias)
    //   header X-Session-Id            (canonical)
    //   header X-Resume                (alias — ergonomic single-word form)
    //   header X-Conversation-Id       (alias — matches OpenAI Assistants vocab)
    const sessionResult = resolveSessionId([
      ['session_id', parsed.data.session_id],
      ['resume_id', parsed.data.resume_id],
      ['X-Session-Id', c.req.header('x-session-id')],
      ['X-Resume', c.req.header('x-resume')],
      ['X-Conversation-Id', c.req.header('x-conversation-id')],
    ])
    if (!sessionResult.ok) return invalidRequest(c, sessionResult.message)

    let mode
    try {
      mode = parseMode({
        body: parsed.data.mode,
        bridgeModeHeader: c.req.header('x-bridge-mode'),
        sandboxHeader: c.req.header('x-sandbox'),
      })
    } catch (err) {
      return c.json(
        {
          error: {
            message: err instanceof Error ? err.message : String(err),
            type: 'invalid_request_error',
          },
        },
        400,
      )
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
      session_id: sessionResult.value,
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

    if (req.interaction_policy === 'interactive') {
      return c.json(
        {
          error: {
            message:
              'interactive responses require a retained native session; one-shot chat runners advertise interactions=false',
            type: 'capability_denied',
          },
        },
        501,
      )
    }

    if (req.interaction_policy === 'unattended-allow') {
      const profile = req.agent_profile as Record<string, unknown> | undefined
      const profileMetadata = profile?.metadata as Record<string, unknown> | undefined
      const policy = profileMetadata?.cliBridge as Record<string, unknown> | undefined
      if (policy?.interactionPolicy !== 'unattended-allow-v1') {
        return invalidRequest(
          c,
          'interaction_policy=unattended-allow requires agent_profile.metadata.cliBridge.interactionPolicy="unattended-allow-v1"',
        )
      }
      req.interaction_policy_receipt = {
        schema: 'cli-bridge.interaction-policy.v1',
        name: 'unattended-allow',
        profileDigest: canonicalCandidateDigest(req.agent_profile),
      }
    }

    const backend = deps.registry.resolve(req.model)
    if (!backend) {
      return c.json(
        {
          error: {
            message: `no backend matches model "${req.model}". Check /health for registered backends.`,
            type: 'not_found_error',
          },
        },
        404,
      )
    }

    if (req.session_id) {
      try {
        deps.sessions.claimSessionIdentity(req.session_id, 'legacy')
      } catch (error) {
        if (error instanceof SessionIdentityConflictError) {
          return c.json({ error: { message: error.message, type: error.code } }, 409)
        }
        throw error
      }
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
      if (error instanceof RunAdmissionClosedError) {
        return c.json({ error: { message: error.message, type: error.code } }, 503)
      }
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
    const recorder: RequestSpanRecorder | null =
      deps.trace?.beginRequest({
        runId,
        model: req.model,
        backend: backend.name,
        sessionId: req.session_id ?? null,
        mode: req.mode ?? 'byob',
        execution: req.execution?.kind ?? 'host',
        caller: resolveCallerTrace({
          traceparent: c.req.header('traceparent'),
          traceId: c.req.header('x-trace-id'),
          parentSpanId: c.req.header('x-parent-span-id'),
        }),
      }) ?? null

    let admissionLease: AdmissionLease | null = null
    let sessionLease: SessionExecutionLease | null = null
    try {
      // Distinct runs that continue one backend session must own its full
      // read → execute → update interval. The duplicate-run attachment path
      // above intentionally happens first and never enters this queue.
      if (req.session_id) {
        try {
          sessionLease = await deps.sessions.acquireExecution(req.session_id, backend.name, run.signal)
        } catch (error) {
          if (error instanceof SessionExecutionAbortedError) {
            throw new BackendError(error.message, 'aborted', error)
          }
          throw error
        }
      }

      const session = req.session_id ? deps.sessions.get(req.session_id, backend.name) : null
      if (!req.cwd && session?.cwd) {
        req.cwd = session.cwd
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
        if (req.jailSpec) {
          req.jailSpec.authSources = authSourcesFor(backend.name)
          req.jailSpec.writableEnvironment = writableEnvironmentFor(backend.name)
        }
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
              recorder?.observe(delta)
              if (delta.usage) sawUsage = true
              if (delta.finish_reason === 'error' || delta.finish_reason === 'timeout') failed = true
              completionChars +=
                (delta.content?.length ?? 0) +
                (delta.tool_calls?.reduce(
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
                    ...(req.agent_profile ? { profile_digest: canonicalCandidateDigest(req.agent_profile) } : {}),
                  },
                })
              }
              yield delta.finish_reason && (req.profile_materialization_receipt || req.interaction_policy_receipt)
                ? {
                    ...delta,
                    ...(req.profile_materialization_receipt
                      ? { profile_materialization: req.profile_materialization_receipt }
                      : {}),
                    ...(req.interaction_policy_receipt
                      ? { interaction_policy_receipt: req.interaction_policy_receipt }
                      : {}),
                  }
                : delta
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
          } finally {
            // Admission is released when the job ends. Reader disconnects
            // cannot release a slot that still owns a subprocess.
            admissionLease?.release()
            sessionLease?.release()
            // No-op when the catch above already closed the span.
            recorder?.end()
          }
        },
      })

      // The run pumps the source to completion on its own. This connection is only one reader;
      // dropping it never touches `run.signal` or releases job-owned admission.
      void run.pump(wrap(makeSource(run)))
    } catch (error) {
      admissionLease?.release()
      admissionLease = null
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
