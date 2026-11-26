/**
 * Factory Droid on its streamed JSON-RPC mode (droid-native-session.ts). A retained session holds one
 * `droid exec --input-format stream-jsonrpc` process across turns; a chat turn runs one such process for its
 * one message and continues the Bridge session's Droid session with `droid.load_session`. Both pass the turn's
 * MCP servers in the session request, so Droid's own `~/.factory/mcp.json` is never rewritten.
 *
 * Droid runs the custom models its own settings name (`~/.factory/settings.json` `customModels`, model id
 * `custom:<id>`), requested as `factory-droids/custom:<id>`; the bare id runs Droid's default. Its ACP mode
 * refuses `session/new` without a Factory login, and this mode needs none. It offers MCP tools to its model
 * through its `ToolSearch` tool, not directly, and has no setting that turns that off.
 */
import type { AgentEnvironmentCapabilities } from '@tangle-network/agent-interface'
import type { BackendHealth, ChatDelta, ChatRequest, NativeSession, NativeSessionBackend } from './types.js'
import { BackendError } from './types.js'
import { DROID_TURN_SETTLED, DroidNativeSession, droidMcpServers, type DroidUsage } from './droid-native-session.js'
import type { SessionRecord } from '../sessions/store.js'
import { assertModeSupported } from '../modes.js'
import { resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import { scopedHostSpawner } from '../executors/scoped-host.js'
import { terminateSpawned } from '../executors/process-tree.js'
import { hostRequestJail } from '../jail/host-request.js'
import { genericCliBridgeCapabilities } from '../sessions/retained/capabilities.js'
import { versionHealth } from './health.js'
import { flattenMessages } from './content.js'
import { resolvePromptMessages } from './profile-prompt.js'
import { resolveMcpServers } from './profile-mcp.js'

/** Bound on every session request; a turn itself has none. */
const REQUEST_TIMEOUT_CAP_MS = 60_000

export interface DroidBackendOptions {
  bin: string
  /** Operator fallback when the caller omits `execution.timeoutMs`; zero means none. */
  timeoutMs: number
  spawner?: Spawner
  /** The operator's jail settings; a retained session resolves its own jail from them, as the chat route does. */
  jailEnv?: NodeJS.ProcessEnv
}

export class DroidBackend implements NativeSessionBackend {
  readonly name = 'factory-droids'
  readonly defaultExecutionTimeoutMs: number
  readonly nativeModes = ['byob'] as const
  private readonly alias = 'droid'
  private readonly spawner: Spawner

  constructor(private readonly opts: DroidBackendOptions) {
    this.defaultExecutionTimeoutMs = opts.timeoutMs
    this.spawner = opts.spawner ?? scopedHostSpawner
  }

  matches(model: string): boolean {
    return [this.name, this.alias].some((id) => model === id || model.startsWith(`${id}/`))
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    return versionHealth(this.name, this.opts.bin, this.spawner, undefined, signal)
  }

  nativeCapabilities(): AgentEnvironmentCapabilities {
    return droidNativeCapabilities()
  }

  async startNativeSession(req: ChatRequest, session: SessionRecord | null, signal?: AbortSignal): Promise<NativeSession> {
    // Refuses a profile prompt intent Droid cannot carry, exactly as a chat turn does.
    resolvePromptMessages(req, session, this.name)
    // The chat route resolves a one-shot's jail; a retained session starts here, so it resolves its own.
    req.jailSpec ??= hostRequestJail(req, this.name, this.opts.jailEnv ?? process.env)
    return await this.open(req, session, signal)
  }

  /** One turn on its own process, continuing the Bridge session's Droid session when it has one. */
  async *chat(req: ChatRequest, session: SessionRecord | null, signal: AbortSignal): AsyncIterable<ChatDelta> {
    assertModeSupported(this.name, req.mode ?? 'byob', ['byob'])
    if ((req.env && Object.keys(req.env).length > 0) || req.effort || req.temperature !== undefined || req.max_tokens !== undefined
      || req.messages.some((message) => typeof message.content !== 'string' && message.content !== null)) {
      throw new BackendError(`${this.name} takes text turns, native resume and MCP; public env, reasoning and sampling overrides and attachments are not configured`, 'capability_denied')
    }
    const prompt = flattenMessages(resolvePromptMessages(req, session, this.name))
    signal.throwIfAborted()
    const native = await this.open(req, session, signal)
    try {
      yield { internal_session_id: native.providerSessionId()! }
      let text = '', message: unknown, usage: DroidUsage = {}, failure: string | null = null
      try {
        for await (const raw of native.turn(prompt, signal)) {
          const event = raw as Record<string, unknown>
          if (event.type === 'assistant_text_delta' && typeof event.textDelta === 'string') {
            // Each assistant message is a line of the reply.
            const content = `${text && event.messageId !== message ? '\n' : ''}${event.textDelta}`
            message = event.messageId
            text += content
            if (content) yield { content }
          } else if (event.type === DROID_TURN_SETTLED) {
            usage = (event.usage ?? {}) as DroidUsage
            failure = typeof event.error === 'string' ? event.error : null
          }
        }
      } catch (error) {
        if (!signal.aborted) throw error
      }
      if (signal.aborted) { yield { finish_reason: 'error' }; return }
      if (failure) throw new BackendError(`${this.name}: ${failure}`, 'upstream')
      yield { final_text: text, usage: { ...droidTurnUsage(usage), estimated: false, cost_known: false }, finish_reason: 'stop' }
    } finally {
      await native.close().catch(() => {})
    }
  }

  /** The model named after the harness id (`factory-droids/custom:<id>`), or null for Droid's default. */
  private modelOf(model: string): string | null {
    for (const id of [this.name, this.alias]) {
      if (model.startsWith(`${id}/`)) return model.slice(id.length + 1) || null
    }
    return null
  }

  private async open(req: ChatRequest, session: SessionRecord | null, signal?: AbortSignal): Promise<DroidNativeSession> {
    const cwd = resolveSpawnerCwd(this.spawner, req.cwd ?? session?.cwd ?? process.cwd())!
    const mcpServers = droidMcpServers(resolveMcpServers(req, session, { backend: this.name, privateMcpConfig: true }))
    const spawned = await this.spawner(this.opts.bin,
      ['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc', '--skip-permissions-unsafe', '--cwd', cwd], {
        signal, stdio: ['pipe', 'pipe', 'pipe'], cwd, env: process.env, envPassthroughKeys: ['FACTORY_HOME_OVERRIDE'],
        ...(req.session_id ? { sessionId: req.session_id } : {}),
        ...(req.jailSpec ? { jail: req.jailSpec } : {}),
        ...(req.childLineage ? { lineageEnv: req.childLineage } : {}),
        ...(req.acquireDeadlineMs !== undefined ? { acquireDeadlineMs: req.acquireDeadlineMs } : {}),
        ...(req.admissionClass ? { admissionClass: req.admissionClass } : {}),
      })
    const spawnError = spawned.spawnError?.()
    if (spawnError || !spawned.child.stdin || !spawned.child.stdout) {
      await terminateSpawned(spawned).finally(() => spawned.release())
      throw new BackendError('droid failed to start with stdin and stdout pipes', 'upstream', spawnError)
    }
    const native = new DroidNativeSession(spawned, {
      capabilities: droidNativeCapabilities(),
      cwd,
      modelId: this.modelOf(req.model),
      mcpServers,
      resumeSessionId: session?.internalId || null,
      requestTimeoutMs: this.defaultExecutionTimeoutMs > 0 ? Math.min(this.defaultExecutionTimeoutMs, REQUEST_TIMEOUT_CAP_MS) : REQUEST_TIMEOUT_CAP_MS,
      cleanup: () => {},
    })
    try {
      await native.start(signal)
    } catch (error) {
      await native.close().catch(() => {})
      throw error
    }
    return native
  }
}

/** A turn's counts as the Bridge reports them, by Droid's names; a turn that reported none reports nothing. */
export function droidTurnUsage(counts: DroidUsage): NonNullable<ChatDelta['usage']> {
  return {
    ...(counts.inputTokens === undefined ? {} : { input_tokens: counts.inputTokens }),
    ...(counts.outputTokens === undefined ? {} : { output_tokens: counts.outputTokens }),
    ...(counts.cacheReadTokens === undefined ? {} : { cache_read_input_tokens: counts.cacheReadTokens }),
    ...(counts.cacheCreationTokens === undefined ? {} : { cache_write_input_tokens: counts.cacheCreationTokens }),
    ...(counts.thinkingTokens === undefined ? {} : { reasoning_output_tokens: counts.thinkingTokens }),
  }
}

/**
 * What a Droid session proves: continuation in one process and across processes, input for a running turn,
 * and MCP servers from the profile. Droid runs unattended, so it raises no interactions; its system-prompt
 * parameters are not wired, so no prompt intent, instructions or tool controls are offered.
 */
export function droidNativeCapabilities(): AgentEnvironmentCapabilities {
  const generic = genericCliBridgeCapabilities('factory-droids')
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
    workspace: { ...generic.workspace, read: true, write: true, exec: true, git: true },
  }
}
