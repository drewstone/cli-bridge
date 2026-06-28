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

/** $HOME-relative auth/config paths per backend name. */
const AUTH_PATHS: Record<string, readonly string[]> = {
  claude: ['.claude', '.claude.json'],
  kimi: ['.kimi'],
  opencode: ['.config/opencode', '.local/share/opencode'],
  codex: ['.codex'],
  gemini: ['.gemini'],
}

/** Absolute host auth paths for a backend that actually exist on this host. */
export function authSourcesFor(backendName: string): string[] {
  const home = homedir()
  return (AUTH_PATHS[backendName] ?? [])
    .map((rel) => join(home, rel))
    .filter((abs) => existsSync(abs))
}

/** The path, inside the jail HOME, where an auth source must appear (its
 * location relative to the real HOME). */
export function jailRelPath(source: string): string {
  return relative(homedir(), source)
}

/** Copy each auth source into the jail HOME at its $HOME-relative path. Used
 * on macOS where sandbox-exec cannot bind-mount; the copy lands under the
 * (writable) jail root, so the CLI can both read its creds and write state. */
export async function copyAuthIntoJail(root: string, sources: string[] | undefined): Promise<void> {
  for (const source of sources ?? []) {
    if (!existsSync(source)) continue
    await cp(source, join(root, jailRelPath(source)), { recursive: true, force: true, errorOnExist: false })
  }
}
