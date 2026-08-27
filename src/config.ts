/** Environment configuration and startup policy validation. */

import { join, resolve } from 'node:path'
import { formatAllowEntry, parseAllowList } from './jail/net-allowlist.js'
import { parseAllExecutors, type BackendExecutorConfig } from './config/executor-config.js'
export type { BackendExecutorConfig } from './config/executor-config.js'

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
  hermesBin: string
  openclawBin: string
  nanoclawSocket: string
  piBin: string
  piTimeoutMs: number
  cliTimeoutMsDefault: number
  admission: { maxActive: number; maxQueue: number; queueTimeoutMs: number }
  claudishUrl: string | null
  openaiApiKey: string | null
  anthropicApiKey: string | null
  moonshotApiKey: string | null
  zaiApiKey: string | null
  sandboxApiUrl: string | null
  sandboxApiKey: string | null
  sandboxProfilesDir: string
  sandboxTimeoutMs: number
  executors: Record<string, BackendExecutorConfig>
  jailMode: 'off' | 'write-jail' | 'fs-jail'
  jailRoot: string | null
  netJailMode: 'off' | 'net-jail'
  netJailAllow: string[]
  trace: TraceConfig
}

export interface TraceConfig {
  enabled: boolean
  file: string
  maxBytes: number
  maxFiles: number
  maxToolSpans: number
}

const NON_HOST_SPAWN_BACKENDS = new Set(['sandbox', 'passthrough', 'nanoclaw'])
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

export function anyBackendSpawnsOnHost(backends: Iterable<string>, executors: Record<string, BackendExecutorConfig>): boolean {
  for (const name of backends) {
    if (NON_HOST_SPAWN_BACKENDS.has(name)) continue
    if (executors[name]?.kind === 'docker') continue
    return true
  }
  return false
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.BRIDGE_HOST ?? '127.0.0.1'
  const port = Number.parseInt(env.BRIDGE_PORT ?? '3344', 10)
  const bearer = env.BRIDGE_BEARER?.trim() || null
  const dataDir = resolve(env.BRIDGE_DATA_DIR ?? './data')
  const backends = new Set((env.BRIDGE_BACKENDS ?? 'claude,codex,opencode,kimi,gemini,pi,passthrough').split(',').map(s => s.trim()).filter(Boolean))
  if (Number.isNaN(port) || port < 1 || port > 65535) throw new Error(`invalid BRIDGE_PORT: ${env.BRIDGE_PORT}`)
  if (!LOOPBACK.has(host) && !bearer) throw new Error(`BRIDGE_HOST is ${host} (not loopback) but BRIDGE_BEARER is not set. Refusing to start.`)
  const defaultTimeout = Number.parseInt(env.CLI_TIMEOUT_MS ?? '300000', 10)
  const executors = parseAllExecutors(env, dataDir)
  const netJailMode = parseNetJailMode(env)
  if (netJailMode !== 'off') assertNetJailEnforceable(backends, executors)
  return {
    host, port, bearer, dataDir, backends,
    claudeBin: env.CLAUDE_BIN ?? 'claude', claudeTimeoutMs: Number.parseInt(env.CLAUDE_TIMEOUT_MS ?? String(defaultTimeout), 10),
    codexBin: env.CODEX_BIN ?? 'codex', codexTimeoutMs: Number.parseInt(env.CODEX_TIMEOUT_MS ?? String(defaultTimeout), 10),
    opencodeBin: env.OPENCODE_BIN ?? 'opencode', opencodeTimeoutMs: Number.parseInt(env.OPENCODE_TIMEOUT_MS ?? String(defaultTimeout), 10),
    kimiBin: env.KIMI_BIN ?? 'kimi', kimiTimeoutMs: Number.parseInt(env.KIMI_TIMEOUT_MS ?? String(defaultTimeout), 10),
    geminiBin: env.GEMINI_BIN ?? 'gemini', geminiTimeoutMs: Number.parseInt(env.GEMINI_TIMEOUT_MS ?? String(defaultTimeout), 10),
    factoryBin: env.FACTORY_BIN ?? env.DROID_BIN ?? 'droid', ampBin: env.AMP_BIN ?? 'amp', forgeBin: env.FORGE_BIN ?? 'forge',
    hermesBin: env.HERMES_BIN ?? 'hermes', openclawBin: env.OPENCLAW_BIN ?? 'openclaw', nanoclawSocket: env.NANOCLAW_SOCKET ?? '',
    piBin: env.PI_BIN ?? 'pi', piTimeoutMs: Number.parseInt(env.PI_TIMEOUT_MS ?? String(defaultTimeout), 10), cliTimeoutMsDefault: defaultTimeout,
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
    executors,
    jailMode: parseJailMode(env.BRIDGE_JAIL_MODE),
    jailRoot: env.BRIDGE_JAIL_ROOT?.trim() || null,
    netJailMode,
    netJailAllow: parseAllowList(env.BRIDGE_NET_JAIL_ALLOW, 'BRIDGE_NET_JAIL_ALLOW').map(formatAllowEntry),
    trace: parseTraceConfig(env, dataDir),
  }
}

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
  if (value !== undefined && value !== '' && value !== 'off' && value !== 'net-jail') throw new Error(`invalid BRIDGE_NET_JAIL_MODE: ${value} — expected off|net-jail`)
  return value === 'net-jail' || ['1', 'true', 'yes', 'on'].includes((env.WORKER_NET_JAIL ?? '').trim().toLowerCase()) ? 'net-jail' : 'off'
}
function assertNetJailEnforceable(backends: Set<string>, executors: Record<string, BackendExecutorConfig>): void {
  const hostSpawned = [...backends].filter(name => !NON_HOST_SPAWN_BACKENDS.has(name) && executors[name]?.kind !== 'docker')
  if (hostSpawned.length > 0) throw new Error(
    `net-jail is enabled (BRIDGE_NET_JAIL_MODE / WORKER_NET_JAIL) but ${hostSpawned.join(', ')} ` +
    `${hostSpawned.length === 1 ? 'runs' : 'run'} on the host execution mode, which cannot enforce it. Set ` +
    hostSpawned.map(name => `${name.toUpperCase()}_EXECUTOR=docker`).join(' / ') +
    ', drop those backends from BRIDGE_BACKENDS, or unset the net-jail.',
  )
  for (const cfg of Object.values(executors)) if (cfg.kind === 'docker' && cfg.network && backends.has(cfg.name)) throw new Error(`net-jail is enabled but ${cfg.name.toUpperCase()}_DOCKER_NETWORK=${cfg.network} pins its workers to a routable network`)
}
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number.parseInt(value, 10); if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`invalid positive integer: ${value}`)
  return parsed
}
function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number.parseInt(value, 10); if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`invalid non-negative integer: ${value}`)
  return parsed
}
