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
 * `kimi-k2.6`, or the CLI's configured default if the model is
 * omitted).
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

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentProfile } from '@tangle-network/sandbox'
import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError, JSON_MODE_DIRECTIVE, wantsJsonObject } from './types.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import {
  materialiseEmptyMcpConfig,
  materialiseMcpServersForClaudeKimi,
  resolveMcpServers,
  resolvePromptMessages,
} from './profile-support.js'
import { contentToText } from './content.js'
import { hostSpawner } from '../executors/host.js'
import type { Spawner } from '../executors/types.js'
import { readProcessLines, waitForProcessClose } from './process-lines.js'
import { writeStdinPayload } from './stdin-payload.js'

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
  private readonly prefix: string
  private readonly spawner: Spawner

  constructor(private readonly opts: KimiBackendOptions) {
    this.name = opts.harness ?? 'kimi-code'
    this.prefix = `${this.name}/`
    this.spawner = opts.spawner ?? hostSpawner
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === this.name || m.startsWith(this.prefix)
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
      'kimi hosted-safe requires a verified tool-disable flag path on kimi-cli')

    // Compose the full prompt and pipe via stdin instead of stuffing
    // it into argv. See backends/stdin-payload.ts for the rationale
    // (Linux MAX_ARG_STRLEN = 128 KiB per arg; any non-trivial
    // agentic call with tools[] or a long system prompt would E2BIG
    // on the previous `--prompt <text>` path).
    const prompt = this.buildPrompt(req, session)
    const model = this.resolveCliModel(req.model)
    const configFile = await this.prepareConfigFile(req.model)
    // Materialise agent_profile.mcp into a temp mcp-config.json. Same
    // shape claude expects ({mcpServers: {name: {command,args,env}}});
    // kimi takes the path via --mcp-config-file. Cleanup runs in the
    // outer finally so the temp dir doesn't leak when the subprocess
    // crashes.
    const mcpMaterialised =
      materialiseMcpServersForClaudeKimi(resolveMcpServers(req, session)) ?? materialiseEmptyMcpConfig()

    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
    ]
    if (configFile) {
      args.push('--config-file', configFile)
    }
    if (mcpMaterialised) {
      args.push('--mcp-config-file', mcpMaterialised.configPath)
    }
    if (session?.internalId) {
      args.push('--resume', session.internalId)
    }
    if (model) {
      args.push('--model', model)
    }
    const thinkingFlag = thinkingFlagForEffort(req.effort)
    if (thinkingFlag) args.push(thinkingFlag)

    const spawned = await this.spawner(this.opts.bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: req.cwd ?? session?.cwd ?? process.cwd(),
      env: process.env,
      ...(req.session_id ? { sessionId: req.session_id } : {}),
    })
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

    const timeoutHandle = setTimeout(() => child.kill('SIGTERM'), this.opts.timeoutMs)
    const onAbort = () => child.kill('SIGTERM')
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      let internalSessionId: string | undefined
      let stderr = ''
      let emittedContent = false
      let emittedToolCall = false
      if (spawnErrorMessage) {
        throw new BackendError(`kimi spawn failed: ${spawnErrorMessage}`, 'upstream')
      }
      if (!child.stdout) {
        throw new BackendError('kimi subprocess has no stdout pipe', 'upstream')
      }
      if (!child.stdin) {
        throw new BackendError('kimi subprocess has no stdin pipe', 'upstream')
      }

      // Pipe the prompt via stdin instead of argv. kimi's NDJSON input
      // schema matches claude-code's: {"type":"user","message":
      // {"role":"user","content":"..."}}, one per line.
      const stdinResult = await writeStdinPayload(child.stdin, [
        { role: 'user', content: prompt },
      ])
      if (!stdinResult.ok) {
        throw new BackendError(`kimi stdin write failed: ${stdinResult.error}`, 'upstream')
      }
      child.stderr?.on('data', (b) => {
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
                emittedToolCall = true
              }
            }
            // 'think' blocks are reasoning chain-of-thought; don't surface.
          }
        } else {
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
            finish_reason: sawError ? 'error' : (emittedToolCall ? 'tool_calls' : 'stop'),
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
      // Kimi CLI --print exits non-zero on some successful runs (known
      // quirk — the "To resume this session: kimi -r <uuid>" stderr
      // message is printed as a successful trailer, not an error). If
      // we observed real assistant content, treat exit non-zero as OK.
      if (exitCode !== 0 && exitCode !== null && !emittedContent) {
        throw new BackendError(`kimi exited ${exitCode}: ${stderr.slice(0, 300)}`, 'upstream')
      }
      if (!emittedContent && !emittedToolCall) {
        throw new BackendError(`kimi produced no stream output: ${stderr.slice(0, 300)}`, 'upstream')
      }
      yield { finish_reason: emittedToolCall ? 'tool_calls' : 'stop', internal_session_id: internalSessionId }
    } finally {
      clearTimeout(timeoutHandle)
      signal.removeEventListener('abort', onAbort)
      if (child.exitCode === null) child.kill('SIGTERM')
      if (configFile) await cleanupConfigFile(configFile)
      mcpMaterialised?.cleanup()
      releaseSpawner()
    }
  }

  /**
   * Build the final prompt text passed to `kimi --print --prompt`. Kimi
   * CLI has no `--append-system-prompt` equivalent and no native
   * json-mode flag, so when the caller asks for `json_object` we
   * prepend the directive to the user prompt. Best-effort — clients
   * should still strip markdown fences as a fallback.
   *
   * Exposed (not private) so tests can verify the prefix without
   * spawning a real subprocess.
   */
  buildPrompt(req: ChatRequest, session: SessionRecord | null): string {
    const flat = this.flattenPrompt(resolvePromptMessages(req, session))
    const preambles: string[] = []
    if (wantsJsonObject(req)) preambles.push(JSON_MODE_DIRECTIVE)
    return preambles.length > 0 ? `${preambles.join('\n\n')}\n\n${flat}` : flat
  }

  /** Exposed so tests can verify when the backend omits `--model`. */
  resolveCliModel(fullModel: string): string | null {
    // K2.6 is the required path on this machine, but the current Kimi
    // CLI is unstable when passed `--model kimi-code/kimi-k2.6`
    // explicitly. When the external caller requests that exact model,
    // route to the CLI's default model instead and require the local
    // config to pin that default to K2.6.
    const lower = fullModel.toLowerCase()
    if (lower === this.name || lower === `${this.prefix}kimi-k2.6`) return null

    // Kimi's config.toml uses `<provider>/<model>` as the literal key
    // (e.g. `kimi-code/kimi-for-coding`) — the harness prefix IS the
    // provider side of that key. Pass the full string through; stripping
    // the prefix makes `--model kimi-for-coding` fail with "LLM not set".
    if (lower.startsWith(this.prefix)) return fullModel
    return null
  }

  private async prepareConfigFile(fullModel: string): Promise<string | null> {
    if (fullModel.toLowerCase() !== `${this.prefix}kimi-k2.6`) return null

    const home = process.env.HOME
    if (!home) throw new BackendError('HOME is not set for kimi backend', 'not_configured')

    const source = join(home, '.kimi', 'config.toml')
    let config: string
    try {
      config = await readFile(source, 'utf8')
    } catch (error) {
      throw new BackendError(`failed to read Kimi config: ${source}`, 'not_configured', error)
    }

    const next = ensureK2DefaultConfig(config)
    const dir = await mkdtemp(join(tmpdir(), 'cli-bridge-kimi-'))
    const file = join(dir, 'config.toml')
    await writeFile(file, next, 'utf8')
    return file
  }

  private flattenPrompt(messages: ChatRequest['messages']): string {
    if (messages.length === 1) return contentToText(messages[0]?.content ?? '')
    return messages.map((m) => `[${m.role}] ${contentToText(m.content)}`).join('\n\n')
  }
}

function ensureK2DefaultConfig(config: string): string {
  const nextDefault = 'default_model = "kimi-code/kimi-k2.6"'
  let next = config

  if (/^default_model\s*=.*$/m.test(next)) {
    next = next.replace(/^default_model\s*=.*$/m, nextDefault)
  } else {
    next = `${nextDefault}\n${next}`
  }

  if (!/\[models\."kimi-code\/kimi-k2\.6"\]/.test(next)) {
    next += '\n\n[models."kimi-code/kimi-k2.6"]\n'
    next += 'provider = "managed:kimi-code"\n'
    next += 'model = "kimi-k2.6"\n'
    next += 'max_context_size = 262144\n'
    next += 'capabilities = ["thinking", "video_in", "image_in"]\n'
    next += 'display_name = "Kimi-k2.6"\n'
  }

  return next
}

export function thinkingFlagForEffort(effort: ChatRequest['effort']): '--thinking' | '--no-thinking' | null {
  if (!effort || effort === 'medium') return null
  if (effort === 'minimal' || effort === 'low') return '--no-thinking'
  return '--thinking'
}

async function cleanupConfigFile(file: string): Promise<void> {
  await rm(file, { force: true }).catch(() => undefined)
  await rm(dirname(file), { recursive: true, force: true }).catch(() => undefined)
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
