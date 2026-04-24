/**
 * Claude Code backend — spawns `claude -p` with stream-json I/O and
 * translates the stream to OpenAI-shaped chat deltas.
 *
 * Model id scheme: `claude/<model>` where `<model>` is passed to
 * `claude --model <model>`. Claude Code accepts the short aliases
 * (`sonnet`, `opus`, `haiku`) and the fully-qualified Anthropic
 * version ids. A bare `claude` with no model defaults to sonnet.
 *
 * Session resume:
 *   - External `session_id` maps (via SessionStore) to Claude's
 *     internal conversation uuid captured from the `system:init` event.
 *   - When we have an internal id, we pass `--resume <id>` so Claude
 *     loads prior transcript + context.
 *
 * Why a claude SEPARATE harness and not unified with claudish: Claude
 * Code with its native Anthropic endpoint has different guarantees than
 * Claude Code bent toward a third-party brain. Keeping them on separate
 * model-id prefixes makes the choice explicit at call time.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError, JSON_MODE_DIRECTIVE, wantsJsonObject } from './types.js'
import { ModeNotSupportedError, type BridgeMode } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import { renderLocalHarnessProfilePreamble, resolveAgentProfile } from './profile-support.js'

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

export interface ClaudeBackendOptions {
  bin: string
  timeoutMs: number
  /** Harness name that claims the <harness>/* prefix. Default 'claude'. */
  harness?: string
  /**
   * If set, the Claude Code subprocess is spawned with
   * ANTHROPIC_BASE_URL=<this value>. Used by the `claudish` harness to
   * aim Claude Code at a local claudish proxy so the workflow runs over
   * a different model backend.
   */
  anthropicBaseUrl?: string | null
}

export class ClaudeBackend implements Backend {
  readonly name: string
  private readonly bin: string
  private readonly timeoutMs: number
  private readonly anthropicBaseUrl: string | null
  private readonly prefix: string

  constructor(opts: ClaudeBackendOptions) {
    this.name = opts.harness ?? 'claude'
    this.bin = opts.bin
    this.timeoutMs = opts.timeoutMs
    this.anthropicBaseUrl = opts.anthropicBaseUrl ?? null
    this.prefix = `${this.name}/`
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === this.name || m.startsWith(this.prefix)
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
          resolve({
            name: this.name,
            state: 'ready',
            version: stdout.trim() || undefined,
            detail: this.anthropicBaseUrl ? `via ${this.anthropicBaseUrl}` : undefined,
          })
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
    const mode: BridgeMode = req.mode ?? 'byob'

    // hosted-sandboxed requires the sandbox launcher which is a separate
    // code path (src/sandbox.ts, not yet landed). Fail loud until that's
    // wired up so we never quietly run untrusted prompts on the bare VM.
    if (mode === 'hosted-sandboxed') {
      throw new ModeNotSupportedError(
        this.name,
        mode,
        'sandbox launcher not yet wired — use byob or hosted-safe',
      )
    }

    const prompt = this.flattenPrompt(req.messages)
    const args = this.buildArgs(req, session, mode, prompt)

    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    if (this.anthropicBaseUrl) {
      childEnv.ANTHROPIC_BASE_URL = this.anthropicBaseUrl
    }

    const child = spawn(this.bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: req.cwd ?? session?.cwd ?? process.cwd(),
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
            yield { finish_reason: 'error', internal_session_id: internalSessionId }
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

  /**
   * Build the argv for `claude -p …`. Extracted so tests can verify
   * flag composition (json-mode, hosted-safe, resume, model) without
   * spawning a real subprocess.
   *
   * Non-native JSON mode is honored via `--append-system-prompt` — a
   * real Claude Code flag that cleanly layers the directive on top of
   * the user prompt without mutating it. Content may still arrive
   * fenced; callers should keep fence-stripping as a fallback.
   */
  buildArgs(
    req: ChatRequest,
    session: SessionRecord | null,
    mode: BridgeMode,
    prompt: string,
  ): string[] {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose']

    const appendPrompts = [
      renderLocalHarnessProfilePreamble(resolveAgentProfile(req, session)),
      wantsJsonObject(req) ? JSON_MODE_DIRECTIVE : null,
    ].filter((value): value is string => Boolean(value))
    if (appendPrompts.length) {
      args.push('--append-system-prompt', appendPrompts.join('\n\n'))
    }

    // hosted-safe: force Claude Code into plan mode and hard-disable
    // every tool that can touch the FS or shell. `plan` mode alone
    // already bans Write/Edit/Bash/NotebookEdit, but we also pass the
    // full disallowed list so a future upstream flag rename doesn't
    // silently re-enable them.
    if (mode === 'hosted-safe') {
      args.push(
        '--permission-mode', 'plan',
        '--disallowed-tools', 'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch',
      )
    } else if (mode === 'byob') {
      // byob = caller runs their own bridge and trusts the tool calls;
      // the whole point of the mode is "full harness tools available"
      // (see src/modes.ts). Claude Code's default permission mode is
      // interactive approval, which in a non-TTY bridge pipeline hangs
      // every Write/Edit call (worker emits `The file write requests
      // need user approval` and no approver exists). Use bypass mode
      // explicitly — matches what kimi.ts does implicitly by not
      // exposing a permission flag at all.
      args.push('--permission-mode', 'bypassPermissions')
    }

    if (session?.internalId) {
      args.push('--resume', session.internalId)
    }

    const modelArg = this.extractModel(req.model)
    if (modelArg) {
      args.push('--model', modelArg)
    }

    return args
  }

  private flattenPrompt(messages: ChatRequest['messages']): string {
    if (messages.length === 1) return messages[0]?.content ?? ''
    return messages.map((m) => `[${m.role}] ${m.content}`).join('\n\n')
  }

  /**
   * Parse `claude/sonnet` → `sonnet`, `claude` (bare) → null (default
   * model). Claude Code accepts short aliases and full version ids; we
   * pass whatever the caller wrote through unchanged.
   */
  private extractModel(fullModel: string): string | null {
    if (fullModel.toLowerCase() === this.name) return null
    if (fullModel.startsWith(this.prefix)) {
      const rest = fullModel.slice(this.prefix.length)
      return rest.length > 0 ? rest : null
    }
    return null
  }
}
