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
 * MCP: MCP support comes from the `pi-mcp-adapter` extension. When a request
 * carries MCP servers (X-Mcp-Config header, body `mcp.mcpServers`, or
 * `agent_profile.mcp`), the bridge writes a unique request-scoped config and
 * passes it through the adapter's `--mcp-config` flag. Concurrent Pi agents may
 * therefore share a task cwd without sharing control config. If the adapter is NOT
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
 *   {"type":"agent_end","messages":[...]}
 *
 * We surface text_delta as ChatDelta.content and pi tool-call lifecycle events
 * as OpenAI-shaped tool_calls so downstream trace consumers can observe native
 * pi tool activity. thinking_delta is dropped (matches how the kimi backend
 * handles its `think` blocks for non-thinking-aware callers).
 */

import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { versionHealth } from './health.js'
import { BackendError } from './types.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import {
  buildCanonicalMcpServers,
  materializeMcpServersForPi,
  provisionPiProfile,
  resolveAgentProfile,
  resolveMcpServers,
} from './profile-support.js'
import { contentToText } from './content.js'
import { scopedHostSpawner } from '../executors/scoped-host.js'
import { resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import { readProcessLines, waitForProcessClose } from './process-lines.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'
import { terminateSpawned } from '../executors/process-tree.js'

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

function resolveReasoningEffort(
  req: ChatRequest,
  profile: ReturnType<typeof resolveAgentProfile>,
): ChatRequest['effort'] {
  const profileEffort = profile?.model?.reasoningEffort
  if (profileEffort && req.effort && profileEffort !== req.effort) {
    throw new BackendError(
      `request effort ${JSON.stringify(req.effort)} conflicts with agent_profile.model.reasoningEffort ${JSON.stringify(profileEffort)}`,
      'parse_error',
    )
  }
  return profileEffort ?? req.effort
}

/**
 * Pi's MCP adapter keeps its compact proxy by default. A request profile,
 * however, declares actual tools rather than a second protocol the model must
 * learn before it can reach those tools. Select every request-supplied server
 * for direct exposure, preserving any ambient selectors without naming a
 * particular server or tool in bridge source.
 */
function piDirectToolSelection(
  requestedServerNames: readonly string[],
  ambientSelection: string | undefined,
): string | undefined {
  if (requestedServerNames.length === 0) return ambientSelection

  const unsupported = requestedServerNames.filter((name) => name.includes(',') || name.includes('/'))
  if (unsupported.length > 0) {
    throw new BackendError(
      `backend pi cannot expose MCP server name(s) through pi-mcp-adapter: ${unsupported.join(', ')}; `
      + 'server names used by this backend cannot contain "," or "/"',
      'not_configured',
    )
  }

  const ambient = ambientSelection && ambientSelection !== '__none__'
    ? ambientSelection.split(',').map((entry) => entry.trim()).filter(Boolean)
    : []
  return [...new Set([...ambient, ...requestedServerNames])].join(',')
}

/**
 * Translate the handled `extensions.pi.load` control into an exact extension
 * set. This is the provider-specific half that the shared profile materializer
 * deliberately leaves to Pi.
 *
 * An explicit list disables every ambient extension before loading only its
 * entries. Absent `load` preserves Pi's normal global extension discovery,
 * which remains necessary for existing provider packages such as pi-zai-glm.
 */
function piExtensionArgs(
  req: ChatRequest,
  session: SessionRecord | null,
  needsMcpAdapter: boolean,
): string[] {
  const pi = resolveAgentProfile(req, session)?.extensions?.pi
  if (pi === undefined) return []
  if (!pi || typeof pi !== 'object' || Array.isArray(pi)) {
    throw new BackendError('extensions.pi must be an object', 'parse_error')
  }

  const unknown = Object.keys(pi).filter((key) => key !== 'load')
  if (unknown.length > 0) {
    throw new BackendError(
      `unsupported extensions.pi controls: ${unknown.sort().join(', ')}`,
      'parse_error',
    )
  }
  if (!Object.hasOwn(pi, 'load')) return []

  const load = pi.load
  if (!Array.isArray(load) || load.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new BackendError('extensions.pi.load must be an array of non-empty strings', 'parse_error')
  }
  if (
    needsMcpAdapter
    && !load.some((entry) => entry === 'pi-mcp-adapter' || entry === 'npm:pi-mcp-adapter')
  ) {
    throw new BackendError(
      'extensions.pi.load must include the installed pi-mcp-adapter package when the profile requests MCP servers',
      'parse_error',
    )
  }

  const configuredAgentDir = process.env.PI_CODING_AGENT_DIR
  const hostNpmRoot = join(configuredAgentDir ?? join(homedir(), '.pi', 'agent'), 'npm', 'node_modules')
  // Pi expands `~` itself. Keeping the default path HOME-relative makes the
  // same argv work for host execution and for a container whose mounted Pi
  // agent directory lives under a different HOME.
  // A confined run sees the selected host AgentDir at one stable in-jail path.
  // Use that path for explicit extensions too; retaining the host's absolute
  // custom path would make the config readable but leave its packages hidden.
  const runtimeAgentDir = req.jailSpec
    ? join(req.jailSpec.root, '.pi', 'agent')
    : configuredAgentDir ?? '~/.pi/agent'
  const runtimeNpmRoot = join(runtimeAgentDir, 'npm', 'node_modules')
  const entries = new Set((load as string[]).map((spec) =>
    resolvePiExtensionPath(spec.trim(), hostNpmRoot, runtimeNpmRoot),
  ))
  return [
    '--no-extensions',
    ...[...entries].flatMap((entry) => ['--extension', entry]),
  ]
}

function resolvePiExtensionPath(spec: string, hostNpmRoot: string, runtimeNpmRoot: string): string {
  const normalized = spec.startsWith('npm:') ? spec.slice(4) : spec
  if (isAbsolute(normalized)) {
    if (existsSync(normalized)) return normalized
    throw new BackendError(
      `backend pi cannot load extension "${spec}": ${normalized} does not exist`,
      'not_configured',
    )
  }
  if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/u.test(normalized)) {
    throw new BackendError(
      `backend pi cannot load extension "${spec}": expected an installed package name or absolute path`,
      'not_configured',
    )
  }
  const hostPath = join(hostNpmRoot, normalized)
  if (!existsSync(hostPath)) {
    throw new BackendError(
      `backend pi cannot load extension "${spec}": ${hostPath} does not exist`,
      'not_configured',
    )
  }
  // Pi accepts package directories directly and applies its own package.json
  // manifest, glob, and conventional-directory rules. Keeping that logic in Pi
  // avoids a second, inevitably incomplete package loader in the bridge.
  return join(runtimeNpmRoot, normalized)
}

/**
 * True when pi can actually consume MCP config — i.e. the
 * `pi-mcp-adapter` extension is installed. Pi itself ships no MCP
 * support, so passing MCP config without the adapter is a silent
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
      return settings.packages.some((p) => {
        if (typeof p !== 'string') return false
        if (p.includes('pi-mcp-adapter')) return true
        // Local-path installs (`/some/dir`, `./rel`, `file:…`, `path:…`) may
        // not carry the adapter's name in the path — resolve the
        // package.json name. Relative specs resolve against the agent dir
        // (where settings.json lives), NOT the bridge process cwd.
        const spec = p.replace(/^(file|path):(\/\/)?/, '')
        // `isAbsolute` covers POSIX and (on Windows builds) drive-letter
        // forms; the explicit drive-letter check keeps a Windows-authored
        // settings.json from being misread as an npm name elsewhere.
        const winAbsolute = /^[A-Za-z]:[\\/]/.test(spec)
        if (!isAbsolute(spec) && !winAbsolute && !spec.startsWith('.')) return false
        const localPath = isAbsolute(spec) || winAbsolute ? spec : join(agentDir, spec)
        try {
          const pkg = JSON.parse(readFileSync(join(localPath, 'package.json'), 'utf-8')) as { name?: unknown }
          return pkg.name === 'pi-mcp-adapter'
        } catch {
          return false
        }
      })
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
    return versionHealth(this.name, this.opts.bin, this.spawner)
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
    const profile = resolveAgentProfile(req, session)

    const args: string[] = [
      '--print',
      '--mode', 'json',
    ]
    if (spec.provider) args.push('--provider', spec.provider)
    if (spec.model) args.push('--model', spec.model)
    if (session?.internalId) {
      args.push('--session', session.internalId)
    } else if (req.session_id) {
      // Pi's implicit persistent-session path drops request-scoped system
      // prompt overrides while creating the first session. Give Pi an explicit
      // internal id so the first turn uses the profile and report that id back
      // through the normal session event for subsequent `--session` resumes.
      args.push('--session-id', randomUUID())
    } else if (!req.session_id) {
      // Only a truly anonymous call is stateless.
      args.push('--no-session')
    }
    const thinking = thinkingFlagForEffort(resolveReasoningEffort(req, profile))
    if (thinking) args.push('--thinking', thinking)

    const runCwd = resolveSpawnerCwd(this.spawner, req.cwd ?? session?.cwd ?? undefined)

    // MCP servers (X-Mcp-Config header ∪ body `mcp.mcpServers` ∪
    // `agent_profile.mcp`) reach pi-mcp-adapter through its per-process
    // config flag. FAIL-LOUD, not fail-safe: if the caller
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

    // The provider-specific extension namespace, MCP config, and canonical profile
    // files all use Pi's per-process loaders. Every flag precedes the positional
    // prompt, and large prompt material rides file paths rather than argv.
    args.push(...piExtensionArgs(req, session, requestedMcpNames.length > 0))
    let mcpMounted: ReturnType<typeof materializeMcpServersForPi> = null
    let provisioned: ReturnType<typeof provisionPiProfile> = null
    let spawned: Awaited<ReturnType<Spawner>>
    try {
      mcpMounted = requestedMcpNames.length > 0
        ? materializeMcpServersForPi(mcpSpecs, runCwd)
        : null
      if (mcpMounted) args.push('--mcp-config', mcpMounted.configPath)
      provisioned = provisionPiProfile(req, session, runCwd)
      if (provisioned) args.push(...provisioned.flags)
      // The task prompt remains the sole positional message. Profile system and
      // additive instructions retain their native, separate authority channels.
      args.push(prompt)
      spawned = await this.spawner(this.opts.bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: runCwd,
        env: {
          ...process.env,
          ...(provisioned?.env ?? {}),
          ...(requestedMcpNames.length > 0
            ? {
                MCP_DIRECT_TOOLS: piDirectToolSelection(
                  requestedMcpNames,
                  process.env.MCP_DIRECT_TOOLS,
                ),
              }
            : {}),
        },
        ...(req.session_id ? { sessionId: req.session_id } : {}),
        ...(req.jailSpec ? { jail: req.jailSpec } : {}),
      })
    } catch (err) {
      mcpMounted?.cleanup()
      provisioned?.cleanup()
      throw err
    }
    const child = spawned.child
    const releaseSpawner = spawned.release

    let spawnErrorMessage = ''
    child.on('error', (err) => { spawnErrorMessage = err.message })
    const earlySpawnError = spawned.spawnError?.()
    if (earlySpawnError) spawnErrorMessage = earlySpawnError.message

    // Group-kill on timeout/abort — see backends/opencode.ts.
    const timeoutHandle = setTimeout(() => { void terminateSpawned(spawned) }, this.opts.timeoutMs)
    const onAbort = (): void => { void terminateSpawned(spawned) }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      let internalSessionId: string | undefined
      const stderr = new BoundedDiagnosticBuffer()
      let emittedContent = false
      let emittedToolCall = false
      let sawError: string | null = null
      let sawTurnUsage = false
      // Pi reports provider failures on the assistant message, not as an `error` event:
      // it exits 0 with `turn_end.message.stopReason === 'error'` and an `errorMessage`.
      // Only the LAST turn decides, because pi auto-retries a transient failure and the
      // retry's turn_end supersedes it (`auto_retry_start`/`auto_retry_end`).
      let turnFailure: string | null = null
      const usageCost: PiUsageCost = {
        receipts: 0,
        total: 0,
        complete: true,
      }
      const piToolCalls = new PiToolCallTracker()

      child.stderr?.on('data', (b) => { stderr.append(b) })

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

        // Pi emits one turn_end.message.usage receipt for every model call.
        // Emit each receipt immediately: retaining only the last call
        // undercounts tool loops, and waiting for agent_end loses completed
        // calls when the outer run is cancelled.
        if (type === 'turn_end') {
          turnFailure = piAssistantFailure(ev.message)
          const receipts = piUsageReceiptsFromEvent(ev)
          if (receipts.length > 0) sawTurnUsage = true
          for (const receipt of receipts) {
            recordPiUsageCost(usageCost, receipt)
            yield { usage: piTokenUsage(receipt) }
          }
          continue
        }

        // Older Pi versions may report usage only at agent_end, either as one
        // aggregate or as messages[].usage. This is fallback-only because
        // current Pi repeats calls already observed at turn_end.
        if (type === 'agent_end') {
          if (!sawTurnUsage) {
            for (const receipt of piUsageReceiptsFromEvent(ev)) {
              recordPiUsageCost(usageCost, receipt)
              yield { usage: piTokenUsage(receipt) }
            }
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

      // Per-turn token receipts stay observable. Cost is emitted once, only
      // after every contributing call proved its amount; a partial sum must
      // never be presented as the run's complete cost.
      if (usageCost.receipts > 0 && usageCost.complete) {
        yield {
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cost: usageCost.total,
            cost_scope: 'total',
          },
        }
      }

      if (signal.aborted) {
        yield { finish_reason: 'error' }
        return
      }

      if (spawnErrorMessage) {
        throw new BackendError(`pi spawn failed: ${spawnErrorMessage}`, 'upstream')
      }

      if (exitCode !== 0) {
        const detail = sawError ?? (stderr.render(300) || `exit ${exitCode ?? 'unknown'}`)
        throw new BackendError(
          `pi exit ${exitCode ?? 'unknown'}: ${detail}`,
          piFailureKind(detail),
        )
      }

      // A failed provider call must never complete as success. Pi exits 0 and the text it
      // did stream is a truncated answer, so this throws even when content was emitted —
      // an empty or partial body reported as `stop` is silent data loss for any caller
      // scoring outcomes, which is exactly what agent-runtime's piExecutor refuses.
      if (turnFailure) {
        throw new BackendError(`pi assistant turn failed: ${turnFailure}`, piFailureKind(turnFailure))
      }

      if (sawError && !emittedContent && !emittedToolCall) {
        throw new BackendError(`pi error: ${sawError}`, 'upstream')
      }

      yield {
        finish_reason: emittedToolCall ? 'tool_calls' : 'stop',
      }
    } finally {
      clearTimeout(timeoutHandle)
      signal.removeEventListener('abort', onAbort)
      // Reap the whole subtree before releasing the slot.
      await terminateSpawned(spawned)
      try { releaseSpawner() } catch { /* best effort */ }
      mcpMounted?.cleanup()
      provisioned?.cleanup()
    }
  }

  /** Preserve a single task exactly; serialize only genuine multi-message input. */
  private buildPrompt(req: ChatRequest): string {
    const messages = req.messages.flatMap((message) => {
      const text = contentToText(message.content)
      return text ? [{ message, text }] : []
    })
    if (messages.length === 1 && messages[0]?.message.role === 'user') {
      return messages[0].text
    }

    const parts: string[] = []
    for (const { message: msg, text } of messages) {
      const prefix = msg.role === 'system' ? 'System: '
        : msg.role === 'user' ? 'User: '
        : msg.role === 'assistant' ? 'Assistant: '
        : `${msg.role}: `
      parts.push(`${prefix}${text}`)
    }
    return parts.join('\n\n')
  }
}

interface PiUsageReceipt {
  input: number
  output: number
  cost?: number
}

interface PiUsageCost {
  receipts: number
  total: number
  complete: boolean
}

/** Read a provider failure off a `turn_end` assistant message, or null when the turn succeeded.
 *
 *  Pi's `AssistantMessage` carries `stopReason: 'stop' | 'length' | 'toolUse' | 'error' |
 *  'aborted'` plus an optional `errorMessage` (pi 0.83.0 `docs/session-format.md`). A provider
 *  failure produces neither a `type: 'error'` event nor a non-zero exit, so this message is the
 *  only failure signal on the wire.
 *
 *  `aborted` is deliberately NOT a failure here: the caller's `AbortSignal` already owns that
 *  path and reports `finish_reason: 'error'` before this is consulted. */
function piAssistantFailure(message: unknown): string | null {
  const value = record(message)
  if (!value) return null
  const stopReason = typeof value.stopReason === 'string' ? value.stopReason : undefined
  const errorMessage = typeof value.errorMessage === 'string' ? value.errorMessage.trim() : ''
  if (stopReason !== 'error' && errorMessage === '') return null
  return errorMessage !== '' ? errorMessage : `stopReason=${stopReason ?? 'error'}`
}

/** Auth/scope failures are a local credential problem, not a transient upstream one, whether they
 *  arrive on pi's stderr or in the provider's error body. */
function piFailureKind(detail: string): 'not_configured' | 'upstream' {
  return /401|403|token expired|forbidden|unauthorized/i.test(detail) ? 'not_configured' : 'upstream'
}

function piUsageReceiptsFromEvent(ev: Record<string, unknown>): PiUsageReceipt[] {
  const message = record(ev.message)
  const partial = record(ev.partial)
  const direct = record(ev.usage) ?? record(message?.usage) ?? record(partial?.usage)
  if (direct) {
    const receipt = piUsageFromRecord(direct)
    return receipt ? [receipt] : []
  }

  if (!Array.isArray(ev.messages)) return []
  const receipts: PiUsageReceipt[] = []
  for (const item of ev.messages) {
    const usage = record(record(item)?.usage)
    if (!usage) continue
    const receipt = piUsageFromRecord(usage)
    if (receipt) receipts.push(receipt)
  }
  return receipts
}

function piUsageFromRecord(usage: Record<string, unknown>): PiUsageReceipt | undefined {
  // Native Pi usage separates fresh input, cache reads, and cache writes.
  // OpenAI prompt_tokens already includes all three, so never add cache fields
  // to that older aggregate shape.
  const nativeInput = piTokenCount(usage.input ?? usage.inputTokens, 'input')
  const openAiInput = piTokenCount(usage.prompt_tokens, 'prompt_tokens')
  const cacheRead = piTokenCount(
    usage.cacheRead ?? usage.cache_read_input_tokens ?? usage.cacheReadInputTokens,
    'cacheRead',
  )
  const cacheWrite = piTokenCount(
    usage.cacheWrite ?? usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens,
    'cacheWrite',
  )
  const output = piTokenCount(
    usage.output ?? usage.outputTokens ?? usage.completion_tokens,
    'output',
  )
  if (
    nativeInput === undefined
    && openAiInput === undefined
    && cacheRead === undefined
    && cacheWrite === undefined
    && output === undefined
  ) {
    return undefined
  }

  const rawCost = usage.cost
  const nestedCost = record(rawCost)
  const cost = piCost(nestedCost ? nestedCost.total : rawCost)
  return {
    input: openAiInput ?? (nativeInput ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
    output: output ?? 0,
    ...(cost !== undefined ? { cost } : {}),
  }
}

function piTokenUsage(receipt: PiUsageReceipt): NonNullable<ChatDelta['usage']> {
  return {
    input_tokens: receipt.input,
    output_tokens: receipt.output,
  }
}

function recordPiUsageCost(total: PiUsageCost, receipt: PiUsageReceipt): void {
  total.receipts += 1
  if (receipt.cost === undefined) {
    total.complete = false
    return
  }
  total.total += receipt.cost
}

function piTokenCount(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new BackendError(`pi reported invalid ${field} token count`, 'upstream')
  }
  return value
}

function piCost(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BackendError('pi reported invalid usage cost', 'upstream')
  }
  return value
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
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
