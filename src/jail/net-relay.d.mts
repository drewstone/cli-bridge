/**
 * Types for `net-relay.mjs`.
 *
 * The relay is plain JavaScript because `node` executes it directly inside the
 * worker runtime image, where this repository's TypeScript is never built or
 * installed. Its callers — the provisioner and the test suite — are TypeScript,
 * so the contract is declared here rather than inferred.
 */

import type { Server } from 'node:net'

/** Port → set of hostnames permitted on that port. */
export type NetRelayAllowlist = Map<number, Set<string>>

export interface NetRelayHandle {
  close(): Promise<unknown[]>
  ports: number[]
  /** Bound listeners, in allowlist port order. */
  servers: Server[]
}

export function parseAllowlist(raw: string | undefined): NetRelayAllowlist

/**
 * Hostname from a buffered TLS ClientHello. `null` while the record is
 * incomplete, `undefined` when it is complete and names no host.
 */
export function readSni(buf: Buffer): string | null | undefined

/**
 * Hostname from a buffered cleartext HTTP request head, port stripped. Same
 * three-state contract as {@link readSni}.
 */
export function readHttpHost(buf: Buffer): string | null | undefined

export function startRelay(opts: {
  allowlist: NetRelayAllowlist
  listenHost?: string
  /** Injectable DNS resolver; the default queries public servers directly. */
  resolver?: { resolve4(host: string): Promise<string[]> }
}): NetRelayHandle
