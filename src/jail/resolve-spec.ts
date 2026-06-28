/**
 * Resolve a per-request write-jail spec from the request's
 * `execution.jail` config layered over the `BRIDGE_JAIL_*` env defaults.
 *
 *   mode: execution.jail.mode  >  BRIDGE_JAIL_MODE  >  'off'
 *   root: execution.jail.root  >  BRIDGE_JAIL_ROOT  >  '<cwd>/.agent-home'
 *
 * Returns `null` when the effective mode is 'off' — the spawner then runs
 * the CLI exactly as before (no wrap, no env change). When 'write-jail',
 * returns a {@link JailSpec} whose writable root is clamped inside `cwd`:
 * a root that would escape the working directory is rejected and falls
 * back to the in-cwd default, so an untrusted caller can never aim the
 * writable mount outside its own working tree.
 */

import { resolve } from 'node:path'
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
  const mode = normalizeMode(input.execMode ?? env.BRIDGE_JAIL_MODE)
  if (mode !== 'write-jail') return null

  const projectDir = resolve(input.cwd)
  const requested = input.execRoot ?? env.BRIDGE_JAIL_ROOT ?? DEFAULT_JAIL_ROOT
  // Clamp the writable root inside projectDir. resolveJailRoot throws if
  // the resolved path escapes the base; for an untrusted per-request value
  // we fail closed to the in-cwd default rather than honor the escape.
  let root: string
  try {
    root = resolveJailRoot(requested, projectDir)
  } catch {
    root = resolveJailRoot(DEFAULT_JAIL_ROOT, projectDir)
  }
  return { root, projectDir }
}

/** Anything other than the exact 'write-jail' token is treated as 'off' (fail-safe). */
function normalizeMode(value: string | undefined): JailMode {
  return (value ?? '').trim().toLowerCase() === 'write-jail' ? 'write-jail' : 'off'
}
