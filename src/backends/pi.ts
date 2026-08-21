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
 * Provider and model are both required so the bridge can pin the exact
 * credential-free child configuration before Pi starts.
 *
 * Auth: the bridge resolves provider auth before Pi starts and forwards model
 * traffic through a request-scoped loopback endpoint. Pi and every tool it
 * launches receive neither the daemon credential nor ambient GitHub/provider
 * variables.
 *
 * MCP: MCP support comes from the `pi-mcp-adapter` extension. A profile-less
 * request may use X-Mcp-Config/body `mcp.mcpServers`; an exact profile uses
 * `agent_profile.mcp`. The bridge writes the selected set to a unique config and
 * passes it through the adapter's `--mcp-config` flag. Concurrent Pi agents may
 * therefore share a task cwd without sharing control config. If the adapter is NOT
 * installed the request is REJECTED (`not_configured`) instead of
 * silently dropping the servers — a run whose tools never existed must
 * fail loudly, not score zero structurally. Detection: `pi-mcp-adapter`
 * in the pi agent dir's npm node_modules or `settings.json` packages
 * (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`);
 * `CLI_BRIDGE_PI_MCP_ADAPTER=0` can disable it explicitly.
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
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Backend, ChatDelta, ChatRequest, BackendHealth, NativeSessionBackend } from './types.js'
import { versionHealth } from './health.js'
import { BackendError } from './types.js'
import { assertModeSupported } from '../modes.js'
import { nativeReasoningControl } from '@tangle-network/agent-interface'
import type { SessionRecord } from '../sessions/store.js'
import {
  buildCanonicalMcpServers,
  assertPiOutputTokenRequest,
  materializeMcpServersForPi,
  profileExecutionIdentity,
  provisionPiProfile,
  resolveAgentProfile,
  resolveMcpServers,
  resolveRequestedReasoningEffort,
} from './profile-support.js'
import { contentToText } from './content.js'
import { traceContextToChildEnv } from '../trace/ids.js'
import { scopedHostSpawner } from '../executors/scoped-host.js'
import { resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import {
  registerJailArgumentRewrite,
  registerJailReadable,
  resolveJailRoot,
  selectJailBackend,
} from '../jail/index.js'
import { readProcessLines, waitForProcessClose } from './process-lines.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'
import { terminateSpawned } from '../executors/process-tree.js'
import { addUsage, type CollectedUsage } from '../usage.js'
import { piToolProcessEnvironment } from './pi-process-environment.js'
import {
  createPiInferenceTransportResolver,
  ensurePiSessionFile,
  providerDispatchFromPiFailure,
  provisionPiInferenceTransport,
  stripProviderDispatchMarker,
  type PiInferenceTransportResolver,
  type ProvisionedPiInferenceTransport,
} from './pi-inference-transport.js'
export { piToolProcessEnvironment } from './pi-process-environment.js'
import { piNativeCapabilities, startPiNativeSession } from './pi-native-start.js'

export interface PiBackendOptions {
  bin: string
  timeoutMs: number
  /** Overrides the high finite request-inspection boundary for isolated Pi traffic. */
  maxInferenceRequestBytes?: number
  /** Subprocess spawner. Defaults to scoped host. */
  spawner?: Spawner
  /** Trusted provider resolution. Injectable for deterministic tests. */
  transportResolver?: PiInferenceTransportResolver
  /** Attempts per turn before a transient failure is raised, counting the first. Defaults to
   *  {@link DEFAULT_PI_TURN_ATTEMPTS}; `1` disables the retry. */
  maxTurnAttempts?: number
  /** Base backoff between turn attempts, multiplied by the attempt number. Defaults to
   *  {@link PI_TURN_RETRY_BACKOFF_MS}. */
  turnRetryBackoffMs?: number
}

/** Parsed `pi/<provider>/<model>` selection. Incomplete ids are rejected before spawn. */
interface PiModelSpec {
  provider?: string
  model?: string
}

export function parsePiModelId(model: string): PiModelSpec {
  const m = model.toLowerCase()
  if (m === 'pi') return {}
  if (!m.startsWith('pi/')) return {}
  const rest = model.slice(3) // preserve original case for the model id
  const slash = rest.indexOf('/')
  if (slash === -1) return { model: rest }
  return { provider: rest.slice(0, slash), model: rest.slice(slash + 1) }
}


/**
 * Pi's MCP adapter keeps its compact proxy by default. A request profile,
 * however, declares actual tools rather than a second protocol the model must
 * learn before it can reach those tools. Select every request-supplied server
 * for direct exposure, preserving any ambient selectors without naming a
 * particular server or tool in bridge source.
 */
export function piDirectToolSelection(
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
export function piExtensionArgs(
  req: ChatRequest,
  session: SessionRecord | null,
  mcpAdapterPath: string | null,
): string[] {
  const pi = resolveAgentProfile(req, session)?.extensions?.pi
  if (pi !== undefined && (!pi || typeof pi !== 'object' || Array.isArray(pi))) {
    throw new BackendError('extensions.pi must be an object', 'parse_error')
  }
  const unknown = pi === undefined
    ? []
    : Object.keys(pi).filter((key) => key !== 'load')
  if (unknown.length > 0) {
    throw new BackendError(
      `unsupported extensions.pi controls: ${unknown.sort().join(', ')}`,
      'parse_error',
    )
  }

  let load: string[]
  if (pi === undefined || !Object.hasOwn(pi, 'load')) {
    if (!mcpAdapterPath) return []
    // PI_CODING_AGENT_DIR points at a fresh credential-free directory for the
    // child. The adapter therefore cannot arrive through ambient discovery;
    // request-level MCP must opt the already-installed package back in.
    load = [mcpAdapterPath]
  } else {
    if (!Array.isArray(pi.load) || pi.load.some((entry) => typeof entry !== 'string' || !entry.trim())) {
      throw new BackendError('extensions.pi.load must be an array of non-empty strings', 'parse_error')
    }
    load = pi.load as string[]
    if (
      mcpAdapterPath
      && !load.some((entry) => entry === 'pi-mcp-adapter' || entry === 'npm:pi-mcp-adapter')
    ) {
      throw new BackendError(
        'extensions.pi.load must include the installed pi-mcp-adapter package when the profile requests MCP servers',
        'parse_error',
      )
    }
  }

  const configuredAgentDir = process.env.PI_CODING_AGENT_DIR?.trim()
  const hostAgentDir = configuredAgentDir
    ? resolve(configuredAgentDir)
    : join(homedir(), '.pi', 'agent')
  const hostNpmRoot = join(hostAgentDir, 'npm', 'node_modules')
  // Pi expands `~` itself. Keep the ordinary argv portable across a direct
  // host run, the explicit unconfined fallback, and a container whose mounted
  // Pi directory lives under a different HOME. The executor rewrites exact
  // package arguments only after it proves the OS jail will actually apply.
  const runtimeNpmRoot = join(
    (configuredAgentDir || req.jailSpec) ? hostAgentDir : '~/.pi/agent',
    'npm',
    'node_modules',
  )
  const confinedAgentDir = req.jailSpec ? confinedPiAgentDir(req.jailSpec) : null
  const jailedNpmRoot = confinedAgentDir
    ? join(confinedAgentDir, 'npm', 'node_modules')
    : runtimeNpmRoot
  const entries = new Set((load as string[]).map((spec) => {
    const normalizedSpec = spec.trim()
    const runtimePath = resolvePiExtensionPath(normalizedSpec, hostNpmRoot, runtimeNpmRoot)
    const jailedPath = resolvePiExtensionPath(normalizedSpec, hostNpmRoot, jailedNpmRoot)
    if (runtimePath !== jailedPath) {
      registerJailArgumentRewrite(req.jailSpec, runtimePath, jailedPath, '--extension')
    } else if (req.jailSpec?.readConfine && isAbsolute(runtimePath)) {
      registerJailReadable(
        req.jailSpec,
        extensionDependencyRoot(runtimePath, hostNpmRoot),
      )
    }
    return runtimePath
  }))
  return [
    '--no-extensions',
    ...[...entries].flatMap((entry) => ['--extension', entry]),
  ]
}

function extensionDependencyRoot(extensionPath: string, hostNpmRoot: string): string {
  const rel = relative(hostNpmRoot, extensionPath)
  const installedPackage = rel !== ''
    && rel !== '..'
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel)
  return installedPackage ? hostNpmRoot : extensionPath
}

function confinedPiAgentDir(spec: NonNullable<ChatRequest['jailSpec']>): string | null {
  const root = resolveJailRoot(spec.root, spec.projectDir)
  const source = spec.authSources?.find(
    (entry) => entry.envVar === 'PI_CODING_AGENT_DIR',
  )
  return source ? resolveJailRoot(source.jailRel, root) : null
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
 * Local package paths are resolved through settings.json and verified by the
 * installed package name. `CLI_BRIDGE_PI_MCP_ADAPTER=0` disables the adapter.
 */
export function piMcpAdapterAvailable(): boolean {
  const override = process.env.CLI_BRIDGE_PI_MCP_ADAPTER
  if (override === '0' || override === 'false') return false
  return resolvePiMcpAdapterInstallPath() !== null
}

export function resolvePiMcpAdapterInstallPath(): string | null {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
  const installedPath = join(agentDir, 'npm', 'node_modules', 'pi-mcp-adapter')
  if (existsSync(installedPath)) return installedPath
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf-8')) as { packages?: unknown }
    if (Array.isArray(settings.packages)) {
      for (const p of settings.packages) {
        if (typeof p !== 'string') continue
        // Local-path installs (`/some/dir`, `./rel`, `file:…`, `path:…`) may
        // not carry the adapter's name in the path — resolve the
        // package.json name. Relative specs resolve against the agent dir
        // (where settings.json lives), NOT the bridge process cwd.
        const spec = p.replace(/^(file|path):(\/\/)?/, '')
        // `isAbsolute` covers POSIX and (on Windows builds) drive-letter
        // forms; the explicit drive-letter check keeps a Windows-authored
        // settings.json from being misread as an npm name elsewhere.
        const winAbsolute = /^[A-Za-z]:[\\/]/.test(spec)
        if (!isAbsolute(spec) && !winAbsolute && !spec.startsWith('.')) continue
        const localPath = isAbsolute(spec) || winAbsolute ? spec : join(agentDir, spec)
        try {
          const pkg = JSON.parse(readFileSync(join(localPath, 'package.json'), 'utf-8')) as { name?: unknown }
          if (pkg.name === 'pi-mcp-adapter') return localPath
        } catch {
          continue
        }
      }
    }
  } catch {
    // unreadable/absent settings — fall through to "not detected"
  }
  return null
}

export class PiBackend implements NativeSessionBackend {
  readonly name = 'pi'
  readonly defaultExecutionTimeoutMs: number
  readonly nativeModes = ['byob'] as const
  private readonly spawner: Spawner
  private readonly transportResolver: PiInferenceTransportResolver

  constructor(private readonly opts: PiBackendOptions) {
    this.defaultExecutionTimeoutMs = opts.timeoutMs
    this.spawner = opts.spawner ?? scopedHostSpawner
    this.transportResolver = opts.transportResolver ?? createPiInferenceTransportResolver({
      bin: opts.bin,
      maxRequestBytes: opts.maxInferenceRequestBytes,
    })
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'pi' || m.startsWith('pi/')
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    return versionHealth(this.name, this.opts.bin, this.spawner, undefined, signal)
  }

  nativeCapabilities() {
    return piNativeCapabilities()
  }

  startNativeSession(req: ChatRequest, session: SessionRecord | null, signal?: AbortSignal) {
    return startPiNativeSession({
      bin: this.opts.bin,
      timeoutMs: this.opts.timeoutMs,
      spawner: this.spawner,
      transportResolver: this.transportResolver,
    }, req, session, signal)
  }

  /**
   * Retry a turn that died BEFORE the caller saw anything.
   *
   * Pi's stream dies on transient upstream faults — a cut connection, a 5xx, a provider hiccup —
   * and every one of those used to end the caller's turn. Measured through router.tangle.tools,
   * that class killed four supervised runs in two days, each sinking 0.2–2.9M input tokens
   * (drewstone/cli-bridge#125). The route's own reliability notes say every caller needs
   * retry-with-backoff; this is that retry, placed where the failure actually happens.
   *
   * The gate is emission, not optimism: once ANY delta has left for the caller, a second attempt
   * would contradict a stream the caller is already reading — duplicated content, a second usage
   * record, a materialization receipt for a process that no longer exists. So a turn is retried
   * only while nothing has been emitted, which is exactly the shape of the deaths in the report.
   * After the first delta the failure is raised as before, and the caller's own driver-level retry
   * (agent-runtime `supervise`) owns recovery from there — it can resume the harness session,
   * which this layer cannot.
   *
   * `not_configured` and `parse_error` are never retried: a missing jail, a rejected credential, or
   * an unparseable request fails identically every time.
   */
  async *chat(
    req: ChatRequest,
    session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    const maxAttempts = resolveMaxPiTurnAttempts(this.opts.maxTurnAttempts)
    // A persistent first turn must keep one native id across an internal retry. Otherwise the
    // first attempt can leave a durable user entry while the retry replays the task in a new file.
    const requestedInternalSessionId = req.session_id && !session?.internalId
      ? randomUUID()
      : undefined
    for (let attempt = 1; ; attempt += 1) {
      let emitted = 0
      // A turn that never started is not a transient turn failure: a rejected spawn is a local
      // condition (a missing binary, an executor refusing the request) that repeats identically,
      // and re-entering would re-materialize every request-scoped profile and MCP file for nothing.
      const stage = { started: false }
      try {
        for await (const delta of this.runTurn(
          req,
          session,
          signal,
          stage,
          requestedInternalSessionId,
        )) {
          emitted += 1
          yield delta
        }
        return
      } catch (error) {
        if (
          emitted > 0
          || !stage.started
          || attempt >= maxAttempts
          || signal.aborted
          || !isRetryablePiTurnFailure(error)
        ) {
          throw error
        }
        // Linear-doubling backoff on a per-turn scale: the upstream fault this recovers from
        // clears in seconds, and a longer wait would just burn the caller's deadline.
        const backoffBase = this.opts.turnRetryBackoffMs ?? PI_TURN_RETRY_BACKOFF_MS
        await delayBeforeRetry(backoffBase * attempt, signal)
        if (signal.aborted) throw error
      }
    }
  }

  private async *runTurn(
    req: ChatRequest,
    session: SessionRecord | null,
    signal: AbortSignal,
    /** Flipped the moment a child process exists, so the wrapper can tell a turn that DIED from a
     *  turn that never began. */
    stage: { started: boolean },
    requestedInternalSessionId?: string,
  ): AsyncIterable<ChatDelta> {
    const profile = resolveAgentProfile(req, session)
    assertPiOutputTokenRequest(req, profile)
    assertModeSupported(this.name, req.mode ?? 'byob', ['byob'],
      'pi has native tools (read/bash/edit/write); hosted-safe requires a verified --no-tools enforcement path')

    if (this.spawner.executionEnvironment === undefined) {
      throw new BackendError(
        'backend pi requires an executor that declares host or docker isolation; '
        + 'an undeclared executor cannot prove that Pi tools are separated from host credentials',
        'not_configured',
      )
    }
    if (this.spawner.executionEnvironment === 'test-double' && process.env.VITEST !== 'true') {
      throw new BackendError(
        'backend pi test-double executors are only accepted by the test runner',
        'not_configured',
      )
    }
    if (this.spawner.executionEnvironment === 'docker') {
      throw new BackendError(
        'backend pi isolated inference uses a bridge-owned loopback transport that is not reachable from the '
        + 'Docker network namespace; set PI_EXECUTOR=host rather than falling back to mounted provider credentials',
        'not_configured',
      )
    }
    if (this.spawner.executionEnvironment === 'host') {
      const jailBackend = selectJailBackend()
      if (
        !req.jailSpec?.readConfine
        || jailBackend.name !== 'bwrap'
        || !(await jailBackend.isAvailable())
      ) {
        throw new BackendError(
          'backend pi requires an enforced Linux fs-jail so Bash and descendants cannot read host credentials '
          + 'or sibling sessions; send execution.jail.mode=fs-jail and enable bubblewrap',
          'not_configured',
        )
      }
      // Pi carries a scoped model token inside its private config. An operator's
      // global warn fallback must never downgrade this request to open host reads.
      req.jailSpec.requireEnforcement = true
    }

    const spec = parsePiModelId(req.model)
    if (!spec.provider || !spec.model) {
      throw new BackendError(
        'backend pi requires an explicit pi/<provider>/<model> so it can pin the isolated inference endpoint',
        'not_configured',
      )
    }
    const prompt = this.buildPrompt(req)

    const args: string[] = [
      '--print',
      '--mode', 'json',
    ]
    args.push('--provider', spec.provider)
    args.push('--model', spec.model)
    if (session?.internalId) {
      args.push('--session', session.internalId)
    } else if (req.session_id) {
      // Pi's implicit persistent-session path drops request-scoped system
      // prompt overrides while creating the first session. Give Pi an explicit
      // internal id so the first turn uses the profile and report that id back
      // through the normal session event for subsequent `--session` resumes.
      const nativeSessionId = requestedInternalSessionId ?? randomUUID()
      args.push('--session-id', nativeSessionId)
    } else if (!req.session_id) {
      // Only a truly anonymous call is stateless.
      args.push('--no-session')
    }
    const modelHints = profile?.model
    const requestedReasoningEffort = resolveRequestedReasoningEffort(req, session)
    const thinking = nativeReasoningControl('pi', requestedReasoningEffort)
    const executionIdentity = profileExecutionIdentity(req, session, 'pi', thinking)
    if (thinking) args.push('--thinking', thinking)

    const runCwd = resolveSpawnerCwd(this.spawner, req.cwd ?? session?.cwd ?? undefined)
    // Pi no longer authenticates from its ambient config. Keeping the old auth
    // mount would put raw provider credentials back inside a confined process
    // even though model traffic uses the scoped bridge transport.
    if (req.jailSpec) req.jailSpec.authSources = []
    // The single selected MCP source reaches pi-mcp-adapter through its per-process
    // config flag. FAIL-LOUD, not fail-safe: if the caller
    // requested MCP tools pi can't provide, reject the request — a
    // silently tool-less run scores zero for the wrong reason.
    const mcpSpecs = resolveMcpServers(req, session)
    const requestedMcpNames = mcpSpecs ? Object.keys(buildCanonicalMcpServers(mcpSpecs)) : []
    const mcpAdapterPath = requestedMcpNames.length > 0
      ? resolvePiMcpAdapterInstallPath()
      : null
    if (requestedMcpNames.length > 0 && (!piMcpAdapterAvailable() || !mcpAdapterPath)) {
      throw new BackendError(
        `backend pi cannot mount MCP servers: no loadable pi-mcp-adapter install was found `
        + `(run \`pi install npm:pi-mcp-adapter\` or set PI_CODING_AGENT_DIR to its install); `
        + `requested: ${requestedMcpNames.join(', ')}`,
        'not_configured',
      )
    }

    // The provider-specific extension namespace, MCP config, and canonical profile
    // files all use Pi's per-process loaders. Every flag precedes the positional
    // prompt, and large prompt material rides file paths rather than argv.
    args.push(...piExtensionArgs(req, session, mcpAdapterPath))
    let mcpMounted: ReturnType<typeof materializeMcpServersForPi> = null
    let provisioned: ReturnType<typeof provisionPiProfile> = null
    let inference: ProvisionedPiInferenceTransport | null = null
    let spawned: Awaited<ReturnType<Spawner>>
    try {
      const resolvedInference = await this.transportResolver({
        provider: spec.provider,
        model: spec.model,
      }, signal, req.protectedModelCredential)
      inference = await provisionPiInferenceTransport(
        resolvedInference,
        {
          ...(req.session_id ? { sessionId: req.session_id } : {}),
          ...(runCwd ? { projectDir: runCwd } : {}),
          ...(modelHints === undefined
            ? {}
            : { modelHints }),
        },
      )
      if (req.jailSpec) {
        req.jailSpec.extraWritablePaths = [
          ...new Set([
            ...(req.jailSpec.extraWritablePaths ?? []),
            inference.agentDir,
            inference.sessionDir,
          ]),
        ]
      }
      args.push('--session-dir', inference.sessionDir)
      if (req.session_id) {
        ensurePiSessionFile(
          inference.sessionDir,
          session?.internalId ?? requestedInternalSessionId!,
          runCwd ?? process.cwd(),
          { createIfMissing: session?.internalId === undefined },
        )
      }
      mcpMounted = requestedMcpNames.length > 0
        ? materializeMcpServersForPi(mcpSpecs, runCwd)
        : null
      if (mcpMounted) args.push('--mcp-config', mcpMounted.configPath)
      provisioned = provisionPiProfile(
        req,
        session,
        runCwd,
        executionIdentity,
        {
          effectiveEndpoint: inference.requestScopedEndpoint
            ? new URL(inference.upstreamBaseUrl).origin
            : inference.upstreamBaseUrl,
          apiMode: inference.apiMode,
          transport: 'scoped-loopback',
          ...(inference.appliedMaxTotalOutputTokens === undefined
            ? {}
            : { appliedMaxTokens: inference.appliedMaxTotalOutputTokens }),
        },
      )
      if (provisioned) args.push(...provisioned.flags)
      // The task prompt remains the sole positional message. Profile system and
      // additive instructions retain their native, separate authority channels.
      args.push(prompt)
      spawned = await this.spawner(this.opts.bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: runCwd,
        env: {
          ...piToolProcessEnvironment(process.env, req.env ?? {}),
          PI_CODING_AGENT_DIR: inference.agentDir,
          // Request-owned, never inherited: adding TRACEPARENT to the
          // allowlist above would leak the bridge DAEMON's own ambient trace
          // context into every child and mis-parent its spans. Absent caller
          // correlation contributes no keys, so the env is unchanged.
          ...traceContextToChildEnv(req.childTrace),
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
      await inference?.cleanup()
      throw err
    }
    const child = spawned.child
    const releaseSpawner = spawned.release
    stage.started = true

    let spawnErrorMessage = ''
    child.on('error', (err) => { spawnErrorMessage = err.message })
    const earlySpawnError = spawned.spawnError?.()
    if (earlySpawnError) spawnErrorMessage = earlySpawnError.message

    // The durable run owns the deadline and delivers it through this signal.
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
      let observedUsage: CollectedUsage | undefined
      const piToolCalls = new PiToolCallTracker()
      let responseIdentity: PiResponseIdentity | undefined

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
        const eventIdentity = piResponseIdentityFromEvent(ev)
        if (eventIdentity) responseIdentity = mergePiResponseIdentity(responseIdentity, eventIdentity)

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
            const usage = piTokenUsage(receipt)
            observedUsage = addUsage(observedUsage, usage)
            yield { ...piResponseIdentityDelta(responseIdentity), usage }
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
              const usage = piTokenUsage(receipt)
              observedUsage = addUsage(observedUsage, usage)
              yield { ...piResponseIdentityDelta(responseIdentity), usage }
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
              yield { ...piResponseIdentityDelta(responseIdentity), content: delta }
            }
          }
          const toolCall = piToolCalls.observe(ame, ameType)
          if (toolCall) {
            emittedToolCall = true
            yield { ...piResponseIdentityDelta(responseIdentity), tool_calls: [toolCall] }
          }
          // thinking_*, message_start, message_end — drop for now.
          // Future enhancement: surface thinking as a separate ChatDelta
          // variant once the OpenAI o1-style schema lands.
          continue
        }

        const toolCall = piToolCalls.observe(ev, type)
        if (toolCall) {
          emittedToolCall = true
          yield { ...piResponseIdentityDelta(responseIdentity), tool_calls: [toolCall] }
          continue
        }

        // message_start / message_end (top-level) — drop. We rely on
        // text_delta inside message_update for streaming content.
        if (type === 'message_start' || type === 'message_end') continue

        // Unknown event types — drop silently. Pi's NDJSON schema may
        // gain new event types; we don't want to break on additions.
      }

      const exitCode = await waitForProcessClose(child)
      signal.removeEventListener('abort', onAbort)
      releaseSpawner()

      const inferenceTraffic = inference!.traffic()
      const observedModelRequests = inferenceTraffic.generationRequests
        + inferenceTraffic.auxiliaryRequests
      if (observedModelRequests > 0) {
        // The proxy is the authoritative request counter; Pi's usage events are
        // the token receipts checked against it below. Keep the two facts
        // distinct so a missing token receipt never turns into synthetic 0s.
        yield {
          ...piResponseIdentityDelta(responseIdentity),
          usage: {
            model_requests: observedModelRequests,
            cost_known: false,
          },
        }
      }
      const accountingMatched = inferenceTraffic.generationRequests === usageCost.receipts
        && inferenceTraffic.rejectedRequests === 0
        && inferenceTraffic.failedRequests === 0
        && inferenceTraffic.inFlightRequests === 0
      const typedPreProviderFailure = [turnFailure, sawError]
        .filter((message): message is string => message !== null)
        .some((message) => providerDispatchFromPiFailure(
          message,
          inference?.providerDispatchMarker,
        ) === 'not_started')
      const materialization = req.profile_materialization_receipt
      if (materialization?.inference) {
        materialization.inference.observation = {
          ...inferenceTraffic,
          usageReceipts: usageCost.receipts,
          accountingMatched,
          usage: {
            ...(observedUsage?.inputTokensKnown
              ? { inputTokens: observedUsage.inputTokens }
              : {}),
            ...(observedUsage?.freshInputTokensKnown
              ? { freshInputTokens: observedUsage.freshInputTokens }
              : {}),
            ...(observedUsage?.cacheReadInputTokensKnown
              ? { cacheReadInputTokens: observedUsage.cacheReadInputTokens }
              : {}),
            ...(observedUsage?.cacheWriteInputTokensKnown
              ? { cacheWriteInputTokens: observedUsage.cacheWriteInputTokens }
              : {}),
            ...(observedUsage?.outputTokensKnown
              ? { outputTokens: observedUsage.outputTokens }
              : {}),
            costKnown: false,
            ...(usageCost.receipts > 0 && usageCost.complete
              ? { estimatedCost: usageCost.total }
              : {}),
          },
        }
        // Emit the completed receipt before either success or a traffic refusal,
        // so the durable run retains the exact profile and the failed comparison.
        yield {
          ...piResponseIdentityDelta(responseIdentity),
          profile_materialization: structuredClone(materialization),
        }
      }
      if (this.spawner.executionEnvironment === 'host' && !accountingMatched && !typedPreProviderFailure) {
        throw new BackendError(
          'pi inference traffic did not match its recorded usage: '
          + `${inferenceTraffic.generationRequests} generation request(s), `
          + `${usageCost.receipts} Pi usage receipt(s), `
          + `${inferenceTraffic.auxiliaryRequests} auxiliary request(s), `
          + `${inferenceTraffic.rejectedRequests} rejected request(s), `
          + `${inferenceTraffic.failedRequests} failed request(s), `
          + `${inferenceTraffic.inFlightRequests} still in flight`,
          'upstream',
        )
      }

      // Per-turn token receipts stay observable. Pi computes dollars from its
      // local model catalog, so even a complete numeric sum is only an estimate;
      // it must never cross the bridge as provider-billed spend.
      if (usageCost.receipts > 0 && usageCost.complete) {
        yield {
          ...piResponseIdentityDelta(responseIdentity),
          usage: {
            estimated_cost: usageCost.total,
            cost_known: false,
            cost_provenance: 'catalog-estimate',
            cost_scope: 'total',
          },
        }
      }

      if (signal.aborted) {
        yield { ...piResponseIdentityDelta(responseIdentity), finish_reason: 'error' }
        return
      }

      if (spawnErrorMessage) {
        throw new BackendError(`pi spawn failed: ${spawnErrorMessage}`, 'upstream')
      }

      if (exitCode !== 0) {
        const detail = sawError ?? (stderr.render(300) || `exit ${exitCode ?? 'unknown'}`)
        throw piFailureError(
          `pi exit ${exitCode ?? 'unknown'}: ${detail}`,
          piFailureKind(detail),
          inference?.providerDispatchMarker,
        )
      }

      // A failed provider call must never complete as success. Pi exits 0 and the text it
      // did stream is a truncated answer, so this throws even when content was emitted —
      // an empty or partial body reported as `stop` is silent data loss for any caller
      // scoring outcomes, which is exactly what agent-runtime's piExecutor refuses.
      if (turnFailure) {
        throw piFailureError(
          `pi assistant turn failed: ${turnFailure}`,
          piFailureKind(turnFailure),
          inference?.providerDispatchMarker,
        )
      }

      if (sawError && !emittedContent && !emittedToolCall) {
        throw piFailureError(`pi error: ${sawError}`, 'upstream', inference?.providerDispatchMarker)
      }

      yield {
        ...piResponseIdentityDelta(responseIdentity),
        finish_reason: emittedToolCall ? 'tool_calls' : 'stop',
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      // Reap the whole subtree before releasing the slot.
      await terminateSpawned(spawned)
      try { releaseSpawner() } catch { /* best effort */ }
      mcpMounted?.cleanup()
      provisioned?.cleanup()
      await inference?.cleanup()
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

// The usage/receipt/tool-call helpers below are exported for the prime
// backend: prime-agent is a fork of Pi and emits the same AgentEvent lineage
// (message_update / turn_end / agent_end), so both backends parse through one
// implementation instead of drifting copies.
export interface PiUsageReceipt {
  input?: number
  freshInput?: number
  cacheRead?: number
  cacheWrite?: number
  output?: number
  estimatedCost?: number
}

export interface PiUsageCost {
  receipts: number
  total: number
  complete: boolean
}

export interface PiResponseIdentity {
  model: string
  systemFingerprint?: string
}

/**
 * Read Pi's provider response identity before any text delta reaches the bridge.
 * Pi keeps the optional `system_fingerprint` out of its JSON event stream, so
 * the scoped inference proxy carries it in `responseModel` as `model@fingerprint`.
 */
export function piResponseIdentityFromEvent(
  ev: Record<string, unknown>,
): PiResponseIdentity | undefined {
  const candidates: Array<Record<string, unknown> | undefined> = [
    record(ev.message),
    record(record(ev.assistantMessageEvent)?.partial),
    record(ev.partial),
    record(ev.assistantMessageEvent),
    ev,
  ]
  let model: string | undefined
  let fingerprint: string | undefined
  for (const candidate of candidates) {
    if (!candidate) continue
    const responseModel = nonEmptyString(candidate.responseModel)
    const configuredModel = nonEmptyString(candidate.model)
    if (!model && responseModel) model = responseModel
    if (!fingerprint) {
      fingerprint = nonEmptyString(candidate.system_fingerprint)
        ?? nonEmptyString(candidate.systemFingerprint)
    }
    if (!model && fingerprint && configuredModel) model = configuredModel
    if (model && fingerprint) break
  }
  if (!model) return undefined
  const suffix = modelIdentityFingerprint(model)
  const systemFingerprint = fingerprint ?? suffix
  return {
    model: systemFingerprint && suffix === undefined
      ? `${model}@${systemFingerprint}`
      : model,
    ...(systemFingerprint ? { systemFingerprint } : {}),
  }
}

function mergePiResponseIdentity(
  current: PiResponseIdentity | undefined,
  next: PiResponseIdentity,
): PiResponseIdentity {
  if (!current) return next
  if (current.model !== next.model) {
    const currentBase = modelIdentityBase(current.model)
    const nextBase = modelIdentityBase(next.model)
    // Pi emits the configured base `message.model` alongside its provider's
    // fingerprinted `responseModel`; those two observations are one identity.
    if (currentBase !== nextBase) {
      throw new BackendError(
        `pi reported response model changed from ${JSON.stringify(current.model)} to ${JSON.stringify(next.model)}`,
        'upstream',
      )
    }
  }
  if (
    current.systemFingerprint !== undefined
    && next.systemFingerprint !== undefined
    && current.systemFingerprint !== next.systemFingerprint
  ) {
    throw new BackendError(
      `pi reported system fingerprint changed from ${JSON.stringify(current.systemFingerprint)} to ${JSON.stringify(next.systemFingerprint)}`,
      'upstream',
    )
  }
  return {
    model: current.model.includes('@') ? current.model : next.model,
    ...(current.systemFingerprint ?? next.systemFingerprint
      ? { systemFingerprint: current.systemFingerprint ?? next.systemFingerprint }
      : {}),
  }
}

function piResponseIdentityDelta(identity: PiResponseIdentity | undefined): Pick<ChatDelta, 'model' | 'system_fingerprint'> {
  if (!identity) return {}
  return {
    model: identity.model,
    ...(identity.systemFingerprint ? { system_fingerprint: identity.systemFingerprint } : {}),
  }
}

function modelIdentityBase(model: string): string {
  const at = model.lastIndexOf('@')
  return at > 0 ? model.slice(0, at) : model
}

function modelIdentityFingerprint(model: string): string | undefined {
  const at = model.lastIndexOf('@')
  if (at <= 0) return undefined
  const suffix = model.slice(at + 1)
  return /^[A-Za-z0-9._-]+$/u.test(suffix) ? suffix : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
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
export function piAssistantFailure(message: unknown): string | null {
  const value = record(message)
  if (!value) return null
  const stopReason = typeof value.stopReason === 'string' ? value.stopReason : undefined
  const errorMessage = typeof value.errorMessage === 'string' ? value.errorMessage.trim() : ''
  if (stopReason !== 'error' && errorMessage === '') return null
  return errorMessage !== '' ? errorMessage : `stopReason=${stopReason ?? 'error'}`
}

function piFailureError(
  message: string,
  code: BackendError['code'],
  providerDispatchMarker: string | undefined,
): BackendError {
  const providerDispatch = providerDispatchFromPiFailure(message, providerDispatchMarker)
  const cleanMessage = stripProviderDispatchMarker(message, providerDispatchMarker)
  return new BackendError(
    cleanMessage || 'pi provider rejected the request before provider dispatch',
    code,
    undefined,
    providerDispatch === undefined ? undefined : { providerDispatch },
  )
}

/** Attempts per turn, counting the first. Two retries is what the measured transient window needs;
 *  a third would mostly add latency to a genuinely broken route. */
export const DEFAULT_PI_TURN_ATTEMPTS = 3
export const PI_TURN_RETRY_BACKOFF_MS = 750

/** Keep malformed or non-finite configuration from turning a transient retry into an open loop. */
function resolveMaxPiTurnAttempts(configured: number | undefined): number {
  if (configured === undefined || !Number.isSafeInteger(configured)) {
    return DEFAULT_PI_TURN_ATTEMPTS
  }
  return Math.max(1, configured)
}

/** A turn failure worth a second attempt: an upstream/timeout fault, or an unclassified error that
 *  escaped the backend. A refused configuration or an unparseable request repeats identically, and
 *  an abort is the caller's decision. */
export function isRetryablePiTurnFailure(error: unknown): boolean {
  if (error instanceof BackendError) return error.code === 'upstream' || error.code === 'timeout'
  if (error instanceof Error && error.name === 'AbortError') return false
  return error instanceof Error
}

async function delayBeforeRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    timer.unref?.()
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Auth/scope failures are a local credential problem, not a transient upstream one, whether they
 *  arrive on pi's stderr or in the provider's error body. */
export function piFailureKind(detail: string): 'not_configured' | 'upstream' {
  return /401|403|token expired|forbidden|unauthorized/i.test(detail) ? 'not_configured' : 'upstream'
}

export function piUsageReceiptsFromEvent(ev: Record<string, unknown>): PiUsageReceipt[] {
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
  const aggregateInput = openAiInput ?? (
    nativeInput !== undefined || cacheRead !== undefined || cacheWrite !== undefined
      ? (nativeInput ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
      : undefined
  )
  return {
    ...(aggregateInput !== undefined ? { input: aggregateInput } : {}),
    ...(nativeInput !== undefined ? { freshInput: nativeInput } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cost !== undefined ? { estimatedCost: cost } : {}),
  }
}

export function piTokenUsage(receipt: PiUsageReceipt): NonNullable<ChatDelta['usage']> {
  return {
    ...(receipt.input !== undefined ? { input_tokens: receipt.input } : {}),
    ...(receipt.freshInput !== undefined ? { fresh_input_tokens: receipt.freshInput } : {}),
    ...(receipt.cacheRead !== undefined ? { cache_read_input_tokens: receipt.cacheRead } : {}),
    ...(receipt.cacheWrite !== undefined ? { cache_write_input_tokens: receipt.cacheWrite } : {}),
    ...(receipt.output !== undefined ? { output_tokens: receipt.output } : {}),
  }
}

export function recordPiUsageCost(total: PiUsageCost, receipt: PiUsageReceipt): void {
  total.receipts += 1
  if (receipt.estimatedCost === undefined) {
    total.complete = false
    return
  }
  total.total += receipt.estimatedCost
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

export class PiToolCallTracker {
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
