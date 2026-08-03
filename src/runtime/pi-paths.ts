import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function runtimeHome(): string {
  return process.env.HOME?.trim() || homedir()
}

/** Resolve Pi's configured AgentDir consistently across execution and jail setup. */
export function resolvePiAgentDir(configured = process.env.PI_CODING_AGENT_DIR): string {
  const value = configured?.trim()
  const home = runtimeHome()
  if (!value) return join(home, '.pi', 'agent')
  if (value === '~') return home
  if (value.startsWith('~/')) return resolve(home, value.slice(2))
  return resolve(value)
}
