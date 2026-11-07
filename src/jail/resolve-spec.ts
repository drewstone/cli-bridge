/** Operator jail floor wins over a weaker request. `off` returns null. The writable root stays inside `<cwd>/.agent-home`. */

import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { canonicalizeJailPath, resolveJailRoot } from './types.js'
import type { JailSpec } from './types.js'

export type JailMode = 'off' | 'write-jail' | 'fs-jail'

export interface ResolveJailSpecInput {
  /** Per-request mode from `execution.jail.mode`. Overrides the env default. */
  execMode?: string
  /** Per-request writable root from `execution.jail.root`. Overrides the env default. */
  execRoot?: string
  /** Per-request egress from `execution.jail.network`. Default none. `BRIDGE_JAIL_NETWORK=none` forces none. */
  execNetwork?: string
  /** Working directory the CLI runs in; the containment base for the jail root. */
  cwd: string
  /** Env to read `BRIDGE_JAIL_MODE` / `BRIDGE_JAIL_ROOT` / `WORKER_FS_JAIL` defaults from. */
  env?: NodeJS.ProcessEnv
}

/** Default writable root, relative to `cwd`, when a jail is on and no root is given. */
export const DEFAULT_JAIL_ROOT = '.agent-home'

/** Extra bind lists. A relative path, `/`, `/home`, or the operator home is refused. */
export const JAIL_RO_PATHS_ENV = 'BRIDGE_JAIL_RO_PATHS'
export const JAIL_RW_PATHS_ENV = 'BRIDGE_JAIL_RW_PATHS'

/** Unique absolute paths. A subdirectory of the operator home is allowed; the home itself is not. */
export function parseJailPathList(value: string | undefined, name: string, home: string = homedir()): string[] {
  const out: string[] = []
  for (const raw of (value ?? '').split(/[,:]/u)) {
    const p = raw.trim()
    if (!p) continue
    if (!isAbsolute(p)) throw new Error(`${name}: "${p}" is not an absolute path`)
    const norm = canonicalizeJailPath(p)
    if (norm === sep || norm === resolve('/home') || isWithin(norm, canonicalizeJailPath(home))) {
      throw new Error(`${name}: "${p}" would re-open the home tree the fs-jail exists to hide`)
    }
    if (!out.includes(norm)) out.push(norm)
  }
  return out
}

/** The operator floor: `BRIDGE_JAIL_MODE`, raised to fs-jail by `WORKER_FS_JAIL=1`. */
export function jailFloor(env: NodeJS.ProcessEnv = process.env): JailMode {
  return maxMode(normalizeMode(env.BRIDGE_JAIL_MODE), isTruthy(env.WORKER_FS_JAIL) ? 'fs-jail' : 'off')
}

/** Higher rank is stricter. A request may only raise confinement. */
const MODE_RANK: Record<JailMode, number> = { off: 0, 'write-jail': 1, 'fs-jail': 2 }

export function resolveJailSpec(input: ResolveJailSpecInput): JailSpec | null {
  const env = input.env ?? process.env
  const floor = jailFloor(env)
  const mode = maxMode(floor, normalizeMode(input.execMode))
  if (mode === 'off') return null

  const projectDir = canonicalizeJailPath(input.cwd)
  const scratchBase = resolveJailRoot(DEFAULT_JAIL_ROOT, projectDir)
  const requested = input.execRoot ?? env.BRIDGE_JAIL_ROOT ?? DEFAULT_JAIL_ROOT
  let root: string
  try {
    const candidate = resolveJailRoot(requested, projectDir)
    root = isWithin(scratchBase, candidate) ? candidate : resolveJailRoot(DEFAULT_JAIL_ROOT, projectDir)
  } catch {
    root = resolveJailRoot(DEFAULT_JAIL_ROOT, projectDir)
  }
  const readable = mode === 'fs-jail' ? parseJailPathList(env[JAIL_RO_PATHS_ENV], JAIL_RO_PATHS_ENV) : []
  const writable = parseJailPathList(env[JAIL_RW_PATHS_ENV], JAIL_RW_PATHS_ENV)
  for (const p of [...readable, ...writable]) {
    if (isWithin(p, projectDir)) {
      throw new Error(`jail bind ${p} is the working directory or an ancestor of it — refusing to re-open sibling run scratch dirs`)
    }
  }
  return {
    root,
    projectDir,
    fallback: env.BRIDGE_JAIL_FALLBACK === 'warn' ? 'warn' : 'deny',
    network: jailNetwork(input.execNetwork, env),
    ...(mode === 'fs-jail' ? { readConfine: true } : {}),
    ...(readable.length ? { extraReadablePaths: readable } : {}),
    ...(writable.length ? { extraWritablePaths: writable } : {}),
  }
}

/** Default off. An explicit `none` floor cannot be raised by the request. */
export function jailNetwork(requested: string | undefined, env: NodeJS.ProcessEnv): 'none' | 'router' {
  const floor = (env.BRIDGE_JAIL_NETWORK ?? '').trim()
  const ask = (requested ?? '').trim()
  if (floor !== '' && floor !== 'none' && floor !== 'router') {
    throw new Error(`invalid BRIDGE_JAIL_NETWORK: ${floor} — expected none|router`)
  }
  if (ask !== '' && ask !== 'none' && ask !== 'router') throw new Error(`invalid jail network: ${ask}`)
  if (floor === 'none') return 'none'
  return ask === 'router' ? 'router' : 'none'
}

/** Return whichever of the two modes is more confined. */
function maxMode(a: JailMode, b: JailMode): JailMode {
  return MODE_RANK[a] >= MODE_RANK[b] ? a : b
}

/** Truthy env flag: 1/true/yes/on (case-insensitive). Anything else is off. */
function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
}

/** Unknown mode tokens stay off. */
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
