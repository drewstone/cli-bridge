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

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError, JSON_MODE_DIRECTIVE, wantsJsonObject } from './types.js'
import { ModeNotSupportedError, type BridgeMode } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import {
  buildMcpAllowList,
  materialiseMcpServersForClaudeKimi,
  renderLocalHarnessProfilePreamble,
  resolveAgentProfile,
  resolveMcpServers,
  type MaterialisedMcpConfig,
} from './profile-support.js'
import { contentToText } from './content.js'
import { hostSpawner } from '../executors/host.js'
import type { Spawner } from '../executors/types.js'
import { readProcessLines, waitForProcessClose } from './process-lines.js'
import { writeStdinPayload } from './stdin-payload.js'

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
  /**
   * Subprocess spawner. Defaults to host node spawn. Pass a
   * docker-pooled spawner to run claude inside isolated containers
   * (per-call FS isolation; safe parallelism). See
   * `src/executors/docker.ts` + `container-pool.ts`.
   */
  spawner?: Spawner
}

export class ClaudeBackend implements Backend {
  readonly name: string
  private readonly bin: string
  private readonly timeoutMs: number
  private readonly anthropicBaseUrl: string | null
  private readonly prefix: string
  private readonly spawner: Spawner

  constructor(opts: ClaudeBackendOptions) {
    this.name = opts.harness ?? 'claude'
    this.bin = opts.bin
    this.timeoutMs = opts.timeoutMs
    this.anthropicBaseUrl = opts.anthropicBaseUrl ?? null
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
      const spawned = await this.spawner(this.bin, ['--version'], {
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

    // Two transport modes for sending the user message to claude-code-cli:
    //
    //   1. `-p <text>` ARGV — claude-code's "single-shot text" mode.
    //      Single non-interactive turn. Forced to produce an output
    //      and exit. PREFERRED.
    //
    //   2. `--input-format stream-json` STDIN — claude-code's
    //      "interactive agent loop" mode. FALLBACK only, used when
    //      the user text overflows the argv-per-string limit.
    //
    // We use argv when the user-message string fits the kernel's
    // per-arg limit (MAX_ARG_STRLEN = 128 KiB). Fall back to stdin
    // when it overflows. System content (agent profile preamble,
    // JSON-mode directive, etc.) goes through --append-system-prompt
    // regardless of which user-message transport is chosen — see
    // buildArgs/composeStdinInput.
    const stdinInput = this.composeStdinInput(req, session)
    const userText = stdinInput.messages[0]?.content ?? ''
    const PROMPT_ARGV_LIMIT = 120 * 1024
    const userFitsInArgv = Buffer.byteLength(userText, 'utf8') <= PROMPT_ARGV_LIMIT
    // Materialise MCP servers (if any) into a temp config file BEFORE
    // building args — buildArgs needs the path. Tracked so we can clean
    // up the temp dir after the subprocess exits.
    //
    // Merges request-body `mcp.mcpServers` and `agent_profile.mcp` into
    // one map; request-body wins on name collisions. See
    // `resolveMcpServers` for the contract.
    const mcpMaterialised = materialiseMcpServersForClaudeKimi(
      resolveMcpServers(req, session),
    )
    const args = this.buildArgs(req, session, mode, mcpMaterialised, {
      userTextForArgv: userFitsInArgv ? userText : undefined,
    })

    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    if (this.anthropicBaseUrl) {
      childEnv.ANTHROPIC_BASE_URL = this.anthropicBaseUrl
    }

    // Argv mode: stdin is ignored. Stdin mode: stdin is piped (we
    // write the NDJSON payload below). The split here matches the
    // contract claude-code-cli expects for each --input-format.
    const spawned = await this.spawner(this.bin, args, {
      stdio: userFitsInArgv ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      cwd: req.cwd ?? session?.cwd ?? process.cwd(),
      env: childEnv,
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

    const timeoutHandle = setTimeout(() => {
      child.kill('SIGTERM')
    }, this.timeoutMs)

    const onAbort = () => child.kill('SIGTERM')
    signal.addEventListener('abort', onAbort, { once: true })

    let emittedAnyToolCall = false
    try {
      let internalSessionId: string | undefined
      let stderr = ''
      child.stderr?.on('data', (b) => { stderr += b.toString() })

      if (spawnErrorMessage) {
        throw new BackendError(`claude spawn failed: ${spawnErrorMessage}`, 'upstream')
      }
      if (!child.stdout) {
        throw new BackendError('claude subprocess has no stdout pipe', 'upstream')
      }

      // Stdin-mode fallback path: write the NDJSON-framed user
      // message and close stdin so claude sees EOF. Argv-mode (the
      // default fast path) carries the user text via `-p <text>` and
      // child.stdin is 'ignore'.
      if (!userFitsInArgv) {
        if (!child.stdin) {
          throw new BackendError('claude subprocess has no stdin pipe', 'upstream')
        }
        const writeResult = await writeStdinPayload(child.stdin, stdinInput.messages)
        if (!writeResult.ok) {
          throw new BackendError(`claude stdin write failed: ${writeResult.error}`, 'upstream')
        }
      }
      for await (const event of readProcessLines({ child, stdout: child.stdout })) {
        if (event.kind !== 'line') continue
        const line = event.line
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
              // claude-code-cli emits `tool_use` for its own built-in
              // tools (Read, Bash, Edit, ToolSearch, ...) and for any
              // MCP server tools loaded via --mcp-config. Surface them
              // to the caller as OpenAI tool_calls — that IS the
              // contract for callers that registered MCP servers and
              // want the model's tool surface visible.
              yield {
                tool_calls: [{
                  id: block.id,
                  name: block.name,
                  arguments: JSON.stringify(block.input ?? {}),
                }],
              }
              emittedAnyToolCall = true
            }
          }
          continue
        }

        if (msg.type === 'result') {
          const r = msg as ClaudeStreamResult
          if (r.is_error) {
            yield { finish_reason: 'error', internal_session_id: internalSessionId }
          } else {
            // tool_calls wins over stop when the model emitted at least
            // one tool_use block during this turn (native or MCP).
            yield {
              finish_reason: emittedAnyToolCall ? 'tool_calls' : 'stop',
              usage: r.usage,
              internal_session_id: r.session_id ?? internalSessionId,
            }
          }
          return
        }
      }

      const exitCode = await waitForProcessClose(child)

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
      releaseSpawner()
      mcpMaterialised?.cleanup()
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
    mcp?: MaterialisedMcpConfig | null,
    opts?: { userTextForArgv?: string },
  ): string[] {
    // Two transport modes — see chat() for the rationale:
    //   - argv (`-p <text>`):       single-shot text mode. Used when user
    //                               text fits MAX_ARG_STRLEN.
    //   - stdin (--input-format=stream-json): interactive agent-loop mode.
    //                               Fallback for oversized user text.
    const argvMode = opts?.userTextForArgv !== undefined
    const args = argvMode
      ? ['-p', opts!.userTextForArgv!, '--output-format', 'stream-json', '--verbose']
      : ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']

    // Fold every system source into --append-system-prompt so
    // claude-code-cli applies them as a real system slot. Sources:
    //   1. Caller's role:'system' messages (AI SDK sends them this way)
    //   2. agent_profile.prompt.systemPrompt preamble
    //   3. JSON-mode directive (when responseFormat: json_object)
    //
    // Why not stdin: an earlier version of this code flattened the
    // whole messages[] array (including role:'system') with `[role]`
    // tags and piped it through stdin. claude-code-cli reads
    // `[system] You are a security auditor...` as user-supplied
    // content that's trying to impersonate a system instruction —
    // its prompt-injection heuristic refuses to execute the request
    // and replies with a refusal explanation instead of invoking
    // any tools. Observed across multiple audit-bench coord runs:
    // 36-minute trials, zero tool calls, finish_reason=stop.
    //
    // The argv limit is MAX_ARG_STRLEN = 128 KiB per argument; we
    // cap at 120 KiB for headroom. When system content overflows
    // the cap, composeStdinInput's fallback wraps it into the user
    // message — degraded (may trip injection heuristics) but the
    // spawn still succeeds, which beats spawn E2BIG.
    const systemMessages = (req.messages ?? [])
      .filter((m) => m.role === 'system')
      .map((m) => contentToText(m.content))
      .filter((s) => s.length > 0)
    const systemBlocks = [
      ...systemMessages,
      renderLocalHarnessProfilePreamble(resolveAgentProfile(req, session)),
      wantsJsonObject(req) ? JSON_MODE_DIRECTIVE : null,
    ].filter((value): value is string => Boolean(value))
    if (systemBlocks.length > 0) {
      const merged = systemBlocks.join('\n\n')
      const APPEND_LIMIT = 120 * 1024
      if (Buffer.byteLength(merged, 'utf8') <= APPEND_LIMIT) {
        args.push('--append-system-prompt', merged)
      }
    }

    // MCP wiring — when the caller passed `mcp.mcpServers` (or the
    // agent profile carries one), register the servers via --mcp-config
    // and auto-allow their tools so byob mode doesn't hang on the
    // per-call permission prompt. Hosted-safe mode keeps the gate
    // (callers using hosted-safe explicitly want tool grants confirmed
    // elsewhere).
    // MCP wiring — the canonical custom-tool surface. The caller
    // passes `mcp.mcpServers` in the request body (or via X-Mcp-Config
    // header, or via agent_profile.mcp); `resolveMcpServers` merges
    // those sources into the `mcp` value materialised here. Every
    // backend translates the merged map into its native loader; for
    // claude that's `--mcp-config <path>`.
    //
    // We always pair with `--strict-mcp-config` so the operator's
    // `~/.claude/` inherited servers (Google Drive, Linear, etc.) do
    // NOT leak into the caller's request — the caller's MCP set is
    // the entire MCP surface for this turn.
    //
    // Custom tools come in via MCP — NOT via the OpenAI `tools[]`
    // emulation field. With MCP the caller's tools appear in
    // claude-code's native tool registry alongside Bash/Read/etc. and
    // get first-class calling semantics.
    if (mcp) {
      args.push('--mcp-config', mcp.configPath, '--strict-mcp-config')
      if (mode !== 'hosted-safe') {
        args.push('--allowedTools', buildMcpAllowList(mcp.serverNames))
      }
    }

    // Per-mode permission posture. Native tools (Bash/Read/Edit/etc.)
    // STAY ENABLED by design — the LLM should have full agentic
    // capability and pick the right tool (native or MCP-exposed) per
    // task. `--dangerously-skip-permissions` is the explicit ask:
    // full permissions, every tool, no interactive grant prompts.
    //
    // Also pass `--bare` in byob mode to suppress claude-code's
    // operator-side defaults that leak into the request: LSP service
    // probes, `~/.claude/projects/<dir>/memory/*.md` auto-discovery,
    // CLAUDE.md auto-discovery, plugin sync, background prefetches,
    // keychain reads. The caller provides every context source it
    // wants explicitly (system prompt, MCP servers, prompt content).
    //
    // The "easily swappable with a real sandbox" property holds: when
    // the caller flips harness=sandbox, the same mcp config flows
    // through TCloudSandbox's AgentProfile.mcp slot and the
    // sandbox-host enforces isolation at the VM layer.
    if (mode === 'hosted-safe') {
      args.push(
        '--permission-mode', 'plan',
        '--disallowed-tools', 'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch',
      )
    } else if (mode === 'byob') {
      args.push('--dangerously-skip-permissions')
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
    if (messages.length === 1) return contentToText(messages[0]?.content ?? '')
    return messages.map((m) => `[${m.role}] ${contentToText(m.content)}`).join('\n\n')
  }

  /**
   * Compose the stdin payload for `--input-format stream-json`.
   *
   * Default path: stdin carries ONLY user-side content (current turn
   * + multi-turn history). All system content — agent profile
   * preamble, JSON-mode directive — goes through
   * `--append-system-prompt` in argv because claude-code-cli applies
   * it as a real system slot. Folding system content into a synthetic
   * `[SYSTEM INSTRUCTIONS]` user-side wrapper trips the model's
   * prompt-injection heuristic and it refuses to call tools.
   *
   * Fallback path (very rare): when system content exceeds the argv
   * `--append-system-prompt` size cap (~120 KiB), `buildArgs` skips
   * the flag and we wrap the system blocks into the user message
   * here. The model may treat it as injection (degraded behavior)
   * but the spawn still succeeds — better than `spawn E2BIG`.
   *
   * Multi-turn `messages[]` arrays serialise as one user message per
   * element with `[role]` tags so tool-result content (role: 'tool')
   * stays identifiable to the model.
   */
  composeStdinInput(
    req: ChatRequest,
    session: SessionRecord | null,
  ): { messages: Array<{ role: 'user'; content: string }> } {
    const systemMessages = (req.messages ?? [])
      .filter((m) => m.role === 'system')
      .map((m) => contentToText(m.content))
      .filter((s) => s.length > 0)
    const systemBlocks = [
      ...systemMessages,
      renderLocalHarnessProfilePreamble(resolveAgentProfile(req, session)),
      wantsJsonObject(req) ? JSON_MODE_DIRECTIVE : null,
    ].filter((value): value is string => Boolean(value))

    // Flatten only the non-system messages. `[role]` tags on user /
    // assistant / tool messages are fine (claude-code-cli expects
    // some conversation structure); only `[system]` tags trip the
    // injection heuristic, and we route those to argv above.
    const nonSystemMessages = (req.messages ?? []).filter((m) => m.role !== 'system')
    const userText = this.flattenPrompt(nonSystemMessages)

    // Mirror of `buildArgs`'s decision: if system content fits the
    // argv cap, it lives in --append-system-prompt and stdin gets
    // ONLY userText. Otherwise wrap (fallback). Keep the threshold
    // in lock-step with `APPEND_LIMIT` in buildArgs.
    const APPEND_LIMIT = 120 * 1024
    const systemMerged = systemBlocks.join('\n\n')
    const systemFitsInArgv = systemBlocks.length === 0
      || Buffer.byteLength(systemMerged, 'utf8') <= APPEND_LIMIT
    const content = systemFitsInArgv
      ? userText
      : `[SYSTEM INSTRUCTIONS]\n${systemMerged}\n\n[USER]\n${userText}`

    return { messages: [{ role: 'user', content }] }
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
