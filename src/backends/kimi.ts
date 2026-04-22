/**
 * Kimi CLI backend — Moonshot's own coding CLI.
 *
 * Uses the exact same ergonomics as Claude Code: `--print --prompt X`
 * for non-interactive, `--resume <id>` for session resume, `--model`
 * for model selection, `--output-format stream-json` for JSONL. We
 * parse the stream-json events to OpenAI chat deltas.
 *
 * Model id scheme: `<harness>/<model>` where `<harness>` defaults to
 * `kimi-code` (the product name Moonshot ships the CLI under) and
 * `<model>` is what Kimi CLI accepts (e.g., `kimi-for-coding`,
 * `kimi-k2-0905-preview`, or the CLI's configured default if the
 * model is omitted).
 *
 * Why Kimi CLI over opencode + opencode-kimi-full:
 *   - Official Moonshot client — Moonshot's server-side gate lists
 *     "Kimi CLI" as an allowed coding agent by name
 *   - Native OAuth + the right headers, no plugin plumbing
 *   - Non-interactive mode + stream-json are first-class, not bolted on
 *
 * Event shapes we parse (from `kimi --print --output-format stream-json`):
 *   - session/init events carry an id
 *   - assistant-message events with text content
 *   - tool-use events
 *   - result / completion events with usage
 *   - error events
 *
 * The exact field names vary — we defensively pull content from the
 * common ones (`content`, `text`, `message.content`, `delta.text`).
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'

export interface KimiBackendOptions {
  bin: string
  timeoutMs: number
  /** Harness name that claims the `<harness>/*` prefix. Default 'kimi-code'. */
  harness?: string
}

export class KimiBackend implements Backend {
  readonly name: string
  private readonly prefix: string

  constructor(private readonly opts: KimiBackendOptions) {
    this.name = opts.harness ?? 'kimi-code'
    this.prefix = `${this.name}/`
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === this.name || m.startsWith(this.prefix)
  }

  async health(): Promise<BackendHealth> {
    return new Promise((resolve) => {
      const child = spawn(this.opts.bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''; let stderr = ''
      child.stdout.on('data', (b) => { stdout += b.toString() })
      child.stderr.on('data', (b) => { stderr += b.toString() })
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
  }

  async *chat(
    req: ChatRequest,
    session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    assertModeSupported(this.name, req.mode ?? 'byob', ['byob'],
      'kimi hosted-safe requires a verified tool-disable flag path on kimi-cli')

    const prompt = this.flattenPrompt(req.messages)
    const model = this.extractModel(req.model)

    const args = ['--print', '--output-format', 'stream-json', '--prompt', prompt]
    if (session?.internalId) {
      args.push('--resume', session.internalId)
    }
    if (model) {
      args.push('--model', model)
    }

    const child = spawn(this.opts.bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: session?.cwd ?? process.cwd(),
      env: process.env,
    })

    const timeoutHandle = setTimeout(() => child.kill('SIGTERM'), this.opts.timeoutMs)
    const onAbort = () => child.kill('SIGTERM')
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      let internalSessionId: string | undefined
      let stderr = ''
      let emittedContent = false
      child.stderr.on('data', (b) => {
        const chunk = b.toString()
        stderr += chunk
        // Kimi prints "To resume this session: kimi -r <uuid>" to
        // stderr after --print. That's our session id when no init
        // event carries one.
        if (!internalSessionId) {
          const m = chunk.match(/kimi\s+-r\s+([0-9a-f-]{8,})/i)
          if (m) internalSessionId = m[1]
        }
      })

      const rl = createInterface({ input: child.stdout })
      let sawError: string | null = null

      for await (const line of rl) {
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

        // Kimi's actual event shape for assistant output:
        //   {"role":"assistant","content":[{"type":"think","think":"..."},
        //                                   {"type":"text","text":"..."},
        //                                   {"type":"tool_use",…}]}
        // Walk the content array block-by-block — matches how we handle
        // Claude Code's stream-json. Generic extractText is a fallback
        // for events whose content is just a string.
        const role = String(ev.role ?? '')
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
              }
            }
            // 'think' blocks are reasoning chain-of-thought; don't surface.
          }
        } else {
          const text = extractText(ev)
          if (text) { yield { content: text }; emittedContent = true }
          const toolCall = extractToolUse(ev)
          if (toolCall) yield { tool_calls: [toolCall] }
        }

        if (
          type === 'result'
          || type === 'turn.completed'
          || type === 'session.completed'
          || type === 'completed'
        ) {
          const usage = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined
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
      if (sawError) throw new BackendError(`kimi: ${sawError}`, 'upstream')
      // Kimi CLI --print exits non-zero on some successful runs (known
      // quirk — the "To resume this session: kimi -r <uuid>" stderr
      // message is printed as a successful trailer, not an error). If
      // we observed real assistant content, treat exit non-zero as OK.
      if (exitCode !== 0 && exitCode !== null && !emittedContent) {
        throw new BackendError(`kimi exited ${exitCode}: ${stderr.slice(0, 300)}`, 'upstream')
      }
      yield { finish_reason: 'stop', internal_session_id: internalSessionId }
    } finally {
      clearTimeout(timeoutHandle)
      signal.removeEventListener('abort', onAbort)
      if (child.exitCode === null) child.kill('SIGTERM')
    }
  }

  private flattenPrompt(messages: ChatRequest['messages']): string {
    if (messages.length === 1) return messages[0]?.content ?? ''
    return messages.map((m) => `[${m.role}] ${m.content}`).join('\n\n')
  }

  private extractModel(fullModel: string): string | null {
    // Kimi's config.toml uses `<provider>/<model>` as the literal key
    // (e.g. `kimi-code/kimi-for-coding`) — the harness prefix IS the
    // provider side of that key. Pass the full string through; stripping
    // the prefix makes `--model kimi-for-coding` fail with "LLM not set".
    // Bare harness name alone → let kimi pick its default model.
    const lower = fullModel.toLowerCase()
    if (lower === this.name) return null
    if (lower.startsWith(this.prefix)) return fullModel
    return null
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
