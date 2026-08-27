import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { ExecutorConfigurationError, type SpawnOpts } from './types.js'

export interface WorkspaceCwdContext { backend?: string; envPrefix?: string }

export function assertDockerWorkspaceCwd(workspaceRoot: string | undefined, cwd: string | undefined, ctx: WorkspaceCwdContext = {}): string | undefined {
  if (!cwd) return cwd
  if (!workspaceRoot) {
    const backend = ctx.backend ?? 'this backend'
    const prefix = ctx.envPrefix ?? '<BACKEND>'
    throw new ExecutorConfigurationError(
      `${backend} runs on a Docker executor with NO workspace bind, and the run resolved to ${cwd}. ` +
      `That directory does not exist inside the container, so the CLI would never start. It is the executor's ` +
      `resolved working directory, not necessarily one the caller named, so there is nothing for a caller to ` +
      `change. Set ${prefix}_DOCKER_WORKSPACE_ROOT to an absolute host directory containing ${cwd} — the pool ` +
      `bind-mounts it into every container at the identical path — or set ${prefix}_EXECUTOR=host to run the CLI directly on this host.`,
    )
  }
  if (!isAbsolute(cwd)) throw new ExecutorConfigurationError(`Docker executor cwd must be absolute when workspace root is configured: ${cwd}`)
  let canonicalCwd: string
  try { canonicalCwd = realpathSync(cwd) } catch { throw new ExecutorConfigurationError(`Docker executor cwd does not exist: ${cwd}`) }
  if (!statSync(canonicalCwd).isDirectory()) throw new ExecutorConfigurationError(`Docker executor cwd is not a directory: ${cwd}`)
  const rel = relative(workspaceRoot, canonicalCwd)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    const prefix = ctx.envPrefix ?? '<BACKEND>'
    throw new ExecutorConfigurationError(
      `Docker executor cwd ${cwd} is outside configured workspace root ${workspaceRoot}, so it is not inside the ` +
      `bind mount the container can see. Set ${prefix}_DOCKER_WORKSPACE_ROOT to a host directory containing ${cwd} — ` +
      `it is bind-mounted at the identical path in every pool container — or set ${prefix}_EXECUTOR=host to run the CLI directly on this host.`,
    )
  }
  return canonicalCwd
}

const PROXIED_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'MCP_DIRECT_TOOLS', 'ANTHROPIC_BASE_URL', 'GEMINI_SYSTEM_MD',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'MOONSHOT_API_KEY',
])

export function buildDockerExecArgs(
  containerId: string,
  bin: string,
  args: string[],
  spawnOpts: SpawnOpts,
  binPrefix = '',
  pathInContainer?: string,
  homeInContainer?: string,
  mapPath?: (path: string) => string,
): string[] {
  const out = ['exec', '-i']
  if (spawnOpts.cwd) out.push('--workdir', spawnOpts.cwd)
  if (spawnOpts.env && !spawnOpts.exactEnv) {
    for (const [key, value] of Object.entries(spawnOpts.env)) {
      if (typeof value !== 'string' || value.length === 0) continue
      if (PROXIED_ENV_KEYS.has(key) || key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_') || key.startsWith('CODEX_') || key.startsWith('KIMI_') || key.startsWith('OPENCODE_')) out.push('-e', `${key}=${value}`)
    }
  }
  out.push(containerId)
  if (spawnOpts.exactEnv) {
    out.push('env', '-i')
    for (const [key, value] of Object.entries(spawnOpts.env ?? {})) {
      if (typeof value !== 'string' || value.length === 0) continue
      const containerValue = key === 'PATH' && pathInContainer
        ? pathInContainer
        : key === 'HOME' && homeInContainer
          ? homeInContainer
          : isTemporaryEnvironmentKey(key) && isAbsolute(value)
            ? '/tmp'
            : isPathEnvironmentKey(key) && isAbsolute(value) && mapPath
              ? mapPath(value)
              : value
      out.push(`${key}=${containerValue}`)
    }
  }
  out.push(binPrefix ? `${binPrefix}${bin}` : bin, ...args)
  return out
}

function isPathEnvironmentKey(key: string): boolean {
  return ['PWD', 'TMPDIR', 'TEMP', 'TMP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'NVM_DIR', 'PNPM_HOME', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_PACKAGE_DIR'].includes(key)
}

function isTemporaryEnvironmentKey(key: string): boolean { return key === 'TMPDIR' || key === 'TEMP' || key === 'TMP' }
