/**
 * opencode backend — spawns `opencode run --format json` and translates
 * its JSON event stream to OpenAI chat deltas.
 *
 * Model id scheme: `opencode/<rest>` where `<rest>` is opencode's own
 * `provider/model` spec (`anthropic/claude-sonnet-4-5`, `kimi-for-coding`,
 * etc). opencode resolves it via its configured auth.
 *
 * Session resume: external session id maps (via SessionStore) to an
 * opencode session id that opencode prints on startup. We capture it
 * from the event stream and pass `-s <id>` on the next call.
 *
 * Kimi Code: after `opencode auth login kimi` (one-time on the host)
 * and an `opencode-kimi-full` plugin install, the model id
 * `opencode/kimi-for-coding` routes through the Kimi For Coding
 * subscription. No static key needed — opencode handles OAuth + the
 * right headers so Moonshot's backend accepts the call.
 */

import type { Backend, BackendFailureReason, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { versionHealth } from './health.js'
import { BackendError, terminalOutcome } from './types.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import {
  materializeMcpServersForOpencode,
  profileExecutionIdentity,
  provisionProfileWorkspace,
  resolveAgentProfile,
  resolveMcpServers,
  resolvePromptMessages,
  resolveRequestedReasoningEffort,
} from './profile-support.js'
import { registerJailReadable } from '../jail/index.js'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { contentToText } from './content.js'
import { scopedHostSpawner } from '../executors/scoped-host.js'
import { describeCliExit, resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import { readProcessLines, waitForProcessClose } from './process-lines.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'
import { writeStdinPayload } from './stdin-payload.js'
import { terminateSpawned } from '../executors/process-tree.js'
import { nativeReasoningControl } from '@tangle-network/agent-interface'

type UsageReceipt = NonNullable<ChatDelta['usage']>

export interface OpencodeBackendOptions {
  bin: string
  timeoutMs: number
  /** Subprocess spawner. Defaults to host spawn; pass a docker-pooled spawner for parallel-safe execution. */
  spawner?: Spawner
}

export class OpencodeBackend implements Backend {
  readonly name = 'opencode'
  readonly defaultExecutionTimeoutMs: number
  // The signal plugin reports a call at its start; it is installed in the turn's private config
  // directory, which every turn with an AgentProfile has (agent-runtime always sends one).
  readonly toolCallSpans = true
  private readonly spawner: Spawner
  constructor(private readonly opts: OpencodeBackendOptions) {
    this.defaultExecutionTimeoutMs = opts.timeoutMs
    this.spawner = opts.spawner ?? scopedHostSpawner
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'opencode' || m.startsWith('opencode/')
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    return versionHealth(this.name, this.opts.bin, this.spawner, undefined, signal)
  }

  async *chat(
    req: ChatRequest,
    session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    const cwd = resolveSpawnerCwd(this.spawner, req.cwd ?? session?.cwd ?? undefined)
    assertModeSupported(this.name, req.mode ?? 'byob', ['byob'],
      'opencode hosted-safe requires a verified per-provider tool-disable flag path')

    const prompt = this.flattenPrompt(resolvePromptMessages(req, session, 'opencode'))
    const model = this.extractModel(req.model)

    // Reject unsupported profile plans before writing a request-scoped
    // opencode.json that may contain MCP credentials.
    const variant = nativeReasoningControl(
      'opencode',
      resolveRequestedReasoningEffort(req, session),
    )
    const provisioned = provisionProfileWorkspace(
      req,
      session,
      'opencode',
      cwd,
      profileExecutionIdentity(req, session, 'opencode', variant),
    )
    try {
      installSignals(provisioned.env.OPENCODE_CONFIG_DIR)
    } catch (error) {
      provisioned.cleanup?.()
      throw error
    }

    // Materialize the one selected MCP source into a temporary OpenCode config.
    // opencode-cli has no per-invocation `--mcp-config-file` flag —
    // config layering is the only inline injection point. We set
    // OPENCODE_CONFIG to the temp file path; opencode loads it on top
    // of the user's global config (verified: a non-existent
    // OPENCODE_CONFIG path is logged + skipped, and a valid one
    // contributes mcp servers to the tool registry).
    //
    // Cleanup runs in the outer finally so the temp dir doesn't leak
    // when the subprocess crashes.
    //
    // The provisioning above owns a second request-scoped directory — the
    // private opencode config directory this profile runs from — and it leaks
    // into the shared task workspace if anything between here and the spawn
    // throws, so both releases are paired at every exit.
    let mcpMaterialized: ReturnType<typeof materializeMcpServersForOpencode>
    try {
      mcpMaterialized = materializeMcpServersForOpencode(
        resolveMcpServers(req, session),
        (resolveAgentProfile(req, session) as { permissions?: Record<string, unknown> } | null)?.permissions,
      )
    } catch (error) {
      provisioned.cleanup?.()
      throw error
    }
    // Under an fs-jail the fresh tmpfs over /tmp hides this host-/tmp config;
    // expose its dir read-only so the confined opencode can still read it.
    if (mcpMaterialized) registerJailReadable(req.jailSpec, dirname(mcpMaterialized.configPath))

    // opencode installs itself under $HOME, and an fs-jail deliberately hides /home. The generic
    // derivation in `toolchainReadPaths` reaches the install root only when the on-PATH entry
    // realpaths INTO it; an operator whose `opencode` is a wrapper script elsewhere realpaths to
    // the wrapper's own directory, and the jailed run then exits 127 on a binary that exists:
    //   timeout: failed to run command '/home/<user>/.opencode/bin/opencode': No such file or directory
    // The install root is a fixed property of this harness, so this backend declares it rather
    // than leaving every operator to discover BRIDGE_JAIL_RO_PATHS from a 127.
    registerJailReadable(req.jailSpec, process.env.OPENCODE_INSTALL_DIR || join(homedir(), '.opencode'))

    // Pipe the prompt via stdin instead of stuffing it into argv. Linux
    // enforces MAX_ARG_STRLEN = PAGE_SIZE × 32 = 128 KiB per argv arg
    // on x86_64, so any caller passing a long system prompt or
    // multi-turn history would spawn-fail with E2BIG (errno -7) and
    // surface as an opaque "opencode upstream failure" — the bug is
    // invisible until a >100 KiB prompt arrives. `opencode run` with
    // no positional message reads stdin as the literal message text,
    // which lifts the limit entirely (fd payloads aren't accounted to
    // the argv+envp stack page budget). Mirrors the kimi/claude
    // stream-json stdin path, but opencode's stdin schema is raw bytes,
    // not NDJSON — see writeStdinPayload's 'raw' format.
    // `--thinking` is off by default for a non-interactive `run`, and without it opencode's JSON
    // printer skips every reasoning part (run.ts: `part.type === "reasoning" && ... && thinking`).
    // Measured 2026-09-15: two Runtime roots crossed this wire with 0 reasoning bytes against
    // 33k-41k in opencode's own store (cli-bridge#227).
    const args: string[] = ['run', '--format', 'json', '--thinking']
    if (model) args.push('-m', model)
    if (variant) args.push('--variant', variant)
    if (session?.internalId) args.push('-s', session.internalId)

    args.push(...provisioned.flags)
    let spawned: Awaited<ReturnType<Spawner>>
    try {
      spawned = await this.spawner(this.opts.bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        // Preserve the operator's existing proxy and trust roots. Keep the host
        // sanitizer in force; these names are not request-controlled.
        envPassthroughKeys: ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'],
        cwd,
        env: {
          ...process.env,
          // The PATH wrapper has its own `timeout` invocation. Give it the same
          // effective deadline as the durable run; zero disables that wrapper cap.
          OPENCODE_RUN_TIMEOUT_SECONDS: String(Math.ceil(
            (req.execution?.timeoutMs ?? this.defaultExecutionTimeoutMs) / 1000,
          )),
          // Name the SERIES for the isolating wrapper. It keeps non-interactive runs
          // out of the user's shared opencode store by redirecting XDG_DATA_HOME into a
          // temp dir it deletes on exit — but disposability is a property of the series,
          // not of one call. The first shot of a resumable loop carries no `-s` (the
          // session does not exist yet), so it was isolated and wiped, and the next shot
          // resumed a session that was gone: `opencode exited 1: Session not found`,
          // which ended every multi-round run at round 2. The caller's session id is
          // stable across shots, so it names the series and the store persists for it.
          ...(req.session_id
            ? { OPENCODE_RUNTIME_ID: req.session_id.replace(/[^A-Za-z0-9_.-]/g, '-') }
            : {}),
          ...provisioned.env,
          ...(mcpMaterialized ? { OPENCODE_CONFIG: mcpMaterialized.configPath } : {}),
        },
        ...(req.session_id ? { sessionId: req.session_id } : {}),
        ...(req.jailSpec ? { jail: req.jailSpec } : {}),
        ...(req.childLineage ? { lineageEnv: req.childLineage } : {}),
        ...(req.acquireDeadlineMs !== undefined ? { acquireDeadlineMs: req.acquireDeadlineMs } : {}),
        ...(req.admissionClass ? { admissionClass: req.admissionClass } : {}),
      })
    } catch (error) {
      mcpMaterialized?.cleanup()
      provisioned.cleanup?.()
      throw error
    }
    const child = spawned.child
    const releaseSpawner = spawned.release

    // The spawner registers a synchronous 'error' listener to prevent
    // uncaught exceptions on spawn ENOENT/EACCES; we both attach our
    // own listener (for races where the spawner doesn't expose
    // spawnError) and consult spawned.spawnError() after first I/O for
    // the captured event.
    let spawnErrorMessage = ''
    child.on('error', (err) => { spawnErrorMessage = err.message })
    const earlySpawnError = spawned.spawnError?.()
    if (earlySpawnError) spawnErrorMessage = earlySpawnError.message

    // Ask the executor to stop what it owns. Host execution uses a process
    // group; Docker execution recycles the exclusive container slot because
    // killing the local `docker exec` client does not stop OpenCode inside it.
    const onAbort = (): void => { void terminateSpawned(spawned) }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      let internalSessionId: string | undefined
      const stderr = new BoundedDiagnosticBuffer()
      child.stderr?.on('data', (b) => { stderr.append(b) })
      if (spawnErrorMessage) {
        throw new BackendError(`opencode spawn failed: ${spawnErrorMessage}`, 'upstream')
      }
      if (!child.stdout) {
        throw new BackendError('opencode subprocess has no stdout pipe', 'upstream')
      }
      if (!child.stdin) {
        throw new BackendError('opencode subprocess has no stdin pipe', 'upstream')
      }

      // Pipe the composed prompt as raw stdin bytes. opencode reads
      // stdin to EOF as the literal message when no positional argv
      // is supplied to `run`. See writeStdinPayload comments for the
      // EPIPE / backpressure contract.
      const stdinResult = await writeStdinPayload(
        child.stdin,
        [{ role: 'user', content: prompt }],
        { format: 'raw' },
      )
      if (!stdinResult.ok) {
        throw new BackendError(`opencode stdin write failed: ${stdinResult.error}`, 'upstream')
      }
      let sawError: BackendFailureReason | null = null
      let emittedContent = false
      let emittedToolCall = false
      // Calls already reported at their start, so their finished part carries only the outcome.
      const startedTools = new Set<string>()
      let toolSession: string | null = null
      // Steps yield their own usage as they finish; a non-step usage event is the fallback only for a stream with no step receipt.
      let sawStepUsage = false
      let fallbackUsage: UsageReceipt | undefined
      const progressIntervalMs = Math.max(10, Number(process.env.OPENCODE_PROGRESS_MS ?? 30_000))

      for await (const next of readProcessLines({ child, stdout: child.stdout, progressIntervalMs })) {
        if (next.kind === 'progress') {
          // Subprocess liveness signal — opencode has emitted no stdout
          // for `progressIntervalMs`. Yield as keepalive so the SSE
          // writer renders an SSE comment that keeps the socket alive
          // without injecting a fake OpenAI tool_call into the response.
          // See ChatDelta.keepalive (backends/types.ts) for the contract.
          yield {
            keepalive: { source: 'opencode', elapsedMs: next.elapsedMs },
          }
          continue
        }

        const line = next.line
        if (!line.trim()) continue
        let ev: Record<string, unknown>
        try { ev = JSON.parse(line) as Record<string, unknown> } catch { continue }

        // opencode emits a mix of event types. Session id comes early
        // on a session.created / session.started event, or as a top
        // level session field on many events.
        const sessId = pickSessionId(ev)
        if (sessId && !internalSessionId) {
          internalSessionId = sessId
          yield { internal_session_id: internalSessionId }
        }

        const type = String(ev.type ?? '')
        if (type === RETRY_SIGNAL_TYPE) {
          const refusal = longRetryWait(ev)
          if (refusal === null) continue
          // The process is still asleep in its retry; the `finally` below stops it.
          yield { ...terminalOutcome('opencode', refusal, emittedToolCall), internal_session_id: internalSessionId }
          return
        }
        if (type === TOOL_START_SIGNAL_TYPE) {
          // The plugin sees every session's parts; `run` prints only its own session's, so a
          // subagent's tool would open a call that no finished part ever closes. The first start
          // can precede `run`'s first event, and it is the run's own: a subagent's tool starts
          // only inside a root tool that started before it.
          toolSession ??= internalSessionId ?? (typeof ev.partSession === 'string' ? ev.partSession : null)
          if (ev.partSession !== toolSession) continue
          const started = extractToolUse(ev)
          if (started && !startedTools.has(started.id)) {
            startedTools.add(started.id)
            yield { tool_calls: [started] }
            emittedToolCall = true
          }
          continue
        }
        const eventUsage = extractUsage(ev)
        if (eventUsage && !isStepReceipt(ev)) fallbackUsage = eventUsage
        else if (eventUsage) { sawStepUsage = true; yield { usage: { ...eventUsage, model_call: true } } }
        if (type === 'error' || ev.error) {
          // When the event carries no message field, surface the raw event instead of the
          // constant string 'opencode error'. That constant reached run ledgers verbatim:
          // measured 2026-08-19 in discovery-lab, four director rounds died across two lines
          // with 'bridgeExecutor: bridge stream error: opencode: opencode error' as their
          // ONLY recorded cause, and the retry ladder burned ~48 minutes per round against a
          // failure nobody could read. An error the operator cannot see is one nobody fixes.
          // `data.message` FIRST, because that is where opencode actually puts it. Every error
          // in its SDK is a NamedError, `{ name, data: { message, ... } }`, and there is no
          // top-level `error.message` on any of them. opencode's own reader agrees:
          //   function b(j){ if(j.data?.message) return j.data.message
          //                  if(j.message) return j.message
          //                  if(j.name) return j.name
          //                  return "unknown error" }
          // Reading only `error.message` therefore missed EVERY error, and the raw-event
          // fallback below fired on all of them — 16 of them in this host's bridge logs, each
          // one a readable provider message rendered as an unreadable JSON dump truncated at
          // 400 chars, which is where `data` was being cut off.
          const errorObject = ev.error as { message?: unknown; name?: unknown; data?: { message?: unknown; statusCode?: unknown } } | undefined
          // opencode's APIError states the provider's HTTP status as `data.statusCode`. Without it a
          // provider's 429 ("Rate limit reached for requests", "Usage limit reached") reached
          // agent-runtime as bare prose, was classed a transient fault, and was retried every few
          // seconds instead of paused: magnetar-rust-20261017c ended 636 driver attempts that way.
          const status = providerStatus(errorObject?.data?.statusCode)
          sawError = {
            message: String(
              ev.message ??
                errorObject?.data?.message ??
                errorObject?.message ??
                errorObject?.name ??
                `opencode error event without a message: ${JSON.stringify(ev).slice(0, 400)}`,
            ),
            type: 'upstream',
            ...(status === undefined ? {} : { status }),
          }
          continue
        }

        // Reasoning rides `part.text` too, so it must be claimed before `extractText` would
        // yield it as assistant content.
        if (type === 'reasoning') {
          const reasoning = extractText(ev)
          if (reasoning) yield { reasoning }
          continue
        }
        const text = extractText(ev)
        if (text) {
          yield { content: text }
          emittedContent = true
        }
        const toolCall = extractToolUse(ev)
        // `run` prints a tool part only once it has finished. A call the plugin reported at its
        // start gets only its outcome here; one it missed is reported whole, call and outcome.
        if (toolCall && !startedTools.has(toolCall.id)) { yield { tool_calls: [toolCall] }; emittedToolCall = true }
        const toolResult = extractToolResult(ev)
        if (toolResult) yield { tool_results: [toolResult] }

        if (
          type === 'message.completed'
          || type === 'turn.completed'
          || type === 'session.completed'
          || type === 'run.completed'
        ) {
          yield {
            ...terminalOutcome('opencode', sawError, emittedToolCall),
            ...(!sawStepUsage && fallbackUsage ? { usage: fallbackUsage } : {}),
            internal_session_id: internalSessionId,
          }
          return
        }
      }

      const exit = await waitForProcessClose(child)

      if (signal.aborted) {
        yield { finish_reason: 'error', internal_session_id: internalSessionId }
        return
      }
      // Ended through the delta envelope, not a throw, so the provider's status reaches the caller.
      if (sawError) {
        yield { ...terminalOutcome('opencode', sawError, emittedToolCall), internal_session_id: internalSessionId }
        return
      }
      if (exit.code !== 0) {
        throw new BackendError(await describeCliExit(spawned, 'opencode', exit.code, stderr.render(), exit.signal), 'upstream')
      }
      if (!emittedContent && !emittedToolCall) {
        throw new BackendError(`opencode produced no stream output: ${stderr.render(300)}`, 'upstream')
      }
      yield {
        finish_reason: emittedToolCall ? 'tool_calls' : 'stop',
        ...(!sawStepUsage && fallbackUsage ? { usage: fallbackUsage } : {}),
        internal_session_id: internalSessionId,
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      // A terminal response and slot reuse both wait for executor-owned
      // termination. In Docker mode this includes the in-container process,
      // not merely the local attach client.
      await terminateSpawned(spawned)
      releaseSpawner()
      mcpMaterialized?.cleanup()
      // Only after the process is gone: opencode rereads its config directory
      // on every model request, so removing it earlier would strip a running
      // turn's instructions.
      provisioned.cleanup?.()
    }
  }

  private flattenPrompt(messages: ChatRequest['messages']): string {
    if (messages.length === 1) return contentToText(messages[0]?.content ?? '')
    return messages.map((m) => `[${m.role}] ${contentToText(m.content)}`).join('\n\n')
  }

  private extractModel(fullModel: string): string | null {
    const lower = fullModel.toLowerCase()
    if (lower === 'opencode') return null
    if (lower.startsWith('opencode/')) {
      const rest = fullModel.slice('opencode/'.length)
      return rest.length > 0 ? rest : null
    }
    return null
  }
}


function pickSessionId(ev: Record<string, unknown>): string | null {
  for (const k of ['session_id', 'sessionId', 'sessionID', 'session']) {
    const v = ev[k]
    if (typeof v === 'string' && v.length > 0) return v
    if (typeof v === 'object' && v !== null) {
      const id = (v as Record<string, unknown>).id
      if (typeof id === 'string' && id.length > 0) return id
    }
  }
  return null
}

function extractToolUse(ev: Record<string, unknown>): { id: string; name: string; arguments: string } | null {
  const part = ev.part as Record<string, unknown> | undefined
  const tool =
    (ev.tool_call as Record<string, unknown> | undefined)
    ?? (ev.toolCall as Record<string, unknown> | undefined)
    ?? (part?.type === 'tool' || part?.type === 'tool_call' ? part : undefined)
  if (!tool) return null
  const id = String(tool.id ?? tool.callID ?? tool.toolCallID ?? tool.tool_call_id ?? '')
  const name = String(tool.name ?? tool.tool ?? '')
  if (!id || !name) return null
  const state = tool.state as Record<string, unknown> | undefined
  const input = tool.input ?? state?.input ?? tool.arguments ?? {}
  return {
    id,
    name,
    arguments: typeof input === 'string' ? input : JSON.stringify(input),
  }
}

/** The finished tool part's outcome, keyed by the same id `extractToolUse` reports. */
function extractToolResult(
  ev: Record<string, unknown>,
): { id: string; name: string; status: 'completed' | 'error'; output?: string; error?: string } | null {
  const part = ev.part as Record<string, unknown> | undefined
  if (!part || (part.type !== 'tool' && part.type !== 'tool_call')) return null
  const state = part.state as Record<string, unknown> | undefined
  const status = state?.status
  if (status !== 'completed' && status !== 'error') return null
  const id = String(part.id ?? part.callID ?? part.toolCallID ?? part.tool_call_id ?? '')
  const name = String(part.name ?? part.tool ?? '')
  if (!id || !name) return null
  if (status === 'completed') {
    const output = state?.output
    return { id, name, status, ...(typeof output === 'string' ? { output } : {}) }
  }
  const error = state?.error
  return { id, name, status, ...(typeof error === 'string' ? { error } : {}) }
}

function extractUsage(ev: Record<string, unknown>): UsageReceipt | null {
  const direct = ev.usage as Record<string, unknown> | undefined
  if (direct) {
    return usageFromValues({
      input_tokens: direct.input_tokens ?? direct.prompt_tokens ?? direct.input,
      fresh_input_tokens: direct.fresh_input_tokens ?? direct.input,
      cache_read_input_tokens: direct.cache_read_input_tokens ?? direct.cacheRead,
      cache_write_input_tokens: direct.cache_write_input_tokens ?? direct.cacheWrite,
      output_tokens: direct.output_tokens ?? direct.output,
      reasoning_output_tokens: direct.reasoning_output_tokens ?? direct.reasoning,
      cost: direct.cost ?? ev.cost,
    })
  }

  const part = ev.part as Record<string, unknown> | undefined
  const tokens = part?.tokens as Record<string, unknown> | undefined
  const cache = tokens?.cache as Record<string, unknown> | undefined

  return usageFromValues({
    // OpenCode reports input/output *excluding* cache and reasoning.
    // OpenAI totals include those categories, so reconstruct full compute.
    input_tokens: sumKnown([
      tokens?.input_tokens ?? tokens?.input,
      cache?.read,
      cache?.write,
    ]),
    fresh_input_tokens: tokens?.input_tokens ?? tokens?.input,
    cache_read_input_tokens: cache?.read,
    cache_write_input_tokens: cache?.write,
    output_tokens: sumKnown([
      tokens?.output_tokens ?? tokens?.output,
      tokens?.reasoning,
    ]),
    reasoning_output_tokens: tokens?.reasoning,
    cost: part?.cost ?? ev.cost,
  })
}

function usageFromValues(values: Record<string, unknown>): UsageReceipt | null {
  const inputTokens = nonnegativeFinite(values.input_tokens)
  const freshInputTokens = nonnegativeFinite(values.fresh_input_tokens)
  const cacheReadInputTokens = nonnegativeFinite(values.cache_read_input_tokens)
  const cacheWriteInputTokens = nonnegativeFinite(values.cache_write_input_tokens)
  const outputTokens = nonnegativeFinite(values.output_tokens)
  const reasoningOutputTokens = nonnegativeFinite(values.reasoning_output_tokens)
  const cost = nonnegativeFinite(values.cost)
  if (
    inputTokens === undefined
    && freshInputTokens === undefined
    && cacheReadInputTokens === undefined
    && cacheWriteInputTokens === undefined
    && outputTokens === undefined
    && cost === undefined
  ) return null
  return {
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(freshInputTokens !== undefined ? { fresh_input_tokens: freshInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cache_read_input_tokens: cacheReadInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cache_write_input_tokens: cacheWriteInputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoning_output_tokens: reasoningOutputTokens } : {}),
    cost_known: false,
    ...(cost !== undefined
      ? {
          estimated_cost: cost,
          cost_provenance: 'catalog-estimate' as const,
        }
      : {}),
  }
}

function isStepReceipt(ev: Record<string, unknown>): boolean {
  const type = String(ev.type ?? '')
  const partType = String((ev.part as Record<string, unknown> | undefined)?.type ?? '')
  return type === 'step_finish'
    || type === 'step-finish'
    || partType === 'step_finish'
    || partType === 'step-finish'
}

function nonnegativeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function sumKnown(values: unknown[]): number | undefined {
  let total = 0
  let sawValue = false
  for (const value of values) {
    const numeric = nonnegativeFinite(value)
    if (numeric === undefined) continue
    total += numeric
    sawValue = true
  }
  return sawValue ? total : undefined
}

function extractText(ev: Record<string, unknown>): string | null {
  const candidates: unknown[] = [
    ev.text,
    ev.content,
    (ev.message as Record<string, unknown> | undefined)?.text,
    (ev.message as Record<string, unknown> | undefined)?.content,
    (ev.delta as Record<string, unknown> | undefined)?.text,
    (ev.delta as Record<string, unknown> | undefined)?.content,
    (ev.part as Record<string, unknown> | undefined)?.text,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c
  }
  return null
}

/** A provider status stated as a field; the bridge never infers one from prose. */
function providerStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined
}

/**
 * A provider's retry wait, made visible.
 *
 * opencode retries a refused model call itself (`session/retry.ts`). A response with a
 * `retry-after` header sets the wait, capped only at 2^31 ms, and `run --format json` prints
 * nothing while it waits: it never emits the `session.status` retry event. The free seat answers
 * a spent quota with `429` and `retry-after: 47331` (13.1 h), so magnetar-rust-20261019b's root
 * slept in silence until this bridge's 4 h turn cap aborted it, and agent-runtime ended a 48 h run
 * on that abort. The plugin below prints opencode's own retry status as one stdout line, which
 * the event loop reads with the rest of the stream.
 *
 * It prints each tool call's start the same way. `run` prints a tool part only once it has
 * finished (`part.state.status` completed or error), so a 32-minute test battery read as 32 minutes
 * of model silence (magnetar-rust-20261018b), and agent-runtime could not bound a silent model
 * call on this backend. The part is on opencode's bus as `message.part.updated` with status
 * `running` from the moment the tool starts.
 */
const RETRY_SIGNAL_TYPE = 'cli-bridge.opencode-retry'
const TOOL_START_SIGNAL_TYPE = 'cli-bridge.opencode-tool-start'
const SIGNAL_PLUGIN = `// Written by cli-bridge for this turn. Prints what \`run --format json\` omits: opencode's retry
// status, and each tool call when it starts.
export const CliBridgeSignals = async () => {
  const started = new Set()
  return {
    event: async ({ event }) => {
      const props = event?.properties
      if (event?.type === 'session.status' && props?.status?.type === 'retry') {
        process.stdout.write(JSON.stringify({
          type: ${JSON.stringify(RETRY_SIGNAL_TYPE)},
          sessionID: props.sessionID,
          attempt: props.status.attempt,
          message: props.status.message,
          next: props.status.next,
          timestamp: Date.now(),
        }) + '\\n')
        return
      }
      const part = props?.part
      if (event?.type !== 'message.part.updated' || part?.type !== 'tool') return
      if (part.state?.status !== 'running' || started.has(part.id)) return
      started.add(part.id)
      process.stdout.write(JSON.stringify({
        type: ${JSON.stringify(TOOL_START_SIGNAL_TYPE)},
        partSession: part.sessionID,
        part: { type: 'tool', id: part.id, callID: part.callID, tool: part.tool, state: { status: 'running', input: part.state.input } },
        timestamp: Date.now(),
      }) + '\\n')
    },
  }
}
`

/**
 * The longest retry wait a turn sits through. opencode's own backoff without a `retry-after`
 * stays at or under 32 s; anything longer is the provider naming a reset, which agent-runtime
 * holds for without spending the process or an attempt.
 */
const RETRY_WAIT_LIMIT_MS = Math.max(1_000, Number(process.env.OPENCODE_RETRY_WAIT_MAX_MS ?? 60_000))

/**
 * Put the plugin in the turn's private config directory. A turn without an AgentProfile has
 * none: opencode would read the operator's own config directory, which this bridge never writes.
 */
function installSignals(configDir: string | undefined): void {
  if (configDir === undefined) return
  const pluginDir = join(configDir, 'plugin')
  mkdirSync(pluginDir, { recursive: true, mode: 0o755 })
  writeFileSync(join(pluginDir, 'cli-bridge-signals.js'), SIGNAL_PLUGIN, { mode: 0o644 })
}

/**
 * The refusal a retry wait longer than {@link RETRY_WAIT_LIMIT_MS} stands for, or `null` for a
 * short wait opencode should sit out. It carries `upstream_unavailable` rather than a status:
 * opencode's retry status names no HTTP status, and the bridge never infers one. agent-runtime
 * pauses on that code, and a `reset at` time within its hold window holds the run until then.
 */
function longRetryWait(ev: Record<string, unknown>): BackendFailureReason | null {
  const next = typeof ev.next === 'number' ? ev.next : NaN
  const now = typeof ev.timestamp === 'number' ? ev.timestamp : Date.now()
  if (!Number.isFinite(next) || next - now <= RETRY_WAIT_LIMIT_MS) return null
  const message = typeof ev.message === 'string' && ev.message.length > 0 ? ev.message : 'the provider refused the call'
  return {
    message: `${message}; the provider asked opencode to wait ${Math.round((next - now) / 1000)} s before retrying, reset at ${new Date(next).toISOString()}`,
    type: 'upstream_unavailable',
  }
}
