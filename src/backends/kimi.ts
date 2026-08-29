/**
 * Kimi CLI backend — Moonshot's own coding CLI.
 *
 * Kimi Code's prompt mode uses `--prompt X` for non-interactive calls,
 * `--session <id>` for session resume, `--model` for model selection,
 * and `--output-format stream-json` for JSONL. We parse those events
 * into OpenAI chat deltas.
 *
 * Model id scheme: `<harness>/<model>` where `<harness>` defaults to
 * `kimi-code` (the product name Moonshot ships the CLI under) and
 * `<model>` is what Kimi CLI accepts (e.g., `kimi-for-coding`,
 * `kimi-k2.6`, or the CLI's configured default if the model is
 * omitted).
 *
 * Why Kimi CLI over opencode + opencode-kimi-full:
 *   - Official Moonshot client — Moonshot's server-side gate lists
 *     "Kimi CLI" as an allowed coding agent by name
 *   - Native OAuth + the right headers, no plugin plumbing
 *   - Non-interactive mode + stream-json are first-class, not bolted on
 *
 * Event shapes we parse (from `kimi --prompt X --output-format stream-json`):
 *   - system/version events carry metadata
 *   - assistant events with string or block content
 *   - tool-use events
 *   - result / completion events with usage when emitted
 *   - error events
 *
 * The exact field names vary — we defensively pull content from the
 * common ones (`content`, `text`, `message.content`, `delta.text`).
 */

import { type AgentProfile, nativeReasoningControl } from '@tangle-network/agent-interface'
import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { versionHealth } from './health.js'
import { BackendError, JSON_MODE_DIRECTIVE, terminalOutcome, wantsJsonObject } from './types.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import {
  materializeMcpServersForKimi,
  profileExecutionIdentity,
  provisionProfileWorkspace,
  resolveMcpServers,
  resolvePromptMessages,
  resolveRequestedReasoningEffort,
} from './profile-support.js'
import { contentToText } from './content.js'
import { scopedHostSpawner } from '../executors/scoped-host.js'
import { describeCliExit, resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import { readProcessLines, waitForProcessClose } from './process-lines.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'
import { terminateSpawned } from '../executors/process-tree.js'

export interface KimiBackendOptions {
  bin: string
  timeoutMs: number
  /** Harness name that claims the `<harness>/*` prefix. Default 'kimi-code'. */
  harness?: string
  /** Subprocess spawner. Defaults to host spawn; pass a docker-pooled spawner for parallel-safe execution. */
  spawner?: Spawner
}

export class KimiBackend implements Backend {
  readonly name: string
  readonly defaultExecutionTimeoutMs: number
  private readonly prefix: string
  private readonly spawner: Spawner

  constructor(private readonly opts: KimiBackendOptions) {
    this.name = opts.harness ?? 'kimi-code'
    this.defaultExecutionTimeoutMs = opts.timeoutMs
    this.prefix = `${this.name}/`
    this.spawner = opts.spawner ?? scopedHostSpawner
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === this.name || m.startsWith(this.prefix)
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
      'kimi hosted-safe requires a verified tool-disable flag path on kimi-cli')

    // Kimi Code 0.36.1 exposes prompt mode through argv. It does not
    // implement Claude's structured stdin mode, so keep the prompt in
    // the one supported `--prompt` argument.
    const prompt = this.buildPrompt(req, session)
    const model = this.resolveCliModel(req.model)

    // Reject unsupported profile plans before creating either temporary
    // Kimi config. Both files can contain provider or MCP credentials.
    const thinkingFlag = nativeReasoningControl(
      'kimi-code',
      resolveRequestedReasoningEffort(req, session),
    )
    const provisioned = provisionProfileWorkspace(
      req,
      session,
      'kimi-code',
      cwd,
      profileExecutionIdentity(req, session, 'kimi-code', thinkingFlag),
    )

    const args = ['--prompt', prompt, '--output-format', 'stream-json']
    if (session?.internalId) {
      args.push('--session', session.internalId)
    }
    if (model) {
      args.push('--model', model)
    }
    if (thinkingFlag) args.push(thinkingFlag)
    args.push(...provisioned.flags)

    let mcpMaterialized: ReturnType<typeof materializeMcpServersForKimi> = null
    let spawned: Awaited<ReturnType<Spawner>>
    try {
      // Kimi Code discovers request-scoped MCP from the project-local
      // `<cwd>/.kimi-code/mcp.json`; the mount restores the original file
      // after this process exits and serializes overlapping runs.
      mcpMaterialized = materializeMcpServersForKimi(resolveMcpServers(req, session), cwd)

      spawned = await this.spawner(this.opts.bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
        env: { ...process.env, ...provisioned.env },
        ...(req.session_id ? { sessionId: req.session_id } : {}),
        ...(req.jailSpec ? { jail: req.jailSpec } : {}),
        ...(req.acquireDeadlineMs !== undefined ? { acquireDeadlineMs: req.acquireDeadlineMs } : {}),
        ...(req.admissionClass ? { admissionClass: req.admissionClass } : {}),
      })
    } catch (error) {
      mcpMaterialized?.cleanup()
      throw error
    }
    const child = spawned.child
    const releaseSpawner = spawned.release

    // The spawner registers a synchronous 'error' listener so the spawn
    // failure event doesn't crash the process before our own listener
    // can attach. We consult the captured value here (and double-attach
    // for safety against future spawner refactors).
    let spawnErrorMessage = ''
    child.on('error', (err) => { spawnErrorMessage = err.message })
    const earlySpawnError = spawned.spawnError?.()
    if (earlySpawnError) spawnErrorMessage = earlySpawnError.message

    // Tear down the whole process group (kimi + every tool/MCP subprocess
    // it forks). See backends/opencode.ts for the rationale.
    const onAbort = (): void => { void terminateSpawned(spawned) }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      let internalSessionId: string | undefined
      const stderr = new BoundedDiagnosticBuffer()
      let emittedContent = false
      let emittedToolCall = false
      if (spawnErrorMessage) {
        throw new BackendError(`kimi spawn failed: ${spawnErrorMessage}`, 'upstream')
      }
      if (!child.stdout) {
        throw new BackendError('kimi subprocess has no stdout pipe', 'upstream')
      }
      child.stderr?.on('data', (b) => {
        const chunk = b.toString()
        stderr.append(chunk)
        // Older Kimi builds printed a resume hint to stderr. Keep
        // accepting that hint when a compatible executor supplies it.
        if (!internalSessionId) {
          const m = chunk.match(/kimi\s+(?:-r|--session)\s+([0-9a-f-]{8,})/i)
          if (m) internalSessionId = m[1]
        }
      })

      let sawError: string | null = null

      const progressIntervalMs = Math.max(10, Number(process.env.KIMI_PROGRESS_MS ?? 30_000))

      for await (const next of readProcessLines({ child, stdout: child.stdout, progressIntervalMs })) {
        if (next.kind === 'progress') {
          // Subprocess liveness signal — kimi has emitted no stdout for
          // `progressIntervalMs` and may be doing internal think work
          // (stream-json is buffered). Yield as keepalive so the SSE
          // writer renders an SSE comment that keeps the socket alive
          // without injecting a fake OpenAI tool_call into the response.
          // See ChatDelta.keepalive (backends/types.ts) for the contract.
          yield {
            keepalive: { source: 'kimi', elapsedMs: next.elapsedMs },
          }
          continue
        }

        const line = next.line
        if (!line.trim()) continue
        let ev: Record<string, unknown>
        try { ev = JSON.parse(line) as Record<string, unknown> } catch { continue }

        // Session id comes in on an init-flavored event.
        const sessId = pickSessionId(ev)
        if (sessId && !internalSessionId) {
          internalSessionId = sessId
          yield { internal_session_id: internalSessionId }
        }

        const type = String(ev.type ?? ev.event ?? '')
        if (type.toLowerCase().includes('error') || ev.error) {
          sawError = String(
            ev.message
            ?? (ev.error as Record<string, unknown> | undefined)?.message
            ?? 'kimi error',
          )
          continue
        }

        // Kimi's event shape for assistant output is either a top-level
        // string or a block array:
        //   {"role":"assistant","content":"answer"}
        //   {"role":"assistant","content":[{"type":"text","text":"answer"}]}
        // Walk the content array block-by-block — matches how we handle
        // Claude Code's stream-json. Generic extractText is a fallback
        // for events whose content is just a string.
        const role = String(ev.role ?? '').toLowerCase()
        const contentField = ev.content
        if (role === 'assistant' && Array.isArray(contentField)) {
          for (const block of contentField as Array<Record<string, unknown>>) {
            if (!block || typeof block !== 'object') continue
            const blockType = String(block.type ?? '')
            if (blockType === 'text' && typeof block.text === 'string' && block.text) {
              yield { content: block.text }
              emittedContent = true
            } else if (blockType === 'tool_use') {
              const id = String(block.id ?? block.tool_use_id ?? '')
              const name = String(block.name ?? block.tool ?? '')
              const input = block.input ?? {}
              if (id && name) {
                yield {
                  tool_calls: [{
                    id,
                    name,
                    arguments: typeof input === 'string' ? input : JSON.stringify(input),
                  }],
                }
                emittedToolCall = true
              }
            }
            // 'think' blocks are reasoning chain-of-thought; don't surface.
          }
          // Some Kimi builds emit agentic tool calls in a TOP-LEVEL `tool_calls` field
          // (OpenAI shape: [{type:'function', id, function:{name, arguments}}]), NOT
          // as `tool_use` blocks inside content. Without surfacing them, every
          // tool-call turn — whose content is just a `think` block — yields nothing,
          // so a consumer's idle-cap fires before the agent ever emits a text block:
          // the agentic-streaming dead-air bug (#50). Map to the same flat shape.
          if (Array.isArray(ev.tool_calls)) {
            for (const tc of ev.tool_calls as Array<Record<string, unknown>>) {
              if (!tc || typeof tc !== 'object') continue
              const fn = (tc.function ?? {}) as Record<string, unknown>
              const id = String(tc.id ?? '')
              const name = String(fn.name ?? tc.name ?? '')
              const rawArgs = fn.arguments ?? tc.arguments ?? {}
              if (id && name) {
                yield {
                  tool_calls: [{
                    id,
                    name,
                    arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs),
                  }],
                }
                emittedToolCall = true
              }
            }
          }
        } else if (role === '' || role === 'assistant') {
          const text = extractText(ev)
          if (text) {
            yield { content: text }
            emittedContent = true
          }
          const toolCall = extractToolUse(ev)
          if (toolCall) { yield { tool_calls: [toolCall] }; emittedToolCall = true }
        }

        if (
          type === 'result'
          || type === 'turn.completed'
          || type === 'session.completed'
          || type === 'completed'
        ) {
          const usage = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined
          yield {
            ...terminalOutcome('kimi', sawError, emittedToolCall),
            usage,
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
      if (sawError) throw new BackendError(`kimi: ${sawError}`, 'upstream')
      // If Kimi reports a non-zero exit after assistant content, preserve
      // the content because the process did complete a useful turn.
      if (exitCode !== 0 && exitCode !== null && !emittedContent) {
        throw new BackendError(await describeCliExit(spawned, 'kimi', exitCode, stderr.render()), 'upstream')
      }
      if (!emittedContent && !emittedToolCall) {
        throw new BackendError(`kimi produced no stream output: ${stderr.render(300)}`, 'upstream')
      }
      yield { finish_reason: emittedToolCall ? 'tool_calls' : 'stop', internal_session_id: internalSessionId }
    } finally {
      signal.removeEventListener('abort', onAbort)
      // Always tear down the whole subtree (kimi + any MCP/tool forks)
      // before releasing the slot. Idempotent; waits for actual exit.
      await terminateSpawned(spawned)
      mcpMaterialized?.cleanup()
      releaseSpawner()
    }
  }

  /**
   * Build the final prompt text passed to `kimi --prompt`. Kimi
   * CLI has no `--append-system-prompt` equivalent and no native
   * json-mode flag, so when the caller asks for `json_object` we
   * prepend the directive to the user prompt. Best-effort — clients
   * should still strip markdown fences as a fallback.
   *
   * Exposed (not private) so tests can verify the prefix without
   * spawning a real subprocess.
   */
  buildPrompt(req: ChatRequest, session: SessionRecord | null): string {
    const flat = this.flattenPrompt(resolvePromptMessages(req, session, 'kimi-code'))
    const preambles: string[] = []
    if (wantsJsonObject(req)) preambles.push(JSON_MODE_DIRECTIVE)
    return preambles.length > 0 ? `${preambles.join('\n\n')}\n\n${flat}` : flat
  }

  /** Exposed so tests can verify when the backend omits `--model`. */
  resolveCliModel(fullModel: string): string | null {
    const lower = fullModel.toLowerCase()
    if (lower === this.name) return null

    // Kimi Code's config.toml uses `<provider>/<model>` as the literal
    // key (for example `kimi-code/kimi-for-coding`). Pass every qualified
    // model through, including aliases that the local config may reject.
    // Omitting an explicit model for such an alias would silently run the
    // configured default instead.
    if (lower.startsWith(this.prefix)) return fullModel
    return null
  }

  private flattenPrompt(messages: ChatRequest['messages']): string {
    if (messages.length === 1) return contentToText(messages[0]?.content ?? '')
    return messages.map((m) => `[${m.role}] ${contentToText(m.content)}`).join('\n\n')
  }
}

function pickSessionId(ev: Record<string, unknown>): string | null {
  for (const k of ['session_id', 'sessionId', 'session', 'id']) {
    const v = ev[k]
    if (typeof v === 'string' && v.length > 0) return v
    if (typeof v === 'object' && v !== null) {
      const id = (v as Record<string, unknown>).id
      if (typeof id === 'string' && id.length > 0) return id
    }
  }
  return null
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

function extractToolUse(ev: Record<string, unknown>): { id: string; name: string; arguments: string } | null {
  const type = String(ev.type ?? '').toLowerCase()
  if (!type.includes('tool')) return null
  const id = String(ev.id ?? ev.tool_use_id ?? '')
  const name = String(ev.name ?? ev.tool ?? '')
  const input = ev.input ?? ev.arguments ?? {}
  if (!id || !name) return null
  return { id, name, arguments: typeof input === 'string' ? input : JSON.stringify(input) }
}
