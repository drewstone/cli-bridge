/**
 * Gemini CLI backend — spawns Google's official `gemini` CLI.
 *
 * Model id scheme: `gemini/<model>` where `<model>` is passed to
 * `gemini --model <model>`. Bare `gemini` uses the CLI's configured
 * default. The backend is intentionally conservative: it supports BYOB
 * coding-agent execution and rejects hosted-safe/hosted-sandboxed until
 * we verify Gemini's tool-disable and sandbox semantics end-to-end.
 *
 * The Gemini CLI is less stable than Claude/Codex/opencode in its
 * machine-readable output surface, so this backend treats stdout as
 * text and best-effort parses JSONL if a future CLI emits it.
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError, JSON_MODE_DIRECTIVE, wantsJsonObject } from './types.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import { materializeMcpServersForGemini, provisionProfileWorkspace, resolveMcpServers, resolvePromptMessages } from './profile-support.js'
import { contentToText } from './content.js'
import { hostSpawner } from '../executors/host.js'
import type { Spawner } from '../executors/types.js'
import { versionHealth } from './health.js'
import { readProcessLines, waitForProcessClose } from './process-lines.js'
import { writeStdinPayload } from './stdin-payload.js'
import { killTree } from '../executors/process-tree.js'

export interface GeminiBackendOptions {
  bin: string
  timeoutMs: number
  /** Subprocess spawner. Defaults to host spawn; pass a docker-pooled spawner for parallel-safe execution. */
  spawner?: Spawner
}

export class GeminiBackend implements Backend {
  readonly name = 'gemini'
  private readonly spawner: Spawner

  constructor(private readonly opts: GeminiBackendOptions) {
    this.spawner = opts.spawner ?? hostSpawner
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'gemini' || m.startsWith('gemini/')
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
      'gemini hosted modes require a verified tool-disable and sandbox contract')

    const prompt = this.buildPrompt(req, session)
    const model = this.extractModel(req.model)
    const args = this.buildArgs(req.model)
    if (model) args.push('--model', model)
    const cwd = req.cwd ?? session?.cwd ?? process.cwd()

    // Materialize MCP servers (request-body `mcp.mcpServers` ∪
    // `agent_profile.mcp`) into the project-scope `<cwd>/.gemini/settings.json`.
    // Gemini CLI has no per-invocation MCP flag — it discovers MCP by cwd,
    // layering the project settings over the user's global ones. Cleanup in
    // the outer finally restores the workspace so it never leaks. Fail-loud:
    // a symlink/lock violation throws rather than silently dropping MCP.
    const mcpMaterialized = materializeMcpServersForGemini(resolveMcpServers(req, session), cwd)

    // Phase-2 host wiring: provision cwd-native profile dimensions before spawn. Fail-safe.
    provisionProfileWorkspace(req, session, 'gemini', cwd)
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
      let stderr = ''
      let emittedContent = false
      let emittedToolCall = false
      child.stderr?.on('data', (b) => { stderr += b.toString() })
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
          if (type.toLowerCase().includes('error') || parsed.error) {
            sawError = String(
              parsed.message
              ?? (parsed.error as Record<string, unknown> | undefined)?.message
              ?? 'gemini error',
            )
            continue
          }
          const text = extractText(parsed)
          if (text) {
            yield { content: text }
            emittedContent = true
          }
          const toolCall = extractToolCall(parsed)
          if (toolCall) {
            yield { tool_calls: [toolCall] }
            emittedToolCall = true
          }
          if (type === 'completed' || type === 'turn.completed' || type === 'result') {
            yield { finish_reason: sawError ? 'error' : (emittedToolCall ? 'tool_calls' : 'stop') }
            return
          }
        } else {
          yield { content: `${line}\n` }
          emittedContent = true
        }
      }

      const exitCode = await waitForProcessClose(child)
      if (signal.aborted) {
        yield { finish_reason: 'error' }
        return
      }
      if (sawError) throw new BackendError(`gemini: ${sawError}`, 'upstream')
      if (exitCode !== 0 && exitCode !== null) {
        throw new BackendError(`gemini exited ${exitCode}: ${stderr.slice(0, 300)}`, 'upstream')
      }
      if (!emittedContent && !emittedToolCall) {
        throw new BackendError(`gemini produced no output: ${stderr.slice(0, 300)}`, 'upstream')
      }
      yield { finish_reason: emittedToolCall ? 'tool_calls' : 'stop' }
    } finally {
      clearTimeout(timeoutHandle)
      signal.removeEventListener('abort', onAbort)
      await killTree(child)
      releaseSpawner()
      mcpMaterialized?.cleanup()
    }
  }

  buildPrompt(req: ChatRequest, session: SessionRecord | null): string {
    const flat = this.flattenPrompt(resolvePromptMessages(req, session))
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
  const name = holder.name ?? holder.tool ?? (holder.function as Record<string, unknown> | undefined)?.name
  if (typeof name !== 'string' || !name) return null
  const rawArgs =
    holder.args
    ?? holder.arguments
    ?? holder.input
    ?? (holder.function as Record<string, unknown> | undefined)?.arguments
    ?? {}
  const id = String(holder.id ?? holder.callId ?? holder.call_id ?? `${name}-${Math.random().toString(36).slice(2, 10)}`)
  return {
    id,
    name,
    arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs),
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
