/**
 * Factory Droid backend — drives Factory's `droid exec` in non-interactive
 * mode and translates its stream-json event stream to OpenAI chat deltas.
 *
 * Model id scheme: `factory/<model>` where `<model>` is a Droid model id
 * (`claude-opus-4-8`, `gpt-5`, …). Bare `factory` / `factory/default`
 * uses Droid's configured default. Auth is resolved by the CLI itself —
 * `FACTORY_API_KEY` or the persisted subscription credentials in
 * `~/.factory`; the backend does not gate on a specific method so a
 * subscription-authed host still works.
 *
 * MCP: Droid has no per-invocation MCP flag and reads a FIXED config, but
 * it ALSO discovers a PROJECT-SCOPED `<cwd>/.factory/mcp.json` (verified
 * against the CLI's config-path resolution). We write requested servers
 * there via `materializeMcpServersForFactory`, which merges (never
 * clobbers) and restores on cleanup, so the user's own `~/.factory/mcp.json`
 * is untouched.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import { materializeMcpServersForFactory, resolveMcpServers, resolvePromptMessages } from './profile-support.js'
import { contentToText } from './content.js'
import { hostSpawner } from '../executors/host.js'
import type { Spawner } from '../executors/types.js'
import { versionHealth } from './health.js'
import { readProcessLines, waitForProcessClose } from './process-lines.js'
import { killTree } from '../executors/process-tree.js'

export interface FactoryBackendOptions {
  bin: string
  timeoutMs: number
  /** Subprocess spawner. Defaults to host spawn; pass a docker-pooled spawner for parallel-safe execution. */
  spawner?: Spawner
}

export class FactoryBackend implements Backend {
  readonly name = 'factory'
  private readonly spawner: Spawner
  constructor(private readonly opts: FactoryBackendOptions) {
    this.spawner = opts.spawner ?? hostSpawner
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'factory' || m.startsWith('factory/')
  }

  async health(): Promise<BackendHealth> {
    return versionHealth(this.name, this.opts.bin, this.spawner)
  }

  async *chat(
    req: ChatRequest,
    session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    assertModeSupported(this.name, req.mode ?? 'byob', ['byob'],
      'factory hosted modes require a verified tool-disable and sandbox contract')

    const prompt = this.flattenPrompt(resolvePromptMessages(req, session))
    const model = this.extractModel(req.model)
    const cwd = req.cwd ?? session?.cwd ?? process.cwd()

    // Prompt via `-f <file>` rather than argv: `droid exec` reads the
    // prompt from a file, which sidesteps the Linux MAX_ARG_STRLEN
    // (128 KiB) limit that a long system prompt would blow through on the
    // positional-arg path.
    const promptDir = mkdtempSync(join(tmpdir(), 'cli-bridge-droid-'))
    const promptFile = join(promptDir, 'prompt.txt')
    writeFileSync(promptFile, prompt)

    const args = ['exec', '--output-format', 'stream-json', '--auto', droidAutonomy(), '-f', promptFile]
    if (model) args.push('-m', model)
    if (session?.internalId) args.push('-s', session.internalId)

    // Materialize MCP into the project-scope `<cwd>/.factory/mcp.json`
    // (merges + restores, never clobbers the user's global config).
    const mcpMaterialized = materializeMcpServersForFactory(resolveMcpServers(req, session), cwd)

    const spawned = await this.spawner(this.opts.bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: process.env,
      ...(req.session_id ? { sessionId: req.session_id } : {}),
      ...(req.jailSpec ? { jail: req.jailSpec } : {}),
    })
    const child = spawned.child
    const releaseSpawner = spawned.release

    let spawnErrorMessage = ''
    child.on('error', (err) => { spawnErrorMessage = err.message })
    const earlySpawnError = spawned.spawnError?.()
    if (earlySpawnError) spawnErrorMessage = earlySpawnError.message

    const timeoutHandle = setTimeout(() => { void killTree(child) }, this.opts.timeoutMs)
    const onAbort = (): void => { void killTree(child) }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      let internalSessionId: string | undefined
      let stderr = ''
      let emittedContent = false
      let emittedToolCall = false
      let sawError: string | null = null
      child.stderr?.on('data', (b) => { stderr += b.toString() })
      if (spawnErrorMessage) {
        throw new BackendError(`factory spawn failed: ${spawnErrorMessage}`, 'upstream')
      }
      if (!child.stdout) {
        throw new BackendError('factory subprocess has no stdout pipe', 'upstream')
      }

      const progressIntervalMs = Math.max(10, Number(process.env.FACTORY_PROGRESS_MS ?? 30_000))

      for await (const next of readProcessLines({ child, stdout: child.stdout, progressIntervalMs })) {
        if (next.kind === 'progress') {
          yield { keepalive: { source: 'factory', elapsedMs: next.elapsedMs } }
          continue
        }
        const line = next.line
        if (!line.trim()) continue
        let ev: Record<string, unknown>
        try { ev = JSON.parse(line) as Record<string, unknown> } catch { continue }

        const type = String(ev.type ?? '')
        const sessId = ev.session_id ?? ev.sessionId
        if (typeof sessId === 'string' && sessId && !internalSessionId) {
          internalSessionId = sessId
          yield { internal_session_id: internalSessionId }
        }

        if (type === 'error') {
          sawError = String(ev.message ?? 'droid error')
          continue
        }

        // Assistant text — droid emits `{type:'message', role:'assistant', text}`.
        // Skip the `role:'user'` echo of our own prompt.
        if (type === 'message' && ev.role === 'assistant') {
          const text = extractMessageText(ev)
          if (text) { yield { content: text }; emittedContent = true }
        }
        const toolCall = extractToolCall(ev)
        if (toolCall) { yield { tool_calls: [toolCall] }; emittedToolCall = true }

        if (type === 'result') {
          yield {
            finish_reason: sawError ? 'error' : (emittedToolCall ? 'tool_calls' : 'stop'),
            internal_session_id: internalSessionId,
          }
          return
        }
      }

      const exitCode = await waitForProcessClose(child)
      if (signal.aborted) {
        yield { finish_reason: 'error', internal_session_id: internalSessionId }
        return
      }
      if (sawError) throw new BackendError(`factory: ${sawError}`, 'upstream')
      if (exitCode !== 0 && exitCode !== null) {
        throw new BackendError(`factory (droid exec) exited ${exitCode}: ${stderr.slice(0, 300)}`, 'upstream')
      }
      if (!emittedContent && !emittedToolCall) {
        throw new BackendError(`factory produced no output: ${stderr.slice(0, 300)}`, 'upstream')
      }
      yield { finish_reason: emittedToolCall ? 'tool_calls' : 'stop', internal_session_id: internalSessionId }
    } finally {
      clearTimeout(timeoutHandle)
      signal.removeEventListener('abort', onAbort)
      await killTree(child)
      releaseSpawner()
      mcpMaterialized?.cleanup()
      try { rmSync(promptDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  }

  private flattenPrompt(messages: ChatRequest['messages']): string {
    if (messages.length === 1) return contentToText(messages[0]?.content ?? '')
    return messages.map((m) => `[${m.role}] ${contentToText(m.content)}`).join('\n\n')
  }

  private extractModel(fullModel: string): string | null {
    const lower = fullModel.toLowerCase()
    if (lower === 'factory') return null
    if (lower.startsWith('factory/')) {
      const rest = fullModel.slice('factory/'.length)
      return rest.length > 0 && rest !== 'default' ? rest : null
    }
    return null
  }
}

/** Droid autonomy level for headless runs. `high` unblocks file+dev ops; env-overridable. */
function droidAutonomy(): string {
  const raw = process.env.FACTORY_AUTO?.trim()
  return raw === 'low' || raw === 'medium' || raw === 'high' ? raw : 'high'
}

function extractMessageText(ev: Record<string, unknown>): string | null {
  if (typeof ev.text === 'string' && ev.text.length > 0) return ev.text
  // Some events carry a content-parts array; concatenate its text parts.
  const content = ev.content
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => (p && typeof p === 'object' && typeof (p as Record<string, unknown>).text === 'string'
        ? (p as Record<string, unknown>).text as string
        : ''))
      .filter(Boolean)
    if (parts.length) return parts.join('')
  }
  if (typeof content === 'string' && content.length > 0) return content
  return null
}

function extractToolCall(ev: Record<string, unknown>): { id: string; name: string; arguments: string } | null {
  const type = String(ev.type ?? '')
  const holder =
    (ev.tool_call as Record<string, unknown> | undefined)
    ?? (ev.toolCall as Record<string, unknown> | undefined)
    ?? (/tool_(call|use)/i.test(type) ? ev : undefined)
  if (!holder) return null
  const name = holder.name ?? holder.tool
  if (typeof name !== 'string' || !name) return null
  const rawArgs = holder.args ?? holder.arguments ?? holder.input ?? {}
  const id = String(holder.id ?? holder.tool_call_id ?? holder.callId ?? `${name}-${Math.random().toString(36).slice(2, 10)}`)
  return { id, name, arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs) }
}
