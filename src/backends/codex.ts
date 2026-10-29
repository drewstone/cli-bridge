/** Codex native execution and retained context import; cli-bridge owns the JSONL and app-server transports. */

import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { ensurePrivateDataDirectory } from '../runtime/single-instance.js'
import type { Backend, BackendFailureReason, ChatDelta, ChatRequest, BackendHealth, PreparedContextTransfer } from './types.js'
import { versionHealth } from './health.js'
import { BackendError, BRIDGE_RESERVED_FAILURE_CODES, terminalOutcome } from './types.js'
import { assertModeSupported } from '../modes.js'
import type { SessionRecord } from '../sessions/store.js'
import {
  admitNativeSubscription,
  contextTransferRoute,
  profileExecutionIdentity,
  provisionProfileWorkspace,
  resolveAgentProfile,
  resolveRequestedReasoningEffort,
} from './profile-support.js'
import {
  materializeMcpServersForCodex,
} from './codex-mcp.js'
import {
  resolveMcpServers,
} from './profile-mcp.js'
import {
  resolvePromptMessages,
} from './profile-prompt.js'
import { contentToText } from './content.js'
import { scopedHostSpawner } from '../executors/scoped-host.js'
import { sanitizeHostEnv } from '../executors/host.js'
import type { CodexCatalogReader, NativeModelFacts } from '../native-catalog.js'
import { resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import { assertSuccessfulHarnessExit, readProcessLines, waitForProcessClose } from './process-lines.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'
import { terminateSpawned } from '../executors/process-tree.js'
import { hasCodexEnvAuth, isCodexSubscriptionAuth, prepareCodexJailAuth } from './codex-auth.js'
import { nativeReasoningControl, workspaceCwdPathForBase, type ContextTransferRequest } from '@tangle-network/agent-interface'
import { CODEX_NATIVE_IMPORT_VERSION, CodexContextTransfer, validateCodexContextTransfer } from './codex-context-transfer.js'
import { CODEX_DISABLED_FEATURE_ARGS, assertWorkspacePlanSupported, materializeProfile } from '@tangle-network/agent-profile-materialize'
import {
  assertRouterCodexExecution,
  assertRouterCodexVersion,
  codexRouterArgs,
  openRouterLaunchRecord,
  prepareRouterLaunch,
} from './router-launch.js'

export interface CodexBackendOptions {
  bin: string
  timeoutMs: number
  /** Bridge-owned native state; session execution leases serialize access. */
  stateDir?: string
  /** Subprocess spawner. Defaults to host spawn; pass a docker-pooled spawner for parallel-safe execution. */
  spawner?: Spawner
}

export class CodexBackend implements Backend {
  readonly name = 'codex'
  readonly defaultExecutionTimeoutMs: number
  private readonly spawner: Spawner
  private authPreparationTail: Promise<void> = Promise.resolve()
  private nativeImportProtocolQualified = false
  constructor(private readonly opts: CodexBackendOptions) {
    this.defaultExecutionTimeoutMs = opts.timeoutMs
    this.spawner = opts.spawner ?? scopedHostSpawner
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'codex' || m.startsWith('codex/')
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    const health = await versionHealth(this.name, this.opts.bin, this.spawner, undefined, signal)
    // The actual installed public protocol and restart path were qualified at
    // this version. A different binary needs its own proof before advertisement.
    this.nativeImportProtocolQualified = health.state === 'ready' && health.version === CODEX_NATIVE_IMPORT_VERSION
    return health
  }

  /** The existing app-server transport reads the exact native route; it never creates a thread or turn. */
  readonly readCatalog: CodexCatalogReader = async ({ model, cwd, env, flags, signal }): Promise<NativeModelFacts> => {
    if (this.spawner.executionEnvironment !== 'host') return { provider: null, status: 'unknown', authMode: 'unknown', source: 'native_status', fix: 'codex login status' }
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)])
    const args = ['app-server', '--listen', 'stdio://']
    const selection = splitCodexModel(this.extractModel(model))
    if (selection.provider && selection.provider !== this.name) args.push('-c', `model_provider=${JSON.stringify(selection.provider)}`)
    if (selection.model) args.push('-c', `model=${JSON.stringify(selection.model)}`)
    args.push(...codexConfigFlags(flags))
    const effectiveEnv = sanitizeHostEnv(env, cwd)!
    // Pin the same native home as execution; a PATH wrapper must not allocate another account for a probe.
    effectiveEnv.CODEX_HOME ??= effectiveEnv.HOME ? join(effectiveEnv.HOME, '.codex') : undefined
    const spawned = await this.spawner(this.opts.bin, args, { signal: bounded, stdio: ['pipe', 'pipe', 'pipe'], cwd, env: effectiveEnv })
    const native = new CodexContextTransfer(spawned, undefined, bounded, () => {})
    try {
      await native.initialize()
      const facts = await native.readNativeFacts(cwd)
      if (effectiveEnv.CODEX_API_KEY?.trim()) Object.assign(facts, { status: 'configured', authMode: 'api_key', fix: process.env.CODEX_API_KEY === effectiveEnv.CODEX_API_KEY ? 'unset CODEX_API_KEY' : 'codex login status' })
      if (effectiveEnv.OPENAI_BASE_URL || effectiveEnv.CODEX_ACCESS_TOKEN) Object.assign(facts, { status: 'unknown', authMode: 'unknown', source: 'native_status', fix: 'codex login status' })
      return facts
    } finally { await native.close() }
  }

  contextTransferAvailable(): boolean {
    return Boolean(this.opts.stateDir) && this.nativeImportProtocolQualified
  }

  validateContextTransfer(request: ContextTransferRequest): void {
    if (!this.opts.stateDir) {
      throw new BackendError('Codex native context import requires the retained host executor state directory', 'capability_denied')
    }
    const profile = validateCodexContextTransfer(request)
    const req = codexTransferChatRequest(request)
    const effort = nativeReasoningControl('codex', resolveRequestedReasoningEffort(req, null))
    profileExecutionIdentity(req, null, 'codex', effort)
    assertWorkspacePlanSupported(materializeProfile(profile, 'codex', { skip: ['mcp'], binds: ['codex.developer-instructions'] }))
  }

  async prepareContextTransfer(
    request: ContextTransferRequest,
    _environmentId: string,
    signal: AbortSignal,
  ): Promise<PreparedContextTransfer> {
    this.validateContextTransfer(request)
    if (!this.contextTransferAvailable()) throw new BackendError(`installed Codex native import protocol has not been qualified (requires ${CODEX_NATIVE_IMPORT_VERSION})`, 'capability_denied')
    const stateDir = this.opts.stateDir
    if (!stateDir) throw new BackendError('Codex native context import requires the retained host executor state directory', 'capability_denied')
    const req = codexTransferChatRequest(request)
    const cwd = resolveSpawnerCwd(this.spawner, req.cwd)
    const effort = nativeReasoningControl('codex', resolveRequestedReasoningEffort(req, null))
    const provisioned = provisionProfileWorkspace(req, null, 'codex', cwd, profileExecutionIdentity(req, null, 'codex', effort))
    // The same per-session home the first `codex exec resume` turn uses.
    const sessionId = request.plan.destination.sessionId
    const nativeHome = ensurePrivateDataDirectory(join(stateDir, createHash('sha256').update(sessionId).digest('hex')))
    const releasePreparation = await this.acquireAuthPreparation(signal)
    let codexHome: ReturnType<typeof materializeMcpServersForCodex>
    try {
      codexHome = materializeMcpServersForCodex(resolveMcpServers(req, null), resolveCodexAuthPath(), nativeHome)
    } finally {
      releasePreparation()
    }
    const args = ['app-server', '--listen', 'stdio://', ...provisioned.flags, ...CODEX_DISABLED_FEATURE_ARGS]
    const { provider, model: modelArg } = splitCodexModel(this.extractModel(req.model))
    if (provider && provider !== this.name) args.push('-c', `model_provider=${JSON.stringify(provider)}`)
    if (modelArg) args.push('-c', `model=${JSON.stringify(modelArg)}`)
    if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`)
    let prepared: CodexContextTransfer | undefined
    try {
      signal.throwIfAborted()
      const spawned = await this.spawner(this.opts.bin, args, {
        signal, stdio: ['pipe', 'pipe', 'pipe'], cwd,
        env: { ...process.env, ...provisioned.env, CODEX_HOME: nativeHome }, sessionId,
      })
      prepared = new CodexContextTransfer(spawned, request, signal, () => codexHome?.cleanup(), provisioned.receipt)
      await prepared.initialize()
      return prepared
    } catch (error) {
      if (prepared) await prepared.close()
      else codexHome?.cleanup()
      throw error
    }
  }

  async *chat(
    req: ChatRequest,
    session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    yield* this.chatOwned(req, session, signal)
  }

  private async *chatOwned(
    req: ChatRequest,
    session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    const cwd = resolveSpawnerCwd(this.spawner, req.cwd ?? session?.cwd ?? undefined)
    // Codex has `--sandbox` flags but we haven't verified end-to-end that
    // every FS/shell tool is gated under read-only. Reject hosted-safe
    // until that audit lands — never fake safety.
    assertModeSupported(this.name, req.mode ?? 'byob', ['byob'],
      'codex hosted-safe requires verified --sandbox read-only audit')

    let router: ReturnType<typeof prepareRouterLaunch>
    try {
      router = prepareRouterLaunch(req)
    } catch (error) {
      throw new BackendError((error as Error).message, 'not_configured')
    }

    const prompt = this.flattenPrompt(resolvePromptMessages(req, session, 'codex'))
    // Codex config separates provider from model. A repeated codex/ is the harness, never a provider.
    const { provider: splitProvider, model: modelArg } = splitCodexModel(this.extractModel(req.model))

    // Build argv. `codex exec resume <id> <prompt>` if we have one,
    // else `codex exec <prompt>`. --json emits JSONL events.
    const args: string[] = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      // Receipt-required launches refuse any override this codex version does not
      // recognize: an ignored provider table would spend tokens Router cannot attribute.
      ...(router ? ['--strict-config'] : []),
    ]
    // In receipt mode `codexRouterArgs` is the single owner of the route, so the
    // split wire id is not restated here: a second `model_provider` naming a table
    // no config defines relies on undocumented last-override-wins precedence.
    if (!router) {
      if (splitProvider && splitProvider !== this.name) args.push('-c', `model_provider="${splitProvider}"`)
      if (modelArg) args.push('-c', `model="${modelArg}"`)
    }
    const reasoningEffort = nativeReasoningControl(
      'codex',
      resolveRequestedReasoningEffort(req, session),
    )
    if (reasoningEffort) args.push('-c', `model_reasoning_effort="${reasoningEffort}"`)

    if (session?.internalId) {
      args.splice(1, 0, 'resume', session.internalId)
      // codex exec resume <id> [prompt]
    }

    // Reject unsupported profile plans before copying auth or writing MCP
    // credentials into a synthetic CODEX_HOME.
    const provisioned = provisionProfileWorkspace(
      req,
      session,
      'codex',
      cwd,
      profileExecutionIdentity(req, session, 'codex', reasoningEffort),
    )
    const launchEnv = { ...process.env, ...provisioned.env }
    if (req.subscriptionAdmission) launchEnv.CODEX_HOME ??= launchEnv.HOME ? join(launchEnv.HOME, '.codex') : undefined
    args.push(...provisioned.flags)
    if (provisioned.receipt) args.push(...CODEX_DISABLED_FEATURE_ARGS)
    const nativeConfigFlags = codexConfigFlags(args)
    let routerVersion: string | undefined
    if (router) {
      try {
        assertRouterCodexExecution({
          bin: this.opts.bin,
          environment: this.spawner.executionEnvironment,
          jail: req.jailSpec,
          flags: provisioned.flags,
          env: process.env,
          ...(session?.externalId ? { resumedExternalId: session.externalId } : {}),
          launch: router,
        })
        const health = await this.health(AbortSignal.any([signal, AbortSignal.timeout(10_000)]))
        if (health.state !== 'ready') throw new Error('Router receipt preflight: harness version probe failed')
        assertRouterCodexVersion(health.version)
        routerVersion = health.version
        signal.throwIfAborted()
        args.push(...codexRouterArgs(router))
      } catch (error) {
        throw new BackendError((error as Error).message, 'not_configured')
      }
    }

    args.push('--', prompt)

    // Session leases own native state; the account turn lease owns auth rotation.
    // Keep native state across turns, but regenerate MCP config and auth links.
    const mcpServers = resolveMcpServers(req, session)
    const externalId = req.session_id ?? session?.externalId
    const nativeHome = this.opts.stateDir && externalId
      ? join(this.opts.stateDir, createHash('sha256').update(externalId).digest('hex'))
      : undefined
    const legacySession = nativeHome && session?.internalId && !existsSync(nativeHome)
    if (legacySession && mcpServers) {
      throw new BackendError(
        'Codex session has no retained native home; cannot attach MCP without losing its thread. ' +
        'Continue an existing no-MCP session without MCP, or start a new external session with retained context.',
        'parse_error',
      )
    }
    const authSourcePath = resolveCodexAuthPath()
    // Only an unconfined file-backed ChatGPT turn can rotate the shared host
    // credential during inference. Use the effective launch env after profile
    // materialization; Codex exec prefers env API keys and access tokens.
    const hostSubscription = !req.jailSpec
      && !router
      && !hasCodexEnvAuth(launchEnv)
      && isCodexSubscriptionAuth(authSourcePath)
    const releaseHostAuth = hostSubscription ? await this.acquireAuthPreparation(signal) : undefined
    let codexHome: ReturnType<typeof materializeMcpServersForCodex>
    try {
      codexHome = materializeMcpServersForCodex(
        mcpServers,
        authSourcePath,
        nativeHome && !legacySession
          ? ensurePrivateDataDirectory(nativeHome)
          : undefined,
      )
    } catch (error) {
      releaseHostAuth?.()
      throw error
    }
    let jailHome: Awaited<ReturnType<typeof prepareCodexJailAuth>> | undefined
    let record: ReturnType<typeof openRouterLaunchRecord> | undefined
    const releaseState = (outcome: 'closed' | 'failed' | 'aborted'): void => {
      try { codexHome?.cleanup() } finally {
        try { jailHome?.cleanup() } finally {
          try { record?.close(outcome) } finally { releaseHostAuth?.() }
        }
      }
    }
    try {
      // Refuse profile/API route overrides before canonical auth preparation may refresh an approved account.
      await admitNativeSubscription(req, { env: { ...launchEnv, ...(codexHome ? { CODEX_HOME: codexHome.homePath } : {}) },
        cwd: cwd ?? process.cwd(), model: req.model, flags: nativeConfigFlags, credentialOverride: Boolean(router), executor: this.spawner.executionEnvironment })
      if (req.jailSpec) {
        // Only canonical auth preparation can rotate the account. Access-only
        // jailed turns may run concurrently after their private seeds exist.
        const releasePreparation = await this.acquireAuthPreparation(signal)
        try {
          jailHome = await prepareCodexJailAuth(
            this.opts.bin,
            hasCodexEnvAuth(launchEnv) ? undefined : authSourcePath,
            codexHome ? join(codexHome.homePath, 'config.toml')
              : authSourcePath ? join(dirname(authSourcePath), 'config.toml') : undefined,
            req.execution?.timeoutMs ?? this.opts.timeoutMs,
            signal,
            req.jailSpec.readConfine === true,
            Boolean(codexHome),
          )
        } finally {
          releasePreparation()
        }
        if (req.jailSpec.readConfine) req.jailSpec.requireEnforcement = true
        // The jail seed has no refresh capability. File storage must win over
        // an account config that would otherwise select an unrelated keyring.
        args.splice(1, 0, '-c', 'cli_auth_credentials_store="file"')
        nativeConfigFlags.unshift('-c', 'cli_auth_credentials_store="file"')
      }
    } catch (error) {
      releaseState(signal.aborted ? 'aborted' : 'failed')
      throw error
    }

    // Seed only an access-only credential into the writable jail home. The
    // source account file is never mounted or promoted from agent-writable state.
    if (req.jailSpec && jailHome) {
      req.jailSpec.authSources = [
        ...(req.jailSpec.authSources ?? []).filter((s) => s.envVar !== 'CODEX_HOME'),
        {
          source: jailHome.homePath,
          jailRel: '.codex',
          mode: 'seed-writable',
          only: ['auth.json', 'config.toml'],
          envVar: 'CODEX_HOME',
        },
      ]
    }

    let spawned: Awaited<ReturnType<Spawner>>
    try {
      if (router) {
        // Evidence is created before inference on purpose: an unattributable launch
        // must be refused, never reported as a success with the record missing.
        try {
          router.directory = ensurePrivateDataDirectory(router.directory)
          const profile = resolveAgentProfile(req, session)
          record = openRouterLaunchRecord(router, {
            version: routerVersion!,
            profileDigest: provisioned.receipt?.effectiveProfileDigest ?? null,
            configuredTools: profile?.tools ?? null,
            mcpServers: Object.keys(mcpServers ?? {}).sort(),
          })
        } catch (error) {
          throw new BackendError(
            'Router receipt preflight: cannot write launch evidence under BRIDGE_LAUNCH_RECORD_DIR '
            + `(${(error as Error).message})`,
            'not_configured',
          )
        }
        signal.throwIfAborted()
      }
      signal.throwIfAborted()
      const finalEnv = {
          ...launchEnv,
          ...(jailHome?.subscription ? {
            OPENAI_API_KEY: undefined,
            OPENAI_BASE_URL: undefined,
            CODEX_ACCESS_TOKEN: undefined,
            CODEX_API_KEY: undefined,
          } : {}),
          ...(codexHome ? { CODEX_HOME: codexHome.homePath } : {}),
          ...(router ? { TANGLE_ROUTER_CREDENTIAL: router.key } : {}),
        }
      await admitNativeSubscription(req, { env: finalEnv, cwd: cwd ?? process.cwd(), model: req.model, args, flags: nativeConfigFlags, credentialOverride: Boolean(router), executor: this.spawner.executionEnvironment })
      spawned = await this.spawner(this.opts.bin, args, {
        nativeStore: 'codex',
        signal,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
        env: finalEnv,
        ...(externalId ? { sessionId: externalId } : {}),
        ...(req.jailSpec ? { jail: req.jailSpec } : {}),
        ...(req.childLineage ? { lineageEnv: req.childLineage } : {}),
        ...(req.acquireDeadlineMs !== undefined ? { acquireDeadlineMs: req.acquireDeadlineMs } : {}),
        ...(req.admissionClass ? { admissionClass: req.admissionClass } : {}),
      })
      // A custom spawner may settle after cancellation even if it ignores the
      // signal. Do not read a late child's output or report a normal stop.
      if (signal.aborted) {
        const outcome = await terminateSpawned(spawned)
        record?.termination(outcome)
        spawned.release()
        throw new BackendError(`Codex launch aborted during spawn; termination ${outcome}`, 'aborted')
      }
    } catch (error) {
      releaseState(signal.aborted ? 'aborted' : 'failed')
      throw error
    }
    const child = spawned.child
    const releaseSpawner = spawned.release
    const nativeStore = spawned.effectiveNativeStore ? { effective_native_store: spawned.effectiveNativeStore } : {}

    // Capture both errors already observed by the spawner and errors emitted after this listener attaches.
    let spawnErrorMessage = spawned.spawnError?.()?.message ?? ''
    child.on('error', (err) => { spawnErrorMessage = err.message })

    // The durable run owns the deadline and delivers it through this signal.
    const onAbort = (): void => { void terminateSpawned(spawned) }
    signal.addEventListener('abort', onAbort, { once: true })

    let emittedToolCall = false
    let recordOutcome: 'closed' | 'failed' = 'failed'
    let terminationOutcome: 'stopped' | 'failed' | 'unknown' | null = null
    const finishRecord = async (): Promise<'stopped' | 'failed' | 'unknown'> => {
      terminationOutcome ??= await terminateSpawned(spawned)
      record?.termination(terminationOutcome)
      record?.close(signal.aborted ? 'aborted' : terminationOutcome === 'stopped' ? recordOutcome : 'failed')
      return terminationOutcome
    }
    try {
      if (signal.aborted) {
        onAbort()
        throw new BackendError('Codex launch was aborted', 'aborted')
      }
      let internalSessionId: string | undefined
      const stderr = new BoundedDiagnosticBuffer()
      child.stderr?.on('data', (b) => { stderr.append(b) })
      if (spawnErrorMessage) {
        throw new BackendError(`codex spawn failed: ${spawnErrorMessage}`, 'upstream')
      }
      if (!child.stdout) {
        throw new BackendError('codex subprocess has no stdout pipe', 'upstream')
      }
      let sawError: BackendFailureReason | null = null
      let sawTerminal = false
      let usage: ChatDelta['usage']

      for await (const event of readProcessLines({ child, stdout: child.stdout })) {
        if (event.kind !== 'line') continue
        const line = event.line
        record?.append(line)
        if (!line.trim()) continue
        let ev: Record<string, unknown>
        try { ev = JSON.parse(line) as Record<string, unknown> } catch { continue }

        const type = String(ev.type ?? '')

        if (type === 'thread.started' && typeof ev.thread_id === 'string') {
          internalSessionId = ev.thread_id
          yield { internal_session_id: internalSessionId, ...nativeStore }
          continue
        }

        if (type === 'error') {
          sawError = codexFailureReason(ev)
          continue
        }

        const toolCall = extractToolCall(ev)
        if (toolCall) {
          record?.observeTool(toolCall.name)
          yield { tool_calls: [toolCall] }
          emittedToolCall = true
          // Fall through to extractText: a tool item can also carry a
          // string result payload, which consumers audit as evidence.
        }

        const text = extractText(ev)
        if (text) {
          const item = ev.item as { type?: unknown } | undefined
          yield { content: text, ...(item?.type === 'agent_message' ? { final_text: text } : {}) }
        }

        if (type === 'turn.completed' || type === 'thread.completed') {
          sawTerminal = true
          usage = ev.usage as ChatDelta['usage'] ?? usage
          continue
        }
      }

      await waitForProcessClose(child)
      if (usage) yield { usage }

      if (signal.aborted) {
        await finishRecord()
        yield { finish_reason: 'error', internal_session_id: internalSessionId, ...nativeStore }
        return
      }
      if (sawError) {
        recordOutcome = 'failed'
        // Ended through the delta envelope, not a throw: `BackendError.code` is the
        // bridge's own closed taxonomy and cannot carry a provider discriminant, while
        // the terminal error delta reaches the caller with it. The route answers both
        // shapes 502 (`BackendReportedFailureError`), so only the code is new.
        record?.terminal('error')
        if (await finishRecord() !== 'stopped') {
          throw new BackendError('Codex process termination is unconfirmed', 'upstream')
        }
        yield { ...terminalOutcome('codex', sawError, emittedToolCall), internal_session_id: internalSessionId, ...nativeStore }
        return
      }
      await assertSuccessfulHarnessExit(spawned, 'codex', () => stderr.render())
      if (!sawTerminal)
        throw new BackendError('Codex launch ended without a native terminal event', 'parse_error')
      record?.terminal('completed')
      recordOutcome = 'closed'
      if (await finishRecord() !== 'stopped')
        throw new BackendError('Codex process termination is unconfirmed', 'upstream')
      if (signal.aborted) throw new BackendError('Codex launch was aborted', 'aborted')
      yield { finish_reason: emittedToolCall ? 'tool_calls' : 'stop', internal_session_id: internalSessionId, ...nativeStore }
    } finally {
      signal.removeEventListener('abort', onAbort)
      // Reap the whole subtree — codex spawns sub-processes for MCP
      // tool calls, model HTTP I/O, etc. and we owe them a clean exit.
      // Each cleanup runs even if an earlier one throws, so the evidence record is
      // always closed. `recordOutcome` is 'closed' only after a native terminal event
      // already closed the record, so this call is a no-op on the success path.
      try {
        await finishRecord()
      } finally {
        try { releaseSpawner() } finally { releaseState(signal.aborted ? 'aborted' : recordOutcome) }
      }
    }
  }

  private async acquireAuthPreparation(signal: AbortSignal): Promise<() => void> {
    const prior = this.authPreparationTail
    let release!: () => void
    const own = new Promise<void>((resolve) => { release = resolve })
    this.authPreparationTail = prior.then(() => own)
    let onAbort: (() => void) | undefined
    try {
      await Promise.race([
        prior,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new BackendError('Codex account preparation aborted while queued', 'aborted'))
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        }),
      ])
      if (signal.aborted) throw new BackendError('Codex account preparation aborted while queued', 'aborted')
      return release
    } catch (error) {
      release()
      throw error
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  private flattenPrompt(messages: ChatRequest['messages']): string {
    if (messages.length === 1) return contentToText(messages[0]?.content ?? '')
    return messages.map((m) => `[${m.role}] ${contentToText(m.content)}`).join('\n\n')
  }

  private extractModel(fullModel: string): string | null {
    if (!fullModel.toLowerCase().startsWith('codex/')) return null
    return fullModel.slice('codex/'.length) || null
  }
}

function codexTransferChatRequest(request: ContextTransferRequest): ChatRequest {
  const cwd = request.workspace?.cwd
  if (!cwd) throw new BackendError('Codex native context import requires an explicit existing host workspace cwd', 'capability_denied')
  return {
    model: contextTransferRoute(request),
    messages: [], agent_profile: request.profile, session_id: request.plan.destination.sessionId,
    cwd: workspaceCwdPathForBase(cwd, 'host', 'Codex context transfer'), mode: 'byob',
  }
}

/** Preserve nested model ids while separating the provider; default omits only the model override. */
export function splitCodexModel(
  remainder: string | null,
): { provider: string | null; model: string | null } {
  if (!remainder) return { provider: null, model: null }
  const slash = remainder.indexOf('/')
  const provider = slash > 0 ? remainder.slice(0, slash) : null
  const model = slash > 0 ? remainder.slice(slash + 1) : remainder
  return { provider, model: model.toLowerCase() === 'default' ? null : model }
}

/**
 * Path to the user's persistent codex auth.json. cli-bridge points
 * codex at a synthetic CODEX_HOME for MCP passthrough, but the spawned
 * codex still needs to authenticate as the operator. Honors a
 * `CODEX_HOME` already set on cli-bridge's env so admins can pin a
 * custom location. Falls back to `$HOME/.codex/auth.json` which is
 * where `codex login` writes by default.
 */
function resolveCodexAuthPath(): string | undefined {
  const home = process.env.CODEX_HOME ?? (process.env.HOME ? join(process.env.HOME, '.codex') : undefined)
  return home ? join(home, 'auth.json') : undefined
}

/** Preserve only native structured error discriminants and provider JSON; prose never grants authority. */
export function codexFailureReason(ev: Record<string, unknown>): BackendFailureReason {
  const message = firstString(ev.message) ?? 'codex error'
  const codexCode = codexErrorDiscriminant(ev.codex_error_info)
  const variant = codexErrorVariantPayload(ev.codex_error_info)
  const provider = providerErrorBody(message)
  const providerCode = firstString(provider?.body.type, provider?.body.code)
  // `other` is codex declining to classify, so it must not outrank a code the
  // provider did state: 20 of the 983 recorded refusals are a malformed request
  // whose body names `invalid_request_error` under an `other` discriminant. It
  // still beats nothing when the body names no code either.
  const relayed = codexCode === CODEX_UNCLASSIFIED
    ? relayableCode(providerCode) ?? relayableCode(codexCode)
    : relayableCode(codexCode) ?? relayableCode(providerCode)
  // Both structured channels, and only those: the variant payload's own
  // `http_status_code` (429 on every recorded rate-limit refusal) and the status
  // the provider's wrapper states beside its body (400 on the recorded malformed
  // requests). Codex also names a status in prose on 139 of the 983, and that one
  // is left alone — agent-runtime already reads a status out of message text, and
  // a second scraper here would only disagree with it.
  const status = httpStatus(variant?.http_status_code) ?? httpStatus(provider?.status)
  return {
    message,
    type: relayed ?? 'upstream',
    ...(status === undefined ? {} : { status }),
  }
}

/**
 * A code the bridge may relay as its own failure type, or undefined.
 *
 * The relay channel is shared with the bridge's own taxonomy: the route answers
 * 504 for `timeout` and 502 for everything else, and agent-runtime treats
 * `parse_error`, `not_configured` and `capability_denied` as never-retry. The
 * text on this channel comes from a provider, so a body that quotes one of those
 * words would otherwise decide the bridge's status and the caller's retry.
 * Refusing the collision costs only the code — the CLI's own words still reach
 * the caller in `message`.
 */
function relayableCode(code: string | undefined): string | undefined {
  return code === undefined || BRIDGE_RESERVED_FAILURE_CODES.has(code) ? undefined : code
}

/** A status a provider actually stated, within the range HTTP defines. */
function httpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined
}

/** Codex's own discriminant for a failure it did not classify. */
const CODEX_UNCLASSIFIED = 'other'

/**
 * The `CodexErrorInfo` variant codex named, from either form it serializes.
 *
 * A unit variant is a bare string (`server_overloaded`, `usage_limit_exceeded`,
 * `unauthorized`, `other`); a variant that carries data is a single-key object,
 * and the 429 codex reports after exhausting its retries is
 * `{"response_too_many_failed_attempts":{"http_status_code":429}}` — no `type`
 * and no `code` field, so reading only those lost the most common classified
 * refusal in the recordings (309 of 983).
 */
function codexErrorDiscriminant(value: unknown): string | undefined {
  const bare = firstString(value)
  if (bare !== undefined) return bare
  const info = asRecord(value)
  if (!info) return undefined
  const named = firstString(info.type, info.code)
  if (named !== undefined) return named
  const keys = Object.keys(info)
  return keys.length === 1 ? keys[0] : undefined
}

/**
 * The fields a data-carrying `CodexErrorInfo` variant holds.
 *
 * They sit one level UNDER the variant key, which is the same nesting
 * {@link codexErrorDiscriminant} reads the key from — every field a caller wants
 * from this channel has to come through here, or it reads a shape serde never
 * writes. A unit variant is a bare string and carries no fields at all.
 */
function codexErrorVariantPayload(value: unknown): Record<string, unknown> | null {
  const info = asRecord(value)
  if (!info) return null
  const keys = Object.keys(info)
  return keys.length === 1 ? asRecord(info[keys[0]!]) : null
}

/**
 * The provider's own error body, quoted inside a codex message, with the status
 * its wrapper states beside it.
 *
 * Codex wraps it in its own prose (`unexpected status 400, url: …, cf-ray: …:
 * <body>`), and the prose continues after it on some paths, so the body is read
 * as a balanced object rather than as the tail of the string. Each `{` is tried
 * in turn because the prose before it may itself contain a brace; the attempt
 * count is bounded so a message full of braces cannot become quadratic.
 *
 * A codex message also quotes tool output and assistant text, so a parseable
 * object is not yet a provider error: the candidate must carry an `error` object
 * or name its own class beside a message. Without that test, a tool call echoed
 * into the prose supplied the code the bridge relayed.
 */
function providerErrorBody(
  message: string,
): { body: Record<string, unknown>; status: unknown } | null {
  let attempts = 0
  for (let at = message.indexOf('{'); at !== -1 && attempts < 8; at = message.indexOf('{', at + 1)) {
    attempts += 1
    const candidate = balancedObjectAt(message, at)
    if (candidate === null) continue
    let parsed: unknown
    try { parsed = JSON.parse(candidate) } catch { continue }
    const wrapper = asRecord(parsed)
    if (!wrapper) continue
    // `{"error":{…},"status":400}` is the wrapper the provider sends; a bare body is
    // also accepted, and then the wrapper IS the body.
    const nested = asRecord(wrapper.error)
    const body = nested ?? wrapper
    const namesItsOwnClass = firstString(body.type, body.code) !== undefined
      && typeof body.message === 'string'
    if (nested === null && !namesItsOwnClass) continue
    return { body, status: wrapper.status }
  }
  return null
}

/** The `{…}` span starting at `from`, or null when it never closes. String-aware. */
function balancedObjectAt(text: string, from: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(from, i + 1)
    }
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Item types that carry tool activity rather than assistant text.
 * `codex exec --json` reports each tool invocation as an
 * `item.completed` whose `item.type` names the tool class:
 *   command_execution — {command, aggregated_output, exit_code, status}
 *   mcp_tool_call     — {server, tool, arguments?, status}
 *   web_search        — {query}
 *   file_change       — {changes:[{path,kind}], status}
 * These must surface as ChatDelta.tool_calls (not flattened to text):
 * downstream consumers audit tool usage per call — a treatment gate
 * cannot distinguish "agent never searched" from "stream dropped the
 * call" unless the call is a first-class delta.
 */
function extractToolCall(
  ev: Record<string, unknown>,
): { id: string; name: string; arguments: string } | null {
  if (String(ev.type ?? '') !== 'item.completed') return null
  const item = ev.item as Record<string, unknown> | undefined
  if (!item) return null
  const itemType = String(item.type ?? '')
  const id = String(item.id ?? '')
  switch (itemType) {
    case 'command_execution':
      return {
        id,
        name: 'bash',
        arguments: JSON.stringify({ command: item.command ?? '' }),
      }
    case 'mcp_tool_call': {
      const server = String(item.server ?? '')
      const tool = String(item.tool ?? '')
      if (!server && !tool) return null
      // Matches the MCP convention consumers key on: <server>_<tool>.
      const name = server && tool ? `${server}_${tool}` : server || tool
      const args = item.arguments ?? {}
      return {
        id,
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
      }
    }
    case 'web_search':
      return {
        id,
        name: 'websearch',
        arguments: JSON.stringify({ query: item.query ?? '' }),
      }
    case 'file_change':
      return {
        id,
        name: 'apply_patch',
        arguments: JSON.stringify({ changes: item.changes ?? [] }),
      }
    default:
      return null
  }
}

/**
 * Pull any message-shaped text out of a codex event. Intentionally
 * permissive — codex's field naming has drifted across versions, and
 * we'd rather capture text from a slightly-wrong shape than silently
 * drop it.
 */
function extractText(ev: Record<string, unknown>): string | null {
  // Common patterns we've seen
  const candidates: unknown[] = [
    ev.text,
    ev.content,
    (ev.message as Record<string, unknown> | undefined)?.text,
    (ev.message as Record<string, unknown> | undefined)?.content,
    (ev.item as Record<string, unknown> | undefined)?.text,
    (ev.item as Record<string, unknown> | undefined)?.content,
    (ev.delta as Record<string, unknown> | undefined)?.text,
    (ev.delta as Record<string, unknown> | undefined)?.content,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c
  }
  return null
}

/** Forward only effective native configuration selectors to the read-only app-server. */
function codexConfigFlags(args: readonly string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!
    if (['-c', '--config', '-p', '--profile', '--enable', '--disable'].includes(flag)) {
      const value = args[++index]
      if (value === undefined) throw new Error('Codex native configuration selector has no value')
      result.push(flag === '-p' ? '--profile' : flag, value)
    } else if (/^--(?:config|profile|enable|disable)=/u.test(flag)) result.push(flag)
  }
  return result
}
