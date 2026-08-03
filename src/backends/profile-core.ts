import { closeSync, constants as fsConstants, fchmodSync, ftruncateSync, openSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProfile, AgentProfileConfigValue, AgentProfileMcpServer } from '@tangle-network/agent-interface'
import type { ChatRequest, McpServerSpec } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import { createPrivateTemporaryRoot } from '../runtime/private-temporary.js'

export function resolveAgentProfile(req: ChatRequest, _session: SessionRecord | null): AgentProfile | null {
  if (req.agent_profile && typeof req.agent_profile === 'object') return req.agent_profile
  return null
}

/**
 * Merge request-body `mcp.mcpServers` and `agent_profile.mcp` into a
 * single normalized map keyed by server name. Request-body wins on
 * name collisions — caller's per-turn intent overrides profile
 * defaults.
 *
 * Returns `null` when neither source supplies any entries. Callers
 * that need a non-null result (e.g. opencode, which always writes a
 * config file) should default to `{}` after this returns null.
 *
 * The returned spec is the canonical `McpServerSpec` shape; backends
 * pick the fields they support and ignore the rest.
 */
export function resolveMcpServers(
  req: ChatRequest,
  session: SessionRecord | null,
): Record<string, McpServerSpec> | null {
  const merged: Record<string, McpServerSpec> = {}

  const profile = resolveAgentProfile(req, session)
  if (profile && typeof profile === 'object') {
    const profileMcp = (profile as { mcp?: Record<string, AgentProfileMcpServer> }).mcp
    if (profileMcp && typeof profileMcp === 'object') {
      const overriddenByRequest = new Set(Object.keys(req.mcp?.mcpServers ?? {}))
      for (const [name, raw] of Object.entries(profileMcp)) {
        if (!name || !raw || typeof raw !== 'object') continue
        // An entry the request replaces below, and an entry explicitly disabled, are both dropped
        // before anything reads them. Converting them anyway would let a value nobody uses turn a
        // working request into a hard 400 — the validation must follow the value into use, not
        // stand in front of entries that never get there.
        if (overriddenByRequest.has(name)) continue
        if ((raw as { enabled?: unknown }).enabled === false) continue
        merged[name] = profileMcpToSpec(raw, name)
      }
    }
  }

  const requestMcp = req.mcp?.mcpServers
  if (requestMcp && typeof requestMcp === 'object') {
    for (const [name, raw] of Object.entries(requestMcp)) {
      if (!name || !raw || typeof raw !== 'object') continue
      merged[name] = normalizeMcpServerSpec(raw, name)
    }
  }

  return Object.keys(merged).length > 0 ? merged : null
}

/**
 * Read one `AgentProfileMcpServer` configuration value as the plain string an MCP config file or a
 * server spawn needs.
 *
 * Interface 0.40 retyped `args`/`env`/`headers` from `string` to `AgentProfileConfigValue` — public
 * bytes (`{kind:'public', value}`) or an opaque `{kind:'secret-ref', key}` a private executor
 * resolves. cli-bridge is not that executor: every one of these values ends up in an on-disk MCP
 * config the harness reads (`writeMcpConfigFile`, `materializeMcpServersForPi`,
 * `materializeMcpServersForOpencode`, …), and cli-bridge has no `AgentProfileSecretProvider` to
 * resolve a reference with. So a reference is REFUSED here rather than resolved or rendered:
 * writing the reference object is nonsense to the harness, and writing a placeholder turns an auth
 * failure into what looks like a broken tool. The refusal names the reference KEY, never a value.
 *
 * `args` is refused for a second, stronger reason: those strings become the MCP server's argv,
 * which is readable by every process on the host (`/proc/<pid>/cmdline`) and lies outside every
 * redaction channel. agent-runtime's `resolveMcpServerLaunch` refuses a secret-ref in argv even
 * when it DOES hold a provider; a secret belongs in `env`, never in a command line.
 *
 * Plain `string`/`number`/`boolean` are accepted, matching agent-runtime's `publicConfigString`
 * (`src/runtime/supervise/pi-mcp.ts`): hand-written JSON profiles authored before 0.40 commonly
 * carry those where the type now says `{kind:'public'}`, and rejecting them would break every
 * caller mid-migration for no safety gain.
 */
function publicMcpConfigString(value: unknown, where: string): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value && typeof value === 'object') {
    const config = value as AgentProfileConfigValue
    if (config.kind === 'public' && typeof config.value === 'string') return config.value
    if (config.kind === 'secret-ref') {
      throw new BackendError(
        `AgentProfile ${where} is a secret-ref (${JSON.stringify(config.key)}) and cli-bridge has ` +
          'no secret provider — resolve it before the request, or declare a public value',
        'parse_error',
      )
    }
  }
  throw new BackendError(`AgentProfile ${where} is not a public configuration value`, 'parse_error')
}

/** Every entry of an MCP `env`/`headers` map as public strings. */
function publicMcpConfigRecord(
  record: Record<string, AgentProfileConfigValue> | undefined,
  where: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!record || typeof record !== 'object') return out
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue
    out[key] = publicMcpConfigString(value, `${where}[${JSON.stringify(key)}]`)
  }
  return out
}

export function profileMcpToSpec(raw: AgentProfileMcpServer, name: string): McpServerSpec {
  // AgentProfileMcpServer uses `transport`; McpServerSpec uses `type`.
  // Rename and forward only the fields we model.
  const where = `mcp[${JSON.stringify(name)}]`
  const out: McpServerSpec = {}
  if (raw.transport) out.type = raw.transport
  if (typeof raw.command === 'string') out.command = raw.command
  if (Array.isArray(raw.args)) {
    out.args = raw.args.map((arg, index) => publicMcpConfigString(arg, `${where}.args[${index}]`))
  }
  if (raw.env && typeof raw.env === 'object') {
    out.env = publicMcpConfigRecord(raw.env, `${where}.env`)
  }
  if (typeof raw.url === 'string') out.url = raw.url
  if (raw.headers && typeof raw.headers === 'object') {
    out.headers = publicMcpConfigRecord(raw.headers, `${where}.headers`)
  }
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  const timeoutRaw = (raw as { timeout?: unknown }).timeout
  if (typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw > 0) {
    out.timeout = timeoutRaw
  }
  return out
}

function normalizeMcpServerSpec(raw: McpServerSpec | Record<string, unknown>, name: string): McpServerSpec {
  // Defensive copy — drop any unknown fields, coerce types loosely.
  const r = raw as Record<string, unknown>
  const out: McpServerSpec = {}
  if (r.type === 'stdio' || r.type === 'http' || r.type === 'sse') out.type = r.type
  if (typeof r.command === 'string') out.command = r.command
  // A request-body server WINS over a profile server of the same name, so this path decides the
  // bytes that reach argv and the on-disk MCP config. It used to drop every non-string silently,
  // which turned a secret-ref in `args` into a SHORTER command line and a server that spawned
  // wrong for a reason nothing reported. Same refusal as the profile path, same reason.
  const where = `mcp.mcpServers[${JSON.stringify(name)}]`
  if (Array.isArray(r.args)) {
    out.args = (r.args as unknown[]).map((a, i) => publicMcpConfigString(a, `${where}.args[${i}]`))
  }
  if (r.env && typeof r.env === 'object') {
    out.env = publicMcpConfigRecord(r.env as Record<string, AgentProfileConfigValue>, `${where}.env`)
  }
  if (typeof r.url === 'string') out.url = r.url
  if (r.headers && typeof r.headers === 'object') {
    out.headers = publicMcpConfigRecord(r.headers as Record<string, AgentProfileConfigValue>, `${where}.headers`)
  }
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  if (typeof r.timeout === 'number' && Number.isFinite(r.timeout) && r.timeout > 0) {
    out.timeout = r.timeout
  }
  return out
}

/**
 * True when this spec describes a local stdio MCP server. cli-bridge's
 * MCP-enabled CLI backends load stdio MCP via their config-file
 * loaders; remote http/sse MCP needs a per-backend registration path
 * that we don't model in the unified materializers.
 */
export function isStdioMcpSpec(spec: McpServerSpec): boolean {
  if (spec.enabled === false) return false
  if (spec.type === 'stdio') return Boolean(spec.command)
  if (spec.type === 'http' || spec.type === 'sse') return false
  return Boolean(spec.command)
}

/**
 * Materialize an `AgentProfile.mcp` map into a temp JSON file in the
 * standard mcp-config.json shape (any CLI taking --mcp-config-file):
 *
 *   { "mcpServers": { name: {command, args, env}, ... } }
 *
 * Returns `null` when the profile has no enabled MCP servers — backends
 * should skip the `--mcp-config` flag in that case rather than passing
 * an empty config.
 *
 * Caller MUST invoke `cleanup()` after the subprocess exits (typically
 * in a `finally` block) so the temp dir doesn't leak.
 *
 * Honours `AgentProfileMcpServer.enabled` — entries explicitly disabled
 * are dropped. Entries without a `command` (e.g., remote http/sse
 * transports) are also dropped here because the local CLIs only support
 * stdio MCP servers via `--mcp-config`. Remote MCP servers would need a
 * separate registration path (claude has `claude mcp add --transport
 * http`) which we don't model in this materializer.
 */
export interface MaterializedMcpConfig {
  configPath: string
  serverNames: string[]
  cleanup(): void
}

export function materializeMcpConfig(profile: AgentProfile | null): MaterializedMcpConfig | null {
  if (!profile || typeof profile !== 'object') return null
  const mcp = (profile as { mcp?: Record<string, AgentProfileMcpServer> }).mcp
  if (!mcp || typeof mcp !== 'object') return null
  const specs: Record<string, McpServerSpec> = {}
  for (const [name, raw] of Object.entries(mcp)) {
    if (!name || !raw || typeof raw !== 'object') continue
    specs[name] = profileMcpToSpec(raw, name)
  }
  return writeMcpConfigFile(specs)
}

/**
 * Write the canonical claude/kimi `mcp-config.json` shape from a
 * normalized `McpServerSpec` map. Filters out disabled entries.
 *
 * Both stdio and remote (http/sse) transports are emitted: Claude Code's
 * `--mcp-config` JSON natively accepts `{type:'http'|'sse', url, headers}`
 * entries alongside stdio `{command, args, env}` ones (mcp-config.json
 * schema), so a remote MCP server (e.g. an HTTP tool host the caller runs)
 * is forwarded as-is rather than silently dropped. (Earlier this path was
 * stdio-only on the mistaken assumption that claude couldn't load remote
 * servers from the config file — it can.)
 *
 * `timeout` (ms) is the per-MCP-server tool-call timeout. Claude Code
 * honors this in mcp-config.json — its default is 300_000ms which
 * kills long-running tool calls (e.g. coordinators that block while a
 * subagent audit runs). Forward when supplied so callers don't need
 * to set MCP_TIMEOUT globally (which has known-silently-ignored bugs
 * upstream).
 *
 * Returns null when no usable entries remain — backends should skip
 * the `--mcp-config` flag in that case rather than passing an empty
 * config.
 */
/**
 * Build the canonical `mcpServers` object from a normalized spec map:
 * stdio entries as `{command, args, env, timeout}`, remote http/sse
 * entries as `{type, url, headers, timeout}`. Disabled and malformed
 * entries are dropped. Shared by the claude/kimi temp-file materializer
 * and the pi workspace materializer (pi-mcp-adapter reads the same
 * `{mcpServers}` shape from `.mcp.json` / `.pi/mcp.json`).
 */
export function buildCanonicalMcpServers(
  specs: Record<string, McpServerSpec>,
): Record<string, Record<string, unknown>> {
  const mcpServers: Record<string, Record<string, unknown>> = {}
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.enabled === false) continue
    if (isStdioMcpSpec(spec) && spec.command) {
      mcpServers[name] = {
        command: spec.command,
        ...(spec.args && spec.args.length ? { args: spec.args } : {}),
        ...(spec.env && Object.keys(spec.env).length ? { env: spec.env } : {}),
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
      }
    } else if ((spec.type === 'http' || spec.type === 'sse') && spec.url) {
      // Remote MCP server — Claude Code loads these from --mcp-config
      // natively. Forward type/url/headers/timeout verbatim.
      mcpServers[name] = {
        type: spec.type,
        url: spec.url,
        ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}),
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
      }
    }
    // unknown transport / missing required fields → drop silently
  }
  return mcpServers
}

export function writeMcpConfigFile(
  specs: Record<string, McpServerSpec> | null,
  parent: string = tmpdir(),
): MaterializedMcpConfig | null {
  if (!specs) return null
  const mcpServers = buildCanonicalMcpServers(specs)
  const serverNames = Object.keys(mcpServers)
  if (process.env.CLI_BRIDGE_DEBUG_MCP) {
    console.error(
      `[cli-bridge mcp] materialized servers: ${serverNames.length ? serverNames.join(', ') : '(none)'} from specs: ${Object.keys(specs).join(', ') || '(empty)'}`,
    )
  }
  if (serverNames.length === 0) return null

  const root = createPrivateTemporaryRoot(parent, 'cli-bridge-mcp-')
  try {
    const configPath = join(root.path, 'mcp-config.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600, flag: 'wx' })
    return { configPath, serverNames, cleanup: root.cleanup }
  } catch (error) {
    root.cleanup()
    throw error
  }
}

/** Write a cwd-native config without following a planted final-component symlink. */
export function writeFileNoFollow(path: string, bytes: string, mode = 0o600): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
  try {
    fchmodSync(fd, mode)
    ftruncateSync(fd, 0)
    writeFileSync(fd, bytes)
  } finally {
    closeSync(fd)
  }
}
