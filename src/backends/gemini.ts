/**
 * Gemini CLI backend — spawns Google's official `gemini` CLI.
 *
 * Model id scheme: `gemini/<model>` where `<model>` is passed to
 * `gemini --model <model>`. Bare `gemini` uses the CLI's configured
 * default. The backend is intentionally conservative: it supports BYOB
 * coding-agent execution and rejects hosted-safe/hosted-sandboxed until
 * we verify Gemini's tool-disable and sandbox semantics end-to-end.
 *
 * Gemini's stream-json protocol carries native session, assistant, tool, and
 * terminal usage events. Model labels in init/stats can fall back to the
 * request and therefore do not establish provider response identity.
 *
 * A retained session is one `gemini --acp` process (acp-native-session.ts).
 *
 * The CLI reads a Gemini API route from `GEMINI_API_KEY` and
 * `GOOGLE_GEMINI_BASE_URL`: Google's own endpoint, or a Router that serves the
 * Gemini wire. With a key it also needs `security.auth.selectedType` set to
 * `gemini-api-key` in the user's `~/.gemini/settings.json`; 0.68 refuses to
 * start on the key alone ("Invalid auth method selected.").
 */

import type { AgentEnvironmentCapabilities } from '@tangle-network/agent-interface'
import type { Backend, ChatDelta, ChatRequest, BackendHealth, NativeSession, NativeSessionBackend } from './types.js'
import { BackendError, JSON_MODE_DIRECTIVE, wantsJsonObject } from './types.js'
import { AcpNativeSession } from './acp-native-session.js'
import { acpNativeCapabilities } from './acp.js'
import { hostRequestJail } from '../jail/host-request.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import {
  admitNativeSubscription,
  profileExecutionIdentity,
  provisionProfileWorkspace,
} from './profile-support.js'
import {
  buildAcpMcpServers,
  materializeMcpServersForGemini,
  resolveMcpServers,
} from './profile-mcp.js'
import { contentToText } from './content.js'
import { hostSpawner } from '../executors/host.js'
import { resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import { versionHealth } from './health.js'
import { assertSuccessfulHarnessExit, readProcessLines, waitForProcessClose } from './process-lines.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'
import { writeStdinPayload } from './stdin-payload.js'
import { terminateSpawned } from '../executors/process-tree.js'

export interface GeminiBackendOptions {
  bin: string
  timeoutMs: number
  /** Subprocess spawner. Defaults to host spawn; pass a docker-pooled spawner for parallel-safe execution. */
  spawner?: Spawner
  /** The operator's jail settings, which a retained session resolves its jail from. */
  jailEnv?: NodeJS.ProcessEnv
}

/**
 * What the CLI reads its API route from, kept through the host sanitizer, with the Bridge's statement
 * of workspace trust. These names are not request-controlled.
 */
export const GEMINI_ENV_PASSTHROUGH_KEYS: readonly string[] = ['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GEMINI_CLI_TRUST_WORKSPACE']

/** Bound on every retained-session request except a prompt. */
const NATIVE_REQUEST_TIMEOUT_CAP_MS = 60_000

/**
 * The CLI's folder trust, which the Bridge states unless the operator set it. In a folder it does not
 * trust, Gemini CLI 0.68 ignores the project settings, so the MCP servers the Bridge writes there never
 * load, and it lowers the requested approval mode to `default`. `--skip-trust` keeps the approval mode
 * and still ignores the project settings; this variable restores both. The caller named the workspace
 * for the agent to work in, which is the trust the CLI asks about.
 */
function workspaceTrustEnv(): Record<string, string> {
  return process.env.GEMINI_CLI_TRUST_WORKSPACE === undefined ? { GEMINI_CLI_TRUST_WORKSPACE: 'true' } : {}
}

export class GeminiBackend implements NativeSessionBackend {
  readonly name = 'gemini'
  readonly defaultExecutionTimeoutMs: number
  readonly nativeModes = ['byob'] as const
  private readonly spawner: Spawner

  constructor(private readonly opts: GeminiBackendOptions) {
    this.defaultExecutionTimeoutMs = opts.timeoutMs
    this.spawner = opts.spawner ?? hostSpawner
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'gemini' || m.startsWith('gemini/')
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    return versionHealth(this.name, this.opts.bin, this.spawner, undefined, signal)
  }

  nativeCapabilities(): AgentEnvironmentCapabilities {
    return geminiNativeCapabilities()
  }

  /**
   * One retained `gemini --acp` per Bridge session, started as a one-shot turn is: the same model,
   * profile workspace, environment and subscription admission. The profile's MCP servers go inline in
   * `session/new`, so none is written to the workspace. No approval mode is passed: the CLI asks
   * permission for each tool call and the turn's interaction policy answers it. A steer is a second
   * prompt, which ends the running one and aborts its tool call.
   */
  async startNativeSession(req: ChatRequest, session: SessionRecord | null, signal?: AbortSignal): Promise<NativeSession> {
    assertModeSupported(this.name, req.mode ?? 'byob', ['byob'],
      'gemini hosted modes require a verified tool-disable and sandbox contract')
    // The chat route resolves a one-shot's jail; a retained session starts here, so it resolves its own.
    req.jailSpec ??= hostRequestJail(req, this.name, this.opts.jailEnv ?? process.env)
    const { cwd, model, provisioned, env } = this.prepare(req, session)
    const sandbox = geminiSandboxFlag()
    const args = ['--acp', ...(sandbox ? [sandbox] : []), ...(model ? ['--model', model] : []), ...provisioned.flags]
    const mcpServers = buildAcpMcpServers(resolveMcpServers(req, session, { backend: this.name, privateMcpConfig: true }))
    const { spawned, invocation } = await this.spawn(req, args, cwd, env, provisioned.flags, signal)
    const spawnError = spawned.spawnError?.()
    if (spawnError || !spawned.child.stdin || !spawned.child.stdout) {
      await terminateSpawned(spawned).finally(() => spawned.release())
      throw new BackendError('gemini --acp failed to start with stdin and stdout pipes', 'upstream', spawnError)
    }
    const native = new AcpNativeSession(spawned, {
      name: this.name,
      capabilities: geminiNativeCapabilities(),
      cwd: cwd ?? process.cwd(),
      mcpServers,
      resumeSessionId: session?.internalId || null,
      steer: 'prompt',
      requestTimeoutMs: this.opts.timeoutMs > 0 ? Math.min(this.opts.timeoutMs, NATIVE_REQUEST_TIMEOUT_CAP_MS) : NATIVE_REQUEST_TIMEOUT_CAP_MS,
      cleanup: () => provisioned.cleanup?.(),
    })
    try {
      req.subscriptionAdmission?.require()
      await native.start(signal)
    } catch (error) {
      await native.close().catch(() => {})
      throw error
    }
    return Object.assign(native, {
      // A later turn reuses this process, so it re-presents the launch that was admitted.
      async admitSubscription(admission: NonNullable<ChatRequest['subscriptionAdmission']>): Promise<void> {
        await admitNativeSubscription({ ...req, subscriptionAdmission: admission }, invocation)
        admission.require()
      },
    })
  }

  /** What a one-shot turn and a retained session start from: the model, the workspace with the profile applied, and the child's environment. */
  private prepare(req: ChatRequest, session: SessionRecord | null) {
    const model = this.extractModel(req.model)
    const cwd = resolveSpawnerCwd(this.spawner, req.cwd ?? session?.cwd ?? undefined)
    // Validate the profile before touching project-scoped Gemini settings,
    // which can contain MCP headers and other credentials.
    const provisioned = provisionProfileWorkspace(
      req,
      session,
      'gemini',
      cwd,
      profileExecutionIdentity(req, session, 'gemini', null),
    )
    return { model, cwd, provisioned, env: { ...process.env, ...workspaceTrustEnv(), ...provisioned.env } }
  }

  /** Admit the launch against the request's subscription policy, then start the CLI. */
  private async spawn(req: ChatRequest, args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv,
    flags: readonly string[], signal?: AbortSignal) {
    const invocation = { env, args, envPassthroughKeys: GEMINI_ENV_PASSTHROUGH_KEYS, flags,
      cwd: cwd ?? process.cwd(), model: req.model, executor: this.spawner.executionEnvironment }
    await admitNativeSubscription(req, invocation)
    const spawned = await this.spawner(this.opts.bin, args, {
      ...(signal ? { signal } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env,
      envPassthroughKeys: GEMINI_ENV_PASSTHROUGH_KEYS,
      ...(req.session_id ? { sessionId: req.session_id } : {}),
      ...(req.jailSpec ? { jail: req.jailSpec } : {}),
      ...(req.childLineage ? { lineageEnv: req.childLineage } : {}),
      ...(req.acquireDeadlineMs !== undefined ? { acquireDeadlineMs: req.acquireDeadlineMs } : {}),
    })
    return { spawned, invocation }
  }

  async *chat(
    req: ChatRequest,
    session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    assertModeSupported(this.name, req.mode ?? 'byob', ['byob'],
      'gemini hosted modes require a verified tool-disable and sandbox contract')

    const prompt = this.buildPrompt(req, session)
    const { cwd, model, provisioned, env } = this.prepare(req, session)
    const args = this.buildArgs(req.model)
    if (model) args.push('--model', model)
    if (session?.internalId) args.push('--resume', session.internalId)
    args.push(...provisioned.flags)

    // Materialize the one selected MCP source into `<cwd>/.gemini/settings.json`.
    // Gemini CLI has no per-invocation MCP flag — it discovers MCP by cwd,
    // layering the project settings over the user's global ones. Cleanup in
    // the outer finally restores the workspace so it never leaks. Fail-loud:
    // a symlink/lock violation throws rather than silently dropping MCP.
    const mcpMaterialized = materializeMcpServersForGemini(resolveMcpServers(req, session, { backend: this.name, privateMcpConfig: false }), cwd)

    let spawned: Awaited<ReturnType<Spawner>>
    try {
      spawned = (await this.spawn(req, args, cwd, env, provisioned.flags)).spawned
    } catch (error) {
      mcpMaterialized?.cleanup()
      throw error
    }
    const child = spawned.child
    const releaseSpawner = spawned.release

    let spawnErrorMessage = ''
    child.on('error', (err) => { spawnErrorMessage = err.message })
    const earlySpawnError = spawned.spawnError?.()
    if (earlySpawnError) spawnErrorMessage = earlySpawnError.message

    const onAbort = (): void => { void terminateSpawned(spawned) }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      const stderr = new BoundedDiagnosticBuffer()
      let emittedContent = false
      let emittedToolCall = false
      child.stderr?.on('data', (b) => { stderr.append(b) })
      if (spawnErrorMessage) {
        throw new BackendError(`gemini spawn failed: ${spawnErrorMessage}`, 'upstream')
      }
      if (!child.stdout) {
        throw new BackendError('gemini subprocess has no stdout pipe', 'upstream')
      }
      if (!child.stdin) {
        throw new BackendError('gemini subprocess has no stdin pipe', 'upstream')
      }

      const stdinResult = await writeStdinPayload(
        child.stdin,
        [{ role: 'user', content: prompt }],
        { format: 'raw' },
      )
      if (!stdinResult.ok) {
        throw new BackendError(`gemini stdin write failed: ${stdinResult.error}`, 'upstream')
      }

      const progressIntervalMs = Math.max(10, Number(process.env.GEMINI_PROGRESS_MS ?? 30_000))
      let sawError: string | null = null
      let assistantText = ''
      let incremental = false
      const tools = new Map<string, string>()
      let nativeSessionId: string | undefined
      let nativeUsage: ChatDelta['usage']
      let nativeProtocol = false
      let terminalResult = false

      for await (const next of readProcessLines({ child, stdout: child.stdout, progressIntervalMs })) {
        if (next.kind === 'progress') {
          yield { keepalive: { source: 'gemini', elapsedMs: next.elapsedMs } }
          continue
        }

        const line = next.line
        if (!line.trim()) continue
        const parsed = parseMaybeJson(line)
        if (parsed) {
          const type = String(parsed.type ?? parsed.event ?? '')
          if (['init', 'message', 'tool_use', 'tool_result', 'result'].includes(type)) nativeProtocol = true
          if (type === 'init') {
            if (typeof parsed.session_id === 'string' && parsed.session_id.length > 0) {
              if ((session?.internalId && parsed.session_id !== session.internalId)
                || (nativeSessionId && parsed.session_id !== nativeSessionId)) {
                throw new BackendError('gemini resumed a different native session', 'upstream')
              }
              nativeSessionId = parsed.session_id
              yield { internal_session_id: nativeSessionId }
            }
            continue
          }
          if (type === 'message' && parsed.role !== 'assistant') continue
          if (type === 'result') {
            terminalResult = true
            if (parsed.error || (parsed.status !== undefined && parsed.status !== 'success')) {
              sawError = String((parsed.error as Record<string, unknown> | undefined)?.message
                ?? `native result status ${String(parsed.status ?? 'error')}`)
            }
            nativeUsage = geminiUsage(parsed.stats)
            continue
          }
          if (type === 'tool_result') {
            const id = typeof parsed.tool_id === 'string' ? parsed.tool_id : undefined
            const name = id ? tools.get(id) : undefined
            if (id && name && (parsed.status === 'success' || parsed.status === 'error')) {
              yield { tool_results: [{ id, name, status: parsed.status === 'success' ? 'completed' : 'error',
                ...(typeof parsed.output === 'string' ? { output: parsed.output } : {}),
                ...(parsed.error ? { error: typeof parsed.error === 'string' ? parsed.error
                  : String((parsed.error as Record<string, unknown>).message ?? 'gemini tool failed') } : {}),
              }] }
            }
            continue
          }
          if (type.toLowerCase().includes('error') || parsed.error) {
            sawError = String(parsed.message
              ?? (parsed.error as Record<string, unknown> | undefined)?.message ?? 'gemini error')
            continue
          }
          const text = extractText(parsed)
          if (text) {
            if (parsed.role === 'assistant' && type === 'message') {
              assistantText = parsed.delta === true && incremental ? assistantText + text : text
              incremental = parsed.delta === true
              yield { content: text, final_text: assistantText }
            } else yield { content: text }
            emittedContent = true
          }
          const toolCall = extractToolCall(parsed)
          if (toolCall) {
            tools.set(toolCall.id, toolCall.name)
            yield { tool_calls: [toolCall] }
            assistantText = ''
            incremental = false
            emittedToolCall = true
          }

        } else {
          yield { content: `${line}\n` }
          emittedContent = true
        }
      }

      await waitForProcessClose(child)
      if (nativeUsage) yield { usage: nativeUsage }
      if (signal.aborted) {
        yield { finish_reason: 'error' }
        return
      }
      await assertSuccessfulHarnessExit(spawned, 'gemini', () => stderr.render())
      if (sawError) throw new BackendError(`gemini: ${sawError}`, 'upstream')
      if (nativeProtocol && !terminalResult) {
        throw new BackendError('gemini stream ended without a terminal result', 'upstream')
      }
      if (session?.internalId && !nativeSessionId) {
        throw new BackendError('gemini did not confirm its resumed native session', 'upstream')
      }
      if (!emittedContent && !emittedToolCall) {
        throw new BackendError(`gemini produced no output: ${stderr.render(300)}`, 'upstream')
      }
      yield { finish_reason: emittedToolCall ? 'tool_calls' : 'stop' }
    } finally {
      signal.removeEventListener('abort', onAbort)
      await terminateSpawned(spawned)
      releaseSpawner()
      mcpMaterialized?.cleanup()
    }
  }

  buildPrompt(req: ChatRequest, _session: SessionRecord | null): string {
    // AgentProfile.prompt.systemPrompt is already installed as Gemini's native
    // `.gemini/system.md` by provisionProfileWorkspace. Adding it to the
    // request text as well applies the same instruction twice and demotes one
    // copy to user content. Request messages remain independent input.
    const flat = this.flattenPrompt(req.messages)
    return wantsJsonObject(req) ? `${JSON_MODE_DIRECTIVE}\n\n${flat}` : flat
  }

  buildArgs(fullModel: string): string[] {
    // `--output-format stream-json` makes gemini emit machine-readable
    // NDJSON events (assistant text + tool calls) instead of best-effort
    // text, so a fired MCP tool call (e.g. you.com search) surfaces as a
    // provable tool_call rather than vanishing into prose. The line parser
    // falls back to treating any non-JSON line as content, so an
    // unexpected event shape degrades to text rather than an empty result.
    const args = ['--prompt', 'Complete the request provided on stdin.', '--output-format', 'stream-json']
    const sandbox = geminiSandboxFlag()
    if (sandbox) args.push(sandbox)
    const yolo = geminiYoloFlag()
    if (yolo) args.push(yolo)
    const effort = geminiThinkingBudget(fullModel)
    if (effort) args.push('--thinking-budget', effort)
    return args
  }

  extractModel(fullModel: string): string | null {
    const lower = fullModel.toLowerCase()
    if (lower === 'gemini') return null
    if (lower.startsWith('gemini/')) {
      const rest = fullModel.slice('gemini/'.length)
      return rest.length > 0 ? rest : null
    }
    return null
  }

  private flattenPrompt(messages: ChatRequest['messages']): string {
    if (messages.length === 1) return contentToText(messages[0]?.content ?? '')
    return messages.map((m) => `[${m.role}] ${contentToText(m.content)}`).join('\n\n')
  }
}

export function geminiYoloFlag(): string | null {
  const raw = process.env.GEMINI_APPROVAL_MODE ?? 'yolo'
  if (!raw || raw === 'none' || raw === 'manual') return null
  return `--approval-mode=${raw}`
}

export function geminiSandboxFlag(): string | null {
  const raw = process.env.GEMINI_SANDBOX?.trim()
  if (!raw || raw === '0' || raw === 'false') return null
  return raw === '1' || raw === 'true' ? '--sandbox' : `--sandbox=${raw}`
}

export function geminiThinkingBudget(fullModel: string): string | null {
  const lower = fullModel.toLowerCase()
  if (!lower.includes('flash')) return null
  return process.env.GEMINI_THINKING_BUDGET ?? null
}

function parseMaybeJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function extractToolCall(ev: Record<string, unknown>): { id: string; name: string; arguments: string } | null {
  // gemini stream-json surfaces tool invocations either as a dedicated
  // event (`type: 'tool_call' | 'tool_use' | 'function_call'`) or as a
  // `functionCall`/`toolCall` object on the event. Parse defensively —
  // extract only when a name is present, and normalize args to a string.
  const type = String(ev.type ?? ev.event ?? '')
  const holder =
    (ev.functionCall as Record<string, unknown> | undefined)
    ?? (ev.function_call as Record<string, unknown> | undefined)
    ?? (ev.toolCall as Record<string, unknown> | undefined)
    ?? (ev.tool_call as Record<string, unknown> | undefined)
    ?? (/tool|function/i.test(type) ? ev : undefined)
  if (!holder) return null
  const name = holder.name ?? holder.tool_name ?? holder.tool ?? (holder.function as Record<string, unknown> | undefined)?.name
  if (typeof name !== 'string' || !name) return null
  const rawArgs =
    holder.args
    ?? holder.parameters
    ?? holder.arguments
    ?? holder.input
    ?? (holder.function as Record<string, unknown> | undefined)?.arguments
    ?? {}
  const id = holder.id ?? holder.tool_id ?? holder.callId ?? holder.call_id
  if (typeof id !== 'string' || id.length === 0) return null
  return {
    id,
    name,
    arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs),
  }
}

/**
 * StreamStats defaults a missing class to zero and aggregates a turn's requests without per-response
 * coverage, so a zero is not a measurement and a positive count is a subtotal of what was reported.
 * Input and cache subtotals are kept when positive. `output_tokens` is the candidates alone; it is kept
 * when input, output and total are all positive and the provider's total is exactly their sum, which
 * leaves no reported output outside it.
 */
function geminiUsage(value: unknown): ChatDelta['usage'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const stats = value as Record<string, unknown>
  const count = (key: string): number | undefined => {
    const value = stats[key]
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new BackendError(`gemini reported invalid ${key} token count`, 'upstream')
    }
    return value
  }
  const input = count('input_tokens')
  const output = count('output_tokens')
  const total = count('total_tokens')
  const cached = count('cached')
  const fresh = count('input')
  if (input === undefined && cached === undefined && fresh === undefined) return undefined
  if (input !== undefined && ((cached !== undefined && cached > input)
    || (fresh !== undefined && fresh > input)
    || (cached !== undefined && fresh !== undefined && cached + fresh !== input))) {
    throw new BackendError('gemini reported inconsistent input token classes', 'upstream')
  }
  return {
    ...(input !== undefined && input > 0 ? { input_tokens: input } : {}),
    ...(input !== undefined && input > 0 && output !== undefined && output > 0 && total === input + output ? { output_tokens: output } : {}),
    ...(cached !== undefined && cached > 0 ? { cache_read_input_tokens: cached } : {}),
    // Native fresh input is derived using a possibly defaulted cache count.
    ...(input !== undefined && input > 0 && cached !== undefined && cached > 0
      && fresh !== undefined && fresh + cached === input ? { fresh_input_tokens: fresh } : {}),
    // Even an all-zero native record suppresses the route's text-token estimate.
    estimated: false,
    cost_known: false,
  }
}

function extractText(ev: Record<string, unknown>): string | null {
  const candidates: unknown[] = [
    ev.text,
    ev.content,
    (ev.message as Record<string, unknown> | undefined)?.text,
    (ev.message as Record<string, unknown> | undefined)?.content,
    (ev.delta as Record<string, unknown> | undefined)?.text,
    (ev.delta as Record<string, unknown> | undefined)?.content,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c
  }
  return null
}

/**
 * What a retained Gemini session proves: an ACP session's continuation and permission requests, with
 * the profile's system prompt applied as on a one-shot turn (`.gemini/system.md`).
 */
export function geminiNativeCapabilities(): AgentEnvironmentCapabilities {
  const acp = acpNativeCapabilities('gemini')
  return { ...acp, profile: { ...acp.profile, systemPrompt: { replace: true, append: false } } }
}
