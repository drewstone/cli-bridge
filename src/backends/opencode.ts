/**
 * opencode backend — spawns `opencode run --format json` and translates
 * its JSON event stream to OpenAI chat deltas.
 *
 * Model id scheme: `opencode/<rest>` where `<rest>` is opencode's own
 * `provider/model` spec (`anthropic/claude-sonnet-4-5`, `kimi-for-coding`,
 * etc). opencode resolves it via its configured auth.
 *
 * Session resume: external session id maps (via SessionStore) to an
 * opencode session id that opencode prints on startup. We capture it
 * from the event stream and pass `-s <id>` on the next call.
 *
 * Kimi Code: after `opencode auth login kimi` (one-time on the host)
 * and an `opencode-kimi-full` plugin install, the model id
 * `opencode/kimi-for-coding` routes through the Kimi For Coding
 * subscription. No static key needed — opencode handles OAuth + the
 * right headers so Moonshot's backend accepts the call.
 */

import { createInterface } from 'node:readline'
import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import { resolvePromptMessages } from './profile-support.js'
import { hostSpawner } from '../executors/host.js'
import type { Spawner } from '../executors/types.js'

export interface OpencodeBackendOptions {
  bin: string
  timeoutMs: number
  /** Subprocess spawner. Defaults to host spawn; pass a docker-pooled spawner for parallel-safe execution. */
  spawner?: Spawner
}

export class OpencodeBackend implements Backend {
  readonly name = 'opencode'
  private readonly spawner: Spawner
  constructor(private readonly opts: OpencodeBackendOptions) {
    this.spawner = opts.spawner ?? hostSpawner
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'opencode' || m.startsWith('opencode/')
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
        let stdout = ''; let stderr = ''
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
      'opencode hosted-safe requires a verified per-provider tool-disable flag path')

    const prompt = this.flattenPrompt(resolvePromptMessages(req, session))
    const model = this.extractModel(req.model)

    const args: string[] = ['run', '--format', 'json', '--dangerously-skip-permissions']
    if (model) args.push('-m', model)
    const variant = opencodeVariantForEffort(req.effort)
    if (variant) args.push('--variant', variant)
    if (session?.internalId) args.push('-s', session.internalId)
    args.push(prompt)

    const spawned = await this.spawner(this.opts.bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: req.cwd ?? session?.cwd ?? process.cwd(),
      env: process.env,
      ...(req.session_id ? { sessionId: req.session_id } : {}),
    })
    const child = spawned.child
    const releaseSpawner = spawned.release

    const timeoutHandle = setTimeout(() => child.kill('SIGTERM'), this.opts.timeoutMs)
    const onAbort = () => child.kill('SIGTERM')
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      let internalSessionId: string | undefined
      let stderr = ''
      child.stderr?.on('data', (b) => { stderr += b.toString() })
      if (!child.stdout) {
        throw new BackendError('opencode subprocess has no stdout pipe', 'upstream')
      }
      const rl = createInterface({ input: child.stdout })
      let sawError: string | null = null
      let emittedContent = false
      let emittedToolCall = false
      let usage: ChatDelta['usage']
      let progressSeq = 0
      const progressIntervalMs = Math.max(10, Number(process.env.OPENCODE_PROGRESS_MS ?? 30_000))
      const lineIter = rl[Symbol.asyncIterator]()
      let pendingLine = lineIter.next()

      while (true) {
        const next = await Promise.race([
          pendingLine.then((result) => ({ kind: 'line' as const, result })),
          delay(progressIntervalMs).then(() => ({ kind: 'progress' as const })),
        ])
        if (next.kind === 'progress') {
          progressSeq += 1
          yield {
            tool_calls: [{
              id: `opencode-progress-${progressSeq}`,
              name: 'opencode_progress',
              arguments: JSON.stringify({
                elapsedMs: progressSeq * progressIntervalMs,
                stderrTail: stderr.slice(-240),
              }),
            }],
          }
          continue
        }

        pendingLine = lineIter.next()
        const { value: line, done } = next.result
        if (done) break
        if (!line.trim()) continue
        let ev: Record<string, unknown>
        try { ev = JSON.parse(line) as Record<string, unknown> } catch { continue }

        // opencode emits a mix of event types. Session id comes early
        // on a session.created / session.started event, or as a top
        // level session field on many events.
        const sessId = pickSessionId(ev)
        if (sessId && !internalSessionId) {
          internalSessionId = sessId
          yield { internal_session_id: internalSessionId }
        }

        const type = String(ev.type ?? '')
        if (type === 'error' || ev.error) {
          sawError = String(ev.message ?? (ev.error as Record<string, unknown> | undefined)?.message ?? 'opencode error')
          continue
        }

        const text = extractText(ev)
        if (text) { yield { content: text }; emittedContent = true }
        const toolCall = extractToolUse(ev)
        if (toolCall) { yield { tool_calls: [toolCall] }; emittedToolCall = true }
        const eventUsage = extractUsage(ev)
        if (eventUsage) usage = eventUsage

        if (
          type === 'message.completed'
          || type === 'turn.completed'
          || type === 'session.completed'
          || type === 'run.completed'
        ) {
          yield {
            finish_reason: sawError ? 'error' : 'stop',
            usage,
            internal_session_id: internalSessionId,
          }
          return
        }
      }

      const exitCode: number | null = await new Promise((resolve) => {
        if (child.exitCode !== null) resolve(child.exitCode)
        else child.once('close', (code) => resolve(code))
      })

      if (signal.aborted) {
        yield { finish_reason: 'error', internal_session_id: internalSessionId }
        return
      }
      if (sawError) throw new BackendError(`opencode: ${sawError}`, 'upstream')
      if (exitCode !== 0 && exitCode !== null) {
        throw new BackendError(`opencode exited ${exitCode}: ${stderr.slice(0, 300)}`, 'upstream')
      }
      if (!emittedContent && !emittedToolCall) {
        throw new BackendError(`opencode produced no stream output: ${stderr.slice(0, 300)}`, 'upstream')
      }
      yield { finish_reason: 'stop', usage, internal_session_id: internalSessionId }
    } finally {
      clearTimeout(timeoutHandle)
      signal.removeEventListener('abort', onAbort)
      if (child.exitCode === null) child.kill('SIGTERM')
      releaseSpawner()
    }
  }

  private flattenPrompt(messages: ChatRequest['messages']): string {
    if (messages.length === 1) return messages[0]?.content ?? ''
    return messages.map((m) => `[${m.role}] ${m.content}`).join('\n\n')
  }

  private extractModel(fullModel: string): string | null {
    const lower = fullModel.toLowerCase()
    if (lower === 'opencode') return null
    if (lower.startsWith('opencode/')) {
      const rest = fullModel.slice('opencode/'.length)
      return rest.length > 0 ? rest : null
    }
    return null
  }
}

export function opencodeVariantForEffort(effort: ChatRequest['effort']): string | null {
  return effort ?? null
}

function pickSessionId(ev: Record<string, unknown>): string | null {
  for (const k of ['session_id', 'sessionId', 'sessionID', 'session']) {
    const v = ev[k]
    if (typeof v === 'string' && v.length > 0) return v
    if (typeof v === 'object' && v !== null) {
      const id = (v as Record<string, unknown>).id
      if (typeof id === 'string' && id.length > 0) return id
    }
  }
  return null
}

function extractToolUse(ev: Record<string, unknown>): { id: string; name: string; arguments: string } | null {
  const part = ev.part as Record<string, unknown> | undefined
  const tool =
    (ev.tool_call as Record<string, unknown> | undefined)
    ?? (ev.toolCall as Record<string, unknown> | undefined)
    ?? (part?.type === 'tool' || part?.type === 'tool_call' ? part : undefined)
  if (!tool) return null
  const id = String(tool.id ?? tool.callID ?? tool.toolCallID ?? tool.tool_call_id ?? '')
  const name = String(tool.name ?? tool.tool ?? '')
  if (!id || !name) return null
  const state = tool.state as Record<string, unknown> | undefined
  const input = tool.input ?? state?.input ?? tool.arguments ?? {}
  return {
    id,
    name,
    arguments: typeof input === 'string' ? input : JSON.stringify(input),
  }
}

function extractUsage(ev: Record<string, unknown>): ChatDelta['usage'] | null {
  const direct = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined
  if (direct) return direct

  const part = ev.part as Record<string, unknown> | undefined
  const tokens = part?.tokens as
    | { input?: number; output?: number; input_tokens?: number; output_tokens?: number }
    | undefined
  if (!tokens) return null

  return {
    input_tokens: tokens.input_tokens ?? tokens.input,
    output_tokens: tokens.output_tokens ?? tokens.output,
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
    (ev.part as Record<string, unknown> | undefined)?.text,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c
  }
  return null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
