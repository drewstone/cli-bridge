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
 * Auth: pi reads its provider's environment variables itself. The bridge
 * passes only the selected provider's known auth/base-url variables plus a
 * small runtime environment; bridge credentials and unrelated provider keys
 * never cross the child boundary.
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
 *   {"type":"agent_settled"}
 *
 * We surface text_delta as ChatDelta.content and pi tool-call lifecycle events
 * as OpenAI-shaped tool_calls so downstream trace consumers can observe native
 * pi tool activity. thinking_delta is dropped (matches how the kimi backend
 * handles its `think` blocks for non-thinking-aware callers).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { canonicalCandidateDigest, type AgentEnvironmentCapabilities, type NativeContextBoundaryProof } from '@tangle-network/agent-interface'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Backend, ChatDelta, ChatRequest, BackendHealth, NativeSession, NativeSessionBackend } from './types.js'
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
import { prepareSpawnerPrivatePath, resolveSpawnerCwd, type Spawner } from '../executors/types.js'
import { readProcessLines, waitForProcessClose } from './process-lines.js'
import { BoundedDiagnosticBuffer } from './diagnostic-buffer.js'
import { finalizeSpawned, retryCleanupUntilSuccessful, terminateSpawned } from '../executors/process-tree.js'
import { createPrivateTemporaryRoot, type PrivateTemporaryRoot } from '../runtime/private-temporary.js'
import {
  PI_PERMISSION_MARKER_PREFIX,
  piPermissionMarker,
  piPermissionTokenFromTitle,
  piSelectedValue,
} from './pi-interaction.js'

export interface PiBackendOptions {
  bin: string
  timeoutMs: number
  /** Subprocess spawner. Defaults to scoped host. */
  spawner?: Spawner
}

const PI_RPC_REQUEST_TIMEOUT_CAP_MS = 30_000

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

function mapPrivateTreeArgs(args: readonly string[], hostRoot: string, runtimeRoot: string): string[] {
  const prefix = `${hostRoot}/`
  return args.map(value => value === hostRoot
    ? runtimeRoot
    : value.startsWith(prefix)
      ? `${runtimeRoot}/${value.slice(prefix.length)}`
      : value)
}

function mapPrivateTreeEnv(
  env: Readonly<Record<string, string>>,
  hostRoot: string,
  runtimeRoot: string,
): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [
    key,
    mapPrivateTreeArgs([value], hostRoot, runtimeRoot)[0]!,
  ]))
}

function piAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR
  if (!configured) return join(homedir(), '.pi', 'agent')
  return resolve(configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured)
}

/** Pi's compiled default is google, but settings.json is the installed agent's real override. */
function resolvePiDefaultProvider(): string {
  try {
    const settings = JSON.parse(readFileSync(join(piAgentDir(), 'settings.json'), 'utf8')) as { defaultProvider?: unknown }
    if (typeof settings.defaultProvider === 'string' && /^[A-Za-z0-9._-]+$/u.test(settings.defaultProvider.trim())) {
      return settings.defaultProvider.trim()
    }
  } catch {
    // The binary's documented default is used when no readable settings override exists.
  }
  return 'google'
}

function resolvePiModelSpec(spec: PiModelSpec): PiModelSpec {
  return { ...spec, provider: spec.provider ?? resolvePiDefaultProvider() }
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
  spawner: Spawner,
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

  const hostNpmRoot = join(piAgentDir(), 'npm', 'node_modules')
  // Pi expands `~` itself. Keeping the default path HOME-relative makes the
  // same argv work for host execution and for a container whose mounted Pi
  // agent directory lives under a different HOME.
  const runtimeAgentDir = spawner.mapPath?.(piAgentDir()) ?? piAgentDir()
  const runtimeNpmRoot = join(runtimeAgentDir, 'npm', 'node_modules')
  const entries = new Set((load as string[]).map((spec) =>
    resolvePiExtensionPath(spec.trim(), hostNpmRoot, runtimeNpmRoot, spawner),
  ))
  return [
    '--no-extensions',
    ...[...entries].flatMap((entry) => ['--extension', entry]),
  ]
}

function resolvePiExtensionPath(spec: string, hostNpmRoot: string, runtimeNpmRoot: string, spawner: Spawner): string {
  const normalized = spec.startsWith('npm:') ? spec.slice(4) : spec
  if (isAbsolute(normalized)) {
    if (existsSync(normalized)) return spawner.mapPath?.(normalized) ?? normalized
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
  const agentDir = piAgentDir()
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

const PI_NATIVE_CAPABILITIES: AgentEnvironmentCapabilities = {
  profile: {
    namedProfiles: false,
    systemPrompt: true,
    instructions: true,
    tools: true,
    permissions: true,
    mcp: true,
    subagents: true,
    resources: { files: false, instructions: true, tools: false, skills: true, agents: true, commands: true },
    hooks: false,
    modes: true,
    runtimeUpdate: false,
    validation: true,
    extensions: ['pi'],
  },
  streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
  retainedControl: {
    exactRunIdentity: true,
    resultIdentity: true,
    eventIdentity: true,
    cancellationIdempotency: true,
  },
  sessions: { continue: true, list: true, messages: true },
  // Pi's RPC has no provider-side compare-and-admit or operation-id replay
  // primitive. The retained bridge still checks its boundary before a turn,
  // but cannot honestly advertise Agent Interface nativeContinuation.
  interactions: {
    kinds: ['permission'],
    answerFieldTypes: ['select'],
    responseScopes: ['interaction'],
    secretAnswers: false,
    concurrentRequests: false,
    replay: true,
    responseIdempotency: true,
  },
  workspace: { read: true, write: true, exec: true, git: true, upload: false, download: false },
  branching: { checkpoint: false, fork: false },
  placement: true,
  usage: true,
  confidential: false,
}

const PI_CHILD_BASE_ENV_KEYS = [
  'HOME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'PWD',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'NVM_DIR',
  'PNPM_HOME',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_PACKAGE_DIR',
] as const

const PI_PROVIDER_ENV_ALIASES: Record<string, readonly string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
  openai: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  gemini: ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'],
  moonshot: ['MOONSHOT_API_KEY', 'MOONSHOT_BASE_URL'],
  'zai-coding-paas': ['ZAI_API_KEY', 'ZAI_GLM_API_KEY', 'ZAI_BASE_URL', 'ZAI_GLM_BASE_URL'],
  'zai-glm': ['ZAI_GLM_API_KEY', 'ZAI_GLM_BASE_URL', 'ZAI_API_KEY', 'ZAI_BASE_URL'],
  zai: ['ZAI_API_KEY', 'ZAI_BASE_URL'],
  zhipu: ['ZHIPU_API_KEY', 'ZHIPU_BASE_URL'],
  'tangle-router': ['TANGLE_API_KEY', 'TANGLE_BASE_URL', 'TANGLE_ROUTER_BASE_URL'],
  xai: ['XAI_API_KEY', 'XAI_BASE_URL'],
  groq: ['GROQ_API_KEY', 'GROQ_BASE_URL'],
  mistral: ['MISTRAL_API_KEY', 'MISTRAL_BASE_URL'],
  openrouter: ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL'],
  ollama: ['OLLAMA_HOST'],
}

const PI_BLOCKED_ENV_KEY = /(?:^|_)(?:API[_-]?KEY|AUTH(?:ORIZATION|ENTICATION)?|BEARER|COOKIE|CREDENTIALS?|PASSWORD|PASSPHRASE|PRIVATE[_-]?KEY|SECRET|TOKEN)(?:_|$)/iu

function piProviderEnvKeys(provider: string | undefined): Set<string> {
  if (!provider) return new Set()
  const normalized = provider.toLowerCase()
  const prefix = normalized.replace(/[^a-z0-9]+/gu, '_').replace(/^_|_$/gu, '').toUpperCase()
  return new Set([
    ...(PI_PROVIDER_ENV_ALIASES[normalized] ?? []),
    ...(prefix ? [`${prefix}_API_KEY`, `${prefix}_AUTH_TOKEN`, `${prefix}_BASE_URL`] : []),
  ])
}

function isSafeProfileEnvKey(key: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/u.test(key)
    && !key.startsWith('BRIDGE_')
    && !key.startsWith('CLI_BRIDGE_')
    && !PI_BLOCKED_ENV_KEY.test(key)
}

/** Build the exact environment granted to one Pi child. */
function piChildEnv(
  spec: PiModelSpec,
  cwd: string | undefined,
  profileEnv: Record<string, string> | undefined,
  directTools: string | undefined,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  const providerKeys = piProviderEnvKeys(spec.provider)
  const allowedParentKeys = new Set<string>([...PI_CHILD_BASE_ENV_KEYS, ...providerKeys])
  for (const key of allowedParentKeys) {
    const value = process.env[key]
    if (typeof value === 'string' && value.length > 0) out[key] = value
  }
  if (cwd) out.PWD = cwd
  if (directTools) out.MCP_DIRECT_TOOLS = directTools

  // Profile materialization values are explicit public configuration, but a
  // profile cannot smuggle a bridge credential or a provider credential for a
  // different model through the child boundary.
  for (const [key, value] of Object.entries(profileEnv ?? {})) {
    if (!isSafeProfileEnvKey(key)) continue
    if (allowedParentKeys.has(key) || key === 'MCP_DIRECT_TOOLS') continue
    out[key] = value
  }
  return out
}

function piNativeCapabilities(): AgentEnvironmentCapabilities {
  return {
    ...PI_NATIVE_CAPABILITIES,
    profile: {
      ...PI_NATIVE_CAPABILITIES.profile,
      mcp: piMcpAdapterAvailable(),
    },
  }
}

export class PiBackend implements NativeSessionBackend {
  readonly name = 'pi'
  readonly nativeModes = ['byob'] as const
  private readonly spawner: Spawner

  constructor(private readonly opts: PiBackendOptions) {
    this.spawner = opts.spawner ?? scopedHostSpawner
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'pi' || m.startsWith('pi/')
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    return versionHealth(this.name, this.opts.bin, this.spawner, undefined, signal)
  }

  nativeCapabilities(): AgentEnvironmentCapabilities {
    return piNativeCapabilities()
  }

  async startNativeSession(
    req: ChatRequest,
    session: SessionRecord | null,
    signal?: AbortSignal,
  ): Promise<NativeSession> {
    assertModeSupported(this.name, req.mode ?? 'byob', ['byob'],
      'pi has native tools (read/bash/edit/write); hosted-safe requires a verified --no-tools enforcement path')
    if (req.interaction_policy === 'unattended-allow') {
      throw new BackendError('native Pi sessions require interaction_policy=interactive; use one-shot for explicit unattended policy', 'parse_error')
    }

    const spec = resolvePiModelSpec(parsePiModelId(req.model))
    const profile = resolveAgentProfile(req, session)
    const runCwd = resolveSpawnerCwd(this.spawner, req.cwd ?? session?.cwd ?? undefined)
    const mcpSpecs = resolveMcpServers(req, session)
    const requestedMcpNames = mcpSpecs ? Object.keys(buildCanonicalMcpServers(mcpSpecs)) : []
    if (requestedMcpNames.length > 0 && !piMcpAdapterAvailable()) {
      throw new BackendError(
        `backend pi cannot mount MCP servers: pi-mcp-adapter extension not installed; requested: ${requestedMcpNames.join(', ')}`,
        'not_configured',
      )
    }

    let mcpMounted: ReturnType<typeof materializeMcpServersForPi> = null
    let provisioned: ReturnType<typeof provisionPiProfile> = null
    let runtimeProvisionedEnv: Record<string, string> | undefined
    let adapterRoot: PrivateTemporaryRoot | null = null
    let spawned: Awaited<ReturnType<Spawner>> | null = null
    const cleanupOwnedFiles = (): void => {
      const failures: unknown[] = []
      for (const cleanup of [
        mcpMounted ? () => mcpMounted?.cleanup() : null,
        provisioned ? () => provisioned?.cleanup() : null,
        adapterRoot ? () => adapterRoot?.cleanup() : null,
      ]) {
        if (!cleanup) continue
        try { cleanup() } catch (error) { failures.push(error) }
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'pi native session file cleanup failed')
    }
    try {
      const args: string[] = ['--mode', 'rpc']
      if (spec.provider) args.push('--provider', spec.provider)
      if (spec.model) args.push('--model', spec.model)
      if (session?.internalId) args.push('--session', session.internalId)
      else args.push('--session-id', randomUUID())
      const thinking = thinkingFlagForEffort(resolveReasoningEffort(req, profile))
      if (thinking) args.push('--thinking', thinking)
      args.push(...piExtensionArgs(req, session, requestedMcpNames.length > 0, this.spawner))

      // Pi's extension UI is the native approval transport. This adapter is
      // deliberately tiny: it asks Pi to display its own dialog and only
      // translates the resulting JSONL request/response at the bridge edge.
      adapterRoot = createPrivateTemporaryRoot(runCwd ?? process.cwd(), '.cli-bridge-pi-rpc-')
      const interactionExtension = join(adapterRoot.path, 'interaction-gate.mjs')
      const interactionNonce = randomUUID().replaceAll('-', '')
      writeFileSync(interactionExtension, piInteractionExtension(false, interactionNonce), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      const runtimeAdapterRoot = await prepareSpawnerPrivatePath(this.spawner, adapterRoot.path)
      args.push('--extension', join(runtimeAdapterRoot, 'interaction-gate.mjs'))

      provisioned = provisionPiProfile(req, session, runCwd)
      if (provisioned) {
        const runtimeProfileRoot = await prepareSpawnerPrivatePath(this.spawner, provisioned.rootPath)
        args.push(...mapPrivateTreeArgs(provisioned.flags, provisioned.rootPath, runtimeProfileRoot))
        runtimeProvisionedEnv = mapPrivateTreeEnv(provisioned.env, provisioned.rootPath, runtimeProfileRoot)
      }
      if (requestedMcpNames.length > 0) {
        const mounted = materializeMcpServersForPi(mcpSpecs, runCwd, { isolateChildren: true })
        if (!mounted) throw new BackendError('backend pi could not materialize the requested MCP servers', 'not_configured')
        mcpMounted = mounted
        const runtimeMcpRoot = await prepareSpawnerPrivatePath(this.spawner, dirname(mounted.configPath))
        args.push('--mcp-config', join(runtimeMcpRoot, basename(mounted.configPath)))
      }

      spawned = await this.spawner(this.opts.bin, args, {
        signal,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: runCwd,
        env: piChildEnv(
          spec,
          runCwd,
          runtimeProvisionedEnv,
          requestedMcpNames.length > 0
            ? piDirectToolSelection(requestedMcpNames, process.env.MCP_DIRECT_TOOLS)
            : undefined,
        ),
        exactEnv: true,
        ...(req.session_id ? { sessionId: req.session_id } : {}),
        ...(req.jailSpec ? { jail: req.jailSpec } : {}),
      })
      const child = spawned.child
      if (!child.stdin || !child.stdout) {
        throw new BackendError('pi RPC subprocess has no stdin/stdout pipes', 'upstream')
      }
      return new PiNativeSession(spawned, {
        capabilities: piNativeCapabilities(),
        requestTimeoutMs: Math.max(1, Math.min(this.opts.timeoutMs, PI_RPC_REQUEST_TIMEOUT_CAP_MS)),
        cleanup: cleanupOwnedFiles,
      })
    } catch (error) {
      try {
        if (spawned) await finalizeSpawned(spawned, [cleanupOwnedFiles])
        else cleanupOwnedFiles()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'pi native session startup and cleanup failed')
      }
      throw error
    }
  }

  async *chat(
    req: ChatRequest,
    session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    assertOneShotInteractionPolicy(req, session)
    assertModeSupported(this.name, req.mode ?? 'byob', ['byob'],
      'pi has native tools (read/bash/edit/write); hosted-safe requires a verified --no-tools enforcement path')

    const spec = resolvePiModelSpec(parsePiModelId(req.model))
    const prompt = this.buildPrompt(req)
    const profile = resolveAgentProfile(req, session)
    const unattendedAllow = req.interaction_policy === 'unattended-allow'

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
    if (!unattendedAllow) args.push('--no-tools')

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
    args.push(...piExtensionArgs(req, session, requestedMcpNames.length > 0, this.spawner))
    let mcpMounted: ReturnType<typeof materializeMcpServersForPi> = null
    let provisioned: ReturnType<typeof provisionPiProfile> = null
    let runtimeProvisionedEnv: Record<string, string> | undefined
    let interactionRoot: PrivateTemporaryRoot | null = null
    let spawned: Awaited<ReturnType<Spawner>>
    try {
      provisioned = provisionPiProfile(req, session, runCwd)
      if (provisioned) {
        const runtimeProfileRoot = await prepareSpawnerPrivatePath(this.spawner, provisioned.rootPath)
        args.push(...mapPrivateTreeArgs(provisioned.flags, provisioned.rootPath, runtimeProfileRoot))
        runtimeProvisionedEnv = mapPrivateTreeEnv(provisioned.env, provisioned.rootPath, runtimeProfileRoot)
      }
      mcpMounted = requestedMcpNames.length > 0
        ? materializeMcpServersForPi(mcpSpecs, runCwd, { isolateChildren: true })
        : null
      if (mcpMounted) {
        const runtimeMcpRoot = await prepareSpawnerPrivatePath(this.spawner, dirname(mcpMounted.configPath))
        args.push('--mcp-config', join(runtimeMcpRoot, basename(mcpMounted.configPath)))
      }
      if (unattendedAllow) {
        interactionRoot = createPrivateTemporaryRoot(runCwd ?? process.cwd(), '.cli-bridge-pi-interaction-')
        const interactionExtension = join(interactionRoot.path, 'interaction-gate.mjs')
        writeFileSync(interactionExtension, piInteractionExtension(true), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        const runtimeInteractionRoot = await prepareSpawnerPrivatePath(this.spawner, interactionRoot.path)
        args.push('--extension', join(runtimeInteractionRoot, basename(interactionExtension)))
      }
      // The task prompt remains the sole positional message. Profile system and
      // additive instructions retain their native, separate authority channels.
      args.push(prompt)
      spawned = await this.spawner(this.opts.bin, args, {
        signal,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: runCwd,
        env: piChildEnv(
          spec,
          runCwd,
          runtimeProvisionedEnv,
          requestedMcpNames.length > 0
            ? piDirectToolSelection(requestedMcpNames, process.env.MCP_DIRECT_TOOLS)
            : undefined,
        ),
        exactEnv: true,
        ...(req.session_id ? { sessionId: req.session_id } : {}),
        ...(req.jailSpec ? { jail: req.jailSpec } : {}),
      })
    } catch (err) {
      mcpMounted?.cleanup()
      provisioned?.cleanup()
      interactionRoot?.cleanup()
      throw err
    }
    const child = spawned.child

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
      await finalizeSpawned(spawned, [
        mcpMounted ? () => mcpMounted.cleanup() : null,
        provisioned ? () => provisioned.cleanup() : null,
        interactionRoot ? () => interactionRoot.cleanup() : null,
      ])
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

function assertOneShotInteractionPolicy(req: ChatRequest, session: SessionRecord | null): void {
  if (req.interaction_policy === 'interactive') {
    throw new BackendError(
      'pi one-shot mode cannot carry interactive responses; use a retained native session or an explicit unattended policy',
      'capability_denied',
    )
  }
  if (req.interaction_policy !== 'unattended-allow') return
  const profile = resolveAgentProfile(req, session)
  const receipt = req.interaction_policy_receipt
  if (
    !profile
    || receipt?.schema !== 'cli-bridge.interaction-policy.v1'
    || receipt.name !== 'unattended-allow'
    || receipt.profileDigest !== canonicalCandidateDigest(profile)
  ) {
    throw new BackendError(
      'unattended-allow requires a matching profile-scoped interaction-policy receipt',
      'capability_denied',
    )
  }
}

function piInteractionExtension(unattendedAllow: boolean, interactionNonce?: string): string {
  if (unattendedAllow) {
    return `export default function (pi) {
  pi.on('tool_call', async () => undefined)
  // cli-bridge unattended-allow-v1 is only emitted with a matching profile receipt.
}
`
  }
  if (!interactionNonce) throw new Error('interactive Pi extension requires a unique marker nonce')
  const nonce = JSON.stringify(interactionNonce)
  const markerPrefix = JSON.stringify(PI_PERMISSION_MARKER_PREFIX)
  return `export default function (pi) {
  const bridgeNonce = ${nonce}
  let permissionNumber = 0
  const sanitizePublicTitle = (value) => String(value ?? '')
    .replace(/[^\\p{L}\\p{N} .,_:\\/-]/gu, ' ')
    .replace(/\\s+/gu, ' ')
    .trim()
    .slice(0, 120) || 'tool'
  pi.on('tool_call', async (event, ctx) => {
    if (!ctx.hasUI) return { block: true, reason: 'interactive approval is unavailable' }
    const token = bridgeNonce + '-' + (++permissionNumber)
    const publicTitle = 'Permission: ' + sanitizePublicTitle(event.toolName)
    const choice = await ctx.ui.select(publicTitle + ' [cli-bridge-marker:' + token + ']', ['allow_once', 'deny'])
    await ctx.ui.notify(${markerPrefix} + ':' + token + ':' + String(choice), 'info')
    if (choice !== 'allow_once') return { block: true, reason: 'permission denied' }
    return undefined
  })
}
`
}

interface PiNativeSessionOptions {
  capabilities: AgentEnvironmentCapabilities
  requestTimeoutMs: number
  cleanup(): void
}

interface PiRpcResponse {
  type?: string
  id?: string | number
  command?: string
  success?: boolean
  error?: string
  data?: unknown
}

interface PiRpcWaiter {
  resolve: (value: PiRpcResponse) => void
  reject: (error: Error) => void
}

interface PiRpcRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

interface PiMarkerWaiter {
  readonly marker: string
  readonly afterSequence: number
  resolve: () => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

/** A single Pi RPC child; the retained-session service owns the public events. */
class PiNativeSession implements NativeSession {
  readonly capabilities: AgentEnvironmentCapabilities
  private readonly child: Awaited<ReturnType<Spawner>>['child']
  private readonly release: () => void
  private readonly terminate: () => Promise<void>
  private readonly cleanup: () => void
  private readonly requestTimeoutMs: number
  private readonly stderr = new BoundedDiagnosticBuffer()
  private readonly pending = new Map<string | number, PiRpcWaiter>()
  private readonly queue: Record<string, unknown>[] = []
  private readonly waiters: Array<{ resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }> = []
  private readonly markerWaiters = new Set<PiMarkerWaiter>()
  private readonly interactionMarkers = new Map<string, string>()
  private readonly closeListeners = new Set<(reason: Error) => void>()
  private buffer = ''
  private eventSequence = 0
  private closed = false
  private closing: Promise<void> | null = null
  private providerSession: string | null = null
  private turnActive = false
  private childError: Error | null = null
  private abortInFlight: Promise<void> | null = null
  private terminationInFlight: Promise<void> | null = null

  constructor(
    spawned: Awaited<ReturnType<Spawner>>,
    options: PiNativeSessionOptions,
  ) {
    this.capabilities = options.capabilities
    this.requestTimeoutMs = options.requestTimeoutMs
    this.child = spawned.child
    this.release = spawned.release
    this.terminate = async () => {
      if (this.terminationInFlight) return this.terminationInFlight
      this.terminationInFlight = (spawned.terminate ? spawned.terminate() : terminateSpawned(spawned))
      try { await this.terminationInFlight } finally { this.terminationInFlight = null }
    }
    this.cleanup = options.cleanup
    this.child.stdout?.on('data', chunk => this.consume(chunk.toString()))
    this.child.stderr?.on('data', chunk => this.stderr.append(chunk))
    this.child.stdin?.on('error', error => this.end(error))
    this.child.stdout?.on('end', () => this.end(new Error('pi RPC stdout ended')))
    this.child.on('error', error => {
      this.childError = error
      this.end(error)
    })
    this.child.on('close', () => this.end(this.childError ?? new Error('pi RPC process closed')))
  }

  providerSessionId(): string | null {
    return this.providerSession
  }

  isClosed(): boolean {
    return this.closed
  }

  onClose(listener: (reason: Error) => void): () => void {
    if (this.closed) {
      queueMicrotask(() => {
        try {
          listener(this.childError ?? new Error('pi RPC process closed'))
        } catch {
          // A late owner cannot break child cleanup.
        }
      })
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  whenClosed(): Promise<void> {
    if (this.closed) return this.startCleanup()
    return new Promise<void>((resolve, reject) => {
      const unsubscribe = this.onClose(() => {
        unsubscribe()
        this.startCleanup().then(resolve, reject)
      })
    })
  }

  async *turn(prompt: string, signal: AbortSignal): AsyncIterable<unknown> {
    if (this.closed) throw new BackendError('pi native session is closed', 'upstream')
    if (this.turnActive) throw new BackendError('pi native session already has an active turn', 'upstream')
    this.turnActive = true
    const requestId = `prompt-${randomUUID()}`
    const onAbort = (): void => { void this.abort() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await this.request(
        { id: requestId, type: 'prompt', message: prompt },
        { signal, timeoutMs: this.requestTimeoutMs },
      )
      while (!this.closed) {
        const event = await this.nextEvent(signal)
        if (event.type === 'session' && typeof event.id === 'string') this.providerSession = event.id
        yield event
        // `agent_end` closes one low-level model attempt and may be followed by
        // an automatic retry or compaction. `agent_settled` is Pi's documented
        // session-level terminal boundary, so only it ends a retained turn.
        if (event.type === 'agent_settled') return
      }
      throw this.childError ?? new Error('pi native session ended before agent_settled')
    } catch (error) {
      if (signal.aborted || (error instanceof BackendError && (error.code === 'timeout' || error.code === 'aborted'))) {
        // A prompt can be accepted by the OS while Pi never acknowledges it.
        // Try the native abort command within the same bounded window, then
        // close the child so the retained session cannot keep a lease.
        await this.abort()
      }
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.turnActive = false
    }
  }

  async steer(prompt: string): Promise<void> {
    await this.request({ id: `steer-${randomUUID()}`, type: 'steer', message: prompt })
  }

  async abort(): Promise<void> {
    if (this.closed) return
    if (this.abortInFlight) return this.abortInFlight
    this.abortInFlight = (async () => {
      const termination = this.terminate()
      try {
        await this.request(
          { id: `abort-${randomUUID()}`, type: 'abort' },
          // Abort is a courtesy protocol message. The executor hard-stop runs
          // in parallel because Pi may ignore it or stop answering JSON-RPC.
          { timeoutMs: Math.min(this.requestTimeoutMs, 1_000) },
        )
      } catch {
        // The owned Run turns an abort into a cancelled terminal state even when
        // Pi closes the RPC pipe before acknowledging the command.
      } finally {
        await termination
        this.end(new Error('pi native session aborted'))
        await this.closing
        this.abortInFlight = null
      }
    })()
    return this.abortInFlight
  }

  async respondToNativeInteraction(id: string, response: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new BackendError('pi native session is closed', 'upstream')
    const token = this.interactionMarkers.get(id)
    if (!token) {
      throw new BackendError('Pi interaction is not an instrumented permission dialog', 'capability_denied')
    }
    const marker = piPermissionMarker(token, piSelectedValue(response))
    const afterSequence = this.eventSequence
    const waitForMarker = this.waitForMarkerAfter(marker, afterSequence)
    try {
      this.write({ type: 'extension_ui_response', id, ...response })
      // Pi 0.83 does not acknowledge extension_ui_response on the command
      // channel. The injected extension's exact notify marker is the only
      // proof that this specific select response was applied.
      await waitForMarker
    } finally {
      this.interactionMarkers.delete(id)
    }
  }

  async contextBoundary(input: { runId: string; environmentId: string; sessionId: string }): Promise<NativeContextBoundaryProof | null> {
    if (this.closed) return null
    let response: PiRpcResponse
    try {
      response = await this.request({ type: 'get_state' }, { timeoutMs: this.requestTimeoutMs })
    } catch (error) {
      if (error instanceof BackendError && error.code === 'timeout') await this.close()
      throw error
    }
    const data = record(response.data)
    const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : this.providerSession
    const messageCount = typeof data?.messageCount === 'number' ? data.messageCount : null
    if (!sessionId || messageCount === null || !Number.isSafeInteger(messageCount) || messageCount < 0) return null
    this.providerSession = sessionId
    return {
      runId: input.runId,
      provider: 'pi',
      environmentId: input.environmentId,
      sessionId: input.sessionId,
      boundary: { kind: 'revision', revision: boundedPiId(`pi:${sessionId}:${messageCount}`) },
      observedAt: new Date().toISOString(),
    }
  }

  async close(): Promise<void> {
    this.end(new Error('pi native session closed'))
    await this.closing
  }

  private request(command: Record<string, unknown>, options: PiRpcRequestOptions = {}): Promise<PiRpcResponse> {
    const id = (command.id as string | number | undefined) ?? `rpc-${randomUUID()}`
    const wireCommand = { ...command, id }
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('pi RPC process is closed'))
        return
      }
      if (options.signal?.aborted) {
        reject(new BackendError(`pi RPC ${String(command.type ?? 'request')} aborted`, 'aborted'))
        return
      }

      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      let onAbort: (() => void) | undefined
      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        if (onAbort && options.signal) options.signal.removeEventListener('abort', onAbort)
      }
      const settle = (callback: () => void): void => {
        if (settled) return
        settled = true
        this.pending.delete(id)
        cleanup()
        callback()
      }
      const waiter: PiRpcWaiter = {
        resolve: value => settle(() => resolve(value)),
        reject: error => settle(() => reject(error)),
      }
      this.pending.set(id, waiter)
      onAbort = (): void => settle(() => reject(new BackendError(`pi RPC ${String(command.type ?? 'request')} aborted`, 'aborted')))
      options.signal?.addEventListener('abort', onAbort, { once: true })
      // AbortSignal does not invoke a listener added after the signal became
      // aborted. Re-check after registration so a prompt cannot slip into a
      // child after its owning run has already been cancelled.
      if (options.signal?.aborted) {
        onAbort()
        return
      }
      const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs
      if (timeoutMs > 0) {
        timer = setTimeout(() => settle(() => reject(new BackendError(
          `pi RPC ${String(command.type ?? 'request')} timed out after ${timeoutMs}ms`,
          'timeout',
        ))), timeoutMs)
        timer.unref?.()
      }
      try {
        if (settled) return
        this.write(wireCommand)
      } catch (error) {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))))
        this.end(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private write(value: Record<string, unknown>): void {
    if (!this.child.stdin || this.closed) throw new Error('pi RPC stdin is closed')
    this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let value: unknown
      try { value = JSON.parse(line) } catch { continue }
      const message = record(value)
      if (!message) continue
      const id = message.id as string | number | undefined
      if (message.type === 'response' && id !== undefined && this.pending.has(id)) {
        const waiter = this.pending.get(id)!
        this.pending.delete(id)
        if (message.success === false) waiter.reject(new Error(String(message.error ?? 'pi RPC command failed')))
        else waiter.resolve(message as PiRpcResponse)
        continue
      }
      this.eventSequence += 1
      this.observeInteractionMarker(message)
      const waiter = this.waiters.shift()
      if (waiter) waiter.resolve(message)
      else this.queue.push(message)
    }
  }

  private waitForMarkerAfter(marker: string, afterSequence: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(this.childError ?? new Error('pi RPC process closed'))
        return
      }
      const waiter: PiMarkerWaiter = { marker, afterSequence, resolve, reject }
      const timeoutMs = this.requestTimeoutMs > 0 ? this.requestTimeoutMs : 30_000
      waiter.timer = setTimeout(() => {
        this.markerWaiters.delete(waiter)
        reject(new BackendError(
          `pi RPC interaction response produced no exact marker after ${timeoutMs}ms`,
          'timeout',
        ))
      }, timeoutMs)
      waiter.timer.unref?.()
      this.markerWaiters.add(waiter)
    })
  }

  private observeInteractionMarker(message: Record<string, unknown>): void {
    if (message.type === 'extension_ui_request' && message.method === 'select') {
      const id = typeof message.id === 'string' ? message.id : null
      const token = typeof message.title === 'string' ? piPermissionTokenFromTitle(message.title) : null
      if (id && token) this.interactionMarkers.set(id, token)
    }
    if (message.type !== 'extension_ui_request' || message.method !== 'notify' || typeof message.message !== 'string') return
    for (const waiter of this.markerWaiters) {
      if (this.eventSequence <= waiter.afterSequence || message.message !== waiter.marker) continue
      this.markerWaiters.delete(waiter)
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve()
    }
  }

  private nextEvent(signal: AbortSignal): Promise<Record<string, unknown>> {
    if (signal.aborted) return Promise.reject(new Error('pi native turn aborted'))
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.closed) return Promise.reject(this.childError ?? new Error('pi RPC process closed'))
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.findIndex(waiter => waiter.resolve === resolve)
        if (index >= 0) this.waiters.splice(index, 1)
        signal.removeEventListener('abort', onAbort)
        reject(new Error('pi native turn aborted'))
      }
      this.waiters.push({
        resolve: value => { signal.removeEventListener('abort', onAbort); resolve(value) },
        reject: error => { signal.removeEventListener('abort', onAbort); reject(error) },
      })
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private end(error: Error): void {
    const firstClose = !this.closed
    if (firstClose) this.closed = true
    this.childError ??= error
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.childError)
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id)
      waiter.reject(this.childError)
    }
    for (const waiter of this.markerWaiters) {
      this.markerWaiters.delete(waiter)
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.reject(this.childError)
    }
    this.interactionMarkers.clear()
    const cleanup = this.startCleanup()
    if (firstClose) {
      for (const listener of [...this.closeListeners]) {
        try {
          listener(this.childError)
        } catch {
          // A session owner cannot break child cleanup.
        }
      }
      this.closeListeners.clear()
    }
    void cleanup.catch(cleanupError => {
      this.childError ??= cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
    })
  }

  private startCleanup(): Promise<void> {
    if (this.closing) return this.closing
    const attempt = (async () => {
      await this.terminate()
      const failures: unknown[] = []
      try {
        this.cleanup()
      } catch (error) {
        failures.push(error)
        retryCleanupUntilSuccessful(this.cleanup)
      }
      try { this.release() } catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'pi native session cleanup failed')
    })()
    this.closing = attempt
    void attempt.catch(() => {
      if (this.closing === attempt) this.closing = null
    })
    return attempt
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

function boundedPiId(candidate: string): string {
  const trimmed = candidate.trim()
  if (trimmed.length > 0 && trimmed.length <= 512) return trimmed
  return `id:${canonicalCandidateDigest(candidate).slice('sha256:'.length)}`
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
