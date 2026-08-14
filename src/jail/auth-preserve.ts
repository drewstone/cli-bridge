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
import { chmod, cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { resolveJailRoot, type JailAuthSource } from './types.js'

const PI_AUTH_COPY_PREFIX = `pi-${process.pid}-`

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

/**
 * Codex must WRITE inside `$CODEX_HOME` before it can execute at all: PATH
 * aliases under `tmp/arg0/`, the in-process app-server state, session
 * rollouts. A read-only bind therefore kills every jailed codex run at spawn
 * ("Read-only file system (os error 30)"). Seed only the config surface —
 * the host `sessions/` tree runs to hundreds of GB and belongs to OTHER runs.
 */
const CODEX_SEED_ENTRIES = ['auth.json', 'config.toml'] as const

/**
 * Claude Code rewrites `~/.claude.json` on startup and persists session
 * transcripts under `~/.claude/projects/` — with those paths read-only a
 * jailed run cannot boot or `--resume` across turns. Seed the credential and
 * settings surface only; `projects/`, plugin caches, and history stay host-
 * private. Both credential spellings exist across claude versions.
 */
const CLAUDE_SEED_ENTRIES = ['.credentials.json', 'credentials.json', 'settings.json'] as const

/** OpenCode stores credentials beside a writable database and log directory. */
const OPENCODE_SEED_ENTRIES = ['auth.json'] as const

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
  if (backendName === 'claude-code' || backendName === 'claude' || backendName === 'claudish') {
    // A stateful CLI whose home must be writable: seed the credential/settings
    // surface into the jail's stable `$HOME/.claude` + `$HOME/.claude.json`
    // and let the CLI own everything else it writes there. No envVar — the
    // jail's HOME redirect already points claude at these exact paths.
    for (const entry of out) {
      entry.mode = 'seed-writable'
      if (entry.jailRel === '.claude') entry.only = [...CLAUDE_SEED_ENTRIES]
    }
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
    // Codex writes inside its home before it can run (PATH aliases under
    // tmp/arg0, app-server state, session rollouts), so the in-jail home must
    // be a WRITABLE seed, never a read-only bind. Redirect CODEX_HOME at it;
    // the jail applies the redirect only when it actually wraps —
    // docker/fallback runs keep the host CODEX_HOME.
    for (const e of out) {
      if (e.jailRel !== '.codex') continue
      e.mode = 'seed-writable'
      e.only = [...CODEX_SEED_ENTRIES]
      e.envVar = 'CODEX_HOME'
    }
  }
  if (backendName === 'opencode') {
    // OpenCode writes its database and logs below XDG_DATA_HOME before a turn.
    // Seed only auth.json so the jailed data directory stays small and writable.
    for (const entry of out) {
      if (entry.jailRel !== '.local/share/opencode') continue
      entry.mode = 'seed-writable'
      entry.only = [...OPENCODE_SEED_ENTRIES]
    }
  }
  if (backendName === 'pi') {
    const writableAgentRel = `.auth-copies/${PI_AUTH_COPY_PREFIX}${randomUUID()}`
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
      // Request-unique writable copies cannot be shared, so track them before
      // copying and remove even a partial tree after failure. Stable macOS auth
      // paths can be shared by concurrent runs: preserve the established
      // in-place copy behavior and never delete another run's live directory.
      if (options.replace === false) copied.push(dest)
      await cp(source, dest, {
        recursive: true,
        force: options.replace !== false,
        errorOnExist: options.replace === false,
      })
      await chmod(dest, 0o700)
      if (options.replace !== false) copied.push(dest)
    }
    return copied
  } catch (error) {
    await removeAuthCopies(copied)
    throw error
  }
}

/**
 * Seed each `seed-writable` source into the writable jail HOME at its stable
 * path, refreshing the selected entries in place. Deliberately NOT returned
 * for cleanup: the CLI stores its own session state (codex rollouts, claude
 * project transcripts) beside the seed, and the next turn of the same bridge
 * session must find that state or `resume` breaks. The jail root is operator
 * scratch and git-ignored by `prepareJailHome`.
 *
 * Files are replaced via a same-directory temp + rename so a concurrent run
 * in the same workspace can never read a half-written credential.
 */
export async function seedAuthIntoJail(
  root: string,
  sources: JailAuthSource[] | undefined,
): Promise<void> {
  for (const { source, jailRel, only } of sources ?? []) {
    if (!existsSync(source)) continue
    const dest = resolveJailRoot(jailRel, root)
    if (only !== undefined) {
      await mkdir(dest, { recursive: true, mode: 0o700 })
      for (const entry of only) {
        const entrySource = join(source, entry)
        if (!existsSync(entrySource)) continue
        // Containment is checked LEXICALLY on the entry name (a repo-internal
        // constant): a previously seeded leaf may legitimately be replaced, so
        // following an existing leaf symlink here (as resolveJailRoot would)
        // turns a refresh into a false escape. The canonical base `dest`
        // already went through resolveJailRoot above.
        const entryDest = join(dest, entry)
        const rel = relative(dest, entryDest)
        if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          throw new Error(`seed entry '${entry}' must stay inside its seed destination`)
        }
        await mkdir(dirname(entryDest), { recursive: true, mode: 0o700 })
        await seedPath(entrySource, entryDest)
      }
      continue
    }
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
    await seedPath(source, dest)
  }
}

/** Replace `dest` with a copy of `src`: atomically (temp + rename) for a
 * file, recursively in place for a directory. Always dereferences — a
 * dotfiles-managed source (e.g. `~/.claude/settings.json -> ~/code/dotfiles/...`)
 * must arrive as REAL BYTES, because its symlink target is not mounted
 * inside an fs-jail and a copied link would dangle there. */
async function seedPath(src: string, dest: string): Promise<void> {
  const st = await stat(src)
  if (st.isDirectory()) {
    await cp(src, dest, { recursive: true, force: true, dereference: true })
    await chmod(dest, 0o700)
    return
  }
  const tmp = join(dirname(dest), `.seed-${randomUUID()}`)
  try {
    await cp(src, tmp, { dereference: true })
    await chmod(tmp, 0o600)
    await rename(tmp, dest)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** Remove writable Pi config copies owned by bridge processes that no longer
 * exist. Live processes use unique request paths and are never age-limited, so
 * arbitrarily long caller-authorized runs remain safe from scavenging. */
export async function removeStaleAuthCopies(root: string): Promise<void> {
  const parent = resolveJailRoot('.auth-copies', root)
  let names: string[]
  try {
    names = await readdir(parent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const name of names) {
    const match = /^pi-(\d+)-/u.exec(name)
    if (!match) continue
    const ownerPid = Number(match[1])
    if (ownerPid === process.pid || processExists(ownerPid)) continue
    await rm(resolveJailRoot(`.auth-copies/${name}`, root), {
      recursive: true,
      force: true,
    })
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Remove ephemeral auth/config copies after a confined process exits. */
export async function removeAuthCopies(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    await rm(path, { recursive: true, force: true })
  }
}
