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
import { join, relative } from 'node:path'

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
  // codex is intentionally absent: codex.ts already points the spawned CLI at a
  // synthetic CODEX_HOME and copies auth.json there, so it self-preserves auth.
}

/** The HOME the spawned CLIs actually read, honoring a cli-bridge-set HOME
 * override (matches how the backends resolve config/auth at runtime). */
function backendHome(): string {
  return process.env.HOME?.trim() || homedir()
}

/** Absolute host auth paths for a backend that actually exist on this host. */
export function authSourcesFor(backendName: string): string[] {
  const home = backendHome()
  return (AUTH_PATHS[backendName] ?? [])
    .map((rel) => join(home, rel))
    .filter((abs) => existsSync(abs))
}

/** The path, inside the jail HOME, where an auth source must appear (its
 * location relative to the real HOME the CLI reads). */
export function jailRelPath(source: string): string {
  return relative(backendHome(), source)
}

/**
 * Copy each auth source into the jail HOME at its $HOME-relative path. Used on
 * macOS where sandbox-exec cannot bind-mount; the copy lands under the
 * (writable) jail root so the CLI can read its creds and write state. Returns
 * the copied destination paths so the caller can remove them on cleanup — the
 * jail root is project-local, so copied credentials must NOT linger there.
 */
export async function copyAuthIntoJail(root: string, sources: string[] | undefined): Promise<string[]> {
  const copied: string[] = []
  for (const source of sources ?? []) {
    if (!existsSync(source)) continue
    const dest = join(root, jailRelPath(source))
    await cp(source, dest, { recursive: true, force: true, errorOnExist: false })
    copied.push(dest)
  }
  return copied
}
