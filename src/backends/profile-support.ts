import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProfile, AgentProfileMcpServer } from '@tangle-network/sandbox'
import type { ChatMessage, ChatRequest, McpServerSpec } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

export function resolveAgentProfile(req: ChatRequest, session: SessionRecord | null): AgentProfile | null {
  if (req.agent_profile && typeof req.agent_profile === 'object') return req.agent_profile
  const stored = session?.metadata?.agent_profile
  return stored && typeof stored === 'object' ? stored as AgentProfile : null
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
      for (const [name, raw] of Object.entries(profileMcp)) {
        if (!name || !raw || typeof raw !== 'object') continue
        merged[name] = profileMcpToSpec(raw)
      }
    }
  }

  const requestMcp = req.mcp?.mcpServers
  if (requestMcp && typeof requestMcp === 'object') {
    for (const [name, raw] of Object.entries(requestMcp)) {
      if (!name || !raw || typeof raw !== 'object') continue
      merged[name] = normaliseMcpServerSpec(raw)
    }
  }

  return Object.keys(merged).length > 0 ? merged : null
}

function profileMcpToSpec(raw: AgentProfileMcpServer): McpServerSpec {
  // AgentProfileMcpServer uses `transport`; McpServerSpec uses `type`.
  // Rename and forward only the fields we model.
  const out: McpServerSpec = {}
  if (raw.transport) out.type = raw.transport
  if (typeof raw.command === 'string') out.command = raw.command
  if (Array.isArray(raw.args)) out.args = raw.args.filter((a): a is string => typeof a === 'string')
  if (raw.env && typeof raw.env === 'object') {
    out.env = Object.fromEntries(
      Object.entries(raw.env).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>
  }
  if (typeof raw.url === 'string') out.url = raw.url
  if (raw.headers && typeof raw.headers === 'object') {
    out.headers = Object.fromEntries(
      Object.entries(raw.headers).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>
  }
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  const timeoutRaw = (raw as { timeout?: unknown }).timeout
  if (typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw > 0) {
    out.timeout = timeoutRaw
  }
  return out
}

function normaliseMcpServerSpec(raw: McpServerSpec | Record<string, unknown>): McpServerSpec {
  // Defensive copy — drop any unknown fields, coerce types loosely.
  const r = raw as Record<string, unknown>
  const out: McpServerSpec = {}
  if (r.type === 'stdio' || r.type === 'http' || r.type === 'sse') out.type = r.type
  if (typeof r.command === 'string') out.command = r.command
  if (Array.isArray(r.args)) out.args = (r.args as unknown[]).filter((a): a is string => typeof a === 'string')
  if (r.env && typeof r.env === 'object') {
    out.env = Object.fromEntries(
      Object.entries(r.env as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>
  }
  if (typeof r.url === 'string') out.url = r.url
  if (r.headers && typeof r.headers === 'object') {
    out.headers = Object.fromEntries(
      Object.entries(r.headers as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>
  }
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  if (typeof r.timeout === 'number' && Number.isFinite(r.timeout) && r.timeout > 0) {
    out.timeout = r.timeout
  }
  return out
}

/**
 * True when this spec describes a local stdio MCP server. cli-bridge's
 * three primary backends (claude, kimi, opencode) load stdio MCP via
 * their config-file loaders; remote http/sse MCP needs a per-backend
 * registration path that we don't model in the unified materialisers.
 */
export function isStdioMcpSpec(spec: McpServerSpec): boolean {
  if (spec.enabled === false) return false
  if (spec.type === 'stdio') return Boolean(spec.command)
  if (spec.type === 'http' || spec.type === 'sse') return false
  return Boolean(spec.command)
}

/**
 * Materialise an `AgentProfile.mcp` map into a temp JSON file in the
 * canonical claude/kimi mcp-config shape:
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
 * http`) which we don't model in this materialiser.
 */
export interface MaterialisedMcpConfig {
  configPath: string
  serverNames: string[]
  cleanup(): void
}

export function materialiseMcpConfig(profile: AgentProfile | null): MaterialisedMcpConfig | null {
  if (!profile || typeof profile !== 'object') return null
  const mcp = (profile as { mcp?: Record<string, AgentProfileMcpServer> }).mcp
  if (!mcp || typeof mcp !== 'object') return null
  const specs: Record<string, McpServerSpec> = {}
  for (const [name, raw] of Object.entries(mcp)) {
    if (!name || !raw || typeof raw !== 'object') continue
    specs[name] = profileMcpToSpec(raw)
  }
  return materialiseMcpServersForClaudeKimi(specs)
}

/**
 * Write the canonical claude/kimi `mcp-config.json` shape from a
 * normalized `McpServerSpec` map. Filters out disabled and non-stdio
 * entries — claude `--mcp-config` and kimi `--mcp-config-file` both
 * speak the same `{mcpServers: {name: {command, args, env, timeout}}}`
 * schema and neither natively loads remote http/sse via this file
 * path.
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
export function materialiseMcpServersForClaudeKimi(
  specs: Record<string, McpServerSpec> | null,
): MaterialisedMcpConfig | null {
  if (!specs) return null
  // claude-code accepts three transports in --mcp-config:
  //   stdio: { command, args, env, timeout }
  //   http:  { type: "http", url, headers }
  //   sse:   { type: "sse",  url, headers }
  // Materialise whichever applies per server. kimi-code reads the same
  // file shape (claude-code-derived) so this helper is shared.
  const mcpServers: Record<string, Record<string, unknown>> = {}
  for (const [name, spec] of Object.entries(specs)) {
    if (isStdioMcpSpec(spec) && spec.command) {
      mcpServers[name] = {
        command: spec.command,
        ...(spec.args && spec.args.length ? { args: spec.args } : {}),
        ...(spec.env && Object.keys(spec.env).length ? { env: spec.env } : {}),
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
      }
    } else if ((spec.type === 'http' || spec.type === 'sse') && typeof spec.url === 'string' && spec.url.length > 0) {
      mcpServers[name] = {
        type: spec.type,
        url: spec.url,
        ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}),
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
      }
    }
    // unknown transport / missing required fields → drop silently
  }
  const serverNames = Object.keys(mcpServers)
  if (serverNames.length === 0) return null

  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-mcp-'))
  const configPath = join(dir, 'mcp-config.json')
  writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2))
  return {
    configPath,
    serverNames,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    },
  }
}

/**
 * Same as `materialiseMcpConfig` but writes opencode's schema —
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
export function materialiseOpencodeMcpConfig(profile: AgentProfile | null): MaterialisedMcpConfig {
  const specs: Record<string, McpServerSpec> = {}
  if (profile && typeof profile === 'object') {
    const mcp = (profile as { mcp?: Record<string, AgentProfileMcpServer> }).mcp
    if (mcp && typeof mcp === 'object') {
      for (const [name, raw] of Object.entries(mcp)) {
        if (!name || !raw || typeof raw !== 'object') continue
        specs[name] = profileMcpToSpec(raw)
      }
    }
  }
  return materialiseMcpServersForOpencode(specs)
}

/**
 * Write opencode's schema —
 * `{mcp: {<name>: {type:'local', command:[...], environment:{...}, enabled, timeout}}}`
 * from a normalized `McpServerSpec` map. Layered on top of the user's
 * global `~/.config/opencode/opencode.json` via `OPENCODE_CONFIG`.
 *
 * Always returns a non-null result — opencode needs a config file
 * even when no MCP servers are declared (so the headless permission
 * map below can disable interactive prompts).
 *
 * Schema source: https://opencode.ai/config.json
 *   (`properties.mcp.additionalProperties`).
 */
export function materialiseMcpServersForOpencode(
  specs: Record<string, McpServerSpec> | null,
): MaterialisedMcpConfig {
  const opencodeMcp: Record<string, {
    type: 'local'
    command: string[]
    environment?: Record<string, string>
    enabled?: boolean
    timeout?: number
  }> = {}
  if (specs) {
    for (const [name, spec] of Object.entries(specs)) {
      if (!isStdioMcpSpec(spec)) continue
      if (!spec.command) continue
      const command: string[] = [spec.command, ...(spec.args ?? [])]
      opencodeMcp[name] = {
        type: 'local',
        command,
        ...(spec.env && Object.keys(spec.env).length ? { environment: spec.env } : {}),
        enabled: true,
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
      }
    }
  }
  const serverNames = Object.keys(opencodeMcp)

  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-opencode-'))
  const configPath = join(dir, 'opencode.json')
  // Headless benchmark and automation runs must never block on an
  // interactive permission prompt.
  const headlessPermission: Record<string, 'allow' | 'ask' | 'deny'> = {
    external_directory: 'allow',
    bash: 'allow',
    edit: 'allow',
    read: 'allow',
    write: 'allow',
    webfetch: 'allow',
    task: 'allow',
    plan_enter: 'allow',
    plan_exit: 'allow',
    question: 'allow',
  }
  writeFileSync(configPath, JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    permission: headlessPermission,
    mcp: opencodeMcp,
  }, null, 2))
  return {
    configPath,
    serverNames,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    },
  }
}

export function materialiseEmptyMcpConfig(): MaterialisedMcpConfig {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-mcp-'))
  const configPath = join(dir, 'mcp-config.json')
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2))
  return {
    configPath,
    serverNames: [],
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    },
  }
}

/**
 * Materialise a `McpServerSpec` map into a temp `CODEX_HOME` directory
 * containing a synthetic `config.toml`. Codex CLI accepts MCP servers
 * via the `[mcp_servers.<name>]` TOML stanza in `$CODEX_HOME/config.toml`
 * — there is no `--mcp-config` flag. We point codex at a temp HOME so
 * the passthrough is per-invocation and never mutates the user's real
 * `~/.codex/config.toml`.
 *
 * `authSourcePath` is the path to the user's persistent `auth.json`
 * (default `~/.codex/auth.json`). Codex looks up the session's bearer
 * token here. We copy it into the temp dir so the spawned codex still
 * authenticates as the operator. The copy is deleted at cleanup.
 *
 * stdio servers — written as `command = "..."` + optional `args`/`env`.
 * http servers (spec.type === 'http' with `url`) — written as
 * `url = "..."` + optional `headers`/`bearer_token_env_var`.
 *
 * Returns null when no usable servers remain.
 */
export interface MaterialisedCodexHome {
  /** Directory to pass via `CODEX_HOME` env. */
  homePath: string
  /** Names actually written. */
  serverNames: string[]
  cleanup(): void
}

export function materialiseMcpServersForCodex(
  specs: Record<string, McpServerSpec> | null,
  authSourcePath?: string,
): MaterialisedCodexHome | null {
  if (!specs) return null

  const lines: string[] = []
  const serverNames: string[] = []
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.enabled === false) continue
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      // Codex's TOML table key parser is strict; skip names that would
      // require quoting and could collide with other config keys.
      continue
    }
    const block: string[] = [`[mcp_servers.${name}]`]
    if (spec.type === 'http' || (spec.url && spec.type !== 'sse' && !spec.command)) {
      if (!spec.url) continue
      block.push(`url = ${tomlString(spec.url)}`)
      if (spec.headers && Object.keys(spec.headers).length) {
        block.push(`http_headers = ${tomlInlineTable(spec.headers)}`)
      }
      // codex tool-call timeout key — verified against `codex mcp get`
      // round-trip. Other names (`tool_timeout_ms`, `request_timeout_ms`)
      // are silently dropped by the parser.
      if (spec.timeout) block.push(`tool_timeout_sec = ${Math.max(1, Math.round(spec.timeout / 1000))}`)
    } else {
      if (!spec.command) continue
      block.push(`command = ${tomlString(spec.command)}`)
      if (spec.args && spec.args.length) {
        block.push(`args = ${tomlStringArray(spec.args)}`)
      }
      if (spec.env && Object.keys(spec.env).length) {
        block.push(`env = ${tomlInlineTable(spec.env)}`)
      }
      // codex stdio servers use `tool_timeout_sec` for per-call and
      // `startup_timeout_sec` for the launch handshake. We map a
      // single caller-provided `timeout` to BOTH so generous values
      // unblock long-running tools without separately requiring the
      // caller to fiddle with handshake timing.
      if (spec.timeout) {
        const secs = Math.max(1, Math.round(spec.timeout / 1000))
        block.push(`tool_timeout_sec = ${secs}`)
        block.push(`startup_timeout_sec = ${secs}`)
      }
    }
    lines.push(block.join('\n'))
    serverNames.push(name)
  }
  if (serverNames.length === 0) return null

  // Codex aborts if CODEX_HOME is under the system tmpdir on some
  // platforms — use the user's HOME/.cache as a stable parent.
  const baseDir = mkdtempSync(join(stableTmpRoot(), 'cli-bridge-codex-'))
  writeFileSync(join(baseDir, 'config.toml'), lines.join('\n\n') + '\n')

  if (authSourcePath) {
    try {
      const auth = readFileMaybe(authSourcePath)
      if (auth !== null) writeFileSync(join(baseDir, 'auth.json'), auth)
    } catch {
      // Best-effort: codex without auth.json will fail to call the
      // model. Surface that as an upstream error from the backend
      // rather than silently swallowing it here.
    }
  }

  return {
    homePath: baseDir,
    serverNames,
    cleanup: () => {
      try {
        rmSync(baseDir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    },
  }
}

function stableTmpRoot(): string {
  // Prefer ~/.cache so codex's "not in /tmp" guard doesn't trip.
  // `tmpdir()` (typically /tmp) is the documented fallback. The
  // function is sync because the call sites are sync; HOME is always
  // set on supported platforms.
  const home = process.env.HOME
  if (home) {
    try {
      const cache = join(home, '.cache')
      // Don't mkdir — cli-bridge runs on hosts that always have
      // ~/.cache (we don't ship a polyfill for first-boot Linux).
      return cache
    } catch {
      // fallthrough
    }
  }
  return tmpdir()
}

function readFileMaybe(path: string): string | null {
  try {
    // Avoid bringing in another import; lazy-require via dynamic globals.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs')
    return fs.readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

function tomlString(s: string): string {
  // Use TOML's basic string with conservative escaping. Codex's TOML
  // parser handles `\"`, `\\`, `\n`, `\t` — escape the dangerous set
  // and trust UTF-8 for the rest.
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

function tomlStringArray(items: string[]): string {
  return `[${items.map(tomlString).join(', ')}]`
}

function tomlInlineTable(map: Record<string, string>): string {
  const entries = Object.entries(map).map(([k, v]) => {
    const key = /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)
    return `${key} = ${tomlString(v)}`
  })
  return `{ ${entries.join(', ')} }`
}

/**
 * Build the `--allowedTools` CSV that auto-allows every tool exposed by
 * the named MCP servers. Without this, claude's permission system will
 * prompt on first use of each MCP tool, which hangs in non-interactive
 * mode (`-p` print mode). Caller decides whether to actually pass the
 * resulting flag — hosted-safe mode usually wants to keep MCP tools
 * gated rather than auto-allow them.
 *
 * Format follows claude's tool spec: `mcp__<server>` allows ALL tools
 * exposed by that server. Per-tool grants would be `mcp__<server>__<tool>`.
 */
export function buildMcpAllowList(serverNames: string[]): string {
  return serverNames.map((n) => `mcp__${n}`).join(',')
}

export function resolvePromptMessages(req: ChatRequest, session: SessionRecord | null): ChatMessage[] {
  const preamble = renderLocalHarnessProfilePreamble(resolveAgentProfile(req, session))
  if (!preamble) return req.messages
  return [{ role: 'system', content: preamble }, ...req.messages]
}

export function renderLocalHarnessProfilePreamble(profile: AgentProfile | null): string | null {
  if (!profile || typeof profile !== 'object') return null
  const sections: string[] = []

  const systemPrompt = pickString(
    (profile as Record<string, unknown>).systemPrompt,
    ((profile as Record<string, unknown>).prompt as Record<string, unknown> | undefined)?.systemPrompt,
  )
  if (systemPrompt) sections.push(systemPrompt)

  const skills = pickStringArray((profile as Record<string, unknown>).skills)
  if (skills.length) {
    sections.push(`Caller-declared skills for this session: ${skills.join(', ')}`)
  }

  const mcpServers = pickNamedEntries((profile as Record<string, unknown>).mcpServers)
  if (mcpServers.length) {
    sections.push(`Caller-declared MCP servers for this session: ${mcpServers.join(', ')}`)
  }

  const resources = pickNamedEntries((profile as Record<string, unknown>).resources)
  if (resources.length) {
    sections.push(`Caller-declared resources for this session: ${resources.join(', ')}`)
  }

  const permissionSummary = renderPermissions((profile as Record<string, unknown>).permissions)
  if (permissionSummary) {
    sections.push(`Requested permission posture: ${permissionSummary}`)
  }

  return sections.length ? sections.join('\n\n') : null
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function pickStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function pickNamedEntries(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === 'string' && item.trim()) return [item]
      if (item && typeof item === 'object') {
        const name = (item as Record<string, unknown>).name
        if (typeof name === 'string' && name.trim()) return [name]
      }
      return []
    })
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).filter(Boolean)
  }
  return []
}

function renderPermissions(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string' && v)
    .map(([k, v]) => `${k}=${v}`)
  return entries.length ? entries.join(', ') : null
}
