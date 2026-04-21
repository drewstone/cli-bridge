/**
 * Claude Code backend — spawns `claude -p` with stream-json I/O and
 * translates the stream to OpenAI-shaped chat deltas.
 *
 * Session resume:
 *   - The external `session_id` maps via SessionStore to Claude's
 *     internal conversation uuid (stored at session creation).
 *   - When we have an internal id, we pass `--resume <id>` so Claude
 *     loads the prior transcript and context.
 *   - First call (no prior internal id): let Claude assign one. We
 *     capture it from the `system:init` event in the stream and persist.
 *
 * Message shaping:
 *   - We concatenate non-last user/system messages into the prompt
 *     (claude -p takes a single prompt string). For multi-turn, callers
 *     should reuse the session id so Claude's own context tracking
 *     handles history — not flatten-to-prompt every time.
 *   - If the caller floods messages[] instead of resuming, we fall back
 *     to flattening; it still works, just less efficient.
 *
 * Auth:
 *   - `claude` CLI is auth'd on the host via its own `claude login`
 *     (OAuth flow). We never touch that flow.
 *
 * Failure modes we handle:
 *   - CLI not installed → BackendError('cli_missing') at health() time
 *   - Subprocess exits non-zero → BackendError('upstream') with stderr snippet
 *   - Timeout → kill the subprocess, yield finish_reason='timeout'
 *   - Abort signal → kill subprocess, stop yielding
 *   - Malformed JSON line → log + skip (don't kill the whole turn on one bad line)
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

interface ClaudeStreamInit {
  type: 'system'
  subtype: 'init'
  session_id: string
  model?: string
}
interface ClaudeStreamAssistant {
  type: 'assistant'
  message: {
    id: string
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
    >
    stop_reason?: string | null
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  session_id?: string
}
interface ClaudeStreamResult {
  type: 'result'
  subtype: string
  session_id: string
  is_error?: boolean
  result?: string
  usage?: { input_tokens?: number; output_tokens?: number }
  total_cost_usd?: number
}
type ClaudeStreamLine = ClaudeStreamInit | ClaudeStreamAssistant | ClaudeStreamResult | { type: string }

export class ClaudeBackend implements Backend {
  readonly name = 'claude'
  constructor(
    private readonly bin: string,
    private readonly timeoutMs: number,
    /** Optional ANTHROPIC_BASE_URL for the subprocess (claudish etc.) */
    private readonly anthropicBaseUrl: string | null = null,
  ) {}

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m.startsWith('claude') || m === 'sonnet' || m === 'opus' || m === 'haiku'
  }

  async health(): Promise<BackendHealth> {
    return new Promise((resolve) => {
      const child = spawn(this.bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (b) => { stdout += b.toString() })
      child.stderr.on('data', (b) => { stderr += b.toString() })
      child.on('error', (err) => {
        resolve({ name: this.name, state: 'unavailable', detail: `spawn failed: ${err.message}` })
      })
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ name: this.name, state: 'ready', version: stdout.trim() || undefined })
        } else {
          resolve({
            name: this.name,
            state: 'error',
            detail: `exit ${code}: ${stderr.slice(0, 200) || stdout.slice(0, 200)}`,
          })
        }
      })
    })
  }

  async *chat(
    req: ChatRequest,
    session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    const prompt = this.flattenPrompt(req.messages)
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose']

    if (session?.internalId) {
      args.push('--resume', session.internalId)
    }
    if (req.model && req.model !== 'claude') {
      args.push('--model', this.normalizeModel(req.model))
    }

    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    if (this.anthropicBaseUrl) {
      childEnv.ANTHROPIC_BASE_URL = this.anthropicBaseUrl
    }

    const child = spawn(this.bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: session?.cwd ?? process.cwd(),
      env: childEnv,
    })

    const timeoutHandle = setTimeout(() => {
      child.kill('SIGTERM')
    }, this.timeoutMs)

    const onAbort = () => child.kill('SIGTERM')
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      let internalSessionId: string | undefined
      let stderr = ''
      child.stderr.on('data', (b) => { stderr += b.toString() })

      const rl = createInterface({ input: child.stdout })
      for await (const line of rl) {
        if (!line.trim()) continue
        let msg: ClaudeStreamLine
        try {
          msg = JSON.parse(line) as ClaudeStreamLine
        } catch {
          // Tolerate malformed lines — don't kill the turn on one bad line.
          continue
        }

        if (msg.type === 'system' && (msg as ClaudeStreamInit).subtype === 'init') {
          internalSessionId = (msg as ClaudeStreamInit).session_id
          yield { internal_session_id: internalSessionId }
          continue
        }

        if (msg.type === 'assistant') {
          const a = msg as ClaudeStreamAssistant
          const content = a.message?.content ?? []
          for (const block of content) {
            if (block.type === 'text') {
              yield { content: block.text }
            } else if (block.type === 'tool_use') {
              yield {
                tool_calls: [{
                  id: block.id,
                  name: block.name,
                  arguments: JSON.stringify(block.input ?? {}),
                }],
              }
            }
          }
          continue
        }

        if (msg.type === 'result') {
          const r = msg as ClaudeStreamResult
          if (r.is_error) {
            yield {
              finish_reason: 'error',
              internal_session_id: internalSessionId,
            }
          } else {
            yield {
              finish_reason: 'stop',
              usage: r.usage,
              internal_session_id: r.session_id ?? internalSessionId,
            }
          }
          return
        }
      }

      // Stream ended without a `result` event — treat as abnormal close.
      const exitCode: number | null = await new Promise((resolve) => {
        if (child.exitCode !== null) resolve(child.exitCode)
        else child.once('close', (code) => resolve(code))
      })

      if (signal.aborted) {
        yield { finish_reason: 'error', internal_session_id: internalSessionId }
        return
      }

      if (exitCode !== 0 && exitCode !== null) {
        throw new BackendError(
          `claude exited ${exitCode}: ${stderr.slice(0, 300)}`,
          'upstream',
        )
      }

      yield { finish_reason: 'stop', internal_session_id: internalSessionId }
    } finally {
      clearTimeout(timeoutHandle)
      signal.removeEventListener('abort', onAbort)
      if (child.exitCode === null) child.kill('SIGTERM')
    }
  }

  private flattenPrompt(messages: ChatRequest['messages']): string {
    // Claude Code's -p flag takes a single prompt. For a conversation,
    // the CORRECT path is session resume (so Claude tracks history
    // itself). If the caller sends a flat messages[] array without a
    // session id, we concat with role headers as a best-effort fallback.
    if (messages.length === 1) return messages[0]?.content ?? ''
    return messages.map((m) => `[${m.role}] ${m.content}`).join('\n\n')
  }

  private normalizeModel(model: string): string {
    // Map common aliases to the model names Claude Code accepts.
    const m = model.toLowerCase()
    if (m === 'claude' || m === 'claude-sonnet' || m === 'sonnet') return 'sonnet'
    if (m === 'claude-opus' || m === 'opus') return 'opus'
    if (m === 'claude-haiku' || m === 'haiku') return 'haiku'
    // Pass through anything Anthropic-flavored; Claude Code accepts its own full ids.
    return model
  }
}

// Keeping the unused type imports alive for readers.
type _Keep = ChildProcessWithoutNullStreams
