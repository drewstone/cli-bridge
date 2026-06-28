/**
 * Cores-aware concurrency default.
 *
 * The executor semaphores (host + scoped-host) and the chat admission
 * gate each need a default cap that is safe on a small box yet does not
 * artificially throttle a large one. A hardcoded `4` was the original
 * default; on the 32-core/130GB production box it became the bottleneck
 * that starved the pr-reviewer's opencode lane of executor slots — every
 * acquire timed out at in_flight=4/4, opencode's readiness probe failed,
 * its models 404'd, and reviews posted "⚠️ Review Incomplete" (2026-06-01).
 *
 * Scaling on cores (rather than a fixed number) keeps the conservative
 * floor on modest hosts while letting large hosts use the parallelism
 * they paid for. Cloud instances scale RAM roughly with vCPU (~2-4GB per
 * core), so `ratio·cores` spawns at ~1-2GB resident each stay within
 * memory on typical shapes. `max` caps runaway on very large hosts; `min`
 * preserves the original conservative floor where cores are scarce.
 *
 * Env overrides (BRIDGE_HOST_MAX_CONCURRENCY, CLI_BRIDGE_SCOPE_MAX_CONCURRENCY,
 * BRIDGE_HOST_CHAT_MAX_ACTIVE, …) always win — this only sets the default
 * when the operator has not pinned a value.
 */

import { availableParallelism } from 'node:os'

export interface ConcurrencyDefaultOpts {
  /** Fraction of logical cores to use (0 < ratio <= 1). */
  ratio: number
  /** Lower bound — never default below this regardless of core count. */
  min: number
  /** Upper bound — cap the default on very large hosts. */
  max: number
  /** Logical core count. Injectable for tests; defaults to the live host. */
  cores?: number
}

export function coresAwareConcurrency({ ratio, min, max, cores = availableParallelism() }: ConcurrencyDefaultOpts): number {
  const scaled = Math.floor(cores * ratio)
  return Math.max(min, Math.min(max, scaled))
}
