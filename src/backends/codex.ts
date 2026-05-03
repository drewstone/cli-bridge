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

import { createInterface } from 'node:readline'
import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import { resolvePromptMessages } from './profile-support.js'
import { contentToText } from './content.js'
import { hostSpawner } from '../executors/host.js'
import type { Spawner } from '../executors/types.js'

export interface CodexBackendOptions {
  bin: string
  timeoutMs: number
  /** Subprocess spawner. Defaults to host spawn; pass a docker-pooled spawner for parallel-safe execution. */
  spawner?: Spawner
}

export class CodexBackend implements Backend {
  readonly name = 'codex'
  private readonly spawner: Spawner
  constructor(private readonly opts: CodexBackendOptions) {
    this.spawner = opts.spawner ?? hostSpawner
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'codex' || m.startsWith('codex/')
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
    // Codex has `--sandbox` flags but we haven't verified end-to-end that
    // every FS/shell tool is gated under read-only. Reject hosted-safe
    // until that audit lands — never fake safety.
    assertModeSupported(this.name, req.mode ?? 'byob', ['byob'],
      'codex hosted-safe requires verified --sandbox read-only audit')

    const prompt = this.flattenPrompt(resolvePromptMessages(req, session))
    const modelArg = this.extractModel(req.model)

    // Build argv. `codex exec resume <id> <prompt>` if we have one,
    // else `codex exec <prompt>`. --json emits JSONL events.
    const args: string[] = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
    ]
    if (modelArg) args.push('-c', `model="${modelArg}"`)
    const reasoningEffort = codexReasoningEffort(req.effort)
    if (reasoningEffort) args.push('-c', `model_reasoning_effort="${reasoningEffort}"`)

    if (session?.internalId) {
      args.splice(1, 0, 'resume', session.internalId)
      // codex exec resume <id> [prompt]
    }
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
        throw new BackendError('codex subprocess has no stdout pipe', 'upstream')
      }
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
      releaseSpawner()
    }
  }

  private flattenPrompt(messages: ChatRequest['messages']): string {
    if (messages.length === 1) return contentToText(messages[0]?.content ?? '')
    return messages.map((m) => `[${m.role}] ${contentToText(m.content)}`).join('\n\n')
  }

  private extractModel(fullModel: string): string | null {
    const lower = fullModel.toLowerCase()
    if (lower === 'codex') return null
    // `codex/default` is the alias for "no model override; let codex
    // CLI use whatever ~/.codex/config.toml resolves to". Returning
    // null here suppresses the `-c model="..."` flag in chat() so the
    // call works on accounts without entitlement for the gated alias.
    if (lower === 'codex/default') return null
    if (lower.startsWith('codex/')) {
      const rest = fullModel.slice('codex/'.length)
      return rest.length > 0 ? rest : null
    }
    return null
  }
}

export function codexReasoningEffort(effort: ChatRequest['effort']): 'minimal' | 'low' | 'medium' | 'high' | null {
  if (!effort) return null
  if (effort === 'xhigh' || effort === 'max') return 'high'
  return effort
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
