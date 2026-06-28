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
import { provisionProfileWorkspace, resolvePromptMessages } from './profile-support.js'
import { contentToText } from './content.js'
import { hostSpawner } from '../executors/host.js'
import type { Spawner } from '../executors/types.js'
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
            resolve({
              name: this.name,
              state: 'error',
              detail: `exit ${code}: ${stderr.slice(0, 200) || stdout.slice(0, 200)}`,
            })
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
      'gemini hosted modes require a verified tool-disable and sandbox contract')

    const prompt = this.buildPrompt(req, session)
    const model = this.extractModel(req.model)
    const args = this.buildArgs(req.model)
    if (model) args.push('--model', model)

    // Phase-2 host wiring: provision cwd-native profile dimensions before spawn. Fail-safe.
    provisionProfileWorkspace(req, session, 'gemini', req.cwd ?? session?.cwd ?? process.cwd())
    const spawned = await this.spawner(this.opts.bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: req.cwd ?? session?.cwd ?? process.cwd(),
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
          if (type === 'completed' || type === 'turn.completed' || type === 'result') {
            yield { finish_reason: sawError ? 'error' : 'stop' }
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
      if (!emittedContent) {
        throw new BackendError(`gemini produced no output: ${stderr.slice(0, 300)}`, 'upstream')
      }
      yield { finish_reason: 'stop' }
    } finally {
      clearTimeout(timeoutHandle)
      signal.removeEventListener('abort', onAbort)
      await killTree(child)
      releaseSpawner()
    }
  }

  buildPrompt(req: ChatRequest, session: SessionRecord | null): string {
    const flat = this.flattenPrompt(resolvePromptMessages(req, session))
    return wantsJsonObject(req) ? `${JSON_MODE_DIRECTIVE}\n\n${flat}` : flat
  }

  buildArgs(fullModel: string): string[] {
    const args = ['--prompt', 'Complete the request provided on stdin.']
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
