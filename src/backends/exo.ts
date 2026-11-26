/**
 * Exo on its HTTP service (exo-serve-session.ts). A retained session holds one `exo run <file> --serve`
 * process across turns; a chat turn runs one for its one message and continues the Bridge session's thread.
 *
 * Exo serves one service per state root, so each Bridge session has its own root,
 * `<EXO_HOME>/bridge-sessions/<digest of the session id>`, which keeps its thread for a later process; a turn
 * outside a session gets a root of its own, removed after it. The root holds the agent definition the
 * service runs (`bridge.md`): its model (`exo/<model>` or `EXO_MODEL`), the route `EXO_MODEL_BASE_URL`, a
 * vault credential holding `EXO_MODEL_API_KEY` for the process's life, and the turn's MCP servers by URL.
 * Exo takes MCP servers by URL only, so the Bridge serves stdio servers by URL (mcp-url-relay.ts) and lets
 * each one's tools run without asking (`permission_policy: always_allow`). A session's relay URLs are
 * derived from its id, so they stay the same for a later process: Exo refuses a thread whose MCP
 * destinations changed.
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentEnvironmentCapabilities } from '@tangle-network/agent-interface'
import type { BackendHealth, ChatDelta, ChatRequest, NativeSession, NativeSessionBackend } from './types.js'
import { BackendError } from './types.js'
import { EXO_TURN_SETTLED, ExoServeSession, exoAssistantParts, type ExoUsage } from './exo-serve-session.js'
import { McpUrlRelay } from './mcp-url-relay.js'
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

const run = promisify(execFile)
const EXO_KEY_ENV = 'EXO_MODEL_API_KEY'
/** Host variables Exo reads, passed through the host allowlist by exact name. */
const EXO_ENV_KEYS = ['EXO_HOME', 'EXO_SECRET_BACKEND', 'EXO_MASTER_KEY_PATH', 'EXO_CONFIG_DIR']
/** Bound on every service request; a turn itself has none. */
const REQUEST_TIMEOUT_CAP_MS = 60_000
const relay = new McpUrlRelay()

export interface ExoBackendOptions {
  bin: string
  /** Operator fallback when the caller omits `execution.timeoutMs`; zero means none. */
  timeoutMs: number
  spawner?: Spawner
  /** The operator's jail settings; a retained session resolves its own jail from them, as the chat route does. */
  jailEnv?: NodeJS.ProcessEnv
}

export class ExoBackend implements NativeSessionBackend {
  readonly name = 'exo'
  readonly defaultExecutionTimeoutMs: number
  readonly nativeModes = ['byob'] as const
  private readonly spawner: Spawner

  constructor(private readonly opts: ExoBackendOptions) {
    this.defaultExecutionTimeoutMs = opts.timeoutMs
    this.spawner = opts.spawner ?? scopedHostSpawner
  }

  matches(model: string): boolean {
    return model === this.name || model.startsWith(`${this.name}/`)
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    return versionHealth(this.name, this.opts.bin, this.spawner, undefined, signal, { args: ['--help'], reportsVersion: false })
  }

  nativeCapabilities(): AgentEnvironmentCapabilities {
    return exoNativeCapabilities()
  }

  async startNativeSession(req: ChatRequest, session: SessionRecord | null, signal?: AbortSignal): Promise<NativeSession> {
    // Refuses a profile prompt intent Exo cannot carry, exactly as a chat turn does.
    resolvePromptMessages(req, session, this.name)
    // The chat route resolves a one-shot's jail; a retained session starts here, so it resolves its own.
    req.jailSpec ??= hostRequestJail(req, this.name, this.opts.jailEnv ?? process.env)
    return await this.open(req, session, signal, signal)
  }

  /** One turn on its own process, continuing the Bridge session's thread when it has one. */
  async *chat(req: ChatRequest, session: SessionRecord | null, signal: AbortSignal): AsyncIterable<ChatDelta> {
    assertModeSupported(this.name, req.mode ?? 'byob', ['byob'])
    if ((req.env && Object.keys(req.env).length > 0) || req.effort || req.temperature !== undefined || req.max_tokens !== undefined
      || req.messages.some((message) => typeof message.content !== 'string' && message.content !== null)) {
      throw new BackendError(`${this.name} takes text turns, native resume, AgentProfile instructions and MCP; `
        + 'public env, reasoning and sampling overrides and attachments are not configured', 'capability_denied')
    }
    const prompt = flattenMessages(resolvePromptMessages(req, session, this.name))
    signal.throwIfAborted()
    // The run's cancel reaches the session, which cancels Exo's turn before stopping it; the spawner would only kill it.
    const native = await this.open(req, session, signal)
    // The service holds the root's lock until it exits, so the turn ends only once it has: the session's
    // next turn starts a service on the same root.
    let closed: Promise<void> | null = null
    const close = (): Promise<void> => (closed ??= native.close().catch(() => {}))
    try {
      yield { internal_session_id: native.providerSessionId()! }
      let text = '', usage: ExoUsage | null = null, failure: string | null = null
      try {
        for await (const raw of native.turn(prompt, signal)) {
          const event = raw as Record<string, unknown>
          if (event.type === 'messages') {
            // Each assistant message is a line of the reply.
            for (const part of exoAssistantParts(event)) {
              if (part.kind !== 'text') continue
              const content = `${text ? '\n' : ''}${part.text}`
              text += content
              yield { content }
            }
          } else if (event.type === EXO_TURN_SETTLED) {
            usage = event.usage as ExoUsage
            failure = typeof event.error === 'string' ? event.error : null
          }
        }
      } catch (error) {
        if (!signal.aborted) throw error
      }
      await close()
      if (signal.aborted) { yield { finish_reason: 'error' }; return }
      if (failure) throw new BackendError(`${this.name}: ${failure}`, 'upstream')
      yield { final_text: text, usage: { ...exoTurnUsage(usage), cost_known: false }, finish_reason: 'stop' }
    } finally {
      await close()
    }
  }

  /** `stopOn` ends the process with that signal; without it the session's own abort does. */
  private async open(req: ChatRequest, session: SessionRecord | null, signal?: AbortSignal, stopOn?: AbortSignal): Promise<ExoServeSession> {
    const model = this.modelOf(req.model) ?? process.env.EXO_MODEL
    const baseUrl = process.env.EXO_MODEL_BASE_URL
    if (!model || !baseUrl || !process.env[EXO_KEY_ENV]) {
      throw new BackendError(`exo needs EXO_MODEL_BASE_URL and ${EXO_KEY_ENV}, and a model: request exo/<model> or set EXO_MODEL`, 'not_configured')
    }
    const cwd = resolveSpawnerCwd(this.spawner, req.cwd ?? session?.cwd ?? process.cwd())!
    const mcp = resolveMcpServers(req, session, { backend: this.name, privateMcpConfig: true })
    const home = process.env.EXO_HOME || join(homedir(), '.exo')
    const sessionKey = req.session_id ?? null
    await mkdir(join(home, sessionKey ? 'bridge-sessions' : 'bridge-turns'), { recursive: true, mode: 0o700 })
    const root = sessionKey
      ? join(home, 'bridge-sessions', createHash('sha256').update(sessionKey).digest('hex').slice(0, 16))
      : await mkdtemp(join(home, 'bridge-turns', 'turn-'))
    await mkdir(root, { recursive: true, mode: 0o700 })
    const env = { ...process.env, EXO_HOME: root }
    const exoCli = (args: string[]) => run(this.opts.bin, args, { cwd, env, timeout: 30_000, maxBuffer: 16 << 20 })
    const credential = `bridge-${randomBytes(8).toString('hex')}`
    let served: Awaited<ReturnType<McpUrlRelay['serve']>> | null = null
    let secret = false
    const cleanup = async (): Promise<void> => {
      await served?.close()
      if (secret) await exoCli(['vault', 'secret', 'delete', 'global', credential]).catch(() => undefined)
      if (!sessionKey) await rm(root, { recursive: true, force: true })
    }
    let spawned: Awaited<ReturnType<Spawner>> | undefined
    try {
      served = mcp && Object.keys(mcp).length > 0 ? await relay.serve(mcp, cwd, sessionKey) : null
      await exoCli(['vault', 'secret', 'create', 'global', credential, '--token-env', EXO_KEY_ENV, '--allow-origin', new URL(baseUrl).origin])
        .catch((error: { stderr?: string }) => { throw new BackendError(`exo vault secret create failed: ${String(error.stderr ?? '').slice(-300)}`, 'not_configured') })
      secret = true
      const file = join(root, 'bridge.md')
      // JSON strings are YAML scalars, so no value can break the front matter.
      await writeFile(file, [
        '---', 'harness: basic', 'model:', `  name: ${JSON.stringify(model)}`, `  base_url: ${JSON.stringify(baseUrl)}`, `  credential: ${credential}`,
        ...(served ? ['mcp_servers:', ...Object.entries(served.urls).flatMap(([name, url]) => [
          '  - type: url', `    name: ${JSON.stringify(name)}`, `    url: ${JSON.stringify(url)}`, '    permission_policy:', '      type: always_allow'])] : []),
        '---', '', 'You are a coding agent working in this directory.', '',
      ].join('\n'), { mode: 0o600 })
      spawned = await this.spawner(this.opts.bin, ['run', file, '--serve', '--bind', '127.0.0.1:0'], {
        ...(stopOn ? { signal: stopOn } : {}), stdio: ['ignore', 'pipe', 'pipe'], cwd, env, envPassthroughKeys: EXO_ENV_KEYS,
        ...(req.session_id ? { sessionId: req.session_id } : {}),
        ...(req.jailSpec ? { jail: req.jailSpec } : {}),
        ...(req.childLineage ? { lineageEnv: req.childLineage } : {}),
        ...(req.acquireDeadlineMs !== undefined ? { acquireDeadlineMs: req.acquireDeadlineMs } : {}),
        ...(req.admissionClass ? { admissionClass: req.admissionClass } : {}),
      })
    } catch (error) {
      await cleanup()
      throw error
    }
    const spawnError = spawned.spawnError?.()
    if (spawnError || !spawned.child.stdout) {
      const failed = spawned
      await terminateSpawned(failed).finally(() => failed.release())
      await cleanup()
      throw new BackendError('exo failed to start with a stdout pipe', 'upstream', spawnError)
    }
    const native = new ExoServeSession(spawned, {
      capabilities: exoNativeCapabilities(),
      cwd,
      resumeThreadId: session?.internalId || null,
      requestTimeoutMs: this.defaultExecutionTimeoutMs > 0 ? Math.min(this.defaultExecutionTimeoutMs, REQUEST_TIMEOUT_CAP_MS) : REQUEST_TIMEOUT_CAP_MS,
      cleanup,
    })
    try {
      await native.start(signal)
    } catch (error) {
      await native.close().catch(() => {})
      throw error
    }
    return native
  }

  /** The model named after the harness id (`exo/<model>`), or null for the operator's `EXO_MODEL`. */
  private modelOf(model: string): string | null {
    return model.startsWith(`${this.name}/`) ? model.slice(this.name.length + 1) || null : null
  }
}

/** A turn's counts as the Bridge reports them; a turn whose model calls reported none reports nothing. */
export function exoTurnUsage(usage: ExoUsage | null): NonNullable<ChatDelta['usage']> {
  if (!usage || usage.calls === 0) return {}
  // Exo's prompt count includes the cached part, as OpenAI's does.
  return {
    model_requests: usage.calls, input_tokens: usage.input, output_tokens: usage.output, estimated: false,
    ...(usage.cacheRead > 0 && usage.cacheRead <= usage.input
      ? { cache_read_input_tokens: usage.cacheRead, fresh_input_tokens: usage.input - usage.cacheRead } : {}),
  }
}

/**
 * What an Exo session proves: continuation in one process and across processes, input for a running turn
 * (it interrupts the turn), MCP servers from the profile, and tools on the workspace. Exo runs its tools
 * without asking, so it raises no interactions; its system prompt is not wired, so no prompt intent,
 * instructions or tool controls are offered.
 */
export function exoNativeCapabilities(): AgentEnvironmentCapabilities {
  const generic = genericCliBridgeCapabilities('exo')
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
