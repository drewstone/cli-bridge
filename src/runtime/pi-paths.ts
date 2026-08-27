import { homedir, userInfo } from 'node:os'
import { existsSync } from 'node:fs'
import { assertNoSymlinkComponents, expandUserPath, isWithin, trustedTemporaryRoot, validateStablePath } from '../jail/path-policy.js'
import { join, resolve } from 'node:path'

function runtimeHome(): string {
  const systemHome = trustedHome()
  const configured = process.env.HOME?.trim()
  if (!configured) return systemHome
  const resolved = expandUserPath(configured, systemHome)
  validateStablePath(resolved, {
    label: 'HOME',
    kind: 'directory',
    allowBroadDirectory: resolved === systemHome,
  })
  return resolved
}

function trustedHome(): string {
  try {
    return userInfo().homedir
  } catch {
    return homedir()
  }
}

/** Resolve Pi's configured AgentDir consistently across execution and jail setup. */
export function resolvePiAgentDir(configured = process.env.PI_CODING_AGENT_DIR): string {
  const value = configured?.trim()
  const home = runtimeHome()
  const resolved = value ? expandUserPath(value, home) : join(home, '.pi', 'agent')
  assertNoSymlinkComponents(resolved, 'PI_CODING_AGENT_DIR', true)
  const allowedRoots = [trustedHome(), trustedTemporaryRoot()]
  if (value && !allowedRoots.some((root) => isWithin(resolve(root), resolved))) {
    throw new Error(`PI_CODING_AGENT_DIR is outside the allowed credential roots: ${resolved}`)
  }
  if (existsSync(resolved)) {
    validateStablePath(resolved, {
      label: 'PI_CODING_AGENT_DIR',
      kind: 'directory',
      allowedRoots,
    })
  }
  return resolved
}
