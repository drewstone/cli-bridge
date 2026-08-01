/**
 * The one gate a net-jailed request crosses.
 *
 * Enforcement itself lives in the network a worker container was created on,
 * which is decided at startup. This gate answers the only question left at
 * request time: is the jail the caller asked for the jail that is actually in
 * force for the backend about to run? Any answer other than yes is a refusal.
 *
 * It sits in the chat route rather than at the spawn seam on purpose. Every
 * backend forwards `req.jailSpec` into its own `SpawnOpts` by hand — eight
 * call sites today — and a control that depends on each new backend
 * remembering to forward it is a control that will one day be silently absent
 * for one backend. A request cannot reach any backend without passing here.
 */

import { ExecutorConfigurationError } from '../executors/types.js'
import type { NetJailSpec } from './resolve-net-spec.js'

export interface EnforcedNetJail {
  /** Internal Docker network the backend's workers run on. */
  network: string
  /** Canonical `host:port` allowlist proven in force at provisioning time. */
  allow: string[]
}

/** Backends with a provisioned, verified net-jail. Absence means no enforcement. */
export type NetJailRegistry = ReadonlyMap<string, EnforcedNetJail>

export function assertNetJailEnforced(opts: {
  backend: string
  /** The request's `execution.kind`; only host-executed work reaches the local pools. */
  executionKind: 'host' | 'sandbox'
  spec: NetJailSpec
  registry: NetJailRegistry
}): EnforcedNetJail {
  if (opts.executionKind === 'sandbox') {
    throw new ExecutorConfigurationError(
      'net-jail was requested but execution.kind=sandbox runs the harness in a Tangle sandbox, which this ' +
        'bridge does not configure the network policy for. Use the sandbox EgressPolicy for that mode, or ' +
        'send execution.kind=host against a net-jailed Docker backend.',
    )
  }
  const enforced = opts.registry.get(opts.backend)
  if (!enforced) {
    throw new ExecutorConfigurationError(
      `net-jail was requested but backend '${opts.backend}' has no net-jail in force, so the run would have ` +
        'unrestricted egress. The allowlist is a property of the network its worker containers were created ' +
        `on, which is fixed at startup: set WORKER_NET_JAIL=1 and ${opts.backend.toUpperCase()}_EXECUTOR=docker, ` +
        'then restart the bridge. Refusing to run unconfined.',
    )
  }
  if (opts.spec.assertedAllow.length > 0 && !sameList(opts.spec.assertedAllow, enforced.allow)) {
    throw new ExecutorConfigurationError(
      `net-jail allowlist mismatch for backend '${opts.backend}': the request requires exactly ` +
        `[${opts.spec.assertedAllow.join(', ')}] but the enforced allowlist is [${enforced.allow.join(', ')}]. ` +
        'execution.netJail.allow asserts what is in force rather than changing it — a pooled container joined ' +
        'its network when the bridge started and cannot be re-jailed per request. Change BRIDGE_NET_JAIL_ALLOW ' +
        'and restart, or drop the assertion to accept the enforced list.',
    )
  }
  return enforced
}

/** Both lists arrive canonical (sorted, de-duplicated), so equality is positional. */
function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}
