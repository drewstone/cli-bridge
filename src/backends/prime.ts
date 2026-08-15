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
 * AgentProfile coverage is the SHARED prime agent-dir lowering in
 * `@tangle-network/agent-profile-materialize` — the same implementation
 * sdk-provider-prime runs in-sandbox, so the two executors driving this fork
 * cannot disagree about what it can honor. It accepts prompt replace/append,
 * instructions, inline skills and subagents, and refuses every other dimension
 * loudly with the fork evidence. This file keeps only what is genuinely
 * transport-specific: the rpc argv/stream contract, host-process isolation
 * (HOME + XDG + per-run daemon socket), and operator credential handling.
 *
 * Known fork defect this backend defends against: a spontaneously crashed
 * IPython kernel is never re-provisioned headlessly. Every later `ipython`
 * call fails with a known marker (PRIME_KERNEL_DEAD_MARKERS), which is treated
 * as session-fatal rather than retryable, so a dead kernel cannot burn the
 * caller's whole `execution.timeoutMs` against a permanently broken tool.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  assertPrimeModelAgreement,
  matchPrimeKernelDeadMarker,
  materializePrimeProfileControls,
  parsePrimeModelsJson,
  PRIME_HARNESS_STATE_ENV_DENYLIST,
  PRIME_KERNEL_ENV_PASSTHROUGH,
  PRIME_MCP_UNSUPPORTED_REASON,
  primeAgentDirEnv,
  primeProfileNeedsAgentDir,
  primeApiKeyEnvNames,
  PrimeHarnessStateError,
  PrimeProfileError,
  type PrimeProfileControls,
  primeThinkingLevel,
  prunePrimeProfileMaterial,
  readPrimeProfileControls,
  writePrimeAgentFile,
} from '@tangle-network/agent-profile-materialize'
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

/**
 * Neutral env allowlist for the prime-agent process tree. Deliberately absent:
 * HOME and XDG_* (pinned per run below) and every ambient provider key —
 * credentials reach the child only when the materialized models.json names
 * them. The prime-specific kernel knobs come from the shared fork contract, so
 * an operator-prepared Python kernel survives the HOME isolation (the kernel
 * venv defaults to `$HOME/.prime/agent/kernel-venv`, which a fresh HOME would
 * otherwise re-bootstrap on every run).
 */
const PRIME_INHERITED_ENV_KEYS: readonly string[] = [
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
  ...PRIME_KERNEL_ENV_PASSTHROUGH,
]

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
  // The harness-store redirects are excluded from the allowlist above; deleting
  // them again is the guard that survives a future well-meaning addition, since
  // either one silently re-points the self-modifying store outside the isolated
  // agent dir.
  for (const key of PRIME_HARNESS_STATE_ENV_DENYLIST) delete child[key]
  return child
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
  for (const name of primeApiKeyEnvNames(modelsConfig)) {
    const value = env[name]
    if (typeof value === 'string' && value.length > 0) out[name] = value
  }
  return out
}

/**
 * One authority per run. The harness pin and the model agreement are both
 * enforced by the shared lowering, so this backend only renders the refusal in
 * its own typed error contract — a profile can never be scored against a model
 * it does not name, and a profile pinned to another harness never runs here.
 */
function assertPrimeProfileBinding(
  profile: AgentProfile,
  spec: { provider: string; model: string },
): void {
  translatePrimeProfileError(() =>
    assertPrimeModelAgreement(profile, { provider: spec.provider, model: spec.model }),
  )
  // `extensions.prime` is the one profile namespace that is NOT a fork fact:
  // it names controls a specific executor implements, and this backend
  // implements none. Other backends' namespaces are ignored per the extensions
  // contract; this one must not be, or a caller would believe a prime-specific
  // knob is in force.
  const primeExtensions = Object.keys(profile.extensions?.prime ?? {})
  if (primeExtensions.length > 0) {
    throw new BackendError(
      `agent_profile.extensions.prime is not supported by backend prime: unsupported controls `
      + `(${primeExtensions.sort().join(', ')}); this backend defines no prime extension knobs`,
      'not_configured',
    )
  }
}

/**
 * Render a shared-lowering refusal as this backend's typed error.
 *
 * `unsupported` is a capability the fork verifiably lacks (`not_configured`);
 * `invalid` is a caller declaration this backend cannot accept
 * (`parse_error`). The reason text — where the fork evidence lives — is never
 * rewritten here, so it cannot drift from the other executor's copy.
 */
function translatePrimeProfileError<T>(run: () => T): T {
  try {
    return run()
  } catch (err) {
    if (err instanceof PrimeProfileError) {
      throw new BackendError(
        `agent_profile.${err.control} ${
          err.kind === 'unsupported' ? 'is not supported by backend prime' : 'is invalid'
        }: ${err.reason}`,
        err.kind === 'unsupported' ? 'not_configured' : 'parse_error',
        err,
      )
    }
    throw err
  }
}

interface ProvisionedPrimeHome {
  home: string
  agentDir: string
  sessionArtifactDir: string
  /** Per-run dir for request-scoped prompt files, outside the agent dir. */
  promptDir: string
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

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    return versionHealth(this.name, this.opts.bin, this.spawner, undefined, signal)
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

    // FAIL-LOUD on MCP, whether it arrives request-scoped or as
    // agent_profile.mcp (resolveMcpServers merges both; entries with
    // enabled:false are OFF, not requested). The fork evidence is the shared
    // refusal reason, so this backend and the in-sandbox adapter cite the same
    // facts and a fork change moves one string.
    const mcpSpecs = resolveMcpServers(req, session)
    if (mcpSpecs && Object.keys(mcpSpecs).length > 0) {
      throw new BackendError(
        `backend prime cannot mount MCP servers (requested: ${Object.keys(mcpSpecs).join(', ')}): `
        + PRIME_MCP_UNSUPPORTED_REASON,
        'not_configured',
      )
    }

    const profile = resolveAgentProfile(req, session)
    let profileControls: PrimeProfileControls | null = null
    if (profile) {
      assertProfileRequestAuthority(req, session)
      assertPrimeProfileBinding(profile, { provider: spec.provider, model: spec.model })
      profileControls = translatePrimeProfileError(() => readPrimeProfileControls(profile))
      // Prompts and skills are bound by flag, so they land in this run's own
      // prompt dir and are safe against any agent dir. Instructions and the
      // subagent roster are located BY the agent dir and have no flag, so they
      // are refused when that dir is operator-owned.
      if (primeProfileNeedsAgentDir(profileControls) && this.opts.persistentAgentDir) {
        throw new BackendError(
          'agent_profile instructions/subagents can only be written into the agent dir itself, and '
          + 'PRIME_PERSISTENT_AGENT_DIR names an operator-owned dir this backend must not rewrite; '
          + 'drop the persistent dir or strip those profile dimensions',
          'not_configured',
        )
      }
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
    const thinking = translatePrimeProfileError(() =>
      primeThinkingLevel(requestedReasoningEffort),
    )
    if (thinking) args.push('--thinking', thinking)

    const home = this.provisionHome(req.session_id)
    // The shared lowering writes the profile's prompt files and skills into
    // this run's prompt dir, its instructions and subagent roster into the
    // agent dir, and returns the flags that bind them. The prune runs even when
    // the current profile carries nothing, so a session dir whose in-band
    // profile shrank does not keep serving the previous turn's material.
    if (profileControls) {
      const materializeOptions = { flagFileRoot: home.promptDir }
      try {
        prunePrimeProfileMaterial(
          this.opts.persistentAgentDir ? home.promptDir : home.agentDir,
          materializeOptions,
        )
        args.push(
          ...materializePrimeProfileControls(home.agentDir, profileControls, materializeOptions),
        )
      } catch (err) {
        home.cleanup()
        if (err instanceof PrimeHarnessStateError) {
          throw new BackendError(err.message, 'upstream', err)
        }
        throw translatePrimeProfileError(() => {
          throw err
        })
      }
    }

    // Every ADDITIVE system source the REQUEST carries folds into one more
    // --append-system-prompt (the flag accumulates in order, fork
    // cli/args.ts:141-143), after the profile's own addition and with the
    // JSON-mode directive last so nothing restates the output contract after
    // it. It is written as a FILE (resolved by the fork when the path exists,
    // resource-loader.ts:41-56) outside the agent dir, so it carries no argv
    // size ceiling and works unchanged against an operator-owned agent dir.
    const requestAppendBlocks = [
      ...promptMessages
        .filter((message) => message.role === 'system')
        .map((message) => contentToText(message.content))
        .filter(Boolean),
      wantsJsonObject(req) ? JSON_MODE_DIRECTIVE : null,
    ].filter((value): value is string => Boolean(value))
    if (requestAppendBlocks.length > 0) {
      const appendPath = join(home.promptDir, 'request-append-system-prompt.md')
      try {
        writePrimeAgentFile(appendPath, requestAppendBlocks.join('\n\n'))
      } catch (err) {
        home.cleanup()
        throw new BackendError(
          `prime could not materialize the request system prompt: ${err instanceof Error ? err.message : String(err)}`,
          'upstream',
          err,
        )
      }
      args.push('--append-system-prompt', appendPath)
    }
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
          ...primeAgentDirEnv(home.agentDir),
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
      let kernelDeadMarker: string | undefined
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
        const assistantEvent = type === 'message_update' ? record(ev.assistantMessageEvent) : undefined
        const assistantEventType = assistantEvent ? String(assistantEvent.type ?? '') : ''

        // Kernel death: a crashed IPython kernel is never re-provisioned
        // headlessly, so every later `ipython` call fails with a known marker
        // and the session is unrecoverable rather than retryable. Scan every
        // non-prose frame — tool results, errors, turn failures. The model's
        // own text rides text_delta/thinking_delta and is deliberately
        // excluded, so an answer that quotes a marker cannot fail the run.
        if (
          kernelDeadMarker === undefined
          && assistantEventType !== 'text_delta'
          && assistantEventType !== 'thinking_delta'
        ) {
          kernelDeadMarker = matchPrimeKernelDeadMarker(line)
        }

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
          const ame = assistantEvent
          if (!ame) continue
          const ameType = assistantEventType
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

      kernelDeadMarker ??= matchPrimeKernelDeadMarker(stderr.render(4000))

      // A kernel-dead sighting OUTRANKS every other failure shape: whatever the
      // turn reported, the session is unrecoverable rather than retryable, and
      // the caller must be told that rather than left to retry into the same
      // dead tool (or to burn its whole deadline against a wedged one).
      if (kernelDeadMarker !== undefined) {
        throw new BackendError(
          `prime IPython kernel died (${JSON.stringify(kernelDeadMarker)}) and prime-agent never `
          + 're-provisions it headlessly; this session is unrecoverable — start a new one',
          'upstream',
        )
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
    // Request-scoped prompt files live beside the HOME, never inside the agent
    // dir, so they work unchanged against an operator-owned persistent dir.
    const promptDir = join(base, 'prompt')
    mkdirSync(home, { recursive: true })
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(sessionArtifactDir, { recursive: true })
    mkdirSync(promptDir, { recursive: true })

    let apiKeyEnv: Record<string, string> = {}
    if (this.opts.modelsJsonPath) {
      // Re-read per run so operator rotation lands without a bridge restart.
      const text = readFileSync(this.opts.modelsJsonPath, 'utf8')
      const parsed = parsePrimeModelsJson(text, this.opts.modelsJsonPath)
      // Atomic + owner-only: the fork re-reads models.json at model-resolution
      // time, so a live process must never observe a partial write, and this
      // file carries the operator's real credentials.
      writePrimeAgentFile(join(agentDir, 'models.json'), text)
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
      promptDir,
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
