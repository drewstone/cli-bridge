import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProfile, AgentProfileMcpServer } from '@tangle-network/agent-interface'
import type { McpServerSpec } from './types.js'
import { isStdioMcpSpec, type MaterializedMcpConfig, profileMcpToSpec } from './profile-core.js'
import { mountCwdNativeMcp } from './profile-mcp-jail.js'
import { requireMaterializationCwd } from './profile-workspace.js'
import { createPrivateTemporaryRoot } from '../runtime/private-temporary.js'

function buildGeminiMcpServers(specs: Record<string, McpServerSpec>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.enabled === false) continue
    if (isStdioMcpSpec(spec) && spec.command) {
      out[name] = {
        command: spec.command,
        ...(spec.args && spec.args.length ? { args: spec.args } : {}),
        ...(spec.env && Object.keys(spec.env).length ? { env: spec.env } : {}),
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
        trust: true,
      }
    } else if (spec.type === 'http' && spec.url) {
      out[name] = {
        httpUrl: spec.url,
        ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}),
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
        trust: true,
      }
    } else if (spec.type === 'sse' && spec.url) {
      out[name] = {
        url: spec.url,
        ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}),
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
        trust: true,
      }
    }
  }
  return out
}

/**
 * Materialize MCP servers for the gemini backend by merging them into the
 * project-scope `<cwd>/.gemini/settings.json`, which Gemini CLI layers on
 * top of the user's global `~/.gemini/settings.json`. cwd-native (no
 * per-invocation MCP flag), so it shares pi's lock + no-follow discipline
 * via `mountCwdNativeMcp`; every non-`mcpServers` settings key already in
 * the file is preserved. Returns null when no usable servers remain.
 */
export function materializeMcpServersForGemini(
  specs: Record<string, McpServerSpec> | null,
  cwd: string | undefined,
): MaterializedMcpConfig | null {
  if (!specs) return null
  const target = requireMaterializationCwd(cwd, 'gemini MCP passthrough')
  const mcpServers = buildGeminiMcpServers(specs)
  if (process.env.CLI_BRIDGE_DEBUG_MCP) {
    console.error(
      `[cli-bridge mcp gemini] materialized servers: ${Object.keys(mcpServers).join(', ') || '(none)'} from specs: ${Object.keys(specs).join(', ') || '(empty)'}`,
    )
  }
  return mountCwdNativeMcp(target, { subdir: '.gemini', filename: 'settings.json', backendName: 'gemini', mcpServers })
}

/**
 * Build the droid (Factory) `mcpServers` object. droid's `mcp.json` is
 * nearly canonical — stdio entries carry an explicit `type:'stdio'` and
 * every entry an explicit `disabled:false`, both of which the canonical
 * shape omits. Remote entries are `{type:'http'|'sse', url, headers}`.
 */
function buildFactoryMcpServers(specs: Record<string, McpServerSpec>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.enabled === false) continue
    if (isStdioMcpSpec(spec) && spec.command) {
      out[name] = {
        type: 'stdio',
        command: spec.command,
        args: spec.args ?? [],
        ...(spec.env && Object.keys(spec.env).length ? { env: spec.env } : {}),
        disabled: false,
      }
    } else if ((spec.type === 'http' || spec.type === 'sse') && spec.url) {
      out[name] = {
        type: spec.type,
        url: spec.url,
        ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}),
        disabled: false,
      }
    }
  }
  return out
}

/**
 * Materialize MCP servers for the droid/Factory backend by merging them
 * into the project-scope `<cwd>/.factory/mcp.json`, which `droid exec`
 * discovers by cwd (verified against the CLI: config candidates include
 * `join(cwd, '.factory', 'mcp.json')`). This never touches the user's
 * `~/.factory/mcp.json`. cwd-native, so it shares pi's lock + no-follow
 * discipline via `mountCwdNativeMcp`. Returns null when no usable servers
 * remain.
 */
export function materializeMcpServersForFactory(
  specs: Record<string, McpServerSpec> | null,
  cwd: string,
): MaterializedMcpConfig | null {
  if (!specs) return null
  const mcpServers = buildFactoryMcpServers(specs)
  if (process.env.CLI_BRIDGE_DEBUG_MCP) {
    console.error(
      `[cli-bridge mcp factory] materialized servers: ${Object.keys(mcpServers).join(', ') || '(none)'} from specs: ${Object.keys(specs).join(', ') || '(empty)'}`,
    )
  }
  return mountCwdNativeMcp(cwd, { subdir: '.factory', filename: 'mcp.json', backendName: 'factory', mcpServers })
}

/**
 * Build the ACP `session/new` `mcpServers` param array from a normalized
 * spec map. ACP takes MCP servers INLINE as a JSON-RPC param (no temp
 * file). The schema (verified live against `hermes acp`, protocol v1)
 * differs from the config-file shapes:
 *   - remote:  `{type:'http'|'sse', name, url, headers:[{name,value}]}`
 *   - stdio:   `{name, command, args, env:[{name,value}]}`
 * Note `headers`/`env` are LISTS of `{name,value}` pairs, not objects.
 * Disabled/malformed entries are dropped.
 */
export function buildAcpMcpServers(specs: Record<string, McpServerSpec> | null): Array<Record<string, unknown>> {
  if (!specs) return []
  const pairs = (map: Record<string, string> | undefined): Array<{ name: string; value: string }> =>
    Object.entries(map ?? {}).map(([name, value]) => ({ name, value }))
  const out: Array<Record<string, unknown>> = []
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.enabled === false) continue
    if (isStdioMcpSpec(spec) && spec.command) {
      out.push({ name, command: spec.command, args: spec.args ?? [], env: pairs(spec.env) })
    } else if ((spec.type === 'http' || spec.type === 'sse') && spec.url) {
      out.push({ type: spec.type, name, url: spec.url, headers: pairs(spec.headers) })
    }
  }
  return out
}

/**
 * Same as `materializeMcpConfig` but writes opencode's schema —
 * `{mcp: {<name>: {type:'local', command:[...], environment:{...}, enabled, timeout}}}`
 * instead of claude/kimi's `{mcpServers: {<name>: {command, args, env}}}`.
 *
 * opencode-cli loads the file via the `OPENCODE_CONFIG` env var (which
 * cli-bridge's opencode backend sets when it spawns the CLI). The file
 * is layered on top of the user's global ~/.config/opencode/opencode.json,
 * so we only need to declare the MCP servers we want to add.
 *
 * Schema source: https://opencode.ai/config.json (`properties.mcp.additionalProperties`).
 */
export function materializeOpencodeMcpConfig(profile: AgentProfile | null): MaterializedMcpConfig {
  const specs: Record<string, McpServerSpec> = {}
  if (profile && typeof profile === 'object') {
    const mcp = (profile as { mcp?: Record<string, AgentProfileMcpServer> }).mcp
    if (mcp && typeof mcp === 'object') {
      for (const [name, raw] of Object.entries(mcp)) {
        if (!name || !raw || typeof raw !== 'object') continue
        specs[name] = profileMcpToSpec(raw, name)
      }
    }
  }
  const permissions =
    profile && typeof profile === 'object'
      ? (profile as { permissions?: Record<string, unknown> }).permissions
      : undefined
  const policy = profile?.metadata?.cliBridge as Record<string, unknown> | undefined
  const interactionPolicy = policy?.interactionPolicy === 'unattended-allow-v1' ? 'unattended-allow' : 'unattended-deny'
  return materializeMcpServersForOpencode(specs, permissions, interactionPolicy)
}

/**
 * Write opencode's schema —
 * `{mcp: {<name>: {type:'local', command:[...], environment:{...}, enabled, timeout}}}`
 * from a normalized `McpServerSpec` map. Layered on top of the user's
 * global `~/.config/opencode/opencode.json` via `OPENCODE_CONFIG`.
 *
 * Always returns a non-null result — opencode needs a config file even when
 * no MCP servers are declared so the permission posture is explicit.
 *
 * Schema source: https://opencode.ai/config.json
 *   (`properties.mcp.additionalProperties`).
 */
export function materializeMcpServersForOpencode(
  specs: Record<string, McpServerSpec> | null,
  callerPermissions?: Record<string, unknown> | null,
  interactionPolicy: 'interactive' | 'unattended-deny' | 'unattended-allow' = 'unattended-deny',
  parent: string = tmpdir(),
): MaterializedMcpConfig {
  const opencodeMcp: Record<
    string,
    | { type: 'local'; command: string[]; environment?: Record<string, string>; enabled?: boolean; timeout?: number }
    | { type: 'remote'; url: string; headers?: Record<string, string>; enabled?: boolean }
  > = {}
  if (specs) {
    for (const [name, spec] of Object.entries(specs)) {
      if (spec.enabled === false) continue
      if (isStdioMcpSpec(spec) && spec.command) {
        opencodeMcp[name] = {
          type: 'local',
          command: [spec.command, ...(spec.args ?? [])],
          ...(spec.env && Object.keys(spec.env).length ? { environment: spec.env } : {}),
          enabled: true,
          ...(spec.timeout ? { timeout: spec.timeout } : {}),
        }
      } else if ((spec.type === 'http' || spec.type === 'sse') && spec.url) {
        // opencode loads remote MCP via `{type:'remote', url, headers}`
        // (opencode.ai/config.json). Forward verbatim so an HTTP tool host
        // is reachable, mirroring the claude/kimi remote fix (cli-bridge#48).
        opencodeMcp[name] = {
          type: 'remote',
          url: spec.url,
          ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}),
          enabled: true,
        }
      }
      // unknown transport / missing required fields → drop
    }
  }
  if (process.env.CLI_BRIDGE_DEBUG_MCP) {
    console.error(`[cli-bridge mcp opencode] materialized: ${Object.keys(opencodeMcp).join(', ') || '(none)'}`)
  }
  const serverNames = Object.keys(opencodeMcp)

  const root = createPrivateTemporaryRoot(parent, 'cli-bridge-opencode-')
  const configPath = join(root.path, 'opencode.json')
  // Interactive and unattended-deny paths remain explicit. The only path that
  // writes `allow` is an explicit named profile policy, which the chat route
  // has already converted into an interaction-policy receipt.
  const defaultPermission =
    interactionPolicy === 'unattended-allow' ? 'allow' : interactionPolicy === 'interactive' ? 'ask' : 'deny'
  const permission: Record<string, 'allow' | 'ask' | 'deny'> = {
    external_directory: defaultPermission,
    bash: defaultPermission,
    edit: defaultPermission,
    read: defaultPermission,
    write: defaultPermission,
    webfetch: defaultPermission,
    task: defaultPermission,
    plan_enter: defaultPermission,
    plan_exit: defaultPermission,
    question: defaultPermission,
  }
  // The profile may narrow the posture. It may not silently widen an
  // interactive request into unattended execution.
  if (callerPermissions && typeof callerPermissions === 'object') {
    for (const [key, value] of Object.entries(callerPermissions)) {
      if (value === 'allow' || value === 'ask' || value === 'deny') {
        if (interactionPolicy !== 'unattended-allow' && value === 'allow') continue
        permission[key] = value
      }
    }
  }
  try {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          permission,
          mcp: opencodeMcp,
        },
        null,
        2,
      ),
      { mode: 0o600, flag: 'wx' },
    )
    return { configPath, serverNames, cleanup: root.cleanup }
  } catch (error) {
    root.cleanup()
    throw error
  }
}

export function materializeEmptyMcpConfig(parent: string = tmpdir()): MaterializedMcpConfig {
  const root = createPrivateTemporaryRoot(parent, 'cli-bridge-mcp-')
  try {
    const configPath = join(root.path, 'mcp-config.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2), { mode: 0o600, flag: 'wx' })
    return { configPath, serverNames: [], cleanup: root.cleanup }
  } catch (error) {
    root.cleanup()
    throw error
  }
}
