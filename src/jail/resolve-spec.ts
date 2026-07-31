/**
 * Resolve a per-request jail spec from the request's `execution.jail` config
 * layered over the `BRIDGE_JAIL_*` / `WORKER_FS_JAIL` env defaults.
 *
 *   mode: an operator env floor (`BRIDGE_JAIL_MODE`, or `WORKER_FS_JAIL=1` as a
 *         shorthand for `fs-jail`) is a FLOOR — a request can only ADD
 *         confinement, never weaken it. `fs-jail` ⊃ `write-jail`: both confine
 *         WRITES to the jail root; `fs-jail` additionally confines READS to a
 *         minimal system+toolchain allowlist so the CLI cannot read the host
 *         repo (benchmark task defs / grader keys) or sibling run scratch dirs.
 *   root: must be a scratch dir within <cwd>/.agent-home (default the namespace
 *         itself); an arbitrary repo subtree or any escape clamps to the default.
 *
 * Returns `null` when the effective mode is 'off' — the spawner then runs
 * the CLI exactly as before (no wrap, no env change). Otherwise returns a
 * {@link JailSpec} whose writable root is clamped inside `cwd`: a root that
 * would escape the working directory is rejected and falls back to the in-cwd
 * default, so an untrusted caller can never aim the writable mount outside its
 * own working tree. `readConfine` is set when the effective mode is 'fs-jail'.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import { resolveJailRoot } from './types.js'
import type { JailSpec } from './types.js'

export type JailMode = 'off' | 'write-jail' | 'fs-jail'

export interface ResolveJailSpecInput {
  /** Per-request mode from `execution.jail.mode`. Overrides the env default. */
  execMode?: string
  /** Per-request writable root from `execution.jail.root`. Overrides the env default. */
  execRoot?: string
  /** Working directory the CLI runs in; the containment base for the jail root. */
  cwd: string
  /** Env to read `BRIDGE_JAIL_MODE` / `BRIDGE_JAIL_ROOT` / `WORKER_FS_JAIL` defaults from. */
  env?: NodeJS.ProcessEnv
}

/** Default writable root, relative to `cwd`, when a jail is on and no root is given. */
export const DEFAULT_JAIL_ROOT = '.agent-home'

/** Confinement ordering: a higher rank is strictly more confined. Used to take
 * the max of the operator floor and the per-request mode (a request may raise
 * confinement, never lower it below the floor). */
const MODE_RANK: Record<JailMode, number> = { off: 0, 'write-jail': 1, 'fs-jail': 2 }

export function resolveJailSpec(input: ResolveJailSpecInput): JailSpec | null {
  const env = input.env ?? process.env
  // The operator env floor: BRIDGE_JAIL_MODE, plus WORKER_FS_JAIL=1 as a
  // shorthand that raises the floor to fs-jail. The effective mode is the MAX
  // of the floor and the per-request mode — a request can only add confinement.
  const floor = maxMode(normalizeMode(env.BRIDGE_JAIL_MODE), isTruthy(env.WORKER_FS_JAIL) ? 'fs-jail' : 'off')
  const mode = maxMode(floor, normalizeMode(input.execMode))
  if (mode === 'off') return null

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
  return { root, projectDir, ...(mode === 'fs-jail' ? { readConfine: true } : {}) }
}

/** Return whichever of the two modes is more confined. */
function maxMode(a: JailMode, b: JailMode): JailMode {
  return MODE_RANK[a] >= MODE_RANK[b] ? a : b
}

/** Truthy env flag: 1/true/yes/on (case-insensitive). Anything else is off. */
function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
}

/** Only the exact 'write-jail' / 'fs-jail' tokens enable a jail; anything else
 * is 'off' (fail-safe against typos silently confining or not). */
function normalizeMode(value: string | undefined): JailMode {
  const v = (value ?? '').trim().toLowerCase()
  if (v === 'write-jail') return 'write-jail'
  if (v === 'fs-jail') return 'fs-jail'
  return 'off'
}

/** Whether `p` is `base` itself or a descendant of it (lexical). */
function isWithin(base: string, p: string): boolean {
  const rel = relative(resolve(base), resolve(p))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
