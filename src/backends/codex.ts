/**
 * Codex CLI backend — spawns `codex exec --json` and translates its
 * JSONL event stream to OpenAI chat deltas.
 *
 * Model id scheme: `codex/<model>` where `<model>` is the Codex model
 * alias. Passed via `-c model="<model>"` config override. Bare `codex`
 * uses the subscription's default.
 *
 * Session resume: the external session id maps (via SessionStore) to a
 * Codex thread_id (UUID, reported on the `thread.started` event).
 * Subsequent calls invoke `codex exec resume <thread_id>` so Codex
 * loads prior context.
 *
 * Event shapes we parse (from `codex exec --json` JSONL):
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"turn.started"}
 *   {"type":"message","content":{"text":"..."}}         — best-effort
 *   {"type":"item.completed","item":{"type":"message",…}} — best-effort
 *   {"type":"turn.completed","usage":{...}}
 *   {"type":"error","message":"..."}
 *
 * The message-content field names vary across codex versions. We
 * defensively pull `.content`, `.text`, `.message`, `.item.content`,
 * `.item.text` etc — whatever has a string. If Codex changes the shape
 * again, adjust `extractText` below rather than the whole pipeline.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

export interface CodexBackendOptions {
  bin: string
  timeoutMs: number
}

export class CodexBackend implements Backend {
  readonly name = 'codex'
  constructor(private readonly opts: CodexBackendOptions) {}

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'codex' || m.startsWith('codex/')
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
    const prompt = this.flattenPrompt(req.messages)
    const modelArg = this.extractModel(req.model)

    // Build argv. `codex exec resume <id> <prompt>` if we have one,
    // else `codex exec <prompt>`. --json emits JSONL events.
    const args: string[] = ['exec', '--json']
    if (modelArg) args.push('-c', `model="${modelArg}"`)

    if (session?.internalId) {
      args.splice(1, 0, 'resume', session.internalId)
      // codex exec resume <id> [prompt]
    }
    args.push(prompt)

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
      child.stderr.on('data', (b) => { stderr += b.toString() })

      const rl = createInterface({ input: child.stdout })
      let sawError: string | null = null

      for await (const line of rl) {
        if (!line.trim()) continue
        let ev: Record<string, unknown>
        try { ev = JSON.parse(line) as Record<string, unknown> } catch { continue }

        const type = String(ev.type ?? '')

        if (type === 'thread.started' && typeof ev.thread_id === 'string') {
          internalSessionId = ev.thread_id
          yield { internal_session_id: internalSessionId }
          continue
        }

        if (type === 'error') {
          sawError = String(ev.message ?? 'codex error')
          continue
        }

        const text = extractText(ev)
        if (text) yield { content: text }

        if (type === 'turn.completed' || type === 'thread.completed') {
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
      if (sawError) {
        throw new BackendError(`codex: ${sawError}`, 'upstream')
      }
      if (exitCode !== 0 && exitCode !== null) {
        throw new BackendError(`codex exited ${exitCode}: ${stderr.slice(0, 300)}`, 'upstream')
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
    const lower = fullModel.toLowerCase()
    if (lower === 'codex') return null
    if (lower.startsWith('codex/')) {
      const rest = fullModel.slice('codex/'.length)
      return rest.length > 0 ? rest : null
    }
    return null
  }
}

/**
 * Pull any message-shaped text out of a codex event. Intentionally
 * permissive — codex's field naming has drifted across versions, and
 * we'd rather capture text from a slightly-wrong shape than silently
 * drop it.
 */
function extractText(ev: Record<string, unknown>): string | null {
  // Common patterns we've seen
  const candidates: unknown[] = [
    ev.text,
    ev.content,
    (ev.message as Record<string, unknown> | undefined)?.text,
    (ev.message as Record<string, unknown> | undefined)?.content,
    (ev.item as Record<string, unknown> | undefined)?.text,
    (ev.item as Record<string, unknown> | undefined)?.content,
    (ev.delta as Record<string, unknown> | undefined)?.text,
    (ev.delta as Record<string, unknown> | undefined)?.content,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c
  }
  return null
}
