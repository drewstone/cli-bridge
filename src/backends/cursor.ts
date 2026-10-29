/** Cursor's local CLI owns the chat store; the bridge persists only its opaque resume ID. */
import type { Backend, BackendHealth, ChatDelta, ChatRequest } from './types.js'
import { BackendError, JSON_MODE_DIRECTIVE, wantsJsonObject } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import { assertModeSupported } from '../modes.js'
import { hostSpawner } from '../executors/host.js'
import { resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import { terminateSpawned } from '../executors/process-tree.js'
import { versionHealth } from './health.js'
import { flattenMessages } from './content.js'
import { resolveMcpServers } from './profile-mcp.js'
import { admitNativeSubscription } from './profile-support.js'
import { assertSuccessfulHarnessExit, readProcessLines } from './process-lines.js'
import { writeStdinPayload } from './stdin-payload.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'
import { cursorEnvironment } from '../lib/cursor-auth.js'

export class CursorBackend implements Backend {
  readonly name = 'cursor'
  readonly defaultExecutionTimeoutMs: number
  private readonly spawner: Spawner

  constructor(private readonly opts: { bin: string; timeoutMs: number; spawner?: Spawner }) {
    this.defaultExecutionTimeoutMs = opts.timeoutMs
    this.spawner = opts.spawner ?? hostSpawner
  }

  matches(model: string): boolean { return model === 'cursor' || model.startsWith('cursor/') }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    return versionHealth(this.name, this.opts.bin, this.spawner, undefined, signal)
  }

  async *chat(req: ChatRequest, session: SessionRecord | null, signal: AbortSignal): AsyncIterable<ChatDelta> {
    assertModeSupported(this.name, req.mode ?? 'byob', ['byob'])
    if (req.agent_profile || session?.metadata.agent_profile || resolveMcpServers(req, session)
      || req.effort || req.temperature !== undefined || req.max_tokens !== undefined || req.messages.some((message) => typeof message.content !== 'string' && message.content !== null)) {
      throw new BackendError('Cursor CLI supports text turns and native resume; exact profiles, MCP, reasoning overrides and attachments are not configured', 'capability_denied')
    }
    signal.throwIfAborted()
    const cwd = resolveSpawnerCwd(this.spawner, req.cwd ?? session?.cwd ?? process.cwd())!
    // Both cwd and --workspace name this invocation's workspace. --trust is explicit and scoped to that workspace.
    const args = ['-p', '--output-format', 'stream-json', '--trust', '--workspace', cwd]
    const model = req.model.slice('cursor/'.length)
    if (req.model !== 'cursor' && model && model !== 'default') args.push('--model', model)
    if (session?.internalId) args.push('--resume', session.internalId)
    const env = await cursorEnvironment(process.env)
    await admitNativeSubscription(req, { env, args, flags: [], cwd, model: req.model, executor: this.spawner.executionEnvironment })
    const spawned = await this.spawner(this.opts.bin, args, {
      cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'],
      ...(req.session_id ? { sessionId: req.session_id } : {}),
      ...(req.jailSpec ? { jail: req.jailSpec } : {}),
      ...(req.childLineage ? { lineageEnv: req.childLineage } : {}),
      ...(req.acquireDeadlineMs !== undefined ? { acquireDeadlineMs: req.acquireDeadlineMs } : {}),
    })
    const onAbort = (): void => { void terminateSpawned(spawned) }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    const stderr = new BoundedDiagnosticBuffer()
    spawned.child.stderr?.on('data', (bytes) => stderr.append(bytes))
    try {
      if (!spawned.child.stdout || !spawned.child.stdin) throw new BackendError('Cursor CLI pipes unavailable', 'upstream')
      const prompt = flattenMessages(req.messages)
      const written = await writeStdinPayload(spawned.child.stdin, [{ role: 'user', content: wantsJsonObject(req) ? `${JSON_MODE_DIRECTIVE}\n\n${prompt}` : prompt }], { format: 'raw' })
      if (!written.ok) throw new BackendError('Cursor stdin write failed', 'upstream')
      let terminal: Record<string, unknown> | undefined
      let text = ''
      let nativeId = session?.internalId
      let identityEmitted = false
      for await (const next of readProcessLines({ child: spawned.child, stdout: spawned.child.stdout, progressIntervalMs: 30_000 })) {
        if (next.kind === 'progress') { yield { keepalive: { source: 'cursor', elapsedMs: next.elapsedMs } }; continue }
        if (!next.line.trim()) continue
        let event: Record<string, any>
        try { event = JSON.parse(next.line) } catch { throw new BackendError('Cursor emitted invalid stream JSON', 'parse_error') }
        if (typeof event.session_id === 'string' && event.session_id) {
          if (nativeId && nativeId !== event.session_id) throw new BackendError('Cursor changed native session identity', 'upstream')
          nativeId = event.session_id
          if (!identityEmitted) { yield { internal_session_id: nativeId }; identityEmitted = true }
        }
        if (event.type === 'assistant') {
          const content = (event.message?.content ?? []).filter((part: any) => part.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('')
          if (content) { text += content; yield { content, final_text: text } }
        } else if (event.type === 'thinking' && event.subtype === 'delta' && typeof event.text === 'string') {
          yield { reasoning: event.text }
        } else if (event.type === 'tool_call' && event.subtype === 'started') {
          for (const [name, call] of Object.entries(event.tool_call ?? {}) as [string, any][]) {
            yield { tool_calls: [{ id: String(event.call_id), name, arguments: JSON.stringify(call.args ?? {}) }] }
          }
        } else if (event.type === 'result') terminal = event
        else if (event.type === 'error' || event.error) throw new BackendError('Cursor reported a stream error', 'upstream')
      }
      if (signal.aborted) { yield { finish_reason: 'error' }; return }
      await assertSuccessfulHarnessExit(spawned, 'cursor', () => stderr.render())
      if (!nativeId || !terminal || terminal.is_error !== false || terminal.subtype !== 'success') {
        throw new BackendError('Cursor exited without a successful terminal result and native session ID', 'upstream')
      }
      // Cursor's final result is authoritative; it can aggregate several assistant messages.
      if (typeof terminal.result === 'string') yield { final_text: terminal.result, ...(text ? {} : { content: terminal.result }) }
      const usage = terminal.usage as Record<string, unknown> | undefined
      const counts = usage && Number.isSafeInteger(usage.inputTokens) && Number.isSafeInteger(usage.outputTokens)
        && Number(usage.inputTokens) >= 0 && Number(usage.outputTokens) >= 0
        ? { input_tokens: Number(usage.inputTokens), output_tokens: Number(usage.outputTokens), estimated: false } : {}
      yield { usage: { ...counts, cost_known: false }, finish_reason: 'stop' }
    } finally {
      signal.removeEventListener('abort', onAbort)
      await terminateSpawned(spawned)
      spawned.release()
    }
  }
}
