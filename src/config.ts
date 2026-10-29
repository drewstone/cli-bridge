/**
 * Config — env-driven, validated at startup.
 *
 * One principle: the server refuses to start in an unsafe configuration.
 * Specifically, a non-loopback bind without a bearer check is a hard fail,
 * not a warning — an accidental open proxy to your personal subscription
 * keys is the failure mode we refuse to allow.
 */

import { JAIL_RO_PATHS_ENV, JAIL_RW_PATHS_ENV, jailFloor, parseJailPathList } from './jail/resolve-spec.js'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

const maxExecutionTimeoutMs = 2_147_483_647
export const maxCodexSubscriptionTurnMs = 4 * 60 * 60 * 1000

/** Native harness identities only; model selection and seat syntax belong to agent-interface. */
export const localHarnesses = [
  ['claude', 'claude-code', 'claude auth login', ['auth', 'status', '--json'], 'anthropic'],
  ['codex', 'codex', 'codex login', ['login', 'status'], 'openai'],
  ['opencode', 'opencode', 'opencode auth login', ['auth', 'list', '--pure'], null],
  ['kimi', 'kimi-code', 'kimi login', ['--version'], null],
  ['gemini', 'gemini', 'gemini', ['--version'], 'google'],
  ['cursor', 'cursor', 'cursor-agent login', ['status', '--format', 'json'], 'cursor'],
  ['pi', 'pi', 'pi', ['auth', 'check', '--provider', 'openai-codex', '--json', '--no-refresh'], null],
] as const

type NativeHarnessConfig = {
  [Key in typeof localHarnesses[number][0] as `${Key}Bin`]: string
} & { [Key in typeof localHarnesses[number][0] as `${Key}TimeoutMs`]: number }

export interface Config extends NativeHarnessConfig {
  host: string
  port: number
  bearer: string | null
  dataDir: string
  /** Opt-in worker isolation for durable streamed writes; FULL WAL semantics stay unchanged. */
  asyncDurableWrites: boolean
  backends: Set<string>
  /** Dedicated subscription consumers refuse API and unverified native routes. */
  subscriptionsOnly: boolean
  /** ACP-protocol agents driven via `<bin> acp` (AcpBackend). */
  hermesBin: string
  openclawBin: string
  primeBin: string
  primeTimeoutMs: number
  /** Operator models.json materialized into every isolated prime agent dir. Null = none configured. */
  primeModelsJson: string | null
  /**
   * Operator-owned prime agent dir shared across runs — the explicit opt-in to
   * prime-agent's persistent self-modification state (harness_state.json rides
   * every future system prompt). Null = every run gets a fresh agent dir.
   */
  primePersistentAgentDir: string | null
  cliTimeoutMsDefault: number
  admission: {
    maxActive: number
    maxQueue: number
    queueTimeoutMs: number
    reservedActive: number
    bulkQueueTimeoutMs: number
  }
  /**
   * `x-tangle-client` prefixes admitted through the reserved lane. Matched on
   * the segment before `/`, so `pr-reviewer` covers `pr-reviewer/1`.
   */
  admissionReservedClients: string[]
  /**
   * When set, the `claudish` harness is registered and Claude Code is
   * spawned with ANTHROPIC_BASE_URL=<this> for `claudish/*` model ids.
   */
  claudishUrl: string | null
  /** Tangle sandbox-api base URL (e.g. https://sandbox.tangle.tools). When set + key present, the `sandbox` backend registers. */
  sandboxApiUrl: string | null
  /** Bearer for sandbox-api. Required for the sandbox backend. */
  sandboxApiKey: string | null
  /** Filesystem dir holding cataloged AgentProfile JSON files (one per profile, filename is the id). */
  sandboxProfilesDir: string
  /** Operator timeout fallback sent to sandbox-api when the caller omits one. Zero means none. */
  sandboxTimeoutMs: number
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
  /** Explicit policy when the configured OS jail is unavailable. */
  jailFallback: 'deny' | 'warn'
  /**
   * Default writable jail root from `BRIDGE_JAIL_ROOT`. Relative paths
   * resolve under the request cwd; absolute paths must stay inside it.
   * Null falls back to `<cwd>/.agent-home`. A per-request
   * `execution.jail.root` overrides this.
   */
  jailRoot: string | null
  /** Operator extra read-only binds for fs-jailed workers (`BRIDGE_JAIL_RO_PATHS`), validated at boot. */
  jailReadablePaths: string[]
  /** Operator extra writable binds for jailed workers (`BRIDGE_JAIL_RW_PATHS`), validated at boot. */
  jailWritablePaths: string[]
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

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

/** Shared listener safety for environment and embedded callers; only embedding permits port 0. */
export function assertListenerConfig(
  { host, port, bearer }: Pick<Config, 'host' | 'port' | 'bearer'>,
  ephemeral = false,
): void {
  if (!Number.isSafeInteger(port) || port < (ephemeral ? 0 : 1) || port > 65535) {
    throw new Error(`invalid BRIDGE_PORT: ${port}`)
  }
  if (!LOOPBACK.has(host) && !bearer?.trim()) {
    throw new Error(
      `BRIDGE_HOST is ${host} (not loopback) but BRIDGE_BEARER is not set. ` +
        'Refusing to start — an open proxy to your subscription keys is the ' +
        'one thing this tool must not accidentally do. Generate a bearer with ' +
        '`openssl rand -hex 32`, set BRIDGE_BEARER, and retry.',
    )
  }
}

export function anyBackendSpawnsOnHost(backends: Iterable<string>): boolean {
  return [...backends].some((name) => name !== 'sandbox')
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.BRIDGE_HOST ?? '127.0.0.1'
  // 3344 chosen to dodge common dev/services collisions: 8787 was hit
  // by other Hono dev servers, 4098 collided with the ADC sandbox-api
  // gateway in the wild. 3344 is unassigned on IANA + low-conflict.
  const port = Number.parseInt(env.BRIDGE_PORT ?? '3344', 10)
  const bearer = env.BRIDGE_BEARER?.trim() || null
  const dataDir = resolve(env.BRIDGE_DATA_DIR ?? './data')
  const backends = new Set(
    (env.BRIDGE_BACKENDS ?? 'claude,kimi,gemini,sandbox')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  )

  assertListenerConfig({ host, port, bearer })
  // A caller may own the process deadline through `execution.timeoutMs`.
  // Codex defaults to its bounded native subscription policy; explicit operator/request values win.
  const defaultTimeout = parseExecutionTimeoutMs('CLI_TIMEOUT_MS', env.CLI_TIMEOUT_MS, 0)
  for (const [key, value] of Object.entries(env)) {
    if ((key === 'BRIDGE_DEFAULT_EXECUTOR' || /^(CLAUDE|CODEX|KIMI|OPENCODE|GEMINI|CURSOR|PI)_EXECUTOR$/.test(key)) && value && value !== 'host') {
      throw new Error(`${key}: only host execution is supported`)
    }
    if (/^(CLAUDE|CODEX|KIMI|OPENCODE|GEMINI|CURSOR|PI)_DOCKER_/.test(key) && value) throw new Error(`${key}: Docker execution is no longer supported`)
  }
  if ((env.BRIDGE_NET_JAIL_MODE && env.BRIDGE_NET_JAIL_MODE !== 'off')
    || ['1', 'true', 'yes', 'on'].includes((env.WORKER_NET_JAIL ?? '').trim().toLowerCase())
    || env.BRIDGE_NET_JAIL_ALLOW?.trim()) throw new Error('net-jail is no longer supported')

  return {
    host,
    port,
    bearer,
    dataDir,
    asyncDurableWrites: parseOnOff('BRIDGE_ASYNC_DURABLE_WRITES', env.BRIDGE_ASYNC_DURABLE_WRITES, false),
    backends,
    subscriptionsOnly: parseOnOff('BRIDGE_SUBSCRIPTIONS_ONLY', env.BRIDGE_SUBSCRIPTIONS_ONLY, false),
    ...Object.fromEntries(localHarnesses.flatMap(([name]) => [
      [`${name}Bin`, env[`${name.toUpperCase()}_BIN`] ?? (name === 'cursor' ? 'cursor-agent' : name)],
      [`${name}TimeoutMs`, parseExecutionTimeoutMs(`${name.toUpperCase()}_TIMEOUT_MS`, env[`${name.toUpperCase()}_TIMEOUT_MS`], name === 'codex' && !env.CLI_TIMEOUT_MS ? maxCodexSubscriptionTurnMs : defaultTimeout)],
    ])) as NativeHarnessConfig,
    hermesBin: env.HERMES_BIN ?? 'hermes',
    openclawBin: env.OPENCLAW_BIN ?? 'openclaw',
    primeBin: env.PRIME_BIN ?? 'prime-agent',
    primeTimeoutMs: parseExecutionTimeoutMs('PRIME_TIMEOUT_MS', env.PRIME_TIMEOUT_MS, defaultTimeout),
    ...parsePrimeStateConfig(env, backends),
    cliTimeoutMsDefault: defaultTimeout,
    admission: admissionConfig(env),
    admissionReservedClients: parseClientList(env.BRIDGE_HOST_CHAT_RESERVED_CLIENTS, ['pr-reviewer']),
    claudishUrl: env.CLAUDISH_URL?.trim() || null,
    sandboxApiUrl: env.SANDBOX_API_URL?.trim() || null,
    sandboxApiKey: env.SANDBOX_API_KEY?.trim() || null,
    sandboxProfilesDir: resolve(env.SANDBOX_PROFILES_DIR ?? './profiles'),
    sandboxTimeoutMs: parseExecutionTimeoutMs('SANDBOX_TIMEOUT_MS', env.SANDBOX_TIMEOUT_MS, defaultTimeout),
    jailMode: jailFloor({ ...env, BRIDGE_JAIL_MODE: parseJailMode(env.BRIDGE_JAIL_MODE) }),
    jailFallback: env.BRIDGE_JAIL_FALLBACK === 'warn' ? 'warn' : 'deny',
    jailRoot: env.BRIDGE_JAIL_ROOT?.trim() || null,
    ...resolveJailPathLists(env),
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

/**
 * PRIME_MODELS_JSON / PRIME_PERSISTENT_AGENT_DIR — validated here so a broken
 * or ignored setting fails the start instead of the first request. Deep schema
 * validation of the models.json happens in the PrimeBackend constructor, which
 * shares the fork's own comment-tolerant parser.
 */
function parsePrimeStateConfig(
  env: NodeJS.ProcessEnv,
  backends: Set<string>,
): Pick<Config, 'primeModelsJson' | 'primePersistentAgentDir'> {
  const modelsJson = env.PRIME_MODELS_JSON?.trim() || null
  const persistentAgentDir = env.PRIME_PERSISTENT_AGENT_DIR?.trim() || null
  if (modelsJson && persistentAgentDir) {
    throw new Error(
      'PRIME_MODELS_JSON and PRIME_PERSISTENT_AGENT_DIR are both set — a persistent agent dir owns its own ' +
        'models.json, and materializing over it would silently clobber operator config. Unset one.',
    )
  }
  for (const [key, value] of [
    ['PRIME_MODELS_JSON', modelsJson],
    ['PRIME_PERSISTENT_AGENT_DIR', persistentAgentDir],
  ] as const) {
    if (value && !backends.has('prime')) {
      throw new Error(
        `${key} is set but "prime" is not in BRIDGE_BACKENDS — the setting would be ignored. ` +
          `Add prime to BRIDGE_BACKENDS, or remove ${key}.`,
      )
    }
  }
  if (modelsJson) {
    let stat
    try {
      stat = statSync(modelsJson)
    } catch {
      throw new Error(`invalid PRIME_MODELS_JSON: path does not exist: ${modelsJson}`)
    }
    if (!stat.isFile()) throw new Error(`invalid PRIME_MODELS_JSON: not a file: ${modelsJson}`)
  }
  if (persistentAgentDir) {
    if (!isAbsolute(persistentAgentDir)) {
      throw new Error(`invalid PRIME_PERSISTENT_AGENT_DIR: expected an absolute path, got ${persistentAgentDir}`)
    }
    let stat
    try {
      stat = statSync(persistentAgentDir)
    } catch {
      throw new Error(`invalid PRIME_PERSISTENT_AGENT_DIR: path does not exist: ${persistentAgentDir}`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`invalid PRIME_PERSISTENT_AGENT_DIR: not a directory: ${persistentAgentDir}`)
    }
  }
  return {
    primeModelsJson: modelsJson ? resolve(modelsJson) : null,
    primePersistentAgentDir: persistentAgentDir ? resolve(persistentAgentDir) : null,
  }
}

function parseJailMode(value: string | undefined): 'off' | 'write-jail' | 'fs-jail' {
  if (value === undefined || value === '') return 'off'
  if (value === 'off' || value === 'write-jail' || value === 'fs-jail') return value
  throw new Error(`invalid BRIDGE_JAIL_MODE: ${value} — expected off|write-jail|fs-jail`)
}

/**
 * Host-chat admission limits.
 *
 * `reservedActive` defaults to 2 because the PR reviewer issues exactly two
 * concurrent bridge calls per pull request (its value and usefulness agents);
 * a lane narrower than that re-queues the reviewer behind fleet traffic.
 *
 * `bulkQueueTimeoutMs` defaults to 240s: long enough to outlast a median host
 * call (measured p50 ≈ 137s for non-probe work) so bulk callers wait instead of
 * failing, short enough to stay under the 300s socket idle timeout our callers
 * use — past that, a rejection stops being a typed 503 and becomes a hang.
 */
function admissionConfig(env: NodeJS.ProcessEnv): Config['admission'] {
  const maxActive = parseNonNegativeInt(env.BRIDGE_HOST_CHAT_MAX_ACTIVE, 8)
  return {
    maxActive,
    maxQueue: parseNonNegativeInt(env.BRIDGE_HOST_CHAT_MAX_QUEUE, 16),
    queueTimeoutMs: parseNonNegativeInt(env.BRIDGE_HOST_CHAT_QUEUE_TIMEOUT_MS, 30_000),
    reservedActive: parseNonNegativeInt(
      env.BRIDGE_HOST_CHAT_RESERVED_ACTIVE,
      maxActive === 0 ? 0 : Math.min(2, maxActive - 1),
    ),
    bulkQueueTimeoutMs: parseNonNegativeInt(env.BRIDGE_HOST_CHAT_BULK_QUEUE_TIMEOUT_MS, 240_000),
  }
}

function parseClientList(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback
  return value.split(',').map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== '')
}

const parsePositiveInt = (value: string | undefined, fallback: number): number => parseInteger(value, fallback, 1)
const parseNonNegativeInt = (value: string | undefined, fallback: number): number => parseInteger(value, fallback, 0)

function parseInteger(value: string | undefined, fallback: number, minimum: 0 | 1): number {
  if (value === undefined || value === '') return fallback
  const parsed = /^(0|[1-9][0-9]*)$/u.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`invalid ${minimum ? 'positive' : 'non-negative'} integer: ${value}`)
  }
  return parsed
}

function parseExecutionTimeoutMs(
  key: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === '') return fallback
  const parsed = /^\d+$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(parsed) || parsed > maxExecutionTimeoutMs) {
    throw new Error(`invalid ${key}: expected an integer from 0 to ${maxExecutionTimeoutMs}`)
  }
  return parsed
}

/**
 * BRIDGE_JAIL_RO_PATHS / BRIDGE_JAIL_RW_PATHS — parsed at boot so a malformed or unsafe path
 * refuses the bridge instead of one worker request. RO binds are inert unless the jail floor is
 * fs-jail; that case is a boot warning, not a refusal, because an env file may carry the list
 * for a bridge that toggles its floor per deploy.
 */
function resolveJailPathLists(env: NodeJS.ProcessEnv): Pick<Config, 'jailReadablePaths' | 'jailWritablePaths'> {
  const jailReadablePaths = parseJailPathList(env[JAIL_RO_PATHS_ENV], JAIL_RO_PATHS_ENV)
  const jailWritablePaths = parseJailPathList(env[JAIL_RW_PATHS_ENV], JAIL_RW_PATHS_ENV)
  if (jailReadablePaths.length > 0 && jailFloor(env) !== 'fs-jail') {
    console.warn(`${JAIL_RO_PATHS_ENV} is set but the jail floor is ${jailFloor(env)} — read-only extras apply only under fs-jail`)
  }
  return { jailReadablePaths, jailWritablePaths }
}
