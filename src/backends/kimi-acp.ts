/**
 * Kimi large-prompt transport — carries an arbitrarily long assembled prompt
 * to `kimi acp` (Agent Client Protocol, JSON-RPC over stdin/stdout) when it
 * cannot ride in one argv string.
 *
 * Why this exists: KimiBackend's prompt mode passes the whole flattened
 * conversation as a single `--prompt` argv string. Linux bounds one argv
 * string at MAX_ARG_STRLEN (PAGE_SIZE × 32 = 131,072 bytes including the
 * terminating NUL), so a 131,072-byte prompt fails `spawn E2BIG` even though
 * total ARG_MAX is 2 MiB — measured on the serving controller: 131,071 bytes
 * accepted, 131,072 rejected with errno 7. `kimi acp` is the CLI's documented
 * out-of-argv carrier: `session/prompt` takes the prompt as a text content
 * block over the stdin pipe, where no kernel argv accounting applies.
 *
 * Protocol surface (verified against upstream kimi-code 56145f8, the 2.7.2
 * line — docs/en/reference/kimi-acp.md and packages/acp-server/src):
 *   initialize → session/new | session/resume → session/set_config_option
 *   (model/thinking) → session/set_mode → session/prompt → session/update* →
 *   PromptResponse{stopReason}; session/cancel interrupts the live turn.
 *
 * Behavior parity with the argv print path (`kimi --prompt --output-format
 * stream-json`), grounded in the same upstream source and in zero-spend wire
 * probes against the installed 2.7.2 binary:
 *   - permission/plan: the argv print path forces permission 'auto' around a
 *     turn and never activates a plan; a bridge-created native session rests
 *     at 'auto' (the wire log records exactly one permission.set_mode). Here,
 *     a FRESH session gets set_mode 'auto' — a new session holds no plan, so
 *     the coupled cancelPlan cancels nothing, and the resting posture matches
 *     the argv-created sessions the resume path continues. A RESUMED session
 *     gets no set_mode at all: ACP couples every set_mode with cancelPlan,
 *     and the public surface cannot read the engine's persisted plan or
 *     prior permission (a reopened session's modes.currentModeId is ACP-local
 *     state, measured 'default' after the session was put in Plan). A resumed
 *     turn therefore runs under the session's own at-rest authorization —
 *     bridge sessions rest at 'auto' so ordinary print→large continuation is
 *     unblocked, an active plan continues intact, and a tightened session
 *     fails closed. No claim is made about persisted Plan or original
 *     authorization; no approval is ever fabricated or fed back implicitly.
 *   - thinking: the argv path passes a flag only when the caller asked for an
 *     effort; the model's own default applies otherwise (observed
 *     `thinkingEffort high`). Same here: set_config_option 'thinking' only
 *     when the argv builder produced a flag.
 *   - model: `--model <id>` becomes set_config_option configId 'model' with
 *     the same CLI model string.
 *   - session params: the 2.7.2 server validates the request schema
 *     strictly — session/new without mcpServers, and session/resume without
 *     cwd and mcpServers, answer -32602. Both always carry the
 *     execution-origin cwd and the mcpServers list, including the empty one.
 *   - resume: `--session <id>` becomes session/resume, the load sibling that
 *     restores the same on-disk native session WITHOUT replaying history
 *     (session/load would push every past turn as session/update before the
 *     response settles — the caller must never receive replayed history
 *     twice). The resumed native session id is emitted once.
 *   - slash neutrality: the argv print path submits the prompt as a plain
 *     user turn (run-v2-print runNativeTurn → loop.submit). ACP's
 *     session/prompt INTERPRETS a leading "/token" text block as a slash
 *     command and can end the turn without any model call
 *     (session.ts prompt() → detectSlashIntent). parseSlashInput returns null
 *     for a leading "/" that is not followed by a token (and for tokens
 *     containing "/"), so a prompt whose first character would parse as a
 *     command name is delivered as two text blocks, "/" + rest: same text,
 *     no command interpretation.
 *   - single dispatch: session/prompt is sent exactly once. The server's
 *     busy/occupied/stale rejections (turn.agent_busy, session.occupied,
 *     session.stale) surface as errors — a request is never retried after the
 *     agent already began executing.
 *   - usage: kimi's stream-json emits no per-turn usage and neither does this
 *     path; ACP usage_update is a whole-context token gauge, not a provider
 *     per-call receipt, so it is deliberately not mapped onto ChatDelta.usage.
 *     A request's public `max_tokens` stays what it always was on this
 *     backend: an unenforced hint, separate from any measured native bound.
 *   - reasoning chunks (agent_thought_chunk) stay off the wire, like the
 *     argv path's 'think' blocks.
 *   - terminal truth: a turn with no substantive assistant text or tool call
 *     is never published as an empty success — the same contract the argv
 *     path enforces — and this matters double here because kimi's
 *     turnEndReasonToStopReason maps a FAILED engine turn to end_turn.
 *     Native cancelled and refusal outcomes are surfaced as errors even when
 *     some text already streamed, while max_tokens keeps legitimate partial
 *     output and a tool-only turn completes with finish_reason tool_calls.
 *
 * Old-native compatibility: this transport requires a kimi build whose `acp`
 * subcommand implements the surface above (verified on 2.7.2; the subcommand
 * is present at least back to 2.3.2). A build without it fails the handshake
 * with an explicit capability error naming the requirement — never a silent
 * truncation, and never a return to the argv E2BIG.
 */

import type { ChatDelta, ChatRequest } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import type { Spawner } from '../executors/types.js'
import { terminateSpawned } from '../executors/process-tree.js'
import { buildAcpMcpServers, resolveMcpServers } from './profile-mcp.js'
import { admitNativeSubscription } from './profile-support.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'
import { attachNdjsonRpc, type JsonRpcMessage, type NdjsonRpc, RpcCallError } from './ndjson-rpc.js'

/**
 * Largest prompt payload the argv path may carry: Linux MAX_ARG_STRLEN
 * (131,072) minus the terminating NUL. A prompt at or below this fits in one
 * argument; anything larger switches to the ACP stdin transport. Verified
 * from the controller: 131,071 accepted, 131,072 E2BIG.
 */
export const KIMI_ARGV_PROMPT_MAX_BYTES = 131_071

/** True when the assembled prompt cannot ride a single argv string on Linux. */
export function needsAcpPromptTransport(prompt: string): boolean {
  return Buffer.byteLength(prompt, 'utf8') > KIMI_ARGV_PROMPT_MAX_BYTES
}

/** Mirror of kimi-code's parseSlashInput (packages/acp-server/src/slash.ts at 56145f8). */
export function parsesAsKimiSlashCommand(text: string): boolean {
  if (!text.startsWith('/')) return false
  const trimmed = text.slice(1).trim()
  if (trimmed.length === 0) return false
  const spaceIdx = trimmed.indexOf(' ')
  const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
  return !name.includes('/')
}

/** The prompt as ACP text blocks, split when the first byte would parse as a slash command. */
export function kimiAcpPromptBlocks(prompt: string): Array<{ type: 'text'; text: string }> {
  if (parsesAsKimiSlashCommand(prompt)) {
    return [{ type: 'text', text: '/' }, { type: 'text', text: prompt.slice(1) }]
  }
  return [{ type: 'text', text: prompt }]
}

/**
 * ACP stopReason → OpenAI finish_reason. 'cancelled' and 'refusal' are
 * handled before this mapping and reported as failures; a mapped length only
 * publishes with legitimate partial output (the substantive-output guard).
 */
function baseStopReason(reason: unknown): ChatDelta['finish_reason'] {
  if (reason === 'max_tokens') return 'length'
  return 'stop' // end_turn, max_turn_requests, unknown
}

/** Map one failed JSON-RPC call onto the backend's typed error taxonomy. */
function mapRpcError(method: string, error: RpcCallError): BackendError {
  if (error.code === -32000) {
    // ACP authRequired — kimi's managed subscription token is missing/invalid.
    return new BackendError(
      `kimi acp ${method}: ${error.message}`,
      'subscription_required',
      error,
      {
        subscription: {
          cause: 'not_authenticated',
          fix: 'kimi login (the managed kimi-code subscription must be signed in for ACP sessions)',
          harness: 'kimi-code',
          provider: null,
        },
      },
    )
  }
  if (error.code === -32601) {
    return new BackendError(
      `kimi acp does not implement ${method}; this kimi build lacks the ACP surface the large-prompt transport requires (2.7.2 verified, upstream 56145f8)`,
      'capability_denied',
      error,
    )
  }
  const data = error.data as { code?: string } | undefined
  const detail = data?.code ? ` (${data.code})` : ''
  return new BackendError(`kimi acp ${method}${detail}: ${error.message}`, 'upstream', error)
}

export interface KimiAcpTurnOptions {
  backend: string
  bin: string
  spawner: Spawner
  req: ChatRequest
  session: SessionRecord | null
  signal: AbortSignal
  cwd: string | undefined
  /** The exact assembled prompt the argv path would have passed. */
  prompt: string
  /** CLI model string from resolveCliModel, or null for the configured default. */
  model: string | null
  /** Flag from nativeReasoningControl: '--thinking' | '--no-thinking' | null. */
  thinkingFlag: string | null
  provisioned: {
    env: Record<string, string>
    flags: string[]
    cleanup?: () => void
  }
}

/**
 * One Kimi turn over the ACP stdin transport. Spawns `kimi acp`, drives the
 * session protocol, yields ChatDeltas, and always tears the process group
 * down before releasing the executor slot.
 */
export async function* runKimiAcpTurn(opts: KimiAcpTurnOptions): AsyncIterable<ChatDelta> {
  const { req, session, signal, prompt, model, thinkingFlag, provisioned } = opts

  if (provisioned.flags.length > 0) {
    throw new BackendError(
      `backend kimi-code cannot apply AgentProfile launch flags (${provisioned.flags.join(' ')}) on the ACP transport; kimi acp has no per-invocation argv flags`,
      'capability_denied',
    )
  }

  // MCP rides session/new|resume's native mcpServers mount (kimi converts
  // stdio/http/sse entries itself) instead of the argv path's project-local
  // .kimi-code/mcp.json, which the ACP server does not read.
  const mcpServers = buildAcpMcpServers(
    resolveMcpServers(req, session, { backend: opts.backend, privateMcpConfig: false }),
  )

  const childEnv = { ...process.env, ...provisioned.env }
  const args = ['acp']
  await admitNativeSubscription(req, {
    env: childEnv,
    args,
    flags: provisioned.flags,
    cwd: opts.cwd ?? process.cwd(),
    model: req.model,
    executor: opts.spawner.executionEnvironment,
  })

  const spawned = await opts.spawner(opts.bin, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: opts.cwd,
    env: childEnv,
    ...(req.session_id ? { sessionId: req.session_id } : {}),
    ...(req.jailSpec ? { jail: req.jailSpec } : {}),
    ...(req.childLineage ? { lineageEnv: req.childLineage } : {}),
    ...(req.acquireDeadlineMs !== undefined ? { acquireDeadlineMs: req.acquireDeadlineMs } : {}),
    ...(req.admissionClass ? { admissionClass: req.admissionClass } : {}),
  })
  const child = spawned.child
  const releaseSpawner = spawned.release

  let spawnErrorMessage = spawned.spawnError?.()?.message ?? ''
  child.on('error', (err) => { spawnErrorMessage = err.message })

  const stderr = new BoundedDiagnosticBuffer()
  child.stderr?.on('data', (b: Buffer) => { stderr.append(b.toString()) })

  // Cancellation mirrors the argv path: interrupt the live turn through the
  // protocol, then take down the whole process group.
  let cancelled = false
  let rpcRef: NdjsonRpc | null = null
  let liveSessionId: string | undefined
  const onAbort = (): void => {
    cancelled = true
    try { rpcRef?.notify('session/cancel', { sessionId: liveSessionId }) } catch { /* teardown follows */ }
    void terminateSpawned(spawned)
  }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    if (spawnErrorMessage) throw new BackendError(`kimi acp spawn failed: ${spawnErrorMessage}`, 'upstream')
    if (!child.stdin || !child.stdout) throw new BackendError('kimi acp subprocess has no stdio pipes', 'upstream')

    const queue: ChatDelta[] = []
    let wake: (() => void) | null = null
    let streamEnded = false
    let driverError: Error | null = null
    const push = (d: ChatDelta): void => { queue.push(d); wake?.() }

    const emittedTools = new Set<string>()
    let emittedToolCall = false
    let emittedContent = false

    const rpc = attachNdjsonRpc({
      child,
      label: 'kimi acp',
      stdin: child.stdin,
      stdout: child.stdout,
      onMessage: (m: JsonRpcMessage) => {
        if (m.method === 'session/update') {
          const update = (m.params as {
            update?: {
              sessionUpdate?: string
              content?: { type?: string; text?: string }
              toolCallId?: string
              title?: string
              rawInput?: unknown
              status?: string
            }
          })?.update
          if (!update) return
          switch (update.sessionUpdate) {
            case 'agent_message_chunk': {
              const text = update.content?.text
              if (typeof text === 'string' && text) {
                emittedContent = true
                push({ content: text })
              }
              return
            }
            case 'tool_call':
            case 'tool_call_update': {
              // Announce each tool call once, when its rawInput is first
              // available — kimi emits tool_call (lazy, streaming args) or a
              // tool_call_update carrying rawInput when the started event
              // upgraded it. title is the native name for builtin tools
              // (description when the engine supplied one).
              const id = update.toolCallId
              if (!id || emittedTools.has(id) || update.rawInput === undefined) return
              emittedTools.add(id)
              emittedToolCall = true
              const raw = update.rawInput
              push({
                tool_calls: [{
                  id,
                  name: update.title ?? 'tool',
                  arguments: typeof raw === 'string' ? raw : JSON.stringify(raw),
                }],
              })
              return
            }
            default:
              // agent_thought_chunk (reasoning stays off the wire, argv
              // parity), plan/usage/config/commands/session_info updates are
              // not part of this backend's public stream.
              return
          }
        } else if (m.method === 'session/request_permission' && m.id !== undefined) {
          // Never answer for the user: no approval is fabricated here and no
          // permission posture is fed back implicitly. Refuse the request and
          // fail the turn closed, exactly like the generic ACP backend.
          const message = 'kimi acp permission requests require a retained native session; cli-bridge cannot answer this request safely'
          if (!driverError) {
            driverError = new BackendError(message, 'capability_denied')
            rpcRef?.respondError(m.id, -32001, message)
            void terminateSpawned(spawned)
          }
        } else if (m.method && m.id !== undefined) {
          // fs/terminal/elicitation reverse-RPCs we did not advertise: decline.
          rpcRef?.respondError(m.id, -32601, 'method not supported by cli-bridge kimi transport')
        }
      },
      onEnd: () => { streamEnded = true; wake?.() },
    })
    rpcRef = rpc

    const request = (method: string, params: unknown): Promise<unknown> =>
      rpc.request(method, params).catch((error: unknown) => {
        if (error instanceof RpcCallError) throw mapRpcError(method, error)
        throw error
      })

    const driver = (async () => {
      await request('initialize', {
        protocolVersion: 1,
        // No fs, terminal or elicitation: the engine executes its own tools
        // in-process, the same execution surface the argv print path uses.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })

      // The installed 2.7.2 server validates the ACP request schema strictly:
      // session/new without mcpServers and session/resume without cwd and
      // mcpServers both answer -32602 Invalid params (measured, zero model
      // calls). Always pass the execution-origin cwd and the mcpServers list,
      // including the empty one.
      const sessionCwd = opts.cwd ?? process.cwd()
      if (session?.internalId) {
        // resume, not load: restores the same on-disk native session and
        // skips the history replay session/load would push first. The cwd is
        // the same execution-origin cwd the argv path's --session turn used.
        await request('session/resume', { sessionId: session.internalId, cwd: sessionCwd, mcpServers })
        liveSessionId = session.internalId
      } else {
        const created = (await request('session/new', { cwd: sessionCwd, mcpServers })) as { sessionId?: string }
        if (!created?.sessionId) throw new BackendError('kimi acp session/new returned no sessionId', 'upstream')
        liveSessionId = created.sessionId
      }
      push({ internal_session_id: liveSessionId })

      if (model !== null) {
        await request('session/set_config_option', { sessionId: liveSessionId, configId: 'model', value: model })
      }
      if (thinkingFlag === '--no-thinking') {
        await request('session/set_config_option', { sessionId: liveSessionId, configId: 'thinking', value: 'off' })
      } else if (thinkingFlag === '--thinking') {
        await request('session/set_config_option', { sessionId: liveSessionId, configId: 'thinking', value: 'on' })
      }
      if (!session?.internalId) {
        // Authorization posture, owner-preserving by construction:
        //
        // A brand-new native session cannot hold an active plan (nothing has
        // run), so set_mode 'auto' — the same mode the argv print path forces
        // and leaves behind on bridge-created sessions — cancels nothing and
        // matches the print-mode resting state the resume path relies on.
        //
        // A RESUMED session gets NO set_mode at all. ACP's set_mode always
        // couples permission with cancelPlan, and the public surface cannot
        // read the engine's persisted plan or prior permission mode: a
        // reopened session's modes.currentModeId is the ACP layer's own
        // memory, not engine state (measured: 'default' after the session was
        // put in Plan). So a resumed turn runs under the session's own
        // at-rest authorization: a bridge-created session rests at 'auto'
        // (ordinary print→large continuation needs nothing raised), an active
        // plan simply continues intact, and a session whose owner tightened
        // authorization fails closed through session/request_permission
        // below. This code makes no claim about a persisted Plan or original
        // authorization, erases no plan, and persists no relaxed permission.
        await request('session/set_mode', { sessionId: liveSessionId, modeId: 'auto' })
      }

      // Exactly one dispatch; no retry after execution begins.
      const result = (await request('session/prompt', {
        sessionId: liveSessionId,
        prompt: kimiAcpPromptBlocks(prompt),
      })) as { stopReason?: unknown }

      // Terminal truth. kimi's turnEndReasonToStopReason maps a FAILED engine
      // turn to end_turn (only provider.filtered becomes refusal), so an
      // engine error is indistinguishable from success at the stopReason
      // level — the substantive-output guard below is what exposes it. A
      // native cancelled or refusal outcome is reported as the failure it is,
      // never as a silent zero-byte success, including when some text already
      // streamed.
      if (result?.stopReason === 'cancelled') {
        throw new BackendError('kimi acp turn was cancelled by the agent before completing', 'upstream')
      }
      if (result?.stopReason === 'refusal') {
        throw new BackendError('kimi acp refused the turn', 'upstream')
      }
      if (!emittedContent && !emittedToolCall) {
        const detail = stderr.render(300)
        throw new BackendError(
          `kimi acp produced no stream output${detail ? `: ${detail}` : ''}`,
          'upstream',
        )
      }
      const finish = baseStopReason(result?.stopReason)
      if (finish !== 'length' && emittedToolCall) {
        push({ finish_reason: 'tool_calls' })
      } else {
        push({ finish_reason: finish })
      }
    })()
    driver.catch((error: Error) => {
      if (!driverError) {
        driverError = error instanceof BackendError
          ? error
          : new BackendError(`kimi acp: ${error.message}${stderr.render(300) ? `: ${stderr.render(300)}` : ''}`, 'upstream')
      }
      wake?.()
    })

    const keepaliveMs = Math.max(10, Number(process.env.KIMI_PROGRESS_MS ?? 30_000))
    let elapsedMs = 0
    while (true) {
      // An aborted turn reports the argv path's abort terminal, whatever the
      // transport observed while being torn down.
      if (cancelled || signal.aborted) {
        yield { finish_reason: 'error', internal_session_id: liveSessionId }
        return
      }
      // driverError is re-checked before EVERY yield: a permission refusal
      // can land while the pump sits suspended at a yield with the finish
      // frame already queued behind it, and the turn must still fail closed
      // rather than stream the refused turn's tail as a success.
      if (driverError) throw driverError
      const d = queue.shift()
      if (d) {
        yield d
        if (d.finish_reason) return
        continue
      }
      if (driverError) throw driverError
      if (streamEnded || rpc.writeFailure()) {
        const detail = stderr.render(300)
        throw new BackendError(
          `kimi acp stream ended before session/prompt completed${detail ? `: ${detail}` : ''}`,
          'upstream',
        )
      }
      // Idle wait with a liveness heartbeat, mirroring the argv path's
      // progress signal for silently-buffering turns.
      const timedOut = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), keepaliveMs)
        timer.unref?.()
        wake = () => { wake = null; clearTimeout(timer); resolve(false) }
      })
      if (timedOut) {
        elapsedMs += keepaliveMs
        yield { keepalive: { source: 'kimi', elapsedMs } }
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    // The ACP server never exits on its own; always tear down the whole
    // subtree (kimi + any tool/MCP forks) before releasing the slot.
    await terminateSpawned(spawned)
    provisioned.cleanup?.()
    releaseSpawner()
  }
}
