/**
 * Per-backend auth preservation for the write-jail.
 *
 * A jailed run sets HOME to the (empty) jail root, so a CLI would no longer
 * find the operator's credentials at ~/.claude, ~/.config/opencode, etc. and
 * could not authenticate. This module declares, per backend, the host paths
 * that hold its auth/config and makes them available inside the jail at the
 * same $HOME-relative location:
 *   - Linux (bwrap): read-only bind-mounted (free, no copy) — see linux-bwrap.
 *   - macOS (sandbox-exec, no bind): copied in via {@link copyAuthIntoJail}.
 *
 * Only paths that actually exist on the host are surfaced. The mapping mirrors
 * what codex.ts already does for CODEX_HOME, generalized to every host CLI.
 */

import { existsSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { JailAuthSource } from './types.js'

/**
 * $HOME-relative auth/config paths per REGISTERED backend name. Aliases that
 * share the same on-disk credentials are listed explicitly (claude-code /
 * claudish / claude all read ~/.claude; kimi-code / kimi read ~/.kimi) rather
 * than fuzzy-matched, so the credential mapping is exact and auditable.
 */
const AUTH_PATHS: Record<string, readonly string[]> = {
  'claude-code': ['.claude', '.claude.json'],
  claudish: ['.claude', '.claude.json'],
  claude: ['.claude', '.claude.json'],
  'kimi-code': ['.kimi'],
  kimi: ['.kimi'],
  opencode: ['.config/opencode', '.local/share/opencode'],
  gemini: ['.gemini'],
  // codex.ts only synthesizes a CODEX_HOME (with copied auth) when MCP passthrough
  // is active; in the common no-MCP case it reads ~/.codex, which the jail would
  // otherwise hide. Preserve it here so jailed codex authenticates either way.
  codex: ['.codex'],
}

/** The HOME the spawned CLIs actually read, honoring a cli-bridge-set HOME
 * override (matches how the backends resolve config/auth at runtime). */
function backendHome(): string {
  return process.env.HOME?.trim() || homedir()
}

/** Auth sources for a backend that actually exist on this host, each mapped to
 * the jail-relative location the confined CLI reads. */
export function authSourcesFor(backendName: string): JailAuthSource[] {
  const home = backendHome()
  const out: JailAuthSource[] = []
  for (const rel of AUTH_PATHS[backendName] ?? []) {
    const source = join(home, rel)
    // rel is already a POSIX-style jail-relative target ('.claude', '.config/opencode').
    if (existsSync(source)) out.push({ source, jailRel: rel })
  }
  if (backendName === 'codex') {
    // codex.ts honors $CODEX_HOME (src/backends/codex.ts) and only falls back to
    // ~/.codex when it is unset. Mirror that: when CODEX_HOME points elsewhere,
    // surface THAT directory at the jail's ~/.codex (where a confined codex with
    // HOME=root looks), replacing the default entry rather than copying the wrong
    // creds. Without this, a custom-CODEX_HOME install loses its auth in the jail.
    const codexHome = process.env.CODEX_HOME?.trim()
    if (codexHome) {
      const source = resolve(codexHome)
      const idx = out.findIndex((e) => e.jailRel === '.codex')
      if (idx >= 0) out.splice(idx, 1)
      if (existsSync(source)) out.push({ source, jailRel: '.codex' })
    }
  }
  return out
}

/**
 * Copy each auth source into the jail HOME at its $HOME-relative path. Used on
 * macOS where sandbox-exec cannot bind-mount; the copy lands under the
 * (writable) jail root so the CLI can read its creds and write state. Returns
 * the copied destination paths so the caller can remove them on cleanup — the
 * jail root is project-local, so copied credentials must NOT linger there.
 */
export async function copyAuthIntoJail(root: string, sources: JailAuthSource[] | undefined): Promise<string[]> {
  const copied: string[] = []
  for (const { source, jailRel } of sources ?? []) {
    if (!existsSync(source)) continue
    const dest = join(root, jailRel)
    await cp(source, dest, { recursive: true, force: true, errorOnExist: false })
    copied.push(dest)
  }
  return copied
}
