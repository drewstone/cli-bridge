/** Pi model, profile, extension, capability, and child-environment policy. */

import { existsSync, readFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { canonicalCandidateDigest, type AgentEnvironmentCapabilities } from '@tangle-network/agent-interface'
import type { ChatRequest } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import type { Spawner } from '../executors/types.js'
import { registerJailArgumentRewrite, registerJailReadable } from '../jail/index.js'
import { resolvePiAgentDir } from '../runtime/pi-paths.js'
import { resolveAgentProfile } from './profile-support.js'

export interface PiBackendOptions {
  bin: string
  timeoutMs: number
  /** Subprocess spawner. Defaults to scoped host. */
  spawner?: Spawner
}

export interface PiModelSpec {
  provider?: string
  model?: string
}

export function parsePiModelId(model: string): PiModelSpec {
  const normalized = model.toLowerCase()
  if (normalized === 'pi') return {}
  if (!normalized.startsWith('pi/')) return {}
  const rest = model.slice(3)
  const slash = rest.indexOf('/')
  if (slash === -1) return { model: rest }
  return { provider: rest.slice(0, slash), model: rest.slice(slash + 1) }
}

export function resolvePiModelSpec(spec: PiModelSpec): PiModelSpec {
  return { ...spec, provider: spec.provider ?? resolvePiDefaultProvider() }
}

export function thinkingFlagForEffort(effort?: string): string | null {
  if (!effort) return null
  const allowed = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
  const normalized = effort === 'none' ? 'off' : effort === 'ultracode' ? 'xhigh' : effort
  return allowed.has(normalized) ? normalized : null
}

export function resolveReasoningEffort(
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

/** Select every request-declared MCP server for Pi's direct adapter tools. */
export function piDirectToolSelection(
  requestedServerNames: readonly string[],
  ambientSelection: string | undefined,
): string | undefined {
  if (requestedServerNames.length === 0) return ambientSelection
  const unsupported = requestedServerNames.filter((name) => name.includes(',') || name.includes('/'))
  if (unsupported.length > 0) {
    throw new BackendError(
      `backend pi cannot expose MCP server name(s) through pi-mcp-adapter: ${unsupported.join(', ')}; ` +
        'server names used by this backend cannot contain "," or "/"',
      'not_configured',
    )
  }
  const ambient =
    ambientSelection && ambientSelection !== '__none__'
      ? ambientSelection
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : []
  return [...new Set([...ambient, ...requestedServerNames])].join(',')
}

/** Convert the exact `extensions.pi.load` request into Pi argv. */
export function piExtensionArgs(
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
    throw new BackendError(`unsupported extensions.pi controls: ${unknown.sort().join(', ')}`, 'parse_error')
  }
  if (!Object.hasOwn(pi, 'load')) return []
  const load = pi.load
  if (!Array.isArray(load) || load.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new BackendError('extensions.pi.load must be an array of non-empty strings', 'parse_error')
  }
  if (needsMcpAdapter && !load.some((entry) => entry === 'pi-mcp-adapter' || entry === 'npm:pi-mcp-adapter')) {
    throw new BackendError(
      'extensions.pi.load must include the installed pi-mcp-adapter package when the profile requests MCP servers',
      'parse_error',
    )
  }

  const configuredAgentDir = process.env.PI_CODING_AGENT_DIR?.trim()
  const hostAgentDir = resolvePiAgentDir()
  const hostNpmRoot = join(hostAgentDir, 'npm', 'node_modules')
  const runtimeAgentDir = spawner.mapPath?.(hostAgentDir) ?? (configuredAgentDir ? hostAgentDir : '~/.pi/agent')
  const runtimeNpmRoot = join(runtimeAgentDir, 'npm', 'node_modules')
  const jailedNpmRoot = req.jailSpec ? join(req.jailSpec.root, '.pi', 'agent', 'npm', 'node_modules') : runtimeNpmRoot
  const entries = new Set(
    (load as string[]).map((spec) => {
      const normalizedSpec = spec.trim()
      const localSpec = normalizedSpec.startsWith('npm:') ? normalizedSpec.slice(4) : normalizedSpec
      const runtimePath = resolvePiExtensionPath(
        normalizedSpec,
        hostNpmRoot,
        runtimeNpmRoot,
        (path) => spawner.mapPath?.(path) ?? path,
      )
      if (isAbsolute(localSpec)) registerJailReadable(req.jailSpec, localSpec)
      const jailedPath = resolvePiExtensionPath(normalizedSpec, hostNpmRoot, jailedNpmRoot)
      registerJailArgumentRewrite(req.jailSpec, runtimePath, jailedPath, '--extension', ['bwrap'])
      return runtimePath
    }),
  )
  return ['--no-extensions', ...[...entries].flatMap((entry) => ['--extension', entry])]
}

function resolvePiExtensionPath(
  spec: string,
  hostNpmRoot: string,
  runtimeNpmRoot: string,
  mapAbsolute: (path: string) => string = (path) => path,
): string {
  const normalized = spec.startsWith('npm:') ? spec.slice(4) : spec
  if (isAbsolute(normalized)) {
    if (existsSync(normalized)) return mapAbsolute(normalized)
    throw new BackendError(`backend pi cannot load extension "${spec}": ${normalized} does not exist`, 'not_configured')
  }
  if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/u.test(normalized)) {
    throw new BackendError(
      `backend pi cannot load extension "${spec}": expected an installed package name or absolute path`,
      'not_configured',
    )
  }
  const hostPath = join(hostNpmRoot, normalized)
  if (!existsSync(hostPath)) {
    throw new BackendError(`backend pi cannot load extension "${spec}": ${hostPath} does not exist`, 'not_configured')
  }
  return join(runtimeNpmRoot, normalized)
}

export function piMcpAdapterAvailable(): boolean {
  const override = process.env.CLI_BRIDGE_PI_MCP_ADAPTER
  if (override === '1' || override === 'true') return true
  if (override === '0' || override === 'false') return false
  const agentDir = resolvePiAgentDir()
  if (existsSync(join(agentDir, 'npm', 'node_modules', 'pi-mcp-adapter'))) return true
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')) as { packages?: unknown }
    if (Array.isArray(settings.packages)) {
      return settings.packages.some((packageSpec) => {
        if (typeof packageSpec !== 'string') return false
        if (packageSpec.includes('pi-mcp-adapter')) return true
        const spec = packageSpec.replace(/^(file|path):(\/\/)?/u, '')
        const windowsAbsolute = /^[A-Za-z]:[\\/]/u.test(spec)
        if (!isAbsolute(spec) && !windowsAbsolute && !spec.startsWith('.')) return false
        const localPath = isAbsolute(spec) || windowsAbsolute ? spec : join(agentDir, spec)
        try {
          const packageJson = JSON.parse(readFileSync(join(localPath, 'package.json'), 'utf8')) as { name?: unknown }
          return packageJson.name === 'pi-mcp-adapter'
        } catch {
          return false
        }
      })
    }
  } catch {
    // An absent or unreadable settings file means the adapter is not proven.
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

export function piNativeCapabilities(): AgentEnvironmentCapabilities {
  return {
    ...PI_NATIVE_CAPABILITIES,
    profile: {
      ...PI_NATIVE_CAPABILITIES.profile,
      mcp: piMcpAdapterAvailable(),
    },
  }
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

const PI_BLOCKED_ENV_KEY =
  /(?:^|_)(?:API[_-]?KEY|AUTH(?:ORIZATION|ENTICATION)?|BEARER|COOKIE|CREDENTIALS?|PASSWORD|PASSPHRASE|PRIVATE[_-]?KEY|SECRET|TOKEN)(?:_|$)/iu

function piProviderEnvKeys(provider: string | undefined): Set<string> {
  if (!provider) return new Set()
  const normalized = provider.toLowerCase()
  const prefix = normalized
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_|_$/gu, '')
    .toUpperCase()
  return new Set([
    ...(PI_PROVIDER_ENV_ALIASES[normalized] ?? []),
    ...(prefix ? [`${prefix}_API_KEY`, `${prefix}_AUTH_TOKEN`, `${prefix}_BASE_URL`] : []),
  ])
}

function isSafeProfileEnvKey(key: string): boolean {
  return (
    /^[A-Z][A-Z0-9_]*$/u.test(key) &&
    !key.startsWith('BRIDGE_') &&
    !key.startsWith('CLI_BRIDGE_') &&
    !PI_BLOCKED_ENV_KEY.test(key)
  )
}

export function piChildEnv(
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
  for (const [key, value] of Object.entries(profileEnv ?? {})) {
    if (!isSafeProfileEnvKey(key)) continue
    if (allowedParentKeys.has(key) || key === 'MCP_DIRECT_TOOLS') continue
    out[key] = value
  }
  return out
}

export function mapPrivateTreeArgs(args: readonly string[], hostRoot: string, runtimeRoot: string): string[] {
  const prefix = `${hostRoot}/`
  return args.map((value) =>
    value === hostRoot
      ? runtimeRoot
      : value.startsWith(prefix)
        ? `${runtimeRoot}/${value.slice(prefix.length)}`
        : value,
  )
}

export function mapPrivateTreeEnv(
  env: Readonly<Record<string, string>>,
  hostRoot: string,
  runtimeRoot: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, mapPrivateTreeArgs([value], hostRoot, runtimeRoot)[0]!]),
  )
}

function resolvePiDefaultProvider(): string {
  try {
    const settings = JSON.parse(readFileSync(join(resolvePiAgentDir(), 'settings.json'), 'utf8')) as {
      defaultProvider?: unknown
    }
    if (typeof settings.defaultProvider === 'string' && /^[A-Za-z0-9._-]+$/u.test(settings.defaultProvider.trim())) {
      return settings.defaultProvider.trim()
    }
  } catch {
    // Pi's documented default is used when settings do not provide one.
  }
  return 'google'
}
