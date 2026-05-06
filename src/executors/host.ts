/**
 * Host spawner — node's `spawn` with a no-op release.
 *
 * This is the default for every backend; it preserves the current
 * "spawn the CLI on the host" behavior. Backends that don't opt into a
 * pooled Docker executor get this.
 */

import { spawn } from 'node:child_process'
import type { SpawnOpts, SpawnResult, Spawner } from './types.js'

export const hostSpawner: Spawner = async (bin, args, opts) => {
  const child = spawn(bin, args, {
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd,
    env: sanitizeHostEnv(opts.env),
  })
  const result: SpawnResult = {
    child,
    release: () => {},
  }
  return result
}

export function sanitizeHostEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (!env) return undefined

  const out: NodeJS.ProcessEnv = {}
  for (const key of BASE_HOST_ENV_KEYS) {
    const value = env[key]
    if (typeof value === 'string' && value.length > 0) out[key] = value
  }

  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length === 0) continue
    if (value.length > MAX_ENV_VALUE_BYTES) continue
    if (BASE_HOST_ENV_KEYS.has(key) || PROXIED_ENV_KEYS.has(key) || PROXIED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      out[key] = value
    }
  }

  return out
}

const MAX_ENV_VALUE_BYTES = 16_384

const BASE_HOST_ENV_KEYS = new Set([
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
  'NVM_DIR',
  'PNPM_HOME',
])

const PROXIED_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_OAUTH_TOKEN',
  'BRIDGE_BEARER',
  'CLI_BRIDGE_BEARER',
  'CURSOR_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'MOONSHOT_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'TANGLE_ROUTER_API_KEY',
  'ZAI_API_KEY',
  'ZHIPU_API_KEY',
])

const PROXIED_ENV_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_',
  'CODEX_',
  'CURSOR_',
  'KIMI_',
  'MOONSHOT_',
  'OPENAI_',
  'OPENCODE_',
  'TANGLE_',
  'ZAI_',
  'ZHIPU_',
]
