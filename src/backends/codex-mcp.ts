import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { McpServerSpec } from './types.js'
import { scopeCodexTurnConfig } from '../codex-config.js'

/**
 * A private CODEX_HOME preserves operator model/provider settings and replaces
 * ambient MCP/projects with this turn's MCP servers. The source is the resolved
 * operator auth home's config, never a request-supplied workspace path.
 * Host auth links retain native refresh; confined turns use access-only seeds.
 * Session cleanup retains native state; one-shot cleanup removes the home.
 */
export interface MaterializedCodexHome {
  /** Directory to pass via `CODEX_HOME` env. */
  homePath: string
  /** Names actually written. */
  serverNames: string[]
  cleanup(): void
}

export function materializeMcpServersForCodex(
  specs: Record<string, McpServerSpec> | null,
  authSourcePath?: string,
  sessionHome?: string,
): MaterializedCodexHome | null {
  if (!specs && !sessionHome) return null

  const { lines, serverNames } = codexMcpConfig(specs)
  if (serverNames.length === 0 && !sessionHome) return null
  const configPath = authSourcePath && join(dirname(authSourcePath), 'config.toml')
  const base = configPath && existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
  const config = scopeCodexTurnConfig(base, lines.join('\n\n') + '\n')

  // Codex aborts if CODEX_HOME is under the system tmpdir on some
  // platforms — use the user's HOME/.cache as a stable parent.
  const baseDir = sessionHome ?? mkdtempSync(join(stableTmpRoot(), 'cli-bridge-codex-'))
  // A session keeps native rollouts and indexes, never the previous turn's auth link.
  for (const name of ['config.toml', 'auth.json']) rmSync(join(baseDir, name), { force: true })
  writeFileSync(join(baseDir, 'config.toml'), config, { mode: 0o600 })

  if (authSourcePath) {
    try {
      if (existsSync(authSourcePath)) symlinkSync(resolve(authSourcePath), join(baseDir, 'auth.json'))
    } catch {
      // Best-effort: Codex without auth.json reports its own auth error.
    }
  }

  return {
    homePath: baseDir,
    serverNames,
    cleanup: () => {
      try {
        if (sessionHome) {
          for (const name of ['config.toml', 'auth.json']) rmSync(join(baseDir, name), { force: true })
        } else {
          rmSync(baseDir, { recursive: true, force: true })
        }
      } catch {
        // best-effort
      }
    },
  }
}

/** Docker Codex keeps its mounted auth home; write this MCP config through stdin. */
export function codexMcpConfigText(specs: Record<string, McpServerSpec> | null): string | null {
  const { lines, serverNames } = codexMcpConfig(specs)
  return serverNames.length ? `${lines.join('\n\n')}\n` : null
}

function codexMcpConfig(specs: Record<string, McpServerSpec> | null): {
  lines: string[]
  serverNames: string[]
} {
  const lines: string[] = []
  const serverNames: string[] = []
  for (const [name, spec] of Object.entries(specs ?? {})) {
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
  return { lines, serverNames }
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
      mkdirSync(cache, { recursive: true, mode: 0o700 })
      return cache
    } catch {
      // fallthrough
    }
  }
  return tmpdir()
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
