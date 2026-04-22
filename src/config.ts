/**
 * Config — env-driven, validated at startup.
 *
 * One principle: the server refuses to start in an unsafe configuration.
 * Specifically, a non-loopback bind without a bearer check is a hard fail,
 * not a warning — an accidental open proxy to your personal subscription
 * keys is the failure mode we refuse to allow.
 */

import { resolve } from 'node:path'

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
  factoryBin: string
  ampBin: string
  forgeBin: string
  cliTimeoutMsDefault: number
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
    (env.BRIDGE_BACKENDS ?? 'claude,passthrough')
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
    factoryBin: env.FACTORY_BIN ?? env.DROID_BIN ?? 'droid',
    ampBin: env.AMP_BIN ?? 'amp',
    forgeBin: env.FORGE_BIN ?? 'forge',
    cliTimeoutMsDefault: defaultTimeout,
    claudishUrl: env.CLAUDISH_URL?.trim() || null,
    openaiApiKey: env.OPENAI_API_KEY?.trim() || null,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    moonshotApiKey: env.MOONSHOT_API_KEY?.trim() || null,
    zaiApiKey: env.ZAI_API_KEY?.trim() || null,
    sandboxApiUrl: env.SANDBOX_API_URL?.trim() || null,
    sandboxApiKey: env.SANDBOX_API_KEY?.trim() || null,
    sandboxProfilesDir: resolve(env.SANDBOX_PROFILES_DIR ?? './profiles'),
    sandboxTimeoutMs: Number.parseInt(env.SANDBOX_TIMEOUT_MS ?? '300000', 10),
  }
}
