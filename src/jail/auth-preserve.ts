/**
 * Per-backend auth preservation for the write-jail.
 *
 * A jailed run sets HOME to the (empty) jail root, so a CLI would no longer
 * find the operator's credentials at ~/.claude, ~/.config/opencode, etc. and
 * could not authenticate. This module declares, per backend, the host paths
 * that hold its auth/config and makes them available inside the jail:
 *   - Linux (bwrap): read-only bind-mounted unless the CLI must lock settings;
 *     those exact sources are copied into writable jail storage.
 *   - macOS (sandbox-exec, no bind): copied in via {@link copyAuthIntoJail}.
 *
 * Only paths that actually exist on the host are surfaced. The mapping mirrors
 * what codex.ts already does for CODEX_HOME, generalized to every host CLI.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveJailRoot, type JailAuthSource } from './types.js'

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
  // pi keeps provider registrations / model defaults in ~/.pi/agent (the same
  // dir config.ts mounts into pi's docker containers). Without it a jailed pi
  // run starts from an empty HOME and loses every persisted provider/default.
  pi: ['.pi/agent'],
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
    if (existsSync(source)) out.push({ source, jailRel: rel, mode: 'read-only' })
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
      if (existsSync(source)) {
        out.push({ source, jailRel: '.codex', mode: 'read-only' })
      }
    }
    // Redirect CODEX_HOME at the in-jail copy so a confined codex reads creds
    // there rather than the (read-only) host path. The jail applies this only
    // when it actually wraps — docker/fallback runs keep the host CODEX_HOME.
    for (const e of out) if (e.jailRel === '.codex') e.envVar = 'CODEX_HOME'
  }
  if (backendName === 'pi') {
    const writableAgentRel = `.auth-copies/pi-${randomUUID()}`
    // Mirror CODEX_HOME: a custom Pi directory is the real provider catalog,
    // not an alias for ~/.pi/agent. Surface that exact source at a request-
    // unique in-jail location, then redirect the child-only env var to it.
    const piAgentDir = process.env.PI_CODING_AGENT_DIR?.trim()
    if (piAgentDir) {
      const source = resolve(piAgentDir)
      const idx = out.findIndex((e) => e.jailRel === '.pi/agent')
      if (idx >= 0) out.splice(idx, 1)
      if (existsSync(source)) {
        out.push({ source, jailRel: '.pi/agent', mode: 'copy-writable' })
      }
    }
    for (const e of out) {
      if (e.jailRel !== '.pi/agent') continue
      e.jailRel = writableAgentRel
      e.mode = 'copy-writable'
      e.envVar = 'PI_CODING_AGENT_DIR'
    }
  }
  return out
}

/**
 * Copy each auth source into the jail HOME at its $HOME-relative path. macOS
 * uses this for every source because sandbox-exec cannot bind-mount; Linux uses
 * it only for CLIs that lock their settings. Returns the copied destination
 * paths so the caller can remove them on cleanup — the jail root is
 * project-local, so copied credentials must NOT linger there.
 */
export async function copyAuthIntoJail(
  root: string,
  sources: JailAuthSource[] | undefined,
  options: { replace?: boolean } = {},
): Promise<string[]> {
  const copied: string[] = []
  try {
    for (const { source, jailRel } of sources ?? []) {
      if (!existsSync(source)) continue
      const dest = resolveJailRoot(jailRel, root)
      if (options.replace !== false) {
        await rm(dest, { recursive: true, force: true })
      }
      // Track the destination before copying so an interrupted/failed copy is
      // removed too; otherwise a partial credential tree could remain in the
      // project-local jail root even though wrap() never returned a cleanup.
      copied.push(dest)
      await cp(source, dest, {
        recursive: true,
        force: options.replace !== false,
        errorOnExist: options.replace === false,
      })
    }
    return copied
  } catch (error) {
    await removeAuthCopies(copied)
    throw error
  }
}

/** Remove ephemeral auth/config copies after a confined process exits. */
export async function removeAuthCopies(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    await rm(path, { recursive: true, force: true })
  }
}
