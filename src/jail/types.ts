/**
 * Jail module types — the abstraction over "wrap a CLI invocation in an
 * OS sandbox that confines writes to a known scratch root".
 *
 *   JailBackend.wrap(bin, args, spec) → JailWrap{ bin, args, env?, cleanup? }
 *
 * A backend never spawns anything. It rewrites the argv so the SAME
 * spawn machinery the bridge already uses launches the CLI inside a
 * write-jail instead. The host filesystem is readable; writes are
 * confined to `spec.root` (and any `extraWritablePaths`). On Linux this
 * is bubblewrap (bwrap); on macOS it is sandbox-exec (SBPL). Everywhere
 * else the NoopJail passes argv through unchanged.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface JailSpec {
  /** Writable scratch root; becomes HOME inside the jail. Must resolve
   * inside `projectDir` (enforced by {@link resolveJailRoot}). */
  root: string
  /** Project working directory. Read-only inside the jail; the CLI is
   * chdir'd here. Acts as the containment base for `root`. */
  projectDir: string
  /** Extra absolute paths the jailed process may write to. */
  extraWritablePaths?: string[]
  /** Extra absolute paths to expose read-only beyond the host default. */
  extraReadablePaths?: string[]
  /** Absolute host paths holding the backend CLI's auth/config, made
   * available inside the jail at their $HOME-relative location (read-only
   * bind on Linux, copy on macOS) so a confined run still authenticates as
   * the operator. Populated per backend by {@link authSourcesFor}. */
  authSources?: string[]
}

export interface JailWrap {
  /** Executable to spawn (e.g. `sudo`, `sandbox-exec`, or the bin itself). */
  bin: string
  /** Full argv for `bin`, ending in the original `bin` + `args`. */
  args: string[]
  /** Env overrides to merge onto the child's environment. */
  env?: Record<string, string>
  /** Tear down any backend-owned temp state (e.g. an SBPL profile file). */
  cleanup?: () => Promise<void> | void
}

export interface JailBackend {
  readonly name: string
  /** Whether this backend can run on the current host (right OS + tools). */
  isAvailable(): boolean | Promise<boolean>
  wrap(bin: string, args: string[], spec: JailSpec): JailWrap | Promise<JailWrap>
}

/**
 * Resolve `root` against `base` and prove it cannot escape `base`.
 *
 * Pure path arithmetic — no filesystem access, so it is safe to call
 * before the directory exists. A relative `root` is resolved under
 * `base`; an absolute `root` is taken as-is. Either way the result must
 * be `base` itself or a descendant of it, else we throw. This is the
 * single chokepoint that stops a caller from pointing the writable jail
 * root at `../../etc` or any path outside the allowed base.
 */
export function resolveJailRoot(root: string, base: string): string {
  if (!root) throw new Error('jail root must be a non-empty path')
  // Canonicalize BOTH paths (resolve symlinks on the existing prefix) before
  // comparing, so a repo-local symlink (e.g. scratch -> /tmp) cannot look
  // in-base lexically while physically pointing outside it.
  const resolvedBase = canonicalize(resolve(base))
  const resolvedRoot = canonicalize(isAbsolute(root) ? resolve(root) : resolve(resolvedBase, root))
  const rel = relative(resolvedBase, resolvedRoot)
  // Must be a STRICT descendant of base: never the base itself (rel === '',
  // which would make the whole working tree writable) and never an escape.
  const ok = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  if (!ok) {
    throw new Error(`jail root '${resolvedRoot}' must be a dedicated subdirectory inside '${resolvedBase}'`)
  }
  return resolvedRoot
}

/** Resolve symlinks on the deepest EXISTING ancestor of `p`, then re-append the
 * not-yet-created tail. Lets us canonicalize a jail root that does not exist
 * yet while still catching a symlinked ancestor that points outside the base. */
function canonicalize(p: string): string {
  const tail: string[] = []
  let cur = p
  for (;;) {
    try {
      const real = realpathSync(cur)
      return tail.length ? join(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return p
      tail.push(basename(cur))
      cur = parent
    }
  }
}

/**
 * Environment a jailed process must see so a stateful CLI writes INTO the
 * jail rather than the host. HOME plus the XDG base dirs are all redirected
 * under `root` — otherwise CLIs that target `$HOME`, `$XDG_CONFIG_HOME`, or
 * `$XDG_CACHE_HOME` hit the read-only host filesystem and fail. Both
 * backends apply these (bwrap via --setenv, seatbelt via JailWrap.env).
 */
export function jailEnv(root: string): Record<string, string> {
  return {
    HOME: root,
    TMPDIR: join(root, '.tmp'),
    XDG_CONFIG_HOME: join(root, '.config'),
    XDG_CACHE_HOME: join(root, '.cache'),
    XDG_DATA_HOME: join(root, '.local', 'share'),
    XDG_STATE_HOME: join(root, '.local', 'state'),
    XDG_RUNTIME_DIR: join(root, '.runtime'),
  }
}

/**
 * Ensure the jail root is git-ignored from the REPO's perspective. A .gitignore
 * placed inside an untracked directory does not make Git ignore that directory
 * itself, so we add a rule to the project's `.git/info/exclude` (local + untracked,
 * no working-tree change). Best-effort and idempotent; a no-op outside a git repo
 * or when `.git` is a file (worktree/submodule).
 */
export function ignoreJailRoot(projectDir: string, root: string): void {
  try {
    const found = findGitDir(resolve(projectDir))
    if (!found) return
    // .git/info/exclude patterns are anchored at the repo root, so the entry is
    // the jail root relative to THAT (handles cwd being a repo subdirectory).
    const rel = relative(found.repoRoot, root).split(sep).join('/')
    if (!rel || rel.startsWith('..')) return
    const entry = `/${rel}/`
    const excludeFile = join(found.gitDir, 'info', 'exclude')
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : ''
    if (current.split(/\r?\n/).includes(entry)) return
    mkdirSync(dirname(excludeFile), { recursive: true })
    appendFileSync(excludeFile, `${current && !current.endsWith('\n') ? '\n' : ''}${entry}\n`)
  } catch {
    // best-effort: do not fail a jailed run because the ignore rule could not be written
  }
}

/** Find the git dir + repo root for `start`, walking up parents. Handles a `.git`
 * directory (normal repo) and a `.git` FILE (`gitdir: <path>` for worktrees /
 * submodules). Returns null outside any repo. */
function findGitDir(start: string): { gitDir: string; repoRoot: string } | null {
  let dir = start
  for (;;) {
    const dotgit = join(dir, '.git')
    if (existsSync(dotgit)) {
      const st = statSync(dotgit)
      if (st.isDirectory()) return { gitDir: dotgit, repoRoot: dir }
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotgit, 'utf8'))
        if (m && m[1]) return { gitDir: resolve(dir, m[1].trim()), repoRoot: dir }
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Create the jail root and the redirected HOME/XDG dirs so a CLI that
 * expects them to exist does not fail on first write. */
export async function prepareJailHome(root: string): Promise<void> {
  // Mirror the XDG layout produced by jailEnv() so a CLI finds the dirs ready.
  const relDirs = ['.tmp', '.config', '.cache', join('.local', 'share'), join('.local', 'state'), '.runtime']
  await mkdir(root, { recursive: true })
  // The jail root sits inside the project (default <cwd>/.agent-home) and holds
  // scratch + (on macOS) copied credentials. Ignore the whole tree so neither
  // work artifacts nor copied secrets can ever be committed. Never clobber an
  // existing .gitignore.
  const gitignore = join(root, '.gitignore')
  if (!existsSync(gitignore)) await writeFile(gitignore, '*\n')
  for (const rel of relDirs) {
    await mkdir(join(root, rel), { recursive: true })
  }
}
