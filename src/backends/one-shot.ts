/**
 * Agent CLIs the Bridge runs one process per turn: the prompt goes on the command line, the reply comes
 * back on stdout, and the agent names a native session the next turn resumes. What differs per agent (its
 * launch, how its reply, session id and usage are read, where its MCP servers go) is its `OneShotAgent`
 * in one-shot-agents.ts. A turn's model is the one named after the harness id (`nanocode/<model>`), or the
 * agent's own default for the bare id.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Backend, BackendHealth, ChatDelta, ChatRequest, McpServerSpec } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import { assertModeSupported } from '../modes.js'
import { resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import { scopedHostSpawner } from '../executors/scoped-host.js'
import { terminateSpawned } from '../executors/process-tree.js'
import { versionHealth } from './health.js'
import { flattenMessages } from './content.js'
import { resolvePromptMessages } from './profile-prompt.js'
import { resolveMcpServers } from './profile-mcp.js'
import { assertSuccessfulHarnessExit, readProcessLines } from './process-lines.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'

export interface OneShotTurn {
  /** The agent's executable, for a helper command the launch runs. */
  bin: string
  prompt: string
  /** The model named after the harness id, or null for the agent's own default. */
  model: string | null
  cwd: string
  /** The native session the previous turn of this Bridge session named. */
  resume: string | null
  /** The Bridge session the turn belongs to, if any. */
  sessionKey: string | null
  /** The turn's MCP servers, or null for none. */
  mcp: Record<string, McpServerSpec> | null
  /** A private directory for this turn's files, removed when the turn ends. */
  dir: string
}

/** One turn's process: its arguments, and how its output is read. */
export interface OneShotLaunch {
  args: string[]
  env?: Record<string, string>
  stdout(line: string): OneShotRead | null
  stderr?(line: string): OneShotRead | null
  /** Reads what the agent recorded elsewhere once it exited (usage it does not print). */
  after?(done: { sessionId: string | null; pid: number | undefined }): Promise<OneShotRead | null>
  /** Undoes what the launch set up, whatever the turn's outcome. */
  cleanup?(): Promise<void> | void
}

/** What one line of the agent's output, or its after-exit read, adds to the turn. */
export interface OneShotRead {
  /** One line of the reply; lines are joined with a line break. */
  line?: string
  /** The whole reply, used when no line came. */
  finalText?: string
  sessionId?: string
  usage?: { input: number; output: number }
}

export interface OneShotAgent {
  /** Host variables the agent reads, passed through the host allowlist by exact name. */
  envPassthroughKeys: readonly string[]
  launch(turn: OneShotTurn): Promise<OneShotLaunch>
}

const NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u

export class OneShotBackend implements Backend {
  readonly name: string
  readonly defaultExecutionTimeoutMs: number
  private readonly spawner: Spawner

  constructor(private readonly opts: { name: string; alias: string; bin: string; agent: OneShotAgent; timeoutMs: number; spawner?: Spawner }) {
    this.name = opts.name
    this.defaultExecutionTimeoutMs = opts.timeoutMs
    this.spawner = opts.spawner ?? scopedHostSpawner
  }

  matches(model: string): boolean {
    return [this.name, this.opts.alias].some((id) => model === id || model.startsWith(`${id}/`))
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    return versionHealth(this.name, this.opts.bin, this.spawner, undefined, signal)
  }

  private modelOf(model: string): string | null {
    for (const id of [this.name, this.opts.alias]) {
      if (model.startsWith(`${id}/`)) return model.slice(id.length + 1) || null
    }
    return null
  }

  async *chat(req: ChatRequest, session: SessionRecord | null, signal: AbortSignal): AsyncIterable<ChatDelta> {
    assertModeSupported(this.name, req.mode ?? 'byob', ['byob'])
    if ((req.env && Object.keys(req.env).length > 0) || req.effort || req.temperature !== undefined || req.max_tokens !== undefined
      || req.messages.some((message) => typeof message.content !== 'string' && message.content !== null)) {
      throw new BackendError(`${this.name} takes text turns, native resume, AgentProfile instructions and MCP; public env, reasoning and sampling overrides and attachments are not configured`, 'capability_denied')
    }
    const agent = this.opts.agent
    const prompt = flattenMessages(resolvePromptMessages(req, session, this.name))
    const mcp = resolveMcpServers(req, session, { backend: this.name, privateMcpConfig: true })
    signal.throwIfAborted()
    const cwd = resolveSpawnerCwd(this.spawner, req.cwd ?? session?.cwd ?? process.cwd())!
    const dir = await mkdtemp(join(tmpdir(), `cli-bridge-${this.name}-`))
    const turn: OneShotTurn = {
      bin: this.opts.bin, prompt, model: this.modelOf(req.model), cwd, resume: session?.internalId ?? null, sessionKey: req.session_id ?? null,
      mcp: mcp && Object.keys(mcp).length > 0 ? mcp : null, dir,
    }
    let launch: OneShotLaunch | undefined
    let spawned: Awaited<ReturnType<Spawner>> | undefined
    const stop = (): void => { if (spawned) void terminateSpawned(spawned) }
    signal.addEventListener('abort', stop, { once: true })
    try {
      launch = await agent.launch(turn)
      spawned = await this.spawner(this.opts.bin, launch.args, {
        cwd, env: { ...process.env, ...launch.env }, signal, stdio: ['ignore', 'pipe', 'pipe'],
        envPassthroughKeys: [...agent.envPassthroughKeys, ...Object.keys(launch.env ?? {})],
        ...(req.admissionClass ? { admissionClass: req.admissionClass } : {}),
        ...(req.session_id ? { sessionId: req.session_id } : {}),
        ...(req.jailSpec ? { jail: req.jailSpec } : {}),
        ...(req.childLineage ? { lineageEnv: req.childLineage } : {}),
        ...(req.acquireDeadlineMs !== undefined ? { acquireDeadlineMs: req.acquireDeadlineMs } : {}),
      })
      if (signal.aborted) stop()
      const child = spawned.child
      if (!child.stdout) throw new BackendError(`${this.name} stdout unavailable`, 'upstream')
      const stderr = new BoundedDiagnosticBuffer()
      let stderrTail = ''
      const reads: OneShotRead[] = []
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr.append(chunk)
        const text = stderrTail + chunk.toString('utf8')
        const lines = text.split('\n')
        stderrTail = lines.pop() ?? ''
        for (const line of lines) { const read = launch?.stderr?.(line); if (read) reads.push(read) }
      })
      let sessionId = turn.resume
      let identityEmitted = false
      let text = ''
      let lines = 0
      let finalText: string | undefined
      let usage: OneShotRead['usage']
      const take = (read: OneShotRead | null): ChatDelta[] => {
        if (!read) return []
        const out: ChatDelta[] = []
        if (read.sessionId) {
          if (!NATIVE_ID.test(read.sessionId)) throw new BackendError(`${this.name} named an unusable native session id`, 'parse_error')
          if (turn.resume && read.sessionId !== turn.resume) throw new BackendError(`${this.name} changed native session identity`, 'upstream')
          sessionId = read.sessionId
          if (!identityEmitted) { out.push({ internal_session_id: sessionId }); identityEmitted = true }
        }
        if (read.usage) usage = read.usage
        if (read.finalText !== undefined) finalText = read.finalText
        if (read.line !== undefined) {
          const content = lines++ > 0 ? `\n${read.line}` : read.line
          text += content
          if (content) out.push({ content })
        }
        return out
      }
      for await (const next of readProcessLines({ child, stdout: child.stdout, progressIntervalMs: 30_000 })) {
        if (next.kind === 'progress') { yield { keepalive: { source: this.name, elapsedMs: next.elapsedMs } }; continue }
        for (const delta of [...reads.splice(0).flatMap(take), ...take(launch.stdout(next.line))]) yield delta
      }
      if (signal.aborted) { yield { finish_reason: 'error' }; return }
      await assertSuccessfulHarnessExit(spawned, this.name, () => stderr.render())
      if (stderrTail) { const read = launch.stderr?.(stderrTail); if (read) reads.push(read) }
      for (const delta of reads.splice(0).flatMap(take)) yield delta
      for (const delta of take(await launch.after?.({ sessionId, pid: child.pid }) ?? null)) yield delta
      if (!sessionId) throw new BackendError(`${this.name} exited without naming its native session`, 'upstream')
      if (lines === 0 && finalText) { text = finalText; yield { content: finalText } }
      yield { final_text: text, usage: { ...reportedUsage(usage), cost_known: false }, finish_reason: 'stop' }
    } finally {
      signal.removeEventListener('abort', stop)
      if (spawned) { await terminateSpawned(spawned); spawned.release() }
      await launch?.cleanup?.()
      await rm(dir, { recursive: true, force: true })
    }
  }
}

function reportedUsage(usage: OneShotRead['usage']): { input_tokens?: number; output_tokens?: number; estimated?: false } {
  return usage ? { input_tokens: usage.input, output_tokens: usage.output, estimated: false } : {}
}
