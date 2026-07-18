/**
 * Config — env-driven, validated at startup.
 *
 * One principle: the server refuses to start in an unsafe configuration.
 * Specifically, a non-loopback bind without a bearer check is a hard fail,
 * not a warning — an accidental open proxy to your personal subscription
 * keys is the failure mode we refuse to allow.
 */

import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, parse, relative, resolve, sep } from 'node:path'

export interface Config {
  host: string
  port: number
  bearer: string | null
  dataDir: string
  backends: Set<string>
  claudeBin: string
  claudeTimeoutMs: number
  codexBin: string
  codexTimeoutMs: number
  opencodeBin: string
  opencodeTimeoutMs: number
  kimiBin: string
  kimiTimeoutMs: number
  geminiBin: string
  geminiTimeoutMs: number
  factoryBin: string
  ampBin: string
  forgeBin: string
  /** ACP-protocol agents driven via `<bin> acp` (AcpBackend). */
  hermesBin: string
  openclawBin: string
  /** NanoClaw daemon CLI-channel Unix socket (NanoclawBackend connects as a client). */
  nanoclawSocket: string
  piBin: string
  piTimeoutMs: number
  cliTimeoutMsDefault: number
  admission: {
    maxActive: number
    maxQueue: number
    queueTimeoutMs: number
  }
  /**
   * When set, the `claudish` harness is registered and Claude Code is
   * spawned with ANTHROPIC_BASE_URL=<this> for `claudish/*` model ids.
   */
  claudishUrl: string | null
  openaiApiKey: string | null
  anthropicApiKey: string | null
  moonshotApiKey: string | null
  zaiApiKey: string | null
  /** Tangle sandbox-api base URL (e.g. https://sandbox.tangle.tools). When set + key present, the `sandbox` backend registers. */
  sandboxApiUrl: string | null
  /** Bearer for sandbox-api. Required for the sandbox backend. */
  sandboxApiKey: string | null
  /** Filesystem dir holding cataloged AgentProfile JSON files (one per profile, filename is the id). */
  sandboxProfilesDir: string
  /** Per-task timeout sent to sandbox-api `/batch/run`. Default 5min. */
  sandboxTimeoutMs: number
  /**
   * Per-backend executor configuration. Every subprocess backend
   * (claude, kimi, codex, opencode, gemini, …) reads its own slot from this
   * map at startup. `host` (default) spawns the CLI on the host;
   * `docker` provisions a pool of pre-warmed containers and dispatches
   * each chat() via `docker exec`.
   *
   * Env keys per backend `<NAME>` (uppercased, e.g. CLAUDE, KIMI):
   *   `<NAME>_EXECUTOR=host|docker`
   *   `<NAME>_DOCKER_IMAGE=<image-tag>`
   *   `<NAME>_DOCKER_POOL_SIZE=<n>`
   *   `<NAME>_DOCKER_OAUTH_MOUNT=share|per-slot`
   *   `<NAME>_DOCKER_NAME_PREFIX=<prefix>`
   *   `<NAME>_DOCKER_HOST_CONFIG_DIR=<host path>`  (share mode only)
   *   `<NAME>_DOCKER_CONTAINER_CONFIG_DIR=<container path>`  (mount target)
   *   `<NAME>_DOCKER_WORKSPACE_ROOT=<absolute host path>`  (read-write, same container path)
   *
   * `BRIDGE_DEFAULT_EXECUTOR` sets the fallback for backends that don't
   * override individually. Default: host.
   */
  executors: Record<string, BackendExecutorConfig>
  /**
   * Default write-jail mode for host-executed CLIs, from
   * `BRIDGE_JAIL_MODE` (off|write-jail, default off). A per-request
   * `execution.jail.mode` overrides this. In `write-jail` the host
   * filesystem is read-only and the CLI's writes are confined to the
   * jail root (bwrap on Linux, sandbox-exec on macOS; no-op elsewhere).
   */
  jailMode: 'off' | 'write-jail'
  /**
   * Default writable jail root from `BRIDGE_JAIL_ROOT`. Relative paths
   * resolve under the request cwd; absolute paths must stay inside it.
   * Null falls back to `<cwd>/.agent-home`. A per-request
   * `execution.jail.root` overrides this.
   */
  jailRoot: string | null
}

export interface BackendExecutorConfig {
  /** Backend name, lowercase: 'claude', 'kimi', 'codex', 'opencode', … */
  name: string
  kind: 'host' | 'docker'
  /** Docker-only fields. Empty/undefined when kind === 'host'. */
  image?: string
  poolSize?: number
  oauthMode?: 'share' | 'per-slot'
  namePrefix?: string
  /** Host path that gets bind-mounted (share mode). */
  hostConfigDir?: string
  /** Mount target inside the container, e.g. /root/.claude or /root/.config/opencode. */
  containerConfigDir?: string
  /**
   * Canonical host directory exposed read-write to Docker workers at the
   * identical absolute path. Requests with a cwd outside this root fail.
   */
  workspaceRoot?: string
}

/** Backends that never spawn a CLI on the host (remote HTTP, local proxy, or a
 * socket to an already-running daemon), so the host write-jail never applies. */
const NON_HOST_SPAWN_BACKENDS = new Set(['sandbox', 'passthrough', 'nanoclaw'])

/**
 * Whether any ENABLED backend will spawn a CLI on the host (and therefore be
 * subject to the write-jail). True unless every enabled backend is remote/proxy
 * or pinned to a docker executor. Errs toward true: an unrecognized backend is
 * assumed to host-spawn, so the startup jail check fails closed rather than
 * booting "healthy" and failing every request at runtime. Covers backends that
 * are NOT in `executors` (e.g. ACP hermes/openclaw, factory, amp, forge), which
 * default to host spawn.
 */
export function anyBackendSpawnsOnHost(
  backends: Iterable<string>,
  executors: Record<string, BackendExecutorConfig>,
): boolean {
  for (const name of backends) {
    if (NON_HOST_SPAWN_BACKENDS.has(name)) continue
    if (executors[name]?.kind === 'docker') continue
    return true
  }
  return false
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.BRIDGE_HOST ?? '127.0.0.1'
  // 3344 chosen to dodge common dev/services collisions: 8787 was hit
  // by other Hono dev servers, 4098 collided with the ADC sandbox-api
  // gateway in the wild. 3344 is unassigned on IANA + low-conflict.
  const port = Number.parseInt(env.BRIDGE_PORT ?? '3344', 10)
  const bearer = env.BRIDGE_BEARER?.trim() || null
  const dataDir = resolve(env.BRIDGE_DATA_DIR ?? './data')
  const backends = new Set(
    (env.BRIDGE_BACKENDS ?? 'claude,kimi,gemini,sandbox,passthrough')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  )

  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`invalid BRIDGE_PORT: ${env.BRIDGE_PORT}`)
  }

  if (!LOOPBACK.has(host) && !bearer) {
    throw new Error(
      `BRIDGE_HOST is ${host} (not loopback) but BRIDGE_BEARER is not set. ` +
        `Refusing to start — an open proxy to your subscription keys is the ` +
        `one thing this tool must not accidentally do. Generate a bearer with ` +
        `\`openssl rand -hex 32\`, set BRIDGE_BEARER, and retry.`,
    )
  }

  const defaultTimeout = Number.parseInt(env.CLI_TIMEOUT_MS ?? '300000', 10)

  return {
    host,
    port,
    bearer,
    dataDir,
    backends,
    claudeBin: env.CLAUDE_BIN ?? 'claude',
    claudeTimeoutMs: Number.parseInt(env.CLAUDE_TIMEOUT_MS ?? String(defaultTimeout), 10),
    codexBin: env.CODEX_BIN ?? 'codex',
    codexTimeoutMs: Number.parseInt(env.CODEX_TIMEOUT_MS ?? String(defaultTimeout), 10),
    opencodeBin: env.OPENCODE_BIN ?? 'opencode',
    opencodeTimeoutMs: Number.parseInt(env.OPENCODE_TIMEOUT_MS ?? String(defaultTimeout), 10),
    kimiBin: env.KIMI_BIN ?? 'kimi',
    kimiTimeoutMs: Number.parseInt(env.KIMI_TIMEOUT_MS ?? String(defaultTimeout), 10),
    geminiBin: env.GEMINI_BIN ?? 'gemini',
    geminiTimeoutMs: Number.parseInt(env.GEMINI_TIMEOUT_MS ?? String(defaultTimeout), 10),
    factoryBin: env.FACTORY_BIN ?? env.DROID_BIN ?? 'droid',
    ampBin: env.AMP_BIN ?? 'amp',
    forgeBin: env.FORGE_BIN ?? 'forge',
    hermesBin: env.HERMES_BIN ?? 'hermes',
    openclawBin: env.OPENCLAW_BIN ?? 'openclaw',
    nanoclawSocket: env.NANOCLAW_SOCKET ?? '',
    piBin: env.PI_BIN ?? 'pi',
    piTimeoutMs: Number.parseInt(env.PI_TIMEOUT_MS ?? String(defaultTimeout), 10),
    cliTimeoutMsDefault: defaultTimeout,
    admission: {
      maxActive: parsePositiveInt(env.BRIDGE_HOST_CHAT_MAX_ACTIVE, 8),
      maxQueue: parseNonNegativeInt(env.BRIDGE_HOST_CHAT_MAX_QUEUE, 16),
      queueTimeoutMs: parseNonNegativeInt(env.BRIDGE_HOST_CHAT_QUEUE_TIMEOUT_MS, 30_000),
    },
    claudishUrl: env.CLAUDISH_URL?.trim() || null,
    openaiApiKey: env.OPENAI_API_KEY?.trim() || null,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    moonshotApiKey: env.MOONSHOT_API_KEY?.trim() || null,
    zaiApiKey: env.ZAI_API_KEY?.trim() || null,
    sandboxApiUrl: env.SANDBOX_API_URL?.trim() || null,
    sandboxApiKey: env.SANDBOX_API_KEY?.trim() || null,
    sandboxProfilesDir: resolve(env.SANDBOX_PROFILES_DIR ?? './profiles'),
    sandboxTimeoutMs: Number.parseInt(env.SANDBOX_TIMEOUT_MS ?? '300000', 10),
    executors: parseAllExecutors(env),
    jailMode: parseJailMode(env.BRIDGE_JAIL_MODE),
    jailRoot: env.BRIDGE_JAIL_ROOT?.trim() || null,
  }
}

function parseJailMode(value: string | undefined): 'off' | 'write-jail' {
  if (value === undefined || value === '') return 'off'
  if (value === 'off' || value === 'write-jail') return value
  throw new Error(`invalid BRIDGE_JAIL_MODE: ${value} — expected off|write-jail`)
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid positive integer: ${value}`)
  }
  return parsed
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid non-negative integer: ${value}`)
  }
  return parsed
}

/**
 * Per-backend executor defaults. All subprocess backends share the
 * same default runtime image (`cli-bridge-cli-runtime`) — that image
 * has every CLI installed. Per-backend `<NAME>_DOCKER_IMAGE` env
 * overrides if you want a leaner per-backend image. The OAuth/config
 * mount target differs per backend because each CLI stores auth state
 * in a different path.
 */
const SHARED_RUNTIME_IMAGE = 'cli-bridge-cli-runtime:latest'

const BACKEND_EXECUTOR_DEFAULTS: Record<string, { image: string; containerConfigDir: string; hostConfigEnvKey: string; defaultHostConfigDir: string }> = {
  claude: {
    image: SHARED_RUNTIME_IMAGE,
    containerConfigDir: '/root/.claude',
    hostConfigEnvKey: 'HOME',
    defaultHostConfigDir: '.claude',
  },
  kimi: {
    image: SHARED_RUNTIME_IMAGE,
    containerConfigDir: '/root/.kimi',
    hostConfigEnvKey: 'HOME',
    defaultHostConfigDir: '.kimi',
  },
  gemini: {
    image: SHARED_RUNTIME_IMAGE,
    containerConfigDir: '/root/.gemini',
    hostConfigEnvKey: 'HOME',
    defaultHostConfigDir: '.gemini',
  },
  codex: {
    image: SHARED_RUNTIME_IMAGE,
    containerConfigDir: '/root/.codex',
    hostConfigEnvKey: 'HOME',
    defaultHostConfigDir: '.codex',
  },
  opencode: {
    image: SHARED_RUNTIME_IMAGE,
    containerConfigDir: '/root/.config/opencode',
    hostConfigEnvKey: 'HOME',
    defaultHostConfigDir: '.config/opencode',
  },
  pi: {
    image: SHARED_RUNTIME_IMAGE,
    containerConfigDir: '/root/.pi/agent',
    hostConfigEnvKey: 'HOME',
    defaultHostConfigDir: '.pi/agent',
  },
}

const SUPPORTED_EXECUTOR_BACKENDS = Object.keys(BACKEND_EXECUTOR_DEFAULTS)

function parseAllExecutors(env: NodeJS.ProcessEnv): Record<string, BackendExecutorConfig> {
  const defaultKind = parseExecutor('BRIDGE_DEFAULT_EXECUTOR', env.BRIDGE_DEFAULT_EXECUTOR, 'host')
  const out: Record<string, BackendExecutorConfig> = {}
  for (const name of SUPPORTED_EXECUTOR_BACKENDS) {
    const defaults = BACKEND_EXECUTOR_DEFAULTS[name]
    if (!defaults) continue
    const upper = name.toUpperCase()
    const kind = parseExecutor(`${upper}_EXECUTOR`, env[`${upper}_EXECUTOR`], defaultKind)
    const workspaceRootKey = `${upper}_DOCKER_WORKSPACE_ROOT`
    const rawWorkspaceRoot = env[workspaceRootKey]?.trim()
    if (rawWorkspaceRoot && kind !== 'docker') {
      throw new Error(`${workspaceRootKey} requires ${upper}_EXECUTOR=docker`)
    }
    const cfg: BackendExecutorConfig = { name, kind }
    if (kind === 'docker') {
      cfg.image = env[`${upper}_DOCKER_IMAGE`] ?? defaults.image
      cfg.poolSize = Number.parseInt(env[`${upper}_DOCKER_POOL_SIZE`] ?? '4', 10)
      cfg.oauthMode = parseOauthMode(`${upper}_DOCKER_OAUTH_MOUNT`, env[`${upper}_DOCKER_OAUTH_MOUNT`], 'share')
      cfg.namePrefix = env[`${upper}_DOCKER_NAME_PREFIX`] ?? `cli-bridge-${name}-pool`
      const hostBase = env[defaults.hostConfigEnvKey] ?? '/root'
      cfg.hostConfigDir = resolve(env[`${upper}_DOCKER_HOST_CONFIG_DIR`] ?? `${hostBase}/${defaults.defaultHostConfigDir}`)
      cfg.containerConfigDir = env[`${upper}_DOCKER_CONTAINER_CONFIG_DIR`] ?? defaults.containerConfigDir
      if (rawWorkspaceRoot) {
        cfg.workspaceRoot = parseDockerWorkspaceRoot(workspaceRootKey, rawWorkspaceRoot)
        assertDockerMountsDoNotOverlap(
          workspaceRootKey,
          cfg.workspaceRoot,
          cfg.hostConfigDir,
          cfg.containerConfigDir,
        )
      }
    }
    out[name] = cfg
  }
  return out
}

function canonicalOrResolvedPath(value: string): string {
  try {
    return realpathSync(value)
  } catch {
    return resolve(value)
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const rel = relative(left, right)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function assertDockerMountsDoNotOverlap(
  workspaceKey: string,
  workspaceRoot: string,
  hostConfigDir: string,
  containerConfigDir: string,
): void {
  const canonicalHostConfig = canonicalOrResolvedPath(hostConfigDir)
  if (pathsOverlap(workspaceRoot, canonicalHostConfig) || pathsOverlap(canonicalHostConfig, workspaceRoot)) {
    throw new Error(
      `invalid ${workspaceKey}: workspace and host OAuth/config directories must not overlap`,
    )
  }
  if (!isAbsolute(containerConfigDir)) {
    throw new Error(`invalid ${workspaceKey}: Docker config mount target must be absolute`)
  }
  const canonicalContainerConfig = resolve(containerConfigDir)
  if (pathsOverlap(workspaceRoot, canonicalContainerConfig) || pathsOverlap(canonicalContainerConfig, workspaceRoot)) {
    throw new Error(
      `invalid ${workspaceKey}: workspace and container OAuth/config directories must not overlap`,
    )
  }
}

function parseDockerWorkspaceRoot(key: string, value: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`invalid ${key}: expected an absolute path, got ${value}`)
  }
  if (value.includes(',')) {
    throw new Error(`invalid ${key}: commas are not supported in Docker bind paths`)
  }

  let canonical: string
  try {
    canonical = realpathSync(value)
  } catch {
    throw new Error(`invalid ${key}: path does not exist: ${value}`)
  }
  if (!statSync(canonical).isDirectory()) {
    throw new Error(`invalid ${key}: path is not a directory: ${value}`)
  }
  if (canonical === parse(canonical).root) {
    throw new Error(`invalid ${key}: refusing to expose filesystem root ${canonical}`)
  }
  return canonical
}

function parseExecutor(key: string, value: string | undefined, fallback: 'host' | 'docker'): 'host' | 'docker' {
  if (value === 'host' || value === 'docker') return value
  if (value === undefined || value === '') return fallback
  throw new Error(`invalid ${key}: ${value} — expected host|docker`)
}

function parseOauthMode(key: string, value: string | undefined, fallback: 'share' | 'per-slot'): 'share' | 'per-slot' {
  if (value === 'share' || value === 'per-slot') return value
  if (value === undefined || value === '') return fallback
  throw new Error(`invalid ${key}: ${value} — expected share|per-slot`)
}
