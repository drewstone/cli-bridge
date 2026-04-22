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

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'

export interface OpencodeBackendOptions {
  bin: string
  timeoutMs: number
}

export class OpencodeBackend implements Backend {
  readonly name = 'opencode'
  constructor(private readonly opts: OpencodeBackendOptions) {}

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'opencode' || m.startsWith('opencode/')
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
    // opencode supports byob and hosted-safe; hosted-sandboxed defers to
    // the sandbox launcher (not yet wired).
    assertModeSupported(this.name, req.mode ?? 'byob', ['byob', 'hosted-safe'],
      'opencode hosted-sandboxed requires the sandbox launcher — not yet wired')

    const prompt = this.flattenPrompt(req.messages)
    const model = this.extractModel(req.model)

    const args: string[] = ['run', '--format', 'json']
    if (model) args.push('-m', model)
    if (session?.internalId) args.push('-s', session.internalId)

    // hosted-safe: opencode has no CLI flag for permissions — the only
    // runtime knob is `OPENCODE_CONFIG=<path>` pointing to a JSON config
    // whose `permission` block is merged with higher precedence than
    // global config (verified against opencode.ai/docs/config/ and
    // docs/permissions/). We write a fresh temp config per invocation
    // denying every tool by default and allowing only Read/Glob/Grep —
    // this matches the documented recipe for a deny-all-by-default
    // policy. `--agent plan` is also set as defense in depth; plan agent
    // restricts edits + bash to `ask`, which in a non-interactive
    // `run` context blocks them (no approval UI → refused).
    //
    // Caveat: user-installed MCP servers declared in the user's global
    // config may still surface tools. The `"*": "deny"` at the top of
    // the permission map applies across all tools, but opencode's
    // permission enforcement for MCP tools is not explicitly documented
    // as matching `"*"`. hosted-safe therefore assumes the operator has
    // vetted their MCP config; if they haven't, use hosted-sandboxed.
    let tempConfigDir: string | null = null
    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    if (req.mode === 'hosted-safe') {
      args.push('--agent', 'plan')
      tempConfigDir = mkdtempSync(join(tmpdir(), 'cli-bridge-opencode-safe-'))
      const configPath = join(tempConfigDir, 'opencode.json')
      writeFileSync(configPath, JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        permission: {
          '*': 'deny',
          read: 'allow',
          glob: 'allow',
          grep: 'allow',
        },
      }), 'utf8')
      childEnv.OPENCODE_CONFIG = configPath
    }

    args.push(prompt)

    const child = spawn(this.opts.bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: session?.cwd ?? process.cwd(),
      env: childEnv,
    })

    // Capture spawn failures (ENOENT, EACCES) into a local so the read
    // loop surfaces them as BackendError instead of leaking as an
    // unhandled 'error' event on the emitter.
    const spawnErr: { err: Error | null } = { err: null }
    child.on('error', (err) => { spawnErr.err = err })

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
        if (text) yield { content: text }

        if (
          type === 'message.completed'
          || type === 'turn.completed'
          || type === 'session.completed'
          || type === 'run.completed'
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
        else if (spawnErr.err) resolve(null)
        else {
          child.once('close', (code) => resolve(code))
          child.once('error', () => resolve(null))
        }
      })

      if (spawnErr.err) {
        throw new BackendError(`opencode spawn failed: ${spawnErr.err.message}`, 'cli_missing')
      }
      if (signal.aborted) {
        yield { finish_reason: 'error', internal_session_id: internalSessionId }
        return
      }
      if (sawError) throw new BackendError(`opencode: ${sawError}`, 'upstream')
      if (exitCode !== 0 && exitCode !== null) {
        throw new BackendError(`opencode exited ${exitCode}: ${stderr.slice(0, 300)}`, 'upstream')
      }
      yield { finish_reason: 'stop', internal_session_id: internalSessionId }
    } finally {
      clearTimeout(timeoutHandle)
      signal.removeEventListener('abort', onAbort)
      if (child.exitCode === null) child.kill('SIGTERM')
      if (tempConfigDir) {
        try { rmSync(tempConfigDir, { recursive: true, force: true }) }
        catch { /* best effort — temp dir cleanup */ }
      }
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

function pickSessionId(ev: Record<string, unknown>): string | null {
  for (const k of ['session_id', 'sessionId', 'session']) {
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
    (ev.part as Record<string, unknown> | undefined)?.text,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c
  }
  return null
}
