/**
 * Resolve a per-request write-jail spec from the request's
 * `execution.jail` config layered over the `BRIDGE_JAIL_*` env defaults.
 *
 *   mode: BRIDGE_JAIL_MODE=write-jail is a FLOOR (a request can only add
 *         confinement, never weaken it); otherwise execution.jail.mode decides.
 *   root: must be a scratch dir within <cwd>/.agent-home (default the namespace
 *         itself); an arbitrary repo subtree or any escape clamps to the default.
 *
 * Returns `null` when the effective mode is 'off' — the spawner then runs
 * the CLI exactly as before (no wrap, no env change). When 'write-jail',
 * returns a {@link JailSpec} whose writable root is clamped inside `cwd`:
 * a root that would escape the working directory is rejected and falls
 * back to the in-cwd default, so an untrusted caller can never aim the
 * writable mount outside its own working tree.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import { resolveJailRoot } from './types.js'
import type { JailSpec } from './types.js'

export type JailMode = 'off' | 'write-jail'

export interface ResolveJailSpecInput {
  /** Per-request mode from `execution.jail.mode`. Overrides the env default. */
  execMode?: string
  /** Per-request writable root from `execution.jail.root`. Overrides the env default. */
  execRoot?: string
  /** Working directory the CLI runs in; the containment base for the jail root. */
  cwd: string
  /** Env to read `BRIDGE_JAIL_MODE` / `BRIDGE_JAIL_ROOT` defaults from. */
  env?: NodeJS.ProcessEnv
}

/** Default writable root, relative to `cwd`, when write-jail is on and no root is given. */
export const DEFAULT_JAIL_ROOT = '.agent-home'

export function resolveJailSpec(input: ResolveJailSpecInput): JailSpec | null {
  const env = input.env ?? process.env
  // BRIDGE_JAIL_MODE=write-jail is an operator-set FLOOR, not a default a
  // caller may weaken: a per-request mode can turn confinement ON, never OFF.
  const mode = normalizeMode(env.BRIDGE_JAIL_MODE) === 'write-jail'
    ? 'write-jail'
    : normalizeMode(input.execMode)
  if (mode !== 'write-jail') return null

  const projectDir = resolve(input.cwd)
  const scratchBase = resolve(projectDir, DEFAULT_JAIL_ROOT)
  const requested = input.execRoot ?? env.BRIDGE_JAIL_ROOT ?? DEFAULT_JAIL_ROOT
  // The writable root must be a dedicated scratch dir INSIDE <cwd>/.agent-home,
  // never an arbitrary repo subtree (which would make tracked files writable and
  // clobber their .gitignore). Resolve under cwd, then require it within the
  // scratch namespace; anything else (incl. resolveJailRoot rejecting an
  // escape/self-root) fails closed to the scratch base itself.
  let root: string
  try {
    const candidate = resolveJailRoot(requested, projectDir)
    root = isWithin(scratchBase, candidate) ? candidate : resolveJailRoot(DEFAULT_JAIL_ROOT, projectDir)
  } catch {
    root = resolveJailRoot(DEFAULT_JAIL_ROOT, projectDir)
  }
  return { root, projectDir }
}

/** Anything other than the exact 'write-jail' token is treated as 'off' (fail-safe). */
function normalizeMode(value: string | undefined): JailMode {
  return (value ?? '').trim().toLowerCase() === 'write-jail' ? 'write-jail' : 'off'
}

/** Whether `p` is `base` itself or a descendant of it (lexical). */
function isWithin(base: string, p: string): boolean {
  const rel = relative(resolve(base), resolve(p))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
