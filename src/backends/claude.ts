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
import { isEmulationEnabled, renderToolEmulationDirective, ToolMarkerParser } from './tool-emulation.js'
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
    //      and exit. This is the mode that correctly emits
    //      tool-emulation markers (<<<TOOL_CALL>>>...) when caller
    //      tools[] are registered. PREFERRED.
    //
    //   2. `--input-format stream-json` STDIN — claude-code's
    //      "interactive agent loop" mode. The CLI uses its OWN
    //      internal tool registry (ToolSearch, Bash, etc.) and the
    //      emulation markers are NOT emitted reliably. FALLBACK only.
    //
    // We use argv when the user-message string fits the kernel's
    // per-arg limit (MAX_ARG_STRLEN = 128 KiB). Fall back to stdin
    // when it overflows. System content (agent profile preamble,
    // tool-emulation directive, etc.) goes through
    // --append-system-prompt regardless of which user-message
    // transport is chosen — see buildArgs/composeStdinInput.
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

    const emulateTools = isEmulationEnabled(req)
    const toolMarkerParser = emulateTools ? new ToolMarkerParser() : null
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
              if (toolMarkerParser) {
                // Emulation: text blocks may contain TOOL_CALL markers.
                // Surface only the prose between/around markers, and emit
                // any complete tool calls as synthetic tool_calls deltas.
                const { toolCalls, prose } = toolMarkerParser.feed(block.text)
                if (prose) yield { content: prose }
                if (toolCalls.length > 0) {
                  emittedAnyToolCall = true
                  yield { tool_calls: toolCalls }
                }
              } else {
                yield { content: block.text }
              }
            } else if (block.type === 'tool_use') {
              // claude-code-cli emits `tool_use` for its OWN built-in
              // tools (Read, Bash, Edit, ToolSearch, etc.) as it runs
              // its internal agent loop. When tool-call emulation is
              // active (caller passed tools[]), those internal calls
              // are NOT meant for the caller — claude-code executes
              // them itself within the same subprocess run and reads
              // the results internally. Forwarding them as OpenAI
              // tool_calls to the caller corrupts the conversation:
              // the caller's harness sees phantom Read/Bash calls,
              // can't execute them (the names aren't in its tools[]),
              // returns empty/error results, and the model — which
              // already saw the real internal results — gets a
              // contradictory history on the next turn. Observed:
              // multi-turn agent runs derail at turn 3 producing
              // text-only output and finish_reason=stop.
              //
              // When emulation is OFF (no caller tools[] supplied,
              // OR explicitly disabled via BRIDGE_DISABLE_TOOL_EMULATION),
              // surfacing tool_use to the caller IS the contract —
              // they want claude-code's native tool surface exposed
              // as OpenAI tool_calls.
              if (!toolMarkerParser) {
                yield {
                  tool_calls: [{
                    id: block.id,
                    name: block.name,
                    arguments: JSON.stringify(block.input ?? {}),
                  }],
                }
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
            // In emulation mode, drain any trailing prose still in the
            // parser buffer and pick the right finish_reason. tool_calls
            // wins over stop when the model declared at least one.
            if (toolMarkerParser) {
              const tail = toolMarkerParser.flush()
              if (tail.prose) yield { content: tail.prose }
              if (tail.toolCalls.length > 0) {
                emittedAnyToolCall = true
                yield { tool_calls: tail.toolCalls }
              }
            }
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
    //   - argv (`-p <text>`):       single-shot text mode. Tool-emulation
    //                               markers work reliably. Used when user
    //                               text fits MAX_ARG_STRLEN.
    //   - stdin (--input-format=stream-json): interactive agent-loop mode.
    //                               Fallback only — emulation markers are
    //                               unreliable in this mode.
    const argvMode = opts?.userTextForArgv !== undefined
    const args = argvMode
      ? ['-p', opts!.userTextForArgv!, '--output-format', 'stream-json', '--verbose']
      : ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']

    // Fold every system source into --append-system-prompt so
    // claude-code-cli applies them as a real system slot. Sources:
    //   1. Caller's role:'system' messages (AI SDK sends them this way)
    //   2. agent_profile.prompt.systemPrompt preamble
    //   3. JSON-mode directive (when responseFormat: json_object)
    //   4. Tool-emulation directive (when caller passed tools[])
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
    const emulateTools = isEmulationEnabled(req)
    const systemMessages = (req.messages ?? [])
      .filter((m) => m.role === 'system')
      .map((m) => contentToText(m.content))
      .filter((s) => s.length > 0)
    const systemBlocks = [
      ...systemMessages,
      renderLocalHarnessProfilePreamble(resolveAgentProfile(req, session)),
      wantsJsonObject(req) ? JSON_MODE_DIRECTIVE : null,
      emulateTools ? renderToolEmulationDirective(req.tools!, req.tool_choice) : null,
    ].filter((value): value is string => Boolean(value))
    if (systemBlocks.length > 0) {
      const merged = systemBlocks.join('\n\n')
      const APPEND_LIMIT = 120 * 1024
      if (Buffer.byteLength(merged, 'utf8') <= APPEND_LIMIT) {
        args.push('--append-system-prompt', merged)
      }
    }

    // When emulating caller-supplied tools, signal the soft intent
    // with `--allowedTools ''`. The CLI parser doesn't actually disable
    // built-ins from an empty string — the model retains its default
    // tool registry — but the emulation system-prompt directive
    // ("use ONLY the caller tools above, emit markers, do not attempt
    // Read/Bash/Edit/Write") is enough to make the model emit markers
    // for the registered caller tools.
    //
    // We tried `--disallowedTools <full-builtin-list>` to enforce the
    // intent at the CLI layer. It broke multi-turn agent loops: probes
    // still returned tool_calls on the first request, but subsequent
    // requests with assistant+tool history in the conversation
    // returned text-only deltas with finish_reason=stop and the
    // harness exited after 5-8 turns producing zero spawn events.
    // Hypothesis: claude-code uses some of its built-in tools (Task?
    // ToolSearch?) internally during multi-turn agent loops, and
    // disabling them all stalls the loop. Soft intent works fine in
    // practice — the working state pre-disallowedTools produced 15
    // findings on the same audit task.
    if (emulateTools) {
      args.push('--allowedTools', '')
    }

    // MCP wiring — when the caller passed agent_profile.mcp, register
    // the servers via --mcp-config and auto-allow their tools so byob
    // mode doesn't hang on the per-call permission prompt. Hosted-safe
    // mode keeps the gate (callers using hosted-safe explicitly want
    // tool grants confirmed elsewhere).
    if (mcp) {
      args.push('--mcp-config', mcp.configPath)
      if (mode !== 'hosted-safe') {
        args.push('--allowedTools', buildMcpAllowList(mcp.serverNames))
      }
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
    if (messages.length === 1) return contentToText(messages[0]?.content ?? '')
    return messages.map((m) => `[${m.role}] ${contentToText(m.content)}`).join('\n\n')
  }

  /**
   * Compose the stdin payload for `--input-format stream-json`.
   *
   * Default path: stdin carries ONLY user-side content (current turn
   * + multi-turn history). All system content — agent profile
   * preamble, tool-emulation directive, JSON-mode directive — goes
   * through `--append-system-prompt` in argv because claude-code-cli
   * applies it as a real system slot. Folding system content into a
   * synthetic `[SYSTEM INSTRUCTIONS]` user-side wrapper trips the
   * model's prompt-injection heuristic and it refuses to call tools.
   *
   * Fallback path (very rare): when system content exceeds the argv
   * `--append-system-prompt` size cap (~120 KiB), `buildArgs` skips
   * the flag and we wrap the system blocks into the user message
   * here. The model may treat it as injection (degraded behavior)
   * but the spawn still succeeds — better than `spawn E2BIG`.
   *
   * Multi-turn `messages[]` arrays serialise as one user message per
   * element with `[role]` tags so tool-result content (role: 'tool')
   * remains identifiable to the response-side emulation parser.
   */
  composeStdinInput(
    req: ChatRequest,
    session: SessionRecord | null,
  ): { messages: Array<{ role: 'user'; content: string }> } {
    const emulateTools = isEmulationEnabled(req)
    const systemMessages = (req.messages ?? [])
      .filter((m) => m.role === 'system')
      .map((m) => contentToText(m.content))
      .filter((s) => s.length > 0)
    const systemBlocks = [
      ...systemMessages,
      renderLocalHarnessProfilePreamble(resolveAgentProfile(req, session)),
      wantsJsonObject(req) ? JSON_MODE_DIRECTIVE : null,
      emulateTools ? renderToolEmulationDirective(req.tools!, req.tool_choice) : null,
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
