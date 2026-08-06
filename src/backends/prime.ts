/**
 * Prime Agent backend — drives prime-agent (the `@earendil-works` fork of the
 * Pi coding agent, package `@earendil-works/pi-coding-agent`) in `--mode rpc`:
 * JSONL commands on stdin, JSONL responses plus raw agent events on stdout.
 *
 * Model id scheme: `prime/<provider>/<model>` — provider and model are both
 * required so the run binds to an explicit entry in the materialized
 * `models.json` before the CLI starts. There is no ambient default model in an
 * isolated agent dir, so a bare `prime` id has nothing to run.
 *
 * Transport choice, verified against the fork's source (v0.7.0 lineage):
 *
 *   - Every non-daemon client mode (print/json/rpc/acp) rides the fork's
 *     background daemon by default (`shouldUseDaemonClient` in main.ts). That
 *     daemon is spawned `detached` + `unref` on a shared per-uid socket
 *     (`$TMPDIR/prime-agent-<uid>/daemon.sock`), outlives the request, and
 *     would carry one session's HOME into every later session on the box.
 *   - `--mode rpc` with `PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND=1`
 *     runs the whole session in an owned worker inside this backend's own
 *     process tree (cli/owned-session-worker.ts): no daemon, and the worker
 *     self-terminates when its IPC channel to the frontend drops, so a
 *     SIGKILLed request cannot orphan it.
 *   - `--daemon-socket <per-run path>` is passed as a fail-closed backstop: if
 *     a future fork release drops the legacy frontend and reaches for a
 *     daemon anyway, that daemon binds a socket private to this run instead of
 *     the shared per-uid one, so cross-session state bleed stays impossible.
 *   - `--mode acp` has no daemon-free path in the fork
 *     (`classifyOwnedSessionWorkerInvocation` recognizes rpc/json/print only),
 *     and ACP's `session/update` stream collapses the tool/usage detail the
 *     rpc stream carries — so ACP is deliberately not used.
 *
 * The rpc stdout stream interleaves `{type:'response',...}` command replies
 * with the same AgentEvent lineage the Pi backend already parses
 * (`message_update` / `turn_end` / `agent_end` / `tool_execution_*`), so event
 * translation is shared with pi.ts rather than forked.
 *
 * Isolation (fail-closed): prime-agent persists self-modification state
 * (`<agentDir>/harness/harness_state.json`) that rides every future system
 * prompt — persistent cross-session prompt injection if shared. Every run
 * therefore gets a bridge-owned HOME + agent dir (per bridge session when
 * `session_id` is set, ephemeral otherwise), with XDG_* pinned under that HOME.
 * Sharing state across runs requires the operator to name a persistent agent
 * dir explicitly (`PRIME_PERSISTENT_AGENT_DIR`); it is never a default.
 *
 * Credentials: an operator `models.json` (`PRIME_MODELS_JSON`) is materialized
 * verbatim into each isolated agent dir; with a persistent agent dir, that
 * dir's own `models.json` is read instead. Either way, provider `apiKey`
 * entries that name environment variables are forwarded into the child env by
 * exact name; the rest of the environment is a neutral allowlist, so ambient
 * provider keys never reach the CLI or its tools.
 *
 * Vision: images in the request ride the rpc `prompt` command's native
 * `images` field (base64 + mimeType) instead of being flattened away.
 *
 * Known fork defect this backend defends against: a spontaneously crashed
 * IPython kernel is never re-provisioned headlessly. The failure surfaces
 * either as a failed assistant turn (`turn_end` with `stopReason: 'error'`,
 * thrown here as a typed BackendError) or as a wedged session, which the
 * caller-owned `execution.timeoutMs` deadline terminates — never a silent
 * empty completion.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProfile } from '@tangle-network/agent-interface'
import type { Backend, BackendHealth, ChatDelta, ChatMessage, ChatRequest } from './types.js'
import { BackendError, JSON_MODE_DIRECTIVE, wantsJsonObject } from './types.js'
import { versionHealth } from './health.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import {
  assertProfileRequestAuthority,
  resolveAgentProfile,
  resolveMcpServers,
  resolvePromptMessages,
  resolveRequestedReasoningEffort,
} from './profile-support.js'
import { contentToText, extractImageAttachments } from './content.js'
import { scopedHostSpawner } from '../executors/scoped-host.js'
import { resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import { readProcessLines, waitForProcessClose } from './process-lines.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'
import { terminateSpawned } from '../executors/process-tree.js'
import {
  piAssistantFailure,
  piFailureKind,
  PiToolCallTracker,
  piTokenUsage,
  piUsageReceiptsFromEvent,
  recordPiUsageCost,
  type PiUsageCost,
} from './pi.js'

export interface PrimeBackendOptions {
  bin: string
  timeoutMs: number
  /** Root for bridge-owned per-session prime state (isolated HOMEs + agent dirs). */
  stateDir: string
  /** Operator models.json materialized verbatim into every isolated agent dir. */
  modelsJsonPath?: string
  /**
   * Operator-owned agent dir shared across runs — the explicit opt-in to
   * prime-agent's persistent self-modification state. Mutually exclusive with
   * modelsJsonPath: a shared dir's models.json belongs to the operator, and
   * overwriting it per request would be a silent config clobber.
   */
  persistentAgentDir?: string
  /** Subprocess spawner. Defaults to the scoped host spawner. */
  spawner?: Spawner
}

/** Parsed `prime/<provider>/<model>` selection. Incomplete ids are rejected before spawn. */
interface PrimeModelSpec {
  provider?: string
  model?: string
}

function parsePrimeModelId(model: string): PrimeModelSpec {
  const m = model.toLowerCase()
  if (m === 'prime') return {}
  if (!m.startsWith('prime/')) return {}
  const rest = model.slice('prime/'.length) // preserve original case for the model id
  const slash = rest.indexOf('/')
  if (slash === -1) return { model: rest }
  return { provider: rest.slice(0, slash), model: rest.slice(slash + 1) }
}

/** Map the canonical reasoning ladder to prime's `--thinking` flag.
 *  The fork accepts off|minimal|low|medium|high|xhigh|max (cli/args.ts), one
 *  rung above upstream Pi — so `ultracode` maps to `max`, not `xhigh`. */
export function primeThinkingFlagForEffort(effort?: string): string | null {
  if (!effort) return null
  const allowed = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  const e = effort === 'none' ? 'off' : effort === 'ultracode' ? 'max' : effort
  return allowed.has(e) ? e : null
}

/**
 * Neutral env allowlist for the prime-agent process tree. Deliberately absent:
 * HOME and XDG_* (pinned per run below) and every ambient provider key —
 * credentials reach the child only when the materialized models.json names
 * them. PRIME_AGENT_KERNEL_* / PRIME_AGENT_INSTALL_UV pass through so an
 * operator-prepared Python kernel survives the HOME isolation (the kernel venv
 * defaults to `$HOME/.prime/agent/kernel-venv`, which a fresh HOME would
 * otherwise re-bootstrap on every run).
 */
const PRIME_INHERITED_ENV_KEYS = [
  'PATH',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'NVM_DIR',
  'PNPM_HOME',
  'PRIME_AGENT_INSTALL_UV',
  'PRIME_AGENT_KERNEL_PYTHON',
  'PRIME_AGENT_KERNEL_VENV',
] as const

export function primeProcessEnvironment(
  inherited: NodeJS.ProcessEnv,
  requestValues: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {}
  for (const key of PRIME_INHERITED_ENV_KEYS) {
    const value = inherited[key]
    if (typeof value === 'string' && value.length > 0) child[key] = value
  }
  for (const [key, value] of Object.entries(requestValues)) {
    if (typeof value === 'string' && value.length > 0) child[key] = value
  }
  return child
}

/** Strip `//` line comments and trailing commas, leaving string literals
 *  untouched. Byte-for-byte the fork's own `stripJsonComments`
 *  (core/model-registry.ts), so a models.json prime accepts is never refused
 *  here and vice versa. */
function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ''))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail: string | undefined) => tail ?? (m[0] === '"' ? m : ''))
}

/** Parse an operator models.json with the fork's own laxness. Throws with the
 *  offending path on anything prime itself would reject structurally. */
export function parsePrimeModelsJson(text: string, sourcePath: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonComments(text))
  } catch (err) {
    throw new Error(`prime models.json ${sourcePath} is not valid JSON: ${(err as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`prime models.json ${sourcePath} must be a JSON object`)
  }
  const providers = (parsed as Record<string, unknown>).providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    throw new Error(`prime models.json ${sourcePath} must carry a "providers" object (prime's models.json schema)`)
  }
  return parsed as Record<string, unknown>
}

/**
 * One authority per run: an exact profile must agree with the wire model, and
 * a profile pinned to another harness must not run here. The canonical
 * AgentProfile harness enum carries no id for this fork yet, so the only pin
 * this backend can honor is none at all; the comparison reads the field
 * structurally so an enum that gains `prime` is accepted without a code change.
 */
function assertPrimeProfileBinding(
  profile: AgentProfile,
  spec: { provider: string; model: string },
): void {
  const pinned = profile.harness as string | undefined
  if (pinned !== undefined && pinned !== 'prime') {
    throw new BackendError(
      `agent_profile.harness ${JSON.stringify(pinned)} conflicts with backend prime; `
      + 'omit the harness pin to run this profile on prime-agent',
      'parse_error',
    )
  }
  const wireModel = `${spec.provider}/${spec.model}`
  const requestedModel = profile.model?.default
  const requestedProvider = profile.model?.provider
  if (requestedModel !== undefined) {
    const qualified = requestedProvider && !requestedModel.includes('/')
      ? `${requestedProvider}/${requestedModel}`
      : requestedModel
    if (wireModel !== qualified) {
      throw new BackendError(
        `request model ${JSON.stringify(`prime/${wireModel}`)} conflicts with agent_profile.model ${JSON.stringify(qualified)}`,
        'parse_error',
      )
    }
  } else if (requestedProvider !== undefined && requestedProvider !== spec.provider) {
    throw new BackendError(
      `request model ${JSON.stringify(`prime/${wireModel}`)} does not select agent_profile.model.provider ${JSON.stringify(requestedProvider)}`,
      'parse_error',
    )
  }
}

/**
 * Environment variables the materialized models.json names as `apiKey`
 * sources. prime resolves an apiKey value as env-var first, literal second
 * (core/resolve-config-value.ts), so forwarding exactly the named variables
 * lets operators keep secrets out of the file without opening the whole
 * ambient environment to the CLI's tools.
 */
export function primeApiKeyEnv(
  modelsConfig: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {}
  const providers = modelsConfig.providers
  if (!providers || typeof providers !== 'object') return out
  for (const provider of Object.values(providers as Record<string, unknown>)) {
    if (!provider || typeof provider !== 'object') continue
    const key = (provider as Record<string, unknown>).apiKey
    if (typeof key !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(key)) continue
    const value = env[key]
    if (typeof value === 'string' && value.length > 0) out[key] = value
  }
  return out
}

/** Linux MAX_ARG_STRLEN is 128 KiB per argv entry; refuse oversized prompt
 *  flags with the real limit named instead of dying in execve. */
const MAX_PROMPT_FLAG_BYTES = 120 * 1024

interface ProvisionedPrimeHome {
  home: string
  agentDir: string
  sessionArtifactDir: string
  /** Short tmpdir-based socket path — AF_UNIX paths cap at ~104 bytes. */
  daemonSocketPath: string
  apiKeyEnv: Record<string, string>
  cleanup: () => void
}

export class PrimeBackend implements Backend {
  readonly name = 'prime'
  readonly defaultExecutionTimeoutMs: number
  private readonly spawner: Spawner

  constructor(private readonly opts: PrimeBackendOptions) {
    this.defaultExecutionTimeoutMs = opts.timeoutMs
    this.spawner = opts.spawner ?? scopedHostSpawner
    if (opts.modelsJsonPath && opts.persistentAgentDir) {
      throw new Error(
        'prime backend cannot take both modelsJsonPath and persistentAgentDir: a persistent agent dir '
        + 'owns its models.json, and materializing over it would silently clobber operator config',
      )
    }
    if (opts.modelsJsonPath) {
      // Validate at construction so a broken operator file fails the server
      // start, not the first request.
      parsePrimeModelsJson(readFileSync(opts.modelsJsonPath, 'utf8'), opts.modelsJsonPath)
    }
    if (opts.persistentAgentDir && !statSync(opts.persistentAgentDir).isDirectory()) {
      throw new Error(`prime persistentAgentDir is not a directory: ${opts.persistentAgentDir}`)
    }
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'prime' || m.startsWith('prime/')
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
      'prime-agent has native tools (ipython/bash/files); hosted-safe requires a verified tool-disable path')

    if (this.spawner.executionEnvironment === 'test-double' && process.env.VITEST !== 'true') {
      throw new BackendError(
        'backend prime test-double executors are only accepted by the test runner',
        'not_configured',
      )
    }

    const spec = parsePrimeModelId(req.model)
    if (!spec.provider || !spec.model) {
      throw new BackendError(
        'backend prime requires an explicit prime/<provider>/<model> so the run binds to a provider entry '
        + 'in the materialized models.json',
        'not_configured',
      )
    }

    // FAIL-LOUD on MCP: the fork mounts MCP through its RLM kernel runtime,
    // not a per-invocation flag the bridge can drive. Running without the
    // requested tools would score zero for the wrong reason.
    const mcpSpecs = resolveMcpServers(req, session)
    if (mcpSpecs && Object.keys(mcpSpecs).length > 0) {
      throw new BackendError(
        `backend prime cannot mount request-scoped MCP servers (requested: ${Object.keys(mcpSpecs).join(', ')}); `
        + 'prime-agent has no per-invocation MCP loader the bridge can drive',
        'not_configured',
      )
    }

    const profile = resolveAgentProfile(req, session)
    if (profile) {
      assertProfileRequestAuthority(req, session)
      assertPrimeProfileBinding(profile, { provider: spec.provider, model: spec.model })
    }
    const promptMessages = resolvePromptMessages(req, session, this.name)
    const promptText = buildPromptText(promptMessages)
    if (!promptText) {
      throw new BackendError('backend prime received no prompt text', 'parse_error')
    }
    const images = extractImageAttachments(req.messages).map((image) => ({
      type: 'image' as const,
      data: image.data.toString('base64'),
      mimeType: image.mediaType,
    }))

    const args: string[] = ['--mode', 'rpc', '--provider', spec.provider, '--model', spec.model]
    const requestedReasoningEffort = resolveRequestedReasoningEffort(req, session)
    const thinking = primeThinkingFlagForEffort(requestedReasoningEffort ?? undefined)
    if (thinking) args.push('--thinking', thinking)

    // agent_profile.prompt.systemPrompt REPLACES the harness prompt via the
    // fork's --system-prompt; every ADDITIVE system source folds into ONE
    // --append-system-prompt (profile addition first, caller/bridge system
    // messages next, JSON-mode directive last so nothing restates the output
    // contract after it).
    const profileSystemPrompt = typeof profile?.prompt?.systemPrompt === 'string'
      ? profile.prompt.systemPrompt
      : null
    if (profileSystemPrompt !== null) {
      assertPromptFlagSize('--system-prompt', profileSystemPrompt)
      args.push('--system-prompt', profileSystemPrompt)
    }
    const appendBlocks = [
      typeof profile?.prompt?.appendSystemPrompt === 'string' ? profile.prompt.appendSystemPrompt : null,
      ...promptMessages
        .filter((message) => message.role === 'system')
        .map((message) => contentToText(message.content))
        .filter(Boolean),
      wantsJsonObject(req) ? JSON_MODE_DIRECTIVE : null,
    ].filter((value): value is string => Boolean(value))
    if (appendBlocks.length > 0) {
      const merged = appendBlocks.join('\n\n')
      assertPromptFlagSize('--append-system-prompt', merged)
      args.push('--append-system-prompt', merged)
    }

    const home = this.provisionHome(req.session_id)
    if (req.session_id) {
      args.push('--session-dir', home.sessionArtifactDir)
      // The artifact dir is exclusive to this bridge session, so `--continue`
      // deterministically resumes its single most-recent session. The fork
      // dropped upstream Pi's `--session <id>` flag; resume-by-dir replaces it.
      if (session?.internalId) args.push('--continue')
    } else {
      args.push('--no-session')
    }
    args.push('--daemon-socket', home.daemonSocketPath)

    const runCwd = resolveSpawnerCwd(this.spawner, req.cwd ?? session?.cwd ?? undefined)
    if (req.jailSpec) {
      req.jailSpec.extraWritablePaths = [
        ...new Set([...(req.jailSpec.extraWritablePaths ?? []), home.home, home.sessionArtifactDir]),
      ]
    }

    let spawned: Awaited<ReturnType<Spawner>>
    try {
      spawned = await this.spawner(this.opts.bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: runCwd,
        env: primeProcessEnvironment(process.env, {
          HOME: home.home,
          XDG_DATA_HOME: join(home.home, '.local', 'share'),
          XDG_CONFIG_HOME: join(home.home, '.config'),
          XDG_CACHE_HOME: join(home.home, '.cache'),
          PRIME_AGENT_CODING_AGENT_DIR: home.agentDir,
          PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: '1',
          ...home.apiKeyEnv,
        }),
        ...(req.session_id ? { sessionId: req.session_id } : {}),
        ...(req.jailSpec ? { jail: req.jailSpec } : {}),
      })
    } catch (err) {
      home.cleanup()
      throw err
    }
    const child = spawned.child
    const releaseSpawner = spawned.release

    let spawnErrorMessage = ''
    child.on('error', (err) => { spawnErrorMessage = err.message })
    const earlySpawnError = spawned.spawnError?.()
    if (earlySpawnError) spawnErrorMessage = earlySpawnError.message

    const onAbort = (): void => { void terminateSpawned(spawned) }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      if (!child.stdin || !child.stdout) {
        throw new BackendError('prime subprocess is missing stdio pipes', 'upstream')
      }
      // One shot over the rpc channel: state (for the session id), the prompt,
      // then EOF — stdin end is the fork's own idle-then-exit signal, so the
      // worker terminates itself after the turn settles.
      child.stdin.write(`${JSON.stringify({ id: 'bridge-get-state', type: 'get_state' })}\n`)
      child.stdin.write(`${JSON.stringify({
        id: 'bridge-prompt',
        type: 'prompt',
        message: promptText,
        ...(images.length > 0 ? { images } : {}),
      })}\n`)
      child.stdin.end()

      let internalSessionId: string | undefined
      const stderr = new BoundedDiagnosticBuffer()
      let emittedContent = false
      let emittedToolCall = false
      let sawError: string | null = null
      let promptFailure: string | null = null
      let sawTurnUsage = false
      // Only the LAST turn decides: the fork auto-retries transient provider
      // failures and the retry's turn_end supersedes the failed one.
      let turnFailure: string | null = null
      const usageCost: PiUsageCost = { receipts: 0, total: 0, complete: true }
      const toolCalls = new PiToolCallTracker()

      child.stderr?.on('data', (b) => { stderr.append(b) })

      const progressIntervalMs = Math.max(10, Number(process.env.PRIME_PROGRESS_MS ?? 30_000))

      for await (const next of readProcessLines({ child, stdout: child.stdout, progressIntervalMs })) {
        if (next.kind === 'progress') {
          yield { keepalive: { source: 'prime', elapsedMs: next.elapsedMs } }
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

        // Command replies. A failed prompt is the run's failure; any other
        // failed reply is retained as context for the terminal verdict.
        if (type === 'response') {
          const command = String(ev.command ?? '')
          if (ev.success === false) {
            const message = typeof ev.error === 'string' && ev.error
              ? ev.error
              : `prime rpc ${command || 'command'} failed`
            if (command === 'prompt') promptFailure = message
            else if (!sawError) sawError = message
            continue
          }
          if (command === 'get_state' && !internalSessionId) {
            const data = record(ev.data)
            const sessionId = data?.sessionId
            if (typeof sessionId === 'string' && sessionId) {
              internalSessionId = sessionId
              yield { internal_session_id: internalSessionId }
            }
          }
          continue
        }

        if (type === 'error' || ev.error !== undefined) {
          sawError = String(
            ev.message
            ?? record(ev.error)?.message
            ?? (typeof ev.error === 'string' ? ev.error : undefined)
            ?? 'prime error',
          )
          continue
        }

        // One usage receipt per model call, emitted immediately: waiting for
        // agent_end loses completed calls when the outer run is cancelled.
        if (type === 'turn_end') {
          turnFailure = piAssistantFailure(ev.message)
          const receipts = piUsageReceiptsFromEvent(ev)
          if (receipts.length > 0) sawTurnUsage = true
          for (const receipt of receipts) {
            recordPiUsageCost(usageCost, receipt)
            yield { usage: { ...piTokenUsage(receipt), model_requests: 1, cost_known: false } }
          }
          continue
        }

        if (type === 'agent_end') {
          if (!sawTurnUsage) {
            for (const receipt of piUsageReceiptsFromEvent(ev)) {
              recordPiUsageCost(usageCost, receipt)
              yield { usage: { ...piTokenUsage(receipt), model_requests: 1, cost_known: false } }
            }
          }
          continue
        }

        if (type === 'message_update') {
          const ame = record(ev.assistantMessageEvent)
          if (!ame) continue
          const ameType = String(ame.type ?? '')
          if (ameType === 'text_delta') {
            const delta = typeof ame.delta === 'string' ? ame.delta : ''
            if (delta) {
              emittedContent = true
              yield { content: delta }
            }
          }
          const toolCall = toolCalls.observe(ame, ameType)
          if (toolCall) {
            emittedToolCall = true
            yield { tool_calls: [toolCall] }
          }
          continue
        }

        const toolCall = toolCalls.observe(ev, type)
        if (toolCall) {
          emittedToolCall = true
          yield { tool_calls: [toolCall] }
          continue
        }

        // agent_start / turn_start / message_start / message_end / unknown
        // additions — drop silently; the stream may gain event types.
      }

      const exitCode = await waitForProcessClose(child)
      signal.removeEventListener('abort', onAbort)
      releaseSpawner()

      // Prime prices calls from its local model catalog: an estimate, never
      // provider-billed spend.
      if (usageCost.receipts > 0 && usageCost.complete) {
        yield {
          usage: {
            estimated_cost: usageCost.total,
            cost_known: false,
            cost_provenance: 'catalog-estimate',
            cost_scope: 'total',
          },
        }
      }

      if (signal.aborted) {
        yield { finish_reason: 'error' }
        return
      }

      if (spawnErrorMessage) {
        throw new BackendError(`prime spawn failed: ${spawnErrorMessage}`, 'upstream')
      }

      if (promptFailure) {
        throw new BackendError(`prime prompt rejected: ${promptFailure}`, piFailureKind(promptFailure))
      }

      if (exitCode !== 0) {
        const detail = sawError ?? (stderr.render(300) || `exit ${exitCode ?? 'unknown'}`)
        throw new BackendError(`prime exit ${exitCode ?? 'unknown'}: ${detail}`, piFailureKind(detail))
      }

      // A failed provider call must never complete as success — the fork exits
      // 0 with the failure only on the assistant message, and any text it did
      // stream is a truncated answer.
      if (turnFailure) {
        throw new BackendError(`prime assistant turn failed: ${turnFailure}`, piFailureKind(turnFailure))
      }

      if (sawError && !emittedContent && !emittedToolCall) {
        throw new BackendError(`prime error: ${sawError}`, 'upstream')
      }

      yield { finish_reason: emittedToolCall ? 'tool_calls' : 'stop' }
    } finally {
      signal.removeEventListener('abort', onAbort)
      await terminateSpawned(spawned)
      try { releaseSpawner() } catch { /* best effort */ }
      home.cleanup()
    }
  }

  /**
   * A bridge-owned HOME per run: stable under stateDir for a named bridge
   * session (so `--continue` finds its artifacts next turn), ephemeral
   * otherwise. The daemon socket lives in its own short tmp dir in both cases
   * because AF_UNIX socket paths cap near 104 bytes and stateDir may be deep.
   */
  private provisionHome(sessionId: string | undefined): ProvisionedPrimeHome {
    mkdirSync(this.opts.stateDir, { recursive: true })
    const ephemeral = sessionId === undefined
    const base = ephemeral
      ? mkdtempSync(join(this.opts.stateDir, 'ephemeral-'))
      : join(this.opts.stateDir, 'sessions', createHash('sha256').update(sessionId).digest('hex').slice(0, 32))
    const home = join(base, 'home')
    const agentDir = this.opts.persistentAgentDir ?? join(home, '.prime', 'agent')
    const sessionArtifactDir = join(base, 'session-artifacts')
    mkdirSync(home, { recursive: true })
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(sessionArtifactDir, { recursive: true })

    let apiKeyEnv: Record<string, string> = {}
    if (this.opts.modelsJsonPath) {
      // Re-read per run so operator rotation lands without a bridge restart.
      const text = readFileSync(this.opts.modelsJsonPath, 'utf8')
      const parsed = parsePrimeModelsJson(text, this.opts.modelsJsonPath)
      writeFileSync(join(agentDir, 'models.json'), text)
      apiKeyEnv = primeApiKeyEnv(parsed, process.env)
    } else if (this.opts.persistentAgentDir) {
      // The operator dir's own models.json names the env vars its apiKeys
      // resolve from; forward exactly those, because prime resolves an apiKey
      // env-var first and LITERAL second — an unforwarded name would silently
      // become the literal credential string. A dir without a models.json is
      // legal (built-in providers auth from the dir's own auth storage), and a
      // present-but-broken file fails the run here, loudly.
      const operatorModels = join(this.opts.persistentAgentDir, 'models.json')
      if (existsSync(operatorModels)) {
        const text = readFileSync(operatorModels, 'utf8')
        apiKeyEnv = primeApiKeyEnv(parsePrimeModelsJson(text, operatorModels), process.env)
      }
    }

    const socketDir = mkdtempSync(join(tmpdir(), 'prime-sock-'))
    const cleanupSocketDir = (): void => {
      try { rmSync(socketDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
    return {
      home,
      agentDir,
      sessionArtifactDir,
      daemonSocketPath: join(socketDir, 'd.sock'),
      apiKeyEnv,
      cleanup: (): void => {
        cleanupSocketDir()
        if (ephemeral) {
          try { rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
        }
      },
    }
  }
}

function assertPromptFlagSize(flag: string, value: string): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_PROMPT_FLAG_BYTES) {
    throw new BackendError(
      `backend prime ${flag} exceeds ${MAX_PROMPT_FLAG_BYTES} bytes (Linux MAX_ARG_STRLEN); `
      + 'move standing instructions into the task prompt or shorten the profile prompt',
      'parse_error',
    )
  }
}

/** Preserve a single user task exactly; serialize only genuine multi-message input. */
function buildPromptText(messages: ChatMessage[]): string {
  const parts = messages.flatMap((message) => {
    if (message.role === 'system') return []
    const text = contentToText(message.content)
    return text ? [{ role: message.role, text }] : []
  })
  if (parts.length === 1 && parts[0]?.role === 'user') return parts[0].text
  return parts
    .map(({ role, text }) => {
      const prefix = role === 'user' ? 'User: ' : role === 'assistant' ? 'Assistant: ' : `${role}: `
      return `${prefix}${text}`
    })
    .join('\n\n')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
