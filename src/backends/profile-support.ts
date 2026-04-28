import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProfile, AgentProfileMcpServer } from '@tangle-network/sandbox'
import type { ChatMessage, ChatRequest } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

export function resolveAgentProfile(req: ChatRequest, session: SessionRecord | null): AgentProfile | null {
  if (req.agent_profile && typeof req.agent_profile === 'object') return req.agent_profile
  const stored = session?.metadata?.agent_profile
  return stored && typeof stored === 'object' ? stored as AgentProfile : null
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

  const mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string>; timeout?: number }> = {}
  for (const [name, raw] of Object.entries(mcp)) {
    if (!name || !raw || typeof raw !== 'object') continue
    if (raw.enabled === false) continue
    if (!raw.command || typeof raw.command !== 'string') continue
    // `timeout` (ms) is the per-MCP-server tool-call timeout. Claude Code
    // honors this in mcp-config.json — its default is 300_000ms which
    // kills long-running tool calls (e.g. coordinators that block while
    // a subagent audit runs). Forward when supplied so callers don't
    // need to set MCP_TIMEOUT globally (which has known-silently-ignored
    // bugs upstream).
    const timeoutRaw = (raw as { timeout?: unknown }).timeout
    const timeout = typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : undefined
    mcpServers[name] = {
      command: raw.command,
      ...(Array.isArray(raw.args) ? { args: raw.args.filter((a) => typeof a === 'string') } : {}),
      ...(raw.env && typeof raw.env === 'object'
        ? {
            env: Object.fromEntries(
              Object.entries(raw.env).filter(([, v]) => typeof v === 'string'),
            ) as Record<string, string>,
          }
        : {}),
      ...(timeout ? { timeout } : {}),
    }
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
