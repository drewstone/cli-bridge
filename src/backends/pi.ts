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
 * MCP: pi's CLI has no `--mcp-config` flag — MCP support comes from the
 * `pi-mcp-adapter` extension, which discovers the canonical `{mcpServers}`
 * JSON from `<cwd>/.mcp.json` / `<cwd>/.pi/mcp.json`. When a request
 * carries MCP servers (X-Mcp-Config header, body `mcp.mcpServers`, or
 * `agent_profile.mcp`), the bridge writes `<cwd>/.pi/mcp.json` for the
 * run and removes/restores it afterwards. If the adapter is NOT
 * installed the request is REJECTED (`not_configured`) instead of
 * silently dropping the servers — a run whose tools never existed must
 * fail loudly, not score zero structurally. Detection: `pi-mcp-adapter`
 * in the pi agent dir's npm node_modules or `settings.json` packages
 * (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`); override with
 * `CLI_BRIDGE_PI_MCP_ADAPTER=1|0`.
 *
 * Event shapes we parse (from `pi --print --mode json`):
 *
 *   {"type":"session","id":"<uuid>",...}
 *   {"type":"agent_start"}
 *   {"type":"turn_start"}
 *   {"type":"message_update","assistantMessageEvent":{
 *      "type":"thinking_delta"|"text_delta"|"tool_call_start"|...,
 *      "delta":"...", "contentIndex":N, ... }}
 *   {"type":"message_update","assistantMessageEvent":{
 *      "type":"toolcall_start"|"toolcall_end",
 *      "partial":{"content":[{"type":"toolCall",...}]},
 *      "toolCall":{...} }}
 *   {"type":"tool_execution_start","toolCallId":"...","toolName":"...","args":{...}}
 *   {"type":"turn_end","message":{"usage":{...}}}
 *   {"type":"agent_end"}
 *
 * We surface text_delta as ChatDelta.content and pi tool-call lifecycle events
 * as OpenAI-shaped tool_calls so downstream trace consumers can observe native
 * pi tool activity. thinking_delta is dropped (matches how the kimi backend
 * handles its `think` blocks for non-thinking-aware callers).
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import {
  buildCanonicalMcpServers,
  materializeMcpServersForPi,
  provisionProfileWorkspace,
  resolveMcpServers,
  resolvePromptMessages,
} from './profile-support.js'
import { contentToText } from './content.js'
import { scopedHostSpawner } from '../executors/scoped-host.js'
import type { Spawner } from '../executors/types.js'
import { readProcessLines, waitForProcessClose } from './process-lines.js'
import { killTree } from '../executors/process-tree.js'

export interface PiBackendOptions {
  bin: string
  timeoutMs: number
  /** Subprocess spawner. Defaults to scoped host. */
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
  // Canonical ladder → pi's: none → off, ultracode → xhigh (pi's ceiling); the rest pass through.
  const e = effort === 'none' ? 'off' : effort === 'ultracode' ? 'xhigh' : effort
  return allowed.has(e) ? e : null
}

/**
 * True when pi can actually consume MCP config — i.e. the
 * `pi-mcp-adapter` extension is installed. Pi itself ships no MCP
 * support, so mounting `.pi/mcp.json` without the adapter is a silent
 * no-op; callers use this to fail loudly instead.
 *
 * `CLI_BRIDGE_PI_MCP_ADAPTER=1|0` overrides detection for nonstandard
 * installs (e.g. the adapter vendored under a local package path whose
 * name doesn't contain "pi-mcp-adapter").
 */
export function piMcpAdapterAvailable(): boolean {
  const override = process.env.CLI_BRIDGE_PI_MCP_ADAPTER
  if (override === '1' || override === 'true') return true
  if (override === '0' || override === 'false') return false
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
  if (existsSync(join(agentDir, 'npm', 'node_modules', 'pi-mcp-adapter'))) return true
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf-8')) as { packages?: unknown }
    if (Array.isArray(settings.packages)) {
      return settings.packages.some((p) => typeof p === 'string' && p.includes('pi-mcp-adapter'))
    }
  } catch {
    // unreadable/absent settings — fall through to "not detected"
  }
  return false
}

export class PiBackend implements Backend {
  readonly name = 'pi'
  private readonly spawner: Spawner

  constructor(private readonly opts: PiBackendOptions) {
    this.spawner = opts.spawner ?? scopedHostSpawner
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

    const runCwd = req.cwd ?? session?.cwd ?? process.cwd()

    // MCP servers (X-Mcp-Config header ∪ body `mcp.mcpServers` ∪
    // `agent_profile.mcp`) mount as `<cwd>/.pi/mcp.json` for the
    // pi-mcp-adapter extension. FAIL-LOUD, not fail-safe: if the caller
    // requested MCP tools pi can't provide, reject the request — a
    // silently tool-less run scores zero for the wrong reason.
    const mcpSpecs = resolveMcpServers(req, session)
    const requestedMcpNames = mcpSpecs ? Object.keys(buildCanonicalMcpServers(mcpSpecs)) : []
    if (requestedMcpNames.length > 0 && !piMcpAdapterAvailable()) {
      throw new BackendError(
        `backend pi cannot mount MCP servers: pi-mcp-adapter extension not installed `
        + `(run \`pi install npm:pi-mcp-adapter\` or set CLI_BRIDGE_PI_MCP_ADAPTER=1); `
        + `requested: ${requestedMcpNames.join(', ')}`,
        'not_configured',
      )
    }
    const mcpMounted = requestedMcpNames.length > 0
      ? materializeMcpServersForPi(mcpSpecs, runCwd)
      : null

    // Phase-2 host wiring: provision cwd-native profile dimensions before spawn. Fail-safe.
    provisionProfileWorkspace(req, session, 'pi', runCwd)
    let spawned: Awaited<ReturnType<Spawner>>
    try {
      spawned = await this.spawner(this.opts.bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: runCwd,
        env: process.env,
        ...(req.session_id ? { sessionId: req.session_id } : {}),
        ...(req.jailSpec ? { jail: req.jailSpec } : {}),
      })
    } catch (err) {
      // `.pi/mcp.json` lives in the caller's workspace, not a temp dir —
      // never leave it behind when the subprocess failed to spawn.
      mcpMounted?.cleanup()
      throw err
    }
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
      let emittedToolCall = false
      let sawError: string | null = null
      let usage: { input?: number; output?: number } | undefined
      const piToolCalls = new PiToolCallTracker()

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

        // Final turn_end / agent_end carries usage when pi reports it.
        // Different pi versions have emitted usage on the event itself,
        // on `message.usage`, or on `partial.usage`; accept all three
        // shapes so backend-integrity guards see real token activity.
        if (type === 'turn_end' || type === 'agent_end') {
          const message = ev.message as Record<string, unknown> | undefined
          const partial = ev.partial as Record<string, unknown> | undefined
          const u = (ev.usage ?? message?.usage ?? partial?.usage) as
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
          const toolCall = piToolCalls.observe(ame, ameType)
          if (toolCall) {
            emittedToolCall = true
            yield { tool_calls: [toolCall] }
          }
          // thinking_*, message_start, message_end — drop for now.
          // Future enhancement: surface thinking as a separate ChatDelta
          // variant once the OpenAI o1-style schema lands.
          continue
        }

        const toolCall = piToolCalls.observe(ev, type)
        if (toolCall) {
          emittedToolCall = true
          yield { tool_calls: [toolCall] }
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

      if (sawError && !emittedContent && !emittedToolCall) {
        throw new BackendError(`pi error: ${sawError}`, 'upstream')
      }

      yield {
        finish_reason: emittedToolCall ? 'tool_calls' : 'stop',
        ...(usage ? { usage: { input_tokens: usage.input, output_tokens: usage.output } } : {}),
      }
    } finally {
      clearTimeout(timeoutHandle)
      signal.removeEventListener('abort', onAbort)
      // Reap the whole subtree before releasing the slot.
      await killTree(child)
      try { releaseSpawner() } catch { /* best effort */ }
      mcpMounted?.cleanup()
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

type ToolCallDelta = NonNullable<ChatDelta['tool_calls']>[number]

class PiToolCallTracker {
  private readonly emitted = new Set<string>()
  private readonly byIndex = new Map<number, string>()
  private nextSyntheticId = 0

  observe(ev: Record<string, unknown>, eventType: string): ToolCallDelta | null {
    const normalized = normalizePiEventType(eventType)
    if (!isPiToolLifecycleEvent(normalized)) return null

    const tool = this.pickNestedTool(ev)
    const id = this.pickToolCallId(ev, tool) ?? this.idForContentIndex(ev)
    const name = this.pickToolName(ev, tool)
    const args = this.pickToolArguments(ev, tool)

    if (!id || !name || this.emitted.has(id)) return null
    if (this.shouldDefer(normalized, args)) return null
    this.emitted.add(id)
    return {
      id,
      name,
      arguments: stringifyToolArguments(args),
    }
  }

  private shouldDefer(normalized: string, args: unknown): boolean {
    // Pi's real `toolcall_start` frame usually has id/name and an empty
    // arguments object; `toolcall_delta` then streams partial JSON and may
    // start with delta:"". Wait for `toolcall_end` / `tool_execution_start`
    // with the complete args. Emitting early would make every downstream trace
    // see `{}` or an incomplete path forever because tool calls are de-duped.
    if (normalized.includes('delta')) return true
    return normalized.includes('start') && !normalized.startsWith('tool_execution') && isEmptyToolArguments(args)
  }

  private pickToolCallId(ev: Record<string, unknown>, tool: Record<string, unknown> | null): string | null {
    for (const key of ['id', 'toolCallId', 'toolCallID', 'tool_call_id', 'callId', 'callID']) {
      const value = ev[key]
      if (typeof value === 'string' && value.length > 0) return value
    }

    if (tool) {
      for (const key of ['id', 'toolCallId', 'toolCallID', 'tool_call_id', 'callId', 'callID']) {
        const value = tool[key]
        if (typeof value === 'string' && value.length > 0) return value
      }
    }

    return null
  }

  private idForContentIndex(ev: Record<string, unknown>): string {
    const raw = ev.contentIndex ?? ev.content_index ?? ev.index
    const index = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isFinite(index)) {
      const existing = this.byIndex.get(index)
      if (existing) return existing
      const id = `pi_call_${index}`
      this.byIndex.set(index, id)
      return id
    }

    this.nextSyntheticId += 1
    return `pi_call_${this.nextSyntheticId}`
  }

  private pickToolName(ev: Record<string, unknown>, tool: Record<string, unknown> | null): string | null {
    for (const key of ['name', 'toolName', 'tool_name', 'tool']) {
      const value = ev[key]
      if (typeof value === 'string' && value.length > 0) return value
    }

    if (tool) {
      for (const key of ['name', 'toolName', 'tool_name', 'tool']) {
        const value = tool[key]
        if (typeof value === 'string' && value.length > 0) return value
      }
    }

    return null
  }

  private pickToolArguments(ev: Record<string, unknown>, tool: Record<string, unknown> | null): unknown {
    for (const key of ['input', 'arguments', 'args', 'parameters', 'delta']) {
      if (ev[key] !== undefined) return ev[key]
    }

    if (tool) {
      for (const key of ['input', 'arguments', 'args', 'parameters', 'partialArgs']) {
        if (tool[key] !== undefined) return tool[key]
      }
    }

    return {}
  }

  private pickNestedTool(ev: Record<string, unknown>): Record<string, unknown> | null {
    for (const key of ['toolCall', 'tool_call', 'toolCallRequest', 'tool_call_request', 'tool']) {
      const value = ev[key]
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>
      }
    }
    const partial = ev.partial
    if (partial && typeof partial === 'object' && !Array.isArray(partial)) {
      const content = (partial as Record<string, unknown>).content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && !Array.isArray(block)) {
            const candidate = block as Record<string, unknown>
            const kind = String(candidate.type ?? '').replace(/-/g, '_').toLowerCase()
            if (kind === 'toolcall' || kind === 'tool_call') return candidate
          }
        }
      }
    }
    return null
  }
}

function normalizePiEventType(eventType: string): string {
  return eventType.replace(/-/g, '_').toLowerCase()
}

function isPiToolLifecycleEvent(normalized: string): boolean {
  return normalized.includes('tool_call')
    || normalized.includes('toolcall')
    || normalized.startsWith('tool_execution')
}

function isEmptyToolArguments(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.length === 0
  if (typeof value !== 'object') return false
  if (Array.isArray(value)) return value.length === 0
  return Object.keys(value as Record<string, unknown>).length === 0
}

function stringifyToolArguments(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return '{}'
  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}
