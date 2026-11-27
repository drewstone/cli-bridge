/**
 * Generic ACP (Agent Client Protocol) backend — drives any agent that exposes an
 * `<bin> acp` stdio server: hermes, openclaw, and future ACP agents. cli-bridge had
 * no ACP client; the existing backends spawn a CLI and parse stdout, but ACP agents
 * speak JSON-RPC 2.0 over ndjson stdio with a stateful session.
 *
 * Wire flow (verified live against `hermes acp`, protocol v1):
 *   spawn `<bin> acp`  (cwd = req.cwd, so the agent discovers workspace skills/context)
 *   → initialize {protocolVersion, clientCapabilities}
 *   → session/new {cwd, mcpServers}            → { sessionId }
 *     (a Bridge session's later turn: session/resume, else session/load, of that sessionId)
 *   → session/prompt {sessionId, prompt:[{type:'text',text}]}
 *   ← stream session/update {update:{content:{type:'text',text}}}  → ChatDelta.content
 *   ← session/request_permission               → fail closed (capability_denied)
 *   ← session/prompt result {stopReason, usage} → finish_reason, ChatDelta.usage
 *   → session/cancel {sessionId}               when the turn is cancelled
 *
 * The agent answers with the model its own configuration names: the model id is the bare backend
 * name (the harness id) or its alias, and `<name>/<model>` is refused. One bin per backend instance; how each
 * agent starts, takes MCP servers, reports usage and steers is in acp-agents.ts.
 */

import type { AgentEnvironmentCapabilities } from '@tangle-network/agent-interface'
import type { BackendHealth, ChatDelta, ChatMessage, ChatRequest, NativeSession, NativeSessionBackend } from './types.js'
import { BackendError } from './types.js'
import { AcpNativeSession, acpChunkUsage, acpPromptUsage, acpUsageSince, type AcpSteer, type AcpUsage, type AcpUsageSource } from './acp-native-session.js'
import { hostRequestJail } from '../jail/host-request.js'
import { genericCliBridgeCapabilities } from '../sessions/retained/capabilities.js'
import type { SessionRecord } from '../sessions/store.js'
import type { Spawner } from '../executors/types.js'
import { scopedHostSpawner } from '../executors/scoped-host.js'
import { terminateSpawned } from '../executors/process-tree.js'
import { contentToText } from './content.js'
import { buildAcpMcpServers, resolveMcpServers, writeMcpConfigFile, type MaterializedMcpConfig } from './profile-mcp.js'
import { resolvePromptMessages } from './profile-prompt.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'
import { versionHealth } from './health.js'
import { attachNdjsonRpc, type JsonRpcMessage, type NdjsonRpc, RpcCallError } from './ndjson-rpc.js'

export interface AcpBackendOptions {
  /** Registry/backend name + model-id prefix: the harness id, e.g. 'hermes', 'github-copilot'. */
  name: string
  /** The Bridge's shorter key for the agent (`copilot`), also accepted as its model id. */
  alias?: string
  /** Binary to spawn, e.g. 'hermes'. */
  bin: string
  /** Subcommand args that start the ACP server. Default ['acp']. */
  acpArgs?: string[]
  /**
   * The args of a one-shot turn, which has no interaction policy to answer a permission request: the
   * agent's own mode that runs every tool without asking. Default `acpArgs`, and a request is refused.
   */
  unattendedArgs?: string[]
  /** Variables the Bridge sets for the agent. */
  env?: Record<string, string>
  /** The variables the agent reads its route from, carried past the host allowlist by exact name. */
  envPassthroughKeys?: string[]
  /**
   * Launch args naming a private MCP config file, for an agent that ignores `mcpServers` in
   * `session/new`. Without it the servers go inline in `session/new`.
   */
  mcpConfigArgs?: (path: string) => string[]
  /** True when a prompt result's usage totals every prompt the process has answered. */
  cumulativeUsage?: boolean
  /** The agent's own record of its token counts, for an agent whose ACP answers carry none. */
  usageSource?: AcpUsageSource
  /** Operator fallback when the caller omits `execution.timeoutMs`; zero means none. */
  timeoutMs: number
  /** Subprocess spawner; defaults to the scoped host spawner. */
  spawner?: Spawner
  /** How the agent takes input for its running turn. Without it a retained session refuses a steer. */
  steer?: AcpSteer
  /** The operator's jail settings; a retained session resolves its own jail from them, as the chat route does. */
  jailEnv?: NodeJS.ProcessEnv
}

/** Bound on every retained-session request except a prompt. */
const REQUEST_TIMEOUT_CAP_MS = 60_000

/** How long a cancelled turn's agent gets to answer `session/cancel` before its process is stopped. */
const CANCEL_GRACE_MS = 2_000

/** ACP stopReason → OpenAI finish_reason. */
function mapStopReason(reason: unknown): ChatDelta['finish_reason'] {
  switch (reason) {
    case 'max_tokens': return 'length'
    case 'cancelled': return 'stop'
    case 'refusal': return 'stop'
    default: return 'stop' // end_turn, max_turn_requests, unknown
  }
}

/**
 * A turn's token counts as the Bridge reports them, from what the agent reported for the prompt
 * (acpPromptUsage). Counts that are absent, or all zero, leave the turn's usage unreported.
 */
function acpTurnUsage(counts: AcpUsage | undefined): ChatDelta['usage'] | undefined {
  if (!counts) return undefined
  const usage = {
    input_tokens: counts.inputTokens,
    output_tokens: counts.outputTokens,
    reasoning_output_tokens: counts.thoughtTokens,
    cache_read_input_tokens: counts.cachedReadTokens,
    cache_write_input_tokens: counts.cachedWriteTokens,
  }
  if (!Object.values(usage).some((count) => count !== undefined && count > 0)) return undefined
  return Object.fromEntries(Object.entries(usage).filter(([, count]) => count !== undefined)) as ChatDelta['usage']
}

/** Render the (profile-preamble-prefixed) conversation into a single prompt string. */
function renderPrompt(messages: ChatMessage[]): string {
  if (messages.length === 1) return contentToText(messages[0]?.content ?? '')
  return messages
    .map((m) => (m.role === 'user' ? contentToText(m.content) : `[${m.role}] ${contentToText(m.content)}`))
    .join('\n\n')
}

export class AcpBackend implements NativeSessionBackend {
  readonly name: string
  readonly defaultExecutionTimeoutMs: number
  readonly nativeModes = ['byob'] as const
  private readonly alias: string
  private readonly bin: string
  private readonly acpArgs: string[]
  private readonly unattendedArgs: string[]
  private readonly env: Record<string, string>
  private readonly envPassthroughKeys: string[]
  private readonly mcpConfigArgs: ((path: string) => string[]) | null
  private readonly cumulativeUsage: boolean
  private readonly usageSource: AcpUsageSource | null
  private readonly spawner: Spawner
  private readonly steer: AcpSteer | null
  private readonly jailEnv: NodeJS.ProcessEnv | undefined

  constructor(opts: AcpBackendOptions) {
    this.name = opts.name
    this.alias = opts.alias ?? opts.name
    this.defaultExecutionTimeoutMs = opts.timeoutMs
    this.bin = opts.bin
    this.acpArgs = opts.acpArgs ?? ['acp']
    this.unattendedArgs = opts.unattendedArgs ?? this.acpArgs
    this.env = opts.env ?? {}
    this.envPassthroughKeys = [...(opts.envPassthroughKeys ?? []), ...Object.keys(this.env)]
    this.mcpConfigArgs = opts.mcpConfigArgs ?? null
    this.cumulativeUsage = opts.cumulativeUsage ?? false
    this.usageSource = opts.usageSource ?? null
    this.spawner = opts.spawner ?? scopedHostSpawner
    this.steer = opts.steer ?? null
    this.jailEnv = opts.jailEnv
  }

  /**
   * Where the turn's MCP servers go: inline in `session/new` (ACP's own mount point), or, for an agent
   * that ignores those, a private config file its launch args name. The caller removes the file.
   */
  private mcpLaunch(req: ChatRequest, session: SessionRecord | null):
    { inline: Array<Record<string, unknown>>; args: string[]; file: MaterializedMcpConfig | null } {
    const specs = resolveMcpServers(req, session, { backend: this.name, privateMcpConfig: true })
    if (!this.mcpConfigArgs) return { inline: buildAcpMcpServers(specs), args: [], file: null }
    const file = writeMcpConfigFile(specs, req.session_id, { typedStdio: true })
    return { inline: [], args: file ? this.mcpConfigArgs(file.configPath) : [], file }
  }

  nativeCapabilities(): AgentEnvironmentCapabilities {
    return acpNativeCapabilities(this.name)
  }

  /**
   * One retained `<bin> acp` per Bridge session, launched like a one-shot turn: the same model rule,
   * profile prompt check, MCP servers (inline in `session/new`), cwd, environment and jail. A session
   * that already holds the agent's session id continues it.
   */
  async startNativeSession(req: ChatRequest, session: SessionRecord | null, signal?: AbortSignal): Promise<NativeSession> {
    this.assertConfiguredModel(req.model)
    // Refuses a profile prompt intent ACP cannot carry, exactly as a one-shot turn does.
    resolvePromptMessages(req, session, this.name)
    const cwd = req.cwd ?? session?.cwd ?? process.cwd()
    const mcp = this.mcpLaunch(req, session)
    // The chat route resolves a one-shot's jail; a retained session starts here, so it resolves its own.
    req.jailSpec ??= hostRequestJail(req, this.name, this.jailEnv ?? process.env)
    const spawned = await this.spawner(this.bin, [...this.acpArgs, ...mcp.args], {
      signal, stdio: ['pipe', 'pipe', 'pipe'], cwd, env: { ...process.env, ...this.env }, envPassthroughKeys: this.envPassthroughKeys,
      ...(req.session_id ? { sessionId: req.session_id } : {}),
      ...(req.jailSpec ? { jail: req.jailSpec } : {}),
      ...(req.childLineage ? { lineageEnv: req.childLineage } : {}),
      ...(req.acquireDeadlineMs !== undefined ? { acquireDeadlineMs: req.acquireDeadlineMs } : {}),
      ...(req.admissionClass ? { admissionClass: req.admissionClass } : {}),
    }).catch((error: unknown) => { mcp.file?.cleanup(); throw error })
    const spawnError = spawned.spawnError?.()
    if (spawnError || !spawned.child.stdin || !spawned.child.stdout) {
      await terminateSpawned(spawned).finally(() => { spawned.release(); mcp.file?.cleanup() })
      throw new BackendError(`${this.name} acp failed to start with stdin and stdout pipes`, 'upstream', spawnError)
    }
    const native = new AcpNativeSession(spawned, {
      name: this.name,
      capabilities: acpNativeCapabilities(this.name),
      cwd,
      mcpServers: mcp.inline,
      resumeSessionId: session?.internalId || null,
      steer: this.steer,
      cumulativeUsage: this.cumulativeUsage,
      ...(this.usageSource ? { usageSource: this.usageSource } : {}),
      requestTimeoutMs: this.defaultExecutionTimeoutMs > 0 ? Math.min(this.defaultExecutionTimeoutMs, REQUEST_TIMEOUT_CAP_MS) : REQUEST_TIMEOUT_CAP_MS,
      cleanup: () => mcp.file?.cleanup(),
    })
    try {
      await native.start(signal)
    } catch (error) {
      await native.close().catch(() => {})
      throw error
    }
    return native
  }

  private assertConfiguredModel(model: string): void {
    // The agent runs the model its own configuration names; ACP gives this client no portable way to pick
    // another, so a named model is refused instead of being dropped while the configured one answers.
    if (model !== this.name && model !== this.alias) {
      throw new BackendError(
        `backend ${this.name} runs the model ${this.name}'s own configuration names; request model "${this.name}" `
          + `instead of "${model}" and select the model in ${this.name}'s configuration`,
        'not_configured',
      )
    }
  }

  matches(model: string): boolean {
    return [this.name, this.alias].some((id) => model === id || model.startsWith(`${id}/`))
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    return versionHealth(this.name, this.bin, this.spawner, undefined, signal)
  }

  async *chat(req: ChatRequest, session: SessionRecord | null, signal: AbortSignal): AsyncIterable<ChatDelta> {
    this.assertConfiguredModel(req.model)
    const cwd = req.cwd ?? session?.cwd ?? process.cwd()
    const promptText = renderPrompt(resolvePromptMessages(req, session, this.name))
    // Profile MCP, or body/header MCP when no profile is present. Schema verified live against
    // `hermes acp`: remote is `{type, name, url, headers:[{name,value}]}`, stdio is
    // `{name, command, args, env:[{name,value}]}`.
    const mcp = this.mcpLaunch(req, session)
    const mcpServers = mcp.inline

    const spawned = await this.spawner(this.bin, [...this.unattendedArgs, ...mcp.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: { ...process.env, ...this.env },
      envPassthroughKeys: this.envPassthroughKeys,
      ...(req.session_id ? { sessionId: req.session_id } : {}),
      ...(req.jailSpec ? { jail: req.jailSpec } : {}),
      ...(req.childLineage ? { lineageEnv: req.childLineage } : {}),
      ...(req.acquireDeadlineMs !== undefined ? { acquireDeadlineMs: req.acquireDeadlineMs } : {}),
    }).catch((error: unknown) => { mcp.file?.cleanup(); throw error })
    const child = spawned.child
    const release = spawned.release
    const stderr = new BoundedDiagnosticBuffer()
    child.stderr?.on('data', (chunk) => { stderr.append(chunk) })
    let spawnErrorMessage = spawned.spawnError?.()?.message ?? ''
    child.on('error', (err) => { spawnErrorMessage = err.message })

    // A cancelled turn asks the agent to stop it first (`session/cancel`), so an agent whose turn
    // outlives this process (a daemon that owns the session) stops too; the process goes after a grace.
    let acpSessionId: string | undefined
    let cancel: (() => void) | undefined
    let graceTimer: NodeJS.Timeout | undefined
    const onAbort = (): void => {
      cancel?.()
      graceTimer = setTimeout(() => { void terminateSpawned(spawned) }, acpSessionId ? CANCEL_GRACE_MS : 0)
      graceTimer.unref?.()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      if (spawnErrorMessage) throw new BackendError(`${this.name} acp spawn failed: ${spawnErrorMessage}`, 'upstream')
      if (!child.stdin || !child.stdout) throw new BackendError(`${this.name} acp subprocess has no stdio pipes`, 'upstream')
      const stdin = child.stdin
      const stdout = child.stdout

      // ── ndjson JSON-RPC client over the child's stdio (shared framing in
      // ndjson-rpc.ts; this backend keeps only its own protocol decisions) ──
      const queue: ChatDelta[] = []
      let wake: (() => void) | null = null
      let streamEnded = false
      let driverError: Error | null = null
      let prompting = false
      const chunkUsage: Record<string, unknown>[] = []
      const push = (d: ChatDelta): void => { queue.push(d); wake?.() }

      const rpc = attachNdjsonRpc({
        child,
        label: `${this.name} acp`,
        stdin,
        stdout,
        onMessage: (m: JsonRpcMessage) => {
          // Before the prompt is sent, updates are the agent replaying a resumed session's history.
          if (m.method === 'session/update' && !prompting) return
          if (m.method === 'session/update') {
            const update = (m.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } })?.update
            const kind = update?.sessionUpdate
            const c = update?.content
            const counted = acpChunkUsage(update as Record<string, unknown> | undefined)
            if (counted) chunkUsage.push(counted)
            // Emit the agent's MESSAGE text as content; skip thought/plan/tool chunks
            // so reasoning never pollutes the OpenAI content stream. `undefined` kind
            // (older agents that only send content) is treated as a message chunk.
            if (c?.type === 'text' && c.text && (kind === undefined || kind === 'agent_message_chunk')) {
              push({ content: c.text })
            }
          } else if (m.method === 'session/request_permission' && m.id !== undefined) {
            // ACP has a native permission request, but this one-shot backend has
            // no NativeSession handle or canonical response binding. Selecting an
            // option here would fabricate user approval and bypass the retained
            // interaction contract. Refuse the request and stop the turn.
            const message = `${this.name} ACP permission requests require a retained native session; cli-bridge cannot answer this request safely`
            if (!driverError) {
              driverError = new BackendError(message, 'capability_denied')
              rpc.respondError(m.id, -32001, message)
              void terminateSpawned(spawned)
            }
          } else if (m.method && m.id !== undefined) {
            // any other agent→client request (fs reads we declined in capabilities, etc.): refuse cleanly.
            rpc.respondError(m.id, -32601, 'method not supported by cli-bridge ACP client')
          }
        },
        onEnd: () => { streamEnded = true; wake?.() },
      })
      const request = (method: string, params: unknown): Promise<unknown> =>
        rpc.request(method, params).catch((error: unknown) => {
          if (error instanceof RpcCallError) {
            const wire = JSON.stringify({ code: error.code, message: error.message, data: error.data })
            throw new BackendError(`${this.name} acp error: ${wire.slice(0, 160)}`, 'upstream')
          }
          throw error
        })

      // Drive the protocol; deltas flow through `queue` as session/update arrives.
      const driver = (async () => {
        const init = (await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } })) as {
          agentCapabilities?: { loadSession?: boolean; sessionCapabilities?: { resume?: unknown } }
        }
        const sessionId = await this.openSession(request, init?.agentCapabilities, session?.internalId || null, cwd, mcpServers)
        acpSessionId = sessionId
        cancel = () => rpc.notify('session/cancel', { sessionId })
        if (signal.aborted) throw new BackendError(`${this.name} acp turn was cancelled`, 'aborted')
        push({ internal_session_id: sessionId })
        // A resumed session's totals already hold its earlier turns.
        const before = this.usageSource ? await this.usageSource(sessionId).catch(() => undefined) ?? {} : {}
        prompting = true
        const result = (await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: promptText }] })) as { stopReason?: unknown }
        const sourced = !this.usageSource ? undefined : await acpUsageSince(this.usageSource, sessionId, before)
        const usage = acpTurnUsage(acpPromptUsage(result, chunkUsage) ?? sourced?.delta)
        if (usage) push({ usage })
        push({ finish_reason: signal.aborted ? 'error' : mapStopReason(result?.stopReason) })
      })()
      // The agent stays up after a refused step (a server waits for its next request), so a
      // failure must wake the pump itself; otherwise the turn waits for an exit that never comes.
      driver.catch((e: Error) => {
        driverError = e instanceof BackendError ? e : new BackendError(`${this.name} acp: ${e.message}`, 'upstream')
        wake?.()
      })

      // Yield deltas as they arrive; finish_reason ends the turn. The
      // driverError check repeats before every yield so a permission refusal
      // landing while the pump sits at a yield still fails the turn even if
      // the finish frame is already queued behind it.
      while (true) {
        if (driverError) throw driverError
        const d = queue.shift()
        if (d) {
          yield d
          if (d.finish_reason) return
          continue
        }
        if (driverError) throw driverError
        if (streamEnded) {
          yield { finish_reason: 'error' }
          const detail = stderr.render(300)
          throw new BackendError(
            `${this.name} acp stream ended before session/prompt completed${detail ? `: ${detail}` : ''}`,
            'upstream',
          )
        }
        await new Promise<void>((resolve) => { wake = () => { wake = null; resolve() } })
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      clearTimeout(graceTimer)
      await terminateSpawned(spawned)
      release()
      mcp.file?.cleanup()
    }
  }

  /**
   * The ACP session this turn runs in. A Bridge session that already holds the agent's session id
   * continues it: `session/resume` where the agent offers it, else `session/load`; the history either
   * replays is not this turn's output. Without either the turn starts a new agent session.
   */
  private async openSession(
    request: (method: string, params: unknown) => Promise<unknown>,
    capabilities: { loadSession?: boolean; sessionCapabilities?: { resume?: unknown } } | undefined,
    previous: string | null,
    cwd: string,
    mcpServers: unknown[],
  ): Promise<string> {
    if (previous && capabilities?.sessionCapabilities?.resume) {
      await request('session/resume', { sessionId: previous, cwd, mcpServers })
      return previous
    }
    if (previous && capabilities?.loadSession) {
      await request('session/load', { sessionId: previous, cwd, mcpServers })
      return previous
    }
    const created = (await request('session/new', { cwd, mcpServers })) as { sessionId?: unknown }
    if (typeof created?.sessionId !== 'string' || !created.sessionId) {
      throw new BackendError(`${this.name} acp session/new answered without a sessionId`, 'upstream')
    }
    return created.sessionId
  }
}

/**
 * What a retained ACP session proves: continuation in one agent process, permission requests answered
 * by the turn's policy, and the profile surfaces ACP carries (MCP servers inline in `session/new`;
 * no system prompt, instructions or tool controls).
 */
export function acpNativeCapabilities(backend: string): AgentEnvironmentCapabilities {
  const generic = genericCliBridgeCapabilities(backend)
  return {
    ...generic,
    profile: {
      ...generic.profile,
      systemPrompt: { replace: false, append: false },
      instructions: false,
      tools: false,
      permissions: false,
      subagents: false,
      resources: { files: false, instructions: false, tools: false, skills: false, agents: false, commands: false },
      modes: false,
    },
    sessions: { continue: true, list: true, messages: true },
    nativeContinuation: { atomicBoundary: true, requestIdempotency: true, admissionControl: true },
    interactions: { kinds: ['permission'], answerFieldTypes: ['select'], responseScopes: ['interaction'],
      secretAnswers: false, concurrentRequests: false, replay: true, responseIdempotency: true },
    workspace: { ...generic.workspace, read: true, write: true, exec: true, git: true },
  }
}
