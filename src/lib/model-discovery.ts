/**
 * Discover each native CLI's configured models, filtered to routable provider prefixes.
 * Cache successful discovery briefly. Failures return the last good list or static seed;
 * cancellation propagates without returning or caching a fallback.
 */

import { probeNativeStatus } from './native-status.js'

export interface ModelSpec {
  id: string
  note?: string
}

export interface DiscoverySpec {
  /** Resolved CLI binary (config.opencodeBin / config.piBin). */
  bin: string
  /** Subcommand + flags that print the CLI's own model list. */
  args: string[]
  /** Provider prefixes to keep (drops the CLI's free tiers / unrouted providers). */
  providers: readonly string[]
  /** Line parser → fully-qualified `provider/model` ids. */
  parse: (stdout: string, providers: readonly string[]) => string[]
  /** Curated seed, used when discovery fails or returns nothing. Never empty. */
  fallback: readonly ModelSpec[]
}

const TTL_MS = 5 * 60_000
const EXEC_TIMEOUT_MS = 15_000
/** After a failure, retry sooner than the success TTL rather than serving stale for 5 min. */
const FAILURE_RETRY_MS = 30_000

const cache = new Map<string, { at: number; models: readonly ModelSpec[] }>()

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

/** opencode: one `provider/model` per line. */
export function parseOpencodeModels(stdout: string, providers: readonly string[]): string[] {
  return stripAnsi(stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => providers.some((p) => l.startsWith(`${p}/`)))
}

/** pi: whitespace-aligned table `provider  model  context  max-out  thinking  images`. */
export function parsePiModels(stdout: string, providers: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of stripAnsi(stdout).split('\n')) {
    const cols = raw.trim().split(/\s{2,}/)
    const provider = cols[0]
    const model = cols[1]
    if (!provider || !model || provider === 'provider') continue // header / malformed
    if (providers.includes(provider)) out.push(`${provider}/${model}`)
  }
  return out
}

/**
 * Return the live model list for a harness, `<harness>/`-prefixed by the caller.
 * Cached for TTL_MS on success; on failure returns the last good result or the
 * static fallback (never empty).
 */
export async function discoverModels(harness: string, spec: DiscoverySpec, options: { cwd?: string; signal?: AbortSignal } = {}): Promise<readonly ModelSpec[]> {
  options.signal?.throwIfAborted()
  const key = JSON.stringify([harness, spec.bin, spec.args, spec.providers, options.cwd ?? process.cwd()])
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < TTL_MS) return cached.models

  try {
    const result = await probeNativeStatus(spec.bin, spec.args, { timeoutMs: EXEC_TIMEOUT_MS, ...options })
    options.signal?.throwIfAborted()
    const ids = result.stdout ? spec.parse(result.stdout, spec.providers) : []
    if (!ids.length) throw new Error('Native model discovery returned no routable models')
    const models: ModelSpec[] = ids.map((id) => ({ id }))
    cache.set(key, { at: Date.now(), models })
    return models
  } catch {
    options.signal?.throwIfAborted()
    const models = cached?.models ?? spec.fallback
    // Age the cache so the next request retries after FAILURE_RETRY_MS, not TTL_MS.
    cache.set(key, { at: Date.now() - TTL_MS + FAILURE_RETRY_MS, models })
    return models
  }
}
