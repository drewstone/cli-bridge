/**
 * Pi CLI backend — `pi --print --mode json` from @mariozechner/pi-coding-agent.
 *
 * Pi is a multi-provider coding agent (anthropic / openai / google / deepseek /
 * moonshot / zai-glm / custom-extension providers). The bridge fronts it the
 * same way it fronts opencode/kimi: spawn the CLI per-request, translate the
 * NDJSON event stream to OpenAI chat deltas.
 *
 * Model id scheme: `pi/<provider>/<model>` — callers select pi as the harness
 * and a provider+model registered in pi's settings (see `pi --list-models`).
 * `pi/<model>` (no provider) routes through pi's default provider.
 *
 * Auth: pi reads `<PROVIDER>_API_KEY` env vars itself; the bridge inherits
 * `process.env` into the subprocess. ZAI_GLM_API_KEY, DEEPSEEK_API_KEY,
 * MOONSHOT_API_KEY etc. must be set in the bridge's environment (sourced
 * via the kick-script's `.env` chain).
 *
 * Event shapes we parse (from `pi --print --mode json`):
 *
 *   {"type":"session","id":"<uuid>",...}
 *   {"type":"agent_start"}
 *   {"type":"turn_start"}
 *   {"type":"message_update","assistantMessageEvent":{
 *      "type":"thinking_delta"|"text_delta"|"tool_call_start"|...,
 *      "delta":"...", "contentIndex":N, ... }}
 *   {"type":"turn_end","usage":{...}}
 *   {"type":"agent_end"}
 *
 * We currently surface text_delta as ChatDelta.content; thinking_delta is
 * dropped (matches how the kimi backend handles its `think` blocks for
 * non-thinking-aware callers). tool_call events are emitted as keepalives
 * for now — full tool-call mapping is a follow-up since pi's native tools
 * (read/bash/edit/write) execute INSIDE the CLI loop and don't need
 * OpenAI-tool-call round-trips through the bridge.
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import { resolvePromptMessages } from './profile-support.js'
import { contentToText } from './content.js'
import { hostSpawner } from '../executors/host.js'
import type { Spawner } from '../executors/types.js'
import { readProcessLines, waitForProcessClose } from './process-lines.js'
import { killTree } from '../executors/process-tree.js'

export interface PiBackendOptions {
  bin: string
  timeoutMs: number
  /** Subprocess spawner. Defaults to host. */
  spawner?: Spawner
}

/** `pi/<provider>/<model>` or `pi/<model>` (default provider). */
interface PiModelSpec {
  provider?: string
  model?: string
}

function parsePiModelId(model: string): PiModelSpec {
  const m = model.toLowerCase()
  if (m === 'pi') return {}
  if (!m.startsWith('pi/')) return {}
  const rest = model.slice(3) // preserve original case for the model id
  const slash = rest.indexOf('/')
  if (slash === -1) return { model: rest }
  return { provider: rest.slice(0, slash), model: rest.slice(slash + 1) }
}

/** Map ReasoningEffort to pi's `--thinking` flag. */
function thinkingFlagForEffort(effort?: string): string | null {
  if (!effort) return null
  // pi accepts: off | minimal | low | medium | high | xhigh
  const allowed = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
  const e = effort === 'max' ? 'xhigh' : effort
  return allowed.has(e) ? e : null
}

export class PiBackend implements Backend {
  readonly name = 'pi'
  private readonly spawner: Spawner

  constructor(private readonly opts: PiBackendOptions) {
    this.spawner = opts.spawner ?? hostSpawner
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'pi' || m.startsWith('pi/')
  }

  async health(): Promise<BackendHealth> {
    let release = (): void => {}
    try {
      const spawned = await this.spawner(this.opts.bin, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      release = spawned.release
      const child = spawned.child
      return await new Promise<BackendHealth>((resolve) => {
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (b) => { stdout += b.toString() })
        child.stderr?.on('data', (b) => { stderr += b.toString() })
        child.on('error', (err) => {
          resolve({ name: this.name, state: 'unavailable', detail: `spawn failed: ${err.message}` })
        })
        child.on('close', (code) => {
          if (code === 0) {
            resolve({ name: this.name, state: 'ready', version: stdout.trim() || undefined })
          } else {
            resolve({ name: this.name, state: 'error', detail: `exit ${code}: ${stderr.slice(0, 200)}` })
          }
        })
      })
    } catch (err) {
      return { name: this.name, state: 'unavailable', detail: (err as Error).message }
    } finally {
      release()
    }
  }

  async *chat(
    req: ChatRequest,
    session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    assertModeSupported(this.name, req.mode ?? 'byob', ['byob'],
      'pi has native tools (read/bash/edit/write); hosted-safe requires a verified --no-tools enforcement path')

    const spec = parsePiModelId(req.model)
    const prompt = this.buildPrompt(req)

    const args: string[] = [
      '--print',
      '--mode', 'json',
    ]
    if (spec.provider) args.push('--provider', spec.provider)
    if (spec.model) args.push('--model', spec.model)
    if (session?.internalId) {
      args.push('--session', session.internalId)
    } else {
      args.push('--no-session')
    }
    const thinking = thinkingFlagForEffort(req.effort)
    if (thinking) args.push('--thinking', thinking)
    // The prompt goes as a positional argument. Pi reads it directly
    // (no stdin payload required for `--print` mode).
    args.push(prompt)

    const spawned = await this.spawner(this.opts.bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: req.cwd ?? session?.cwd ?? process.cwd(),
      env: process.env,
      ...(req.session_id ? { sessionId: req.session_id } : {}),
    })
    const child = spawned.child
    const releaseSpawner = spawned.release

    let spawnErrorMessage = ''
    child.on('error', (err) => { spawnErrorMessage = err.message })
    const earlySpawnError = spawned.spawnError?.()
    if (earlySpawnError) spawnErrorMessage = earlySpawnError.message

    // Group-kill on timeout/abort — see backends/opencode.ts.
    const timeoutHandle = setTimeout(() => { void killTree(child) }, this.opts.timeoutMs)
    const onAbort = (): void => { void killTree(child) }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      let internalSessionId: string | undefined
      let stderr = ''
      let emittedContent = false
      let sawError: string | null = null
      let usage: { input?: number; output?: number } | undefined

      child.stderr?.on('data', (b) => { stderr += b.toString() })

      if (!child.stdout) {
        throw new BackendError('pi subprocess has no stdout pipe', 'upstream')
      }

      const progressIntervalMs = Math.max(10, Number(process.env.PI_PROGRESS_MS ?? 30_000))

      for await (const next of readProcessLines({ child, stdout: child.stdout, progressIntervalMs })) {
        if (next.kind === 'progress') {
          yield { keepalive: { source: 'pi', elapsedMs: next.elapsedMs } }
          continue
        }

        const line = next.line
        if (!line.trim()) continue
        let ev: Record<string, unknown>
        try {
          ev = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }

        const type = String(ev.type ?? '')

        // Session id is on the first `session` event.
        if (type === 'session' && typeof ev.id === 'string' && !internalSessionId) {
          internalSessionId = ev.id
          yield { internal_session_id: internalSessionId }
          continue
        }

        // Errors land as { type: 'error', message: '...' } OR carry an
        // `error` field on any event. Surface and continue draining so
        // we get full stderr context before terminating.
        if (type === 'error' || ev.error) {
          sawError = String(
            ev.message
            ?? (ev.error as Record<string, unknown> | undefined)?.message
            ?? 'pi error',
          )
          continue
        }

        // Final turn_end carries usage. Pi reports usage on the
        // `message_end` event with role: assistant via `partial.usage`.
        if (type === 'turn_end' || type === 'agent_end') {
          const u = (ev.usage ?? (ev.partial as Record<string, unknown> | undefined)?.usage) as
            | Record<string, number>
            | undefined
          if (u) {
            usage = { input: Number(u.input ?? u.prompt_tokens ?? 0), output: Number(u.output ?? u.completion_tokens ?? 0) }
          }
          continue
        }

        // Text comes through message_update events with
        // assistantMessageEvent.type === 'text_delta' (or 'text_start',
        // 'text_end' boundary markers we can ignore).
        if (type === 'message_update') {
          const ame = ev.assistantMessageEvent as Record<string, unknown> | undefined
          if (!ame) continue
          const ameType = String(ame.type ?? '')
          if (ameType === 'text_delta') {
            // Use the incremental delta only — text_start carries the
            // initial fragment in `partial.content[].text` and is followed
            // immediately by text_delta events that already include it.
            // Emitting both yields doubled output.
            const delta = typeof ame.delta === 'string' ? ame.delta : ''
            if (delta) {
              emittedContent = true
              yield { content: delta }
            }
          }
          // thinking_*, tool_call_*, message_start, message_end — drop
          // for now. Future enhancement: surface thinking as a separate
          // ChatDelta variant once the OpenAI o1-style schema lands.
          continue
        }

        // message_start / message_end (top-level) — drop. We rely on
        // text_delta inside message_update for streaming content.
        if (type === 'message_start' || type === 'message_end') continue

        // Unknown event types — drop silently. Pi's NDJSON schema may
        // gain new event types; we don't want to break on additions.
      }

      const exitCode = await waitForProcessClose(child)
      clearTimeout(timeoutHandle)
      signal.removeEventListener('abort', onAbort)
      releaseSpawner()

      if (signal.aborted) {
        yield { finish_reason: 'error' }
        return
      }

      if (spawnErrorMessage) {
        throw new BackendError(`pi spawn failed: ${spawnErrorMessage}`, 'upstream')
      }

      if (exitCode !== 0) {
        const detail = sawError ?? stderr.slice(0, 300) ?? `exit ${exitCode ?? 'unknown'}`
        // Auth/scope failures surface as a 401/403 in pi stderr.
        const isAuth = /401|403|token expired|forbidden|unauthorized/i.test(detail)
        throw new BackendError(`pi exit ${exitCode ?? 'unknown'}: ${detail}`, isAuth ? 'not_configured' : 'upstream')
      }

      if (sawError && !emittedContent) {
        throw new BackendError(`pi error: ${sawError}`, 'upstream')
      }

      yield {
        finish_reason: 'stop',
        ...(usage ? { usage: { input_tokens: usage.input, output_tokens: usage.output } } : {}),
      }
    } finally {
      clearTimeout(timeoutHandle)
      signal.removeEventListener('abort', onAbort)
      // Reap the whole subtree before releasing the slot.
      await killTree(child)
      try { releaseSpawner() } catch { /* best effort */ }
    }
  }

  /** Compose a single prompt string from the request's messages. */
  private buildPrompt(req: ChatRequest): string {
    const messages = resolvePromptMessages(req, null)
    const parts: string[] = []
    for (const msg of messages) {
      const text = contentToText(msg.content)
      if (!text) continue
      const prefix = msg.role === 'system' ? 'System: '
        : msg.role === 'user' ? 'User: '
        : msg.role === 'assistant' ? 'Assistant: '
        : `${msg.role}: `
      parts.push(`${prefix}${text}`)
    }
    return parts.join('\n\n')
  }
}

/**
 * Pi's `partial` object can carry assembled text in
 * `partial.content[N].text` — walk it for a last-resort delta when the
 * top-level `delta` field is missing on a text event.
 */
function extractTextFromPartial(partial: unknown): string {
  if (!partial || typeof partial !== 'object') return ''
  const obj = partial as Record<string, unknown>
  const content = obj.content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') out += b.text
    }
  }
  return out
}
