/**
 * Resolve a per-request net-jail spec from the request's `execution.netJail`
 * config layered over the `BRIDGE_NET_JAIL_MODE` / `WORKER_NET_JAIL` env
 * defaults. Sibling of `resolve-spec.ts`: same floor semantics, same shape,
 * one idea applied to a second resource.
 *
 *   mode: an operator env floor (`BRIDGE_NET_JAIL_MODE`, or `WORKER_NET_JAIL=1`
 *         as a shorthand for `net-jail`) is a FLOOR — a request can only ADD
 *         confinement, never weaken it. In `net-jail` the worker's process tree
 *         has NO egress except to an allowlist that always includes the
 *         backend's own model endpoint.
 *   allow: an ASSERTION, not a mutation. The allowlist is fixed when the worker
 *         pool is provisioned, so a request cannot widen or narrow it. Naming
 *         one here demands that the enforced allowlist equal it exactly, and
 *         the request FAILS when it does not.
 *
 * That asymmetry with fs-jail's `root` is deliberate. fs-jail wraps each spawn,
 * so a per-request root is applied at spawn time; a net-jail is a property of
 * the network a pooled container was created on, and a per-request allowlist
 * would be accepted and then not applied — the precise defect this feature
 * exists to close.
 *
 * Returns `null` when the effective mode is 'off'.
 */

import { canonicalAllowList, parseAllowEntry } from './net-allowlist.js'

export type NetJailMode = 'off' | 'net-jail'

export interface NetJailSpec {
  mode: 'net-jail'
  /**
   * Canonical `host:port` list the caller requires to be in force, or an empty
   * array when the caller only requires that SOME enforced net-jail applies.
   */
  assertedAllow: string[]
}

export interface ResolveNetJailSpecInput {
  /** Per-request mode from `execution.netJail.mode`. */
  execMode?: string
  /** Per-request allowlist assertion from `execution.netJail.allow`. */
  execAllow?: string[]
  /** Env to read `BRIDGE_NET_JAIL_MODE` / `WORKER_NET_JAIL` defaults from. */
  env?: NodeJS.ProcessEnv
}

/** Confinement ordering, mirroring the fs-jail ranking: a higher rank is
 * strictly more confined, and the effective mode is the max of the operator
 * floor and the per-request mode. */
const MODE_RANK: Record<NetJailMode, number> = { off: 0, 'net-jail': 1 }

export function resolveNetJailSpec(input: ResolveNetJailSpecInput): NetJailSpec | null {
  const env = input.env ?? process.env
  const floor = maxMode(normalizeMode(env.BRIDGE_NET_JAIL_MODE), isTruthy(env.WORKER_NET_JAIL) ? 'net-jail' : 'off')
  const mode = maxMode(floor, normalizeMode(input.execMode))
  if (mode === 'off') return null
  const assertedAllow = canonicalAllowList(
    (input.execAllow ?? []).map((token) => parseAllowEntry(token, 'execution.netJail.allow')),
  )
  return { mode: 'net-jail', assertedAllow }
}

/** Return whichever of the two modes is more confined. */
function maxMode(a: NetJailMode, b: NetJailMode): NetJailMode {
  return MODE_RANK[a] >= MODE_RANK[b] ? a : b
}

/** Truthy env flag: 1/true/yes/on (case-insensitive). Anything else is off. */
function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
}

/** Only the exact 'net-jail' token enables the jail; anything else is 'off',
 * fail-safe against a typo silently confining or not. */
export function normalizeMode(value: string | undefined): NetJailMode {
  return (value ?? '').trim().toLowerCase() === 'net-jail' ? 'net-jail' : 'off'
}
