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

import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

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
  const resolvedBase = resolve(base)
  const resolvedRoot = isAbsolute(root) ? resolve(root) : resolve(resolvedBase, root)
  const rel = relative(resolvedBase, resolvedRoot)
  const escapes = rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)
  if (escapes) {
    throw new Error(`jail root '${resolvedRoot}' escapes allowed base '${resolvedBase}'`)
  }
  return resolvedRoot
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
    XDG_CONFIG_HOME: join(root, '.config'),
    XDG_CACHE_HOME: join(root, '.cache'),
    XDG_DATA_HOME: join(root, '.local', 'share'),
    XDG_STATE_HOME: join(root, '.local', 'state'),
    XDG_RUNTIME_DIR: join(root, '.runtime'),
  }
}

/** Create the jail root and the redirected HOME/XDG dirs so a CLI that
 * expects them to exist does not fail on first write. */
export async function prepareJailHome(root: string): Promise<void> {
  // Mirror the XDG layout produced by jailEnv() so a CLI finds the dirs ready.
  const relDirs = ['.config', '.cache', join('.local', 'share'), join('.local', 'state'), '.runtime']
  await mkdir(root, { recursive: true })
  for (const rel of relDirs) {
    await mkdir(join(root, rel), { recursive: true })
  }
}
