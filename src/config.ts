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
  /**
   * Optional ANTHROPIC_BASE_URL override for the Claude Code subprocess.
   * When set, Claude Code's outbound calls go there instead of
   * api.anthropic.com — the classic pairing is a local `claudish` proxy
   * so Claude Code's workflow drives a Z.AI / OpenRouter / Gemini brain.
   * See README "Claude Code with a different brain".
   */
  claudeAnthropicBaseUrl: string | null
  openaiApiKey: string | null
  anthropicApiKey: string | null
  moonshotApiKey: string | null
  zaiApiKey: string | null
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.BRIDGE_HOST ?? '127.0.0.1'
  const port = Number.parseInt(env.BRIDGE_PORT ?? '8787', 10)
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

  // The safety gate. Non-loopback bind without a bearer is a misconfiguration
  // you cannot set by accident.
  if (!LOOPBACK.has(host) && !bearer) {
    throw new Error(
      `BRIDGE_HOST is ${host} (not loopback) but BRIDGE_BEARER is not set. ` +
        `Refusing to start — an open proxy to your subscription keys is the ` +
        `one thing this tool must not accidentally do. Generate a bearer with ` +
        `\`openssl rand -hex 32\`, set BRIDGE_BEARER, and retry.`,
    )
  }

  return {
    host,
    port,
    bearer,
    dataDir,
    backends,
    claudeBin: env.CLAUDE_BIN ?? 'claude',
    claudeTimeoutMs: Number.parseInt(env.CLAUDE_TIMEOUT_MS ?? '300000', 10),
    claudeAnthropicBaseUrl: env.CLAUDE_ANTHROPIC_BASE_URL?.trim() || null,
    openaiApiKey: env.OPENAI_API_KEY?.trim() || null,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    moonshotApiKey: env.MOONSHOT_API_KEY?.trim() || null,
    zaiApiKey: env.ZAI_API_KEY?.trim() || null,
  }
}
