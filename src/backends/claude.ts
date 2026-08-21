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

import { dirname } from 'node:path'
import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { versionHealth } from './health.js'
import { BackendError, JSON_MODE_DIRECTIVE, wantsJsonObject } from './types.js'
import { ModeNotSupportedError, type BridgeMode } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import {
  buildMcpAllowList,
  writeMcpConfigFile,
  renderLocalHarnessProfilePreamble,
  resolveAgentProfile,
  resolveMcpServers,
  type MaterializedMcpConfig,
  profileExecutionIdentity,
  provisionProfileWorkspace,
  resolveRequestedReasoningEffort,
} from './profile-support.js'
import { contentToText } from './content.js'
import { registerJailReadable } from '../jail/index.js'
import { scopedHostSpawner } from '../executors/scoped-host.js'
import { describeCliExit, resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import { readProcessLines, waitForProcessClose } from './process-lines.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'
import { writeStdinPayload } from './stdin-payload.js'
import { terminateSpawned } from '../executors/process-tree.js'
import { nativeReasoningControl } from '@tangle-network/agent-interface'

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

const MAX_UPSTREAM_ERROR_DETAIL_CHARS = 300

/**
 * Build the usage record for a claude `result` line.
 *
 * `total_cost_usd` is the dollar figure Anthropic billed for the whole
 * `claude -p` invocation, including every internal model call the harness made.
 * It is a provider receipt, so it travels as `cost_known: true` with
 * `provider-receipt` provenance — the lane a dollar budget may debit. It is
 * also the complete charge for the invocation, which is what `cost_scope:
 * 'total'` asserts.
 *
 * A run that reports no figure returns `cost_known: false` with no dollar
 * amount at all. A zero here would read as a measured free turn.
 */
function claudeResultUsage(result: ClaudeStreamResult): NonNullable<ChatDelta['usage']> | undefined {
  const cost = result.total_cost_usd
  const billed = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined
  if (billed === undefined) {
    if (!result.usage) return undefined
    return { ...result.usage, cost_known: false }
  }
  return {
    ...(result.usage ?? {}),
    cost: billed,
    cost_known: true,
    cost_provenance: 'provider-receipt',
    cost_scope: 'total',
  }
}

function sanitizeUpstreamErrorDetail(detail: string | undefined): string {
  const fallback = 'provider returned an error result'
  if (!detail) return fallback

  // Provider messages are useful diagnostics, but they are untrusted output:
  // keep one bounded printable line and remove common credential shapes.
  const sanitized = detail
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]+/gu, ' ')
    .replace(/\b(Bearer\s+)[^\s,;]+/giu, '$1<redacted>')
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}\b/gu, '<redacted>')
    .replace(/\s+/gu, ' ')
    .trim()

  return (sanitized || fallback).slice(0, MAX_UPSTREAM_ERROR_DETAIL_CHARS)
}

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
  readonly defaultExecutionTimeoutMs: number
  private readonly bin: string
  private readonly anthropicBaseUrl: string | null
  private readonly prefix: string
  private readonly spawner: Spawner

  constructor(opts: ClaudeBackendOptions) {
    this.name = opts.harness ?? 'claude'
    this.defaultExecutionTimeoutMs = opts.timeoutMs
    this.bin = opts.bin
    this.anthropicBaseUrl = opts.anthropicBaseUrl ?? null
    this.prefix = `${this.name}/`
    this.spawner = opts.spawner ?? scopedHostSpawner
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === this.name || m.startsWith(this.prefix)
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    return versionHealth(this.name, this.bin, this.spawner, this.anthropicBaseUrl ? `via ${this.anthropicBaseUrl}` : undefined, signal)
  }

  async *chat(
    req: ChatRequest,
    session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    const mode: BridgeMode = req.mode ?? 'byob'
    const cwd = resolveSpawnerCwd(this.spawner, req.cwd ?? session?.cwd ?? undefined)

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
    // Validate and apply the profile before allocating request-scoped MCP
    // files. A rejected plan must never strand a config containing secrets.
    //
    // Ordered before composeStdinInput because the profile's additive prompt is
    // part of the system content whose size decides argv-vs-stdin. Composing
    // stdin against a smaller block than buildArgs will emit lets the two
    // disagree at the cap, and the disagreement drops the system content from
    // BOTH transports rather than degrading it into the user message.
    const appliedReasoningEffort = nativeReasoningControl(
      'claude-code',
      resolveRequestedReasoningEffort(req, session),
    )
    const provisioned = provisionProfileWorkspace(
      req,
      session,
      'claude-code',
      cwd,
      profileExecutionIdentity(req, session, 'claude-code', appliedReasoningEffort),
    )
    const profilePrompt = {
      ...(provisioned.systemPrompt === undefined
        ? {}
        : { systemPrompt: provisioned.systemPrompt }),
      ...(provisioned.appendSystemPrompt === undefined
        ? {}
        : { appendSystemPrompt: provisioned.appendSystemPrompt }),
    }

    const stdinInput = this.composeStdinInput(req, session, profilePrompt)
    const userText = stdinInput.messages[0]?.content ?? ''
    const PROMPT_ARGV_LIMIT = 120 * 1024
    const userFitsInArgv = Buffer.byteLength(userText, 'utf8') <= PROMPT_ARGV_LIMIT

    // Materialize MCP servers (if any) into a temp config file BEFORE
    // building args — buildArgs needs the path. Tracked so we can clean
    // up the temp dir after the subprocess exits.
    //
    // One MCP authority reaches this point: profile MCP for an exact profile,
    // otherwise body/header MCP. `resolveMcpServers` refuses mixed channels.
    const mcpMaterialized = writeMcpConfigFile(
      resolveMcpServers(req, session),
    )
    // Under an fs-jail the fresh tmpfs over /tmp hides this host-/tmp config;
    // expose its dir read-only so the confined claude can still read the
    // `--mcp-config` path. Same idiom as kimi/opencode. Measured without it:
    // `claude exited 1: Invalid MCP configuration: MCP config file not found`.
    if (mcpMaterialized) {
      registerJailReadable(req.jailSpec, dirname(mcpMaterialized.configPath))
    }
    const args = this.buildArgs(req, session, mode, mcpMaterialized, {
      userTextForArgv: userFitsInArgv ? userText : undefined,
      profilePrompt,
    })

    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    if (this.anthropicBaseUrl) {
      childEnv.ANTHROPIC_BASE_URL = this.anthropicBaseUrl
    }

    // Argv mode: stdin is ignored. Stdin mode: stdin is piped (we
    // write the NDJSON payload below). The split here matches the
    // contract claude-code-cli expects for each --input-format.
    Object.assign(childEnv, provisioned.env)
    args.push(...provisioned.flags)
    let spawned: Awaited<ReturnType<Spawner>>
    try {
      spawned = await this.spawner(this.bin, args, {
        stdio: userFitsInArgv ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
        cwd,
        env: childEnv,
        ...(req.session_id ? { sessionId: req.session_id } : {}),
        ...(req.jailSpec ? { jail: req.jailSpec } : {}),
        ...(req.admissionClass ? { admissionClass: req.admissionClass } : {}),
      })
    } catch (error) {
      mcpMaterialized?.cleanup()
      throw error
    }
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

    // Tear down the whole process group (claude + every MCP/tool fork
    // it owns). See backends/opencode.ts for rationale.
    const onAbort = (): void => { void terminateSpawned(spawned) }
    signal.addEventListener('abort', onAbort, { once: true })

    let emittedAnyToolCall = false
    try {
      let internalSessionId: string | undefined
      const stderr = new BoundedDiagnosticBuffer()
      child.stderr?.on('data', (b) => { stderr.append(b) })

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
      // Mirrors kimi/opencode (commits 9691568 / 20023c2): without a
      // keepalive heartbeat, an upstream proxy can drop the SSE socket
      // during long internal-think pauses when claude-code emits no
      // stdout for >30s (stream-json is buffered). The progress event
      // becomes a `keepalive` ChatDelta that the SSE writer renders as
      // an `: keepalive` comment.
      const progressIntervalMs = Math.max(10, Number(process.env.CLAUDE_PROGRESS_MS ?? 30_000))
      for await (const event of readProcessLines({ child, stdout: child.stdout, progressIntervalMs })) {
        if (event.kind === 'progress') {
          yield { keepalive: { source: 'claude', elapsedMs: event.elapsedMs } }
          continue
        }
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
            const detail = sanitizeUpstreamErrorDetail(r.result)
            throw new BackendError(`claude upstream error: ${detail}`, 'upstream')
          } else {
            // tool_calls wins over stop when the model emitted at least
            // one tool_use block during this turn (native or MCP).
            const usage = claudeResultUsage(r)
            yield {
              finish_reason: emittedAnyToolCall ? 'tool_calls' : 'stop',
              ...(usage ? { usage } : {}),
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
          await describeCliExit(spawned, 'claude', exitCode, stderr.render()),
          'upstream',
        )
      }

      yield { finish_reason: 'stop', internal_session_id: internalSessionId }
    } finally {
      signal.removeEventListener('abort', onAbort)
      // Always tear down the whole subtree before releasing the slot.
      // Reaps MCP servers and tool sub-processes claude spawned. Pre-fix
      // this was `child.kill('SIGTERM')` which leaked grand-children.
      await terminateSpawned(spawned)
      releaseSpawner()
      mcpMaterialized?.cleanup()
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
    mcp?: MaterializedMcpConfig | null,
    opts?: {
      userTextForArgv?: string
      /** Prompt intents the profile plan carries, each bound to its own flag below. */
      profilePrompt?: { systemPrompt?: string; appendSystemPrompt?: string }
    },
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
    const effort = nativeReasoningControl('claude-code', resolveRequestedReasoningEffort(req, session))
    if (effort) args.push('--effort', effort)

    // agent_profile.prompt.systemPrompt REPLACES claude-code's own system
    // prompt, so it goes to `--system-prompt` and nowhere else. Folding it in
    // with the additive block below (which this code used to do) left the
    // 27,673-byte built-in prompt on the wire while the caller believed it was
    // deleted — verified against claude-code 2.1.222: `--system-prompt` drops
    // the built-in prompt, `--append-system-prompt` keeps it.
    if (opts?.profilePrompt?.systemPrompt !== undefined) {
      args.push('--system-prompt', opts.profilePrompt.systemPrompt)
    }

    // Fold every ADDITIVE system source into ONE --append-system-prompt.
    // One, not several: claude-code-cli takes the LAST occurrence of the flag
    // and silently discards earlier ones (verified on the wire — two
    // --append-system-prompt values arrive as only the second), so a second
    // occurrence would drop whichever source lost the race. Sources, in the
    // order they compose:
    //   1. agent_profile.prompt.appendSystemPrompt — the profile's own
    //      addition, which is session-level configuration
    //   2. Caller's role:'system' messages (AI SDK sends them this way)
    //   3. Profile surface summary (skills/MCP/resources/permissions)
    //   4. JSON-mode directive (when responseFormat: json_object), last so
    //      nothing above can restate the output contract after it
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
      opts?.profilePrompt?.appendSystemPrompt ?? null,
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

    // MCP wiring — the canonical custom-tool surface. A profile-less request
    // may pass body/header MCP; an exact profile uses `agent_profile.mcp` and
    // rejects that second channel. Claude receives the selected set through
    // `--mcp-config <path>`, with its tools auto-allowed in byob mode.
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

    // The canonical wire id is `<harness>/<provider>/<model>` (agent-runtime's
    // profileBridgeWireModel), and anthropic is claude-code's only provider —
    // the CLI's --model takes the bare model id, so the provider segment is
    // stripped here. Any OTHER provider segment passes through untouched and
    // fails loud in the CLI rather than being silently reinterpreted.
    const modelArg = this.extractModel(req.model)?.replace(/^anthropic\//u, '') ?? null
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
   * Multi-turn `messages[]` arrays serialize as one user message per
   * element with `[role]` tags so tool-result content (role: 'tool')
   * stays identifiable to the model.
   */
  composeStdinInput(
    req: ChatRequest,
    session: SessionRecord | null,
    profilePrompt?: { systemPrompt?: string; appendSystemPrompt?: string },
  ): { messages: Array<{ role: 'user'; content: string }> } {
    const systemMessages = (req.messages ?? [])
      .filter((m) => m.role === 'system')
      .map((m) => contentToText(m.content))
      .filter((s) => s.length > 0)
    // Mirrors buildArgs's additive block exactly, including the profile's
    // addition and its leading position — this function's only job is to
    // predict whether that block fits argv, and a different block predicts the
    // wrong answer. `profilePrompt.systemPrompt` is deliberately absent: it
    // rides `--system-prompt`, which has no interaction with this cap and must
    // never be wrapped into user content, where it would stop replacing
    // anything.
    const systemBlocks = [
      profilePrompt?.appendSystemPrompt ?? null,
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

