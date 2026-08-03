import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServerSpec } from './types.js'
import { createPrivateTemporaryRoot } from '../runtime/private-temporary.js'

/**
 * Materialize a `McpServerSpec` map into a temp `CODEX_HOME` directory
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
  parent: string = stableTmpRoot(),
): MaterializedCodexHome | null {
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
  const root = createPrivateTemporaryRoot(parent, 'cli-bridge-codex-')
  try {
    writeFileSync(join(root.path, 'config.toml'), lines.join('\n\n') + '\n', { mode: 0o600, flag: 'wx' })

    if (authSourcePath) {
      try {
        const auth = readFileMaybe(authSourcePath)
        if (auth !== null) writeFileSync(join(root.path, 'auth.json'), auth, { mode: 0o600, flag: 'wx' })
      } catch {
        // Codex will report missing auth through its normal upstream error.
      }
    }
    return { homePath: root.path, serverNames, cleanup: root.cleanup }
  } catch (error) {
    root.cleanup()
    throw error
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
      mkdirSync(cache, { recursive: true, mode: 0o700 })
      const probe = mkdtempSync(join(cache, '.cli-bridge-write-probe-'))
      rmSync(probe, { recursive: true, force: true })
      return cache
    } catch {
      // fallthrough
    }
  }
  return tmpdir()
}

function readFileMaybe(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
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
