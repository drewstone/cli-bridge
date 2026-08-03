/**
 * Config — env-driven, validated at startup.
 *
 * One principle: the server refuses to start in an unsafe configuration.
 * Specifically, a non-loopback bind without a bearer check is a hard fail,
 * not a warning — an accidental open proxy to your personal subscription
 * keys is the failure mode we refuse to allow.
 */

import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { assertDockerNetworkName } from './executors/docker-network.js'
import { formatAllowEntry, parseAllowList } from './jail/net-allowlist.js'

const maxExecutionTimeoutMs = 2_147_483_647

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
  /** Operator timeout fallback sent to sandbox-api when the caller omits one. Zero means none. */
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
   *   `<NAME>_DOCKER_NETWORK=<existing Docker network name>`
   *   `<NAME>_DOCKER_USER=<positive uid>:<positive gid>`  (non-root container identity)
   *   `<NAME>_DOCKER_HOME=<absolute container path>`  (required with Docker user)
   *
   * `BRIDGE_DEFAULT_EXECUTOR` sets the fallback for backends that don't
   * override individually. Default: host.
   */
  executors: Record<string, BackendExecutorConfig>
  /**
   * Default jail mode for host-executed CLIs, from `BRIDGE_JAIL_MODE`
   * (off|write-jail|fs-jail, default off; `WORKER_FS_JAIL=1` is a shorthand
   * for fs-jail). A per-request `execution.jail.mode` may raise (never lower)
   * this floor. In `write-jail` the host filesystem is read-only and the CLI's
   * writes are confined to the jail root; `fs-jail` additionally confines
   * READS to a minimal system+toolchain allowlist so the CLI cannot read the
   * host repo or sibling run scratch dirs (bwrap Linux only; write-jail on
   * macOS via sandbox-exec; no-op elsewhere).
   */
  jailMode: 'off' | 'write-jail' | 'fs-jail'
  /**
   * Default writable jail root from `BRIDGE_JAIL_ROOT`. Relative paths
   * resolve under the request cwd; absolute paths must stay inside it.
   * Null falls back to `<cwd>/.agent-home`. A per-request
   * `execution.jail.root` overrides this.
   */
  jailRoot: string | null
  /**
   * Default net-jail mode, from `BRIDGE_NET_JAIL_MODE` (off|net-jail, default
   * off; `WORKER_NET_JAIL=1` is a shorthand for net-jail). Sibling of
   * {@link Config.jailMode}: fs-jail confines what a worker can READ, net-jail
   * confines where it can CONNECT. In `net-jail` every worker container runs on
   * an internal Docker network with no route off it, and reaches only an
   * allowlist that always contains its own model endpoint.
   *
   * Docker-only, by construction. A CLI spawned on the host shares the host's
   * network namespace and there is no unprivileged way to give it a partial
   * egress policy, so this setting REFUSES to load alongside a host-executed
   * backend rather than reporting a policy it cannot apply.
   */
  netJailMode: 'off' | 'net-jail'
  /**
   * Extra `host` or `host:port` tokens added to every net-jail allowlist, from
   * `BRIDGE_NET_JAIL_ALLOW`. The model endpoint is derived automatically and
   * does not belong here; this is for the rest (a package registry, an internal
   * service) that a specific workload legitimately needs.
   */
  netJailAllow: string[]
  /** OTLP span emission for chat requests. See {@link TraceConfig}. */
  trace: TraceConfig
}

/**
 * Trace emission settings.
 *
 * On by default: the bridge is the only place every harness passes through, so a
 * bridge that has to be switched on to be observable is a bridge nobody has
 * traces for when they need them. The cost is bounded by `maxBytes * maxFiles`
 * on disk — 32 MiB unless configured — and one append per request.
 */
export interface TraceConfig {
  /** `BRIDGE_TRACE=off` disables emission entirely (the sink becomes a no-op). */
  enabled: boolean
  /** Active JSONL file. Rotated generations get `.1`, `.2`, … */
  file: string
  /** Rotate once the active file would exceed this. */
  maxBytes: number
  /** Generations retained, including the active file. */
  maxFiles: number
  /** Cap on TOOL spans per request; the observed count is still reported in full. */
  maxToolSpans: number
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
  /** Optional numeric non-root identity used by the pool container and every docker exec. */
  containerUser?: string
  /** Writable HOME exposed to the configured container identity. */
  containerHome?: string
  /**
   * Additional credential/state directories this CLI reads, mounted at the same
   * HOME-relative path. opencode is the measured case: config lives in
   * ~/.config/opencode but auth.json lives in ~/.local/share/opencode, so
   * mounting only the config dir gives the container a pool with NO credentials
   * in it — the CLI starts, authenticates against nothing, and the caller reads
   * the empty completion as a model problem.
   */
  extraMounts?: Array<{ host: string; container: string }>
  /**
   * Path, relative to the container HOME, of the file whose presence proves the
   * CLI can authenticate. Checked by the startup preflight against the mount it
   * belongs to.
   */
  credentialFile?: string
  /**
   * Canonical host directory exposed read-write to Docker workers at the
   * identical absolute path. Requests with a cwd outside this root fail.
   * Always set for a docker executor: without a mounted directory a request
   * that names no cwd has nowhere to run, and the bridge used to answer it by
   * refusing the request for the bridge's OWN working directory.
   */
  workspaceRoot?: string
  /** Existing Docker network joined by every pool container. */
  network?: string
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

  // A caller may own the process deadline through `execution.timeoutMs`.
  // Operator values are fallbacks only when the request omits that field; no
  // implicit wall-clock deadline is safer than silently killing valid long work.
  const defaultTimeout = parseExecutionTimeoutMs('CLI_TIMEOUT_MS', env.CLI_TIMEOUT_MS, 0)
  const executors = parseAllExecutors(env, dataDir)
  const netJailMode = parseNetJailMode(env)
  if (netJailMode !== 'off') assertNetJailEnforceable(backends, executors)

  return {
    host,
    port,
    bearer,
    dataDir,
    backends,
    claudeBin: env.CLAUDE_BIN ?? 'claude',
    claudeTimeoutMs: parseExecutionTimeoutMs('CLAUDE_TIMEOUT_MS', env.CLAUDE_TIMEOUT_MS, defaultTimeout),
    codexBin: env.CODEX_BIN ?? 'codex',
    codexTimeoutMs: parseExecutionTimeoutMs('CODEX_TIMEOUT_MS', env.CODEX_TIMEOUT_MS, defaultTimeout),
    opencodeBin: env.OPENCODE_BIN ?? 'opencode',
    opencodeTimeoutMs: parseExecutionTimeoutMs('OPENCODE_TIMEOUT_MS', env.OPENCODE_TIMEOUT_MS, defaultTimeout),
    kimiBin: env.KIMI_BIN ?? 'kimi',
    kimiTimeoutMs: parseExecutionTimeoutMs('KIMI_TIMEOUT_MS', env.KIMI_TIMEOUT_MS, defaultTimeout),
    geminiBin: env.GEMINI_BIN ?? 'gemini',
    geminiTimeoutMs: parseExecutionTimeoutMs('GEMINI_TIMEOUT_MS', env.GEMINI_TIMEOUT_MS, defaultTimeout),
    factoryBin: env.FACTORY_BIN ?? env.DROID_BIN ?? 'droid',
    ampBin: env.AMP_BIN ?? 'amp',
    forgeBin: env.FORGE_BIN ?? 'forge',
    hermesBin: env.HERMES_BIN ?? 'hermes',
    openclawBin: env.OPENCLAW_BIN ?? 'openclaw',
    nanoclawSocket: env.NANOCLAW_SOCKET ?? '',
    piBin: env.PI_BIN ?? 'pi',
    piTimeoutMs: parseExecutionTimeoutMs('PI_TIMEOUT_MS', env.PI_TIMEOUT_MS, defaultTimeout),
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
    sandboxTimeoutMs: parseExecutionTimeoutMs('SANDBOX_TIMEOUT_MS', env.SANDBOX_TIMEOUT_MS, defaultTimeout),
    executors,
    jailMode: parseJailMode(env.BRIDGE_JAIL_MODE),
    jailRoot: env.BRIDGE_JAIL_ROOT?.trim() || null,
    netJailMode,
    // Parsed (not merely split) so an unusable token is rejected at startup
    // rather than at provisioning time, when it would read as a Docker failure.
    netJailAllow: parseAllowList(env.BRIDGE_NET_JAIL_ALLOW, 'BRIDGE_NET_JAIL_ALLOW').map(formatAllowEntry),
    trace: parseTraceConfig(env, dataDir),
  }
}

/**
 * Retained trace bytes default to `DEFAULT_TRACE_MAX_BYTES * DEFAULT_TRACE_MAX_FILES`
 * = 32 MiB. Tracing stays on by default, so this ceiling is what an operator who
 * never configured it silently pays; it is sized to be unnoticeable on any disk
 * that can host a coding CLI rather than to a retention target. A span is a few
 * hundred bytes, so 32 MiB still holds tens of thousands of requests — long past
 * the point where an operator debugging a live bridge would have read them.
 * Raise `BRIDGE_TRACE_MAX_BYTES` / `BRIDGE_TRACE_MAX_FILES` for longer history.
 */
const DEFAULT_TRACE_MAX_BYTES = 16 * 1024 * 1024
const DEFAULT_TRACE_MAX_FILES = 2
const DEFAULT_TRACE_MAX_TOOL_SPANS = 512

function parseTraceConfig(env: NodeJS.ProcessEnv, dataDir: string): TraceConfig {
  return {
    enabled: parseOnOff('BRIDGE_TRACE', env.BRIDGE_TRACE, true),
    file: resolve(env.BRIDGE_TRACE_FILE?.trim() || join(dataDir, 'traces', 'spans.jsonl')),
    maxBytes: parsePositiveInt(env.BRIDGE_TRACE_MAX_BYTES, DEFAULT_TRACE_MAX_BYTES),
    maxFiles: parsePositiveInt(env.BRIDGE_TRACE_MAX_FILES, DEFAULT_TRACE_MAX_FILES),
    maxToolSpans: parseNonNegativeInt(env.BRIDGE_TRACE_MAX_TOOL_SPANS, DEFAULT_TRACE_MAX_TOOL_SPANS),
  }
}

/**
 * Boolean switch. Unrecognised values throw rather than defaulting, because a
 * typo silently leaving tracing on is exactly the surprise config validation
 * exists to prevent.
 */
function parseOnOff(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback
  const normalized = value.trim().toLowerCase()
  if (['on', '1', 'true', 'yes'].includes(normalized)) return true
  if (['off', '0', 'false', 'no'].includes(normalized)) return false
  throw new Error(`invalid ${name}: ${value} — expected on|off`)
}

function parseJailMode(value: string | undefined): 'off' | 'write-jail' | 'fs-jail' {
  if (value === undefined || value === '') return 'off'
  if (value === 'off' || value === 'write-jail' || value === 'fs-jail') return value
  throw new Error(`invalid BRIDGE_JAIL_MODE: ${value} — expected off|write-jail|fs-jail`)
}

function parseNetJailMode(env: NodeJS.ProcessEnv): 'off' | 'net-jail' {
  const value = env.BRIDGE_NET_JAIL_MODE
  if (value !== undefined && value !== '' && value !== 'off' && value !== 'net-jail') {
    throw new Error(`invalid BRIDGE_NET_JAIL_MODE: ${value} — expected off|net-jail`)
  }
  const shorthand = ['1', 'true', 'yes', 'on'].includes((env.WORKER_NET_JAIL ?? '').trim().toLowerCase())
  return value === 'net-jail' || shorthand ? 'net-jail' : 'off'
}

/**
 * Refuse to load a net-jail the bridge cannot enforce.
 *
 * Two contradictions, both fatal rather than warned:
 *
 *   - A backend that spawns its CLI on the host. That process shares the host's
 *     network namespace; there is no unprivileged mechanism that gives it an
 *     egress allowlist, and a proxy variable it can `unset` is not one. Booting
 *     with the setting accepted would report a network policy to every caller
 *     while enforcing nothing — the failure this feature exists to remove.
 *   - A backend pinned to an operator's own `<NAME>_DOCKER_NETWORK`. A worker
 *     joins exactly one network at creation, and joining a routable one is
 *     indistinguishable from having no jail at all.
 */
function assertNetJailEnforceable(
  backends: Set<string>,
  executors: Record<string, BackendExecutorConfig>,
): void {
  const hostSpawned = [...backends].filter(
    (name) => !NON_HOST_SPAWN_BACKENDS.has(name) && executors[name]?.kind !== 'docker',
  )
  if (hostSpawned.length > 0) {
    throw new Error(
      `net-jail is enabled (BRIDGE_NET_JAIL_MODE / WORKER_NET_JAIL) but ${hostSpawned.join(', ')} ` +
        `${hostSpawned.length === 1 ? 'runs' : 'run'} on the host execution mode, which cannot enforce it: a ` +
        'host-spawned CLI shares this machine\'s network namespace and any proxy variable it is given can be ' +
        'unset. Set ' + hostSpawned.map((n) => `${n.toUpperCase()}_EXECUTOR=docker`).join(' / ') +
        ', drop those backends from BRIDGE_BACKENDS, or unset the net-jail. Refusing to start with a network ' +
        'policy that would not be applied.',
    )
  }
  for (const cfg of Object.values(executors)) {
    if (cfg.kind === 'docker' && cfg.network && backends.has(cfg.name)) {
      throw new Error(
        `net-jail is enabled but ${cfg.name.toUpperCase()}_DOCKER_NETWORK=${cfg.network} pins its workers to a ` +
          'routable network. A container joins one network at creation, so the two settings cannot both hold. ' +
          `Unset ${cfg.name.toUpperCase()}_DOCKER_NETWORK, or unset the net-jail.`,
      )
    }
  }
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

function parseExecutionTimeoutMs(
  key: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === '') return fallback
  if (!/^\d+$/.test(value)) {
    throw new Error(`invalid ${key}: expected an integer from 0 to ${maxExecutionTimeoutMs}`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > maxExecutionTimeoutMs) {
    throw new Error(`invalid ${key}: expected an integer from 0 to ${maxExecutionTimeoutMs}`)
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

/** HOME the container runs with when no non-root identity is configured. */
const DEFAULT_CONTAINER_HOME = '/root'

/**
 * Per-backend defaults. `configRel` is HOME-relative and serves BOTH sides:
 * the host default (`$HOME/.config/opencode`) and the container mount target
 * (`<container HOME>/.config/opencode`).
 *
 * It is deliberately relative. A hardcoded absolute `/root/.config/opencode`
 * kept pointing at root's home after the operator asked for a uid-1000
 * container with HOME=/home/node, so the credential volumes landed somewhere
 * the CLI never reads and the CLI failed with EACCES on an unrelated path.
 * Resolving the same relative path against the CONFIGURED home makes that
 * mismatch impossible to express instead of something to detect later.
 */
interface BackendExecutorDefaults {
  image: string
  /** Primary config dir, HOME-relative. The one <NAME>_DOCKER_*_CONFIG_DIR overrides. */
  configRel: string
  /**
   * Further HOME-relative directories the CLI needs mounted. Measured on this
   * host: `opencode auth login` writes ~/.local/share/opencode/auth.json, and
   * ~/.config/opencode holds no credentials at all — so a pool that mounts only
   * the config dir has nothing to authenticate with.
   */
  extraRels?: string[]
  /**
   * HOME-relative path of the file that proves authentication, measured on this
   * host rather than assumed:
   *   ~/.local/share/opencode/auth.json   (opencode)
   *   ~/.claude/.credentials.json         (claude)
   *   ~/.codex/auth.json                  (codex)
   *   ~/.kimi/credentials                 (kimi, a directory)
   *   ~/.pi/agent/auth.json               (pi)
   * gemini is omitted: it authenticates by API key or a browser flow whose
   * artifact is not a stable file on this host, so claiming one would invent a
   * check. An omitted entry falls back to "the mount is empty".
   */
  credentialFile?: string
}

const BACKEND_EXECUTOR_DEFAULTS: Record<string, BackendExecutorDefaults> = {
  claude: { image: SHARED_RUNTIME_IMAGE, configRel: '.claude', credentialFile: '.claude/.credentials.json' },
  kimi: { image: SHARED_RUNTIME_IMAGE, configRel: '.kimi', credentialFile: '.kimi/credentials' },
  gemini: { image: SHARED_RUNTIME_IMAGE, configRel: '.gemini' },
  codex: { image: SHARED_RUNTIME_IMAGE, configRel: '.codex', credentialFile: '.codex/auth.json' },
  opencode: {
    image: SHARED_RUNTIME_IMAGE,
    configRel: '.config/opencode',
    extraRels: ['.local/share/opencode'],
    credentialFile: '.local/share/opencode/auth.json',
  },
  pi: { image: SHARED_RUNTIME_IMAGE, configRel: '.pi/agent', credentialFile: '.pi/agent/auth.json' },
}

const SUPPORTED_EXECUTOR_BACKENDS = Object.keys(BACKEND_EXECUTOR_DEFAULTS)

/**
 * Every `<NAME>_DOCKER_*` setting the parser understands. Anything else with
 * that shape is REJECTED rather than ignored: `OPENCODE_DOCKER_WORKSPACE_ROOT`
 * was set on a build that did not yet read it, so the bridge accepted the
 * setting, mounted nothing, exec'd into a path that did not exist, and reported
 * exit 127 — "command not found". A setting the bridge silently drops is
 * indistinguishable to the operator from one it honours.
 */
const KNOWN_DOCKER_SUFFIXES = [
  'IMAGE',
  'POOL_SIZE',
  'OAUTH_MOUNT',
  'NAME_PREFIX',
  'HOST_HOME',
  'HOST_CONFIG_DIR',
  'CONTAINER_CONFIG_DIR',
  'WORKSPACE_ROOT',
  'NETWORK',
  'USER',
  'HOME',
] as const

function parseAllExecutors(env: NodeJS.ProcessEnv, dataDir: string): Record<string, BackendExecutorConfig> {
  const defaultKind = parseExecutor('BRIDGE_DEFAULT_EXECUTOR', env.BRIDGE_DEFAULT_EXECUTOR, 'host')
  const out: Record<string, BackendExecutorConfig> = {}
  for (const name of SUPPORTED_EXECUTOR_BACKENDS) {
    const defaults = BACKEND_EXECUTOR_DEFAULTS[name]
    if (!defaults) continue
    const upper = name.toUpperCase()
    const kind = parseExecutor(`${upper}_EXECUTOR`, env[`${upper}_EXECUTOR`], defaultKind)
    assertNoUnknownDockerKeys(env, upper)
    const workspaceRootKey = `${upper}_DOCKER_WORKSPACE_ROOT`
    const rawWorkspaceRoot = env[workspaceRootKey]?.trim()
    const networkKey = `${upper}_DOCKER_NETWORK`
    const rawNetwork = env[networkKey]
    const containerUserKey = `${upper}_DOCKER_USER`
    const containerHomeKey = `${upper}_DOCKER_HOME`
    const rawContainerUser = env[containerUserKey]?.trim()
    const rawContainerHome = env[containerHomeKey]?.trim()
    // Every docker-only key, not just the four that used to be checked: a
    // `<NAME>_DOCKER_IMAGE` alongside `<NAME>_EXECUTOR=host` was accepted and
    // dropped, which is the same "accepted but not honoured" failure.
    const configuredDockerOnlyKey = KNOWN_DOCKER_SUFFIXES
      .map((suffix) => `${upper}_DOCKER_${suffix}`)
      .find((key) => (env[key]?.trim() ?? '') !== '')
    if (configuredDockerOnlyKey && kind !== 'docker') {
      throw new Error(
        `${configuredDockerOnlyKey} is set but ${upper}_EXECUTOR is ${kind} — the setting would be ignored. ` +
          `Set ${upper}_EXECUTOR=docker, or remove ${configuredDockerOnlyKey}.`,
      )
    }
    const cfg: BackendExecutorConfig = { name, kind }
    if (kind === 'docker') {
      cfg.image = env[`${upper}_DOCKER_IMAGE`] ?? defaults.image
      cfg.poolSize = parsePositiveInt(env[`${upper}_DOCKER_POOL_SIZE`], 4)
      cfg.oauthMode = parseOauthMode(`${upper}_DOCKER_OAUTH_MOUNT`, env[`${upper}_DOCKER_OAUTH_MOUNT`], 'share')
      cfg.namePrefix = env[`${upper}_DOCKER_NAME_PREFIX`] ?? `cli-bridge-${name}-pool`
      // The host directory treated as this CLI's home for credential purposes.
      // One knob for the whole mount set, because the set only makes sense
      // together: it is one CLI's home seen from the host and from the container.
      // Needed because the credential/state directory is also where the CLI keeps
      // its database — measured, ~/.local/share/opencode/opencode.db is 36 GB on
      // this host — so an operator has to be able to point the pool at a prepared
      // directory instead of the personal one.
      const hostHomeKey = `${upper}_DOCKER_HOST_HOME`
      const rawHostHome = env[hostHomeKey]?.trim()
      if (rawHostHome !== undefined && rawHostHome !== '' && !isAbsolute(rawHostHome)) {
        throw new Error(
          `${hostHomeKey}=${rawHostHome} must be an absolute host path: it is bind-mounted into every pool ` +
            `container, and a relative path would resolve against whatever directory the bridge was started in.`,
        )
      }
      const hostBase = rawHostHome || env.HOME || DEFAULT_CONTAINER_HOME
      cfg.hostConfigDir = resolve(env[`${upper}_DOCKER_HOST_CONFIG_DIR`] ?? `${hostBase}/${defaults.configRel}`)
      if (rawNetwork !== undefined && rawNetwork !== '') {
        cfg.network = assertDockerNetworkName(rawNetwork, networkKey)
      }
      if (Boolean(rawContainerUser) !== Boolean(rawContainerHome)) {
        throw new Error(`${containerUserKey} and ${containerHomeKey} must be configured together`)
      }
      if (rawContainerUser && rawContainerHome) {
        cfg.containerUser = parseDockerUser(containerUserKey, rawContainerUser)
        cfg.containerHome = parseDockerHome(containerHomeKey, rawContainerHome)
      }
      // Resolve the mount target against the home the CLI will actually have,
      // so the default cannot point at another user's home.
      const containerHome = cfg.containerHome ?? DEFAULT_CONTAINER_HOME
      cfg.containerConfigDir = env[`${upper}_DOCKER_CONTAINER_CONFIG_DIR`] ?? `${containerHome}/${defaults.configRel}`
      if (cfg.containerUser) {
        const configRelativeToHome = relative(containerHome, resolve(cfg.containerConfigDir))
        if (configRelativeToHome === ''
          || configRelativeToHome === '..'
          || configRelativeToHome.startsWith(`..${sep}`)
          || isAbsolute(configRelativeToHome)) {
          throw new Error(
            `${upper}_DOCKER_CONTAINER_CONFIG_DIR=${cfg.containerConfigDir} is outside ` +
              `${containerHomeKey}=${containerHome}, so a CLI running as ${cfg.containerUser} would never read it. ` +
              `Use a path under ${containerHome}, or unset ${containerUserKey}/${containerHomeKey} to run as the ` +
              `image's root identity.`,
          )
        }
      }
      // Every further credential directory the CLI reads, at the same
      // HOME-relative path on both sides so `<cli> auth login` inside a
      // container writes where the host mount can see it.
      const extraMounts = (defaults.extraRels ?? []).map((rel) => ({
        host: resolve(`${hostBase}/${rel}`),
        container: `${containerHome}/${rel}`,
      }))
      if (extraMounts.length > 0) cfg.extraMounts = extraMounts
      if (defaults.credentialFile) cfg.credentialFile = defaults.credentialFile
      // A docker executor ALWAYS has a workspace. Without one, a request that
      // names no cwd has no container-visible directory to run in, and the
      // bridge answered it by refusing the caller's request for the bridge's
      // own working directory — a remedy the HTTP API cannot express.
      cfg.workspaceRoot = rawWorkspaceRoot
        ? parseDockerWorkspaceRoot(workspaceRootKey, rawWorkspaceRoot)
        : join(dataDir, 'workspace', name)
      assertDockerMountsDoNotOverlap(
        workspaceRootKey,
        cfg.workspaceRoot,
        cfg.hostConfigDir,
        cfg.containerConfigDir,
      )
    }
    out[name] = cfg
  }
  return out
}

/**
 * Reject a `<NAME>_DOCKER_*` variable the parser does not read. A typo or a
 * variable from a newer/older build is otherwise indistinguishable from a
 * setting that took effect, which is how a configured workspace root ended up
 * never mounted while the bridge reported healthy.
 */
function assertNoUnknownDockerKeys(env: NodeJS.ProcessEnv, upper: string): void {
  const prefix = `${upper}_DOCKER_`
  const known = new Set<string>(KNOWN_DOCKER_SUFFIXES)
  for (const key of Object.keys(env)) {
    if (!key.startsWith(prefix)) continue
    const suffix = key.slice(prefix.length)
    if (known.has(suffix)) continue
    throw new Error(
      `unknown setting ${key} — cli-bridge does not read it, so it would have no effect. ` +
        `Supported ${prefix}* settings: ${KNOWN_DOCKER_SUFFIXES.join(', ')}.`,
    )
  }
}

function parseDockerUser(key: string, value: string): string {
  const match = /^([1-9][0-9]*):([1-9][0-9]*)$/u.exec(value)
  const uid = Number(match?.[1])
  const gid = Number(match?.[2])
  if (!match || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid > 2_147_483_647 || gid > 2_147_483_647) {
    throw new Error(`invalid ${key}: expected positive numeric uid:gid`)
  }
  return `${uid}:${gid}`
}

function parseDockerHome(key: string, value: string): string {
  if (!isAbsolute(value) || value === '/' || value.includes(',')) {
    throw new Error(`invalid ${key}: expected an absolute non-root path without commas`)
  }
  return resolve(value)
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
