import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServerSpec } from './types.js'
import { BackendError } from './types.js'
import {
  createPrivateTemporaryRoot,
  hardenPrivateTemporaryTree,
  reapStalePrivateTemporaryRoots,
  type PrivateTemporaryRoot,
} from '../runtime/private-temporary.js'
import { requireMaterializationCwd } from './profile-workspace.js'
import { buildCanonicalMcpServers, type MaterializedMcpConfig } from './profile-core.js'

export function materializeMcpServersForPi(
  specs: Record<string, McpServerSpec> | null,
  cwd: string | undefined,
  options: { isolateChildren?: boolean } = {},
): MaterializedMcpConfig | null {
  if (!specs) return null
  // `directTools` is pi-adapter-specific, so it is added HERE rather than in the shared canonical
  // builder that Claude and Kimi also read. It registers each server's tools as NATIVE pi tools
  // instead of leaving them behind the generic `mcp` tool, where an agent must connect to the
  // server and describe each verb before it can call one. A measured supervisor run spent turns
  // and hundreds of thousands of input tokens on that discovery before it could delegate once.
  const mcpServers = Object.fromEntries(
    Object.entries(buildCanonicalMcpServers(specs)).map(([name, server]) => [name, { ...server, directTools: true }]),
  )
  const serverNames = Object.keys(mcpServers)
  if (process.env.CLI_BRIDGE_DEBUG_MCP) {
    console.error(
      `[cli-bridge mcp pi] materialized servers: ${serverNames.join(', ') || '(none)'} from specs: ${Object.keys(specs).join(', ') || '(empty)'}`,
    )
  }
  if (serverNames.length === 0) return null
  const workspaceCwd = requireMaterializationCwd(cwd, 'pi MCP passthrough')
  let root: PrivateTemporaryRoot | null = null
  try {
    reapStalePiMcpConfigs()
    // pi-mcp-adapter has exposed the per-process `--mcp-config` flag since its first public
    // release. Keep the config under the mounted workspace so host and Docker Pi see the same
    // absolute path, but never mutate the project's own `.pi/mcp.json`.
    root = createPrivateTemporaryRoot(workspaceCwd, '.cli-bridge-pi-mcp-')
    const configPath = join(root.path, 'mcp.json')
    const isolatedMcpServers = options.isolateChildren ? isolatePiMcpServers(mcpServers, root.path) : mcpServers
    writeFileSync(configPath, JSON.stringify({ mcpServers: isolatedMcpServers }, null, 2), { flag: 'wx', mode: 0o600 })
    hardenPrivateTemporaryTree(root.path)
    let cleaned = false
    return {
      configPath,
      serverNames,
      cleanup: () => {
        if (cleaned) return
        root!.cleanup()
        cleaned = true
      },
    }
  } catch (error) {
    root?.cleanup()
    const message = error instanceof Error ? error.message : String(error)
    throw new BackendError(`backend pi failed to prepare MCP config: ${message}`, 'not_configured', error)
  }
}

/** Backward-compatible entry point; all private backend roots share one reaper. */
export function reapStalePiMcpConfigs(): number {
  return reapStalePrivateTemporaryRoots()
}

const PI_MCP_SECRET_KEY =
  /(?:^|_)(?:API[_-]?KEY|AUTH(?:ORIZATION|ENTICATION)?|BEARER|COOKIE|CREDENTIALS?|PASSWORD|PASSPHRASE|PRIVATE[_-]?KEY|SECRET|TOKEN)(?:_|$)/iu
const PI_MCP_ISOLATION_KEY =
  /^(?:HOME|PATH|PWD|TMPDIR|TEMP|TMP|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME|XDG_RUNTIME_DIR|PI_CODING_AGENT_DIR|PI_CODING_AGENT_SESSION_DIR|PI_PACKAGE_DIR)$/u

/**
 * pi-mcp-adapter currently copies process.env for every stdio child.
 * Put a trusted `/usr/bin/env -i` boundary in the config so the adapter's
 * ambient environment never reaches an untrusted server, and give each server
 * a fresh HOME/XDG tree with no provider auth files.
 */
function isolatePiMcpServers(
  servers: Record<string, Record<string, unknown>>,
  root: string,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server], index) => {
      if (typeof server.command !== 'string') return [name, server]
      const serverEnv = server.env && typeof server.env === 'object' ? (server.env as Record<string, unknown>) : {}
      const safeEntries: string[] = []
      for (const [key, value] of Object.entries(serverEnv)) {
        if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || PI_MCP_SECRET_KEY.test(key)) {
          throw new BackendError(
            `pi MCP server ${JSON.stringify(name)} declares a secret-shaped environment key ${JSON.stringify(key)}; resolve it in a private adapter instead`,
            'parse_error',
          )
        }
        if (PI_MCP_ISOLATION_KEY.test(key)) {
          throw new BackendError(
            `pi MCP server ${JSON.stringify(name)} cannot override isolated environment key ${JSON.stringify(key)}`,
            'parse_error',
          )
        }
        if (typeof value !== 'string' || value.includes('\u0000')) {
          throw new BackendError(
            `pi MCP server ${JSON.stringify(name)} has an invalid environment value for ${JSON.stringify(key)}`,
            'parse_error',
          )
        }
        safeEntries.push(`${key}=${value}`)
      }
      const home = join(root, `home-${index}`)
      const tmp = join(home, 'tmp')
      const config = join(home, '.config')
      const cache = join(home, '.cache')
      const data = join(home, '.local', 'share')
      const runtime = join(home, '.runtime')
      for (const directory of [tmp, config, cache, data, runtime])
        mkdirSync(directory, { recursive: true, mode: 0o700 })
      const args = [
        '-i',
        `HOME=${home}`,
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        `TMPDIR=${tmp}`,
        `TEMP=${tmp}`,
        `TMP=${tmp}`,
        `XDG_CONFIG_HOME=${config}`,
        `XDG_CACHE_HOME=${cache}`,
        `XDG_DATA_HOME=${data}`,
        `XDG_RUNTIME_DIR=${runtime}`,
        ...safeEntries,
        '--',
        server.command,
        ...(Array.isArray(server.args) ? (server.args as string[]) : []),
      ]
      const { env: _discardedEnv, ...withoutEnv } = server
      return [name, { ...withoutEnv, command: '/usr/bin/env', args }]
    }),
  )
}

/**
 * Mount a `{mcpServers}` object into a CWD-NATIVE config file
 * (`<cwd>/<subdir>/<filename>`) that a CLI discovers by working directory
 * rather than a per-invocation flag. Shared by the additive cwd-native MCP
 * backends — gemini (`.gemini/settings.json`) and droid/factory
 * (`.factory/mcp.json`). Only the schema of the `mcpServers` values differs,
 * and the caller has already transformed those.
 *
 * The file lives in the run workspace, not a temp dir, because the CLI
 * discovers config by cwd. When the file already exists (caller-
 * provisioned workspace, or the user's own project settings), the
 * requested servers are merged into its `mcpServers` map (request wins on
 * name collisions) and every other top-level key is preserved; the
 * mount's `cleanup()` restores the original bytes verbatim, otherwise it
 * removes the file and, when this mount created it, the `<subdir>`
 * directory. This is why the user's own `~/.factory/mcp.json` or
 * `~/.gemini/settings.json` is never touched — we only write the
 * project-scoped file the CLI layers on top.
 *
 * Concurrency: the CLI discovers config strictly by cwd, so two
 * overlapping runs in one workspace would either share request-scoped
 * server definitions (leaking one run's tools/secrets into the other) or
 * race on restore. Neither is acceptable — a `<filename>.lock` file
 * (O_EXCL, holds `{pid, originalBytes}`) enforces ONE active MCP mount
 * per cwd across processes. A second overlapping mount fails loud with
 * instructions to use distinct cwds; a lock whose pid is dead is stolen
 * (crashed run) after rolling the workspace back to its recorded
 * pre-mount state.
 *
 * Returns null when `mcpServers` is empty.
 */
