/**
 * Dynamic model discovery for CLI-backed harnesses.
 *
 * The `/v1/models` catalog used to be a hand-maintained allowlist. That drifts
 * from provider reality: when the kimi-for-coding plan added k2p7/k3 the static
 * list still advertised only k2p6, so a downstream selector that filtered against
 * this catalog silently dropped the k2p7 lane. The fix is to read each CLI's own
 * model list at request time (the CLI is the source of truth for what its
 * configured auth can reach), filtered to the provider prefixes this bridge
 * routes, cached briefly, with the curated static list as a never-empty fallback.
 *
 * Fallback semantics matter: an empty catalog is worse than a stale one, because
 * consumers treat "not listed" as "unavailable" and filter the model out. So a
 * failed/timed-out discovery returns the last good result if we have one, else
 * the static seed — never an empty array.
 */

import { execFile } from 'node:child_process'

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

function runList(spec: DiscoverySpec): Promise<string[]> {
  return new Promise((resolvePromise, reject) => {
    execFile(spec.bin, spec.args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // Some CLIs print the table to stdout while exiting non-zero on an unrelated
      // auth probe; trust stdout if it parsed to anything, else surface the error.
      const ids = stdout ? spec.parse(stdout, spec.providers) : []
      if (ids.length) return resolvePromise(ids)
      if (err) return reject(err)
      reject(new Error('discovery returned no models'))
    })
  })
}

/**
 * Return the live model list for a harness, `<harness>/`-prefixed by the caller.
 * Cached for TTL_MS on success; on failure returns the last good result or the
 * static fallback (never empty).
 */
export async function discoverModels(harness: string, spec: DiscoverySpec): Promise<readonly ModelSpec[]> {
  const cached = cache.get(harness)
  if (cached && Date.now() - cached.at < TTL_MS) return cached.models

  try {
    const ids = await runList(spec)
    const models: ModelSpec[] = ids.map((id) => ({ id }))
    cache.set(harness, { at: Date.now(), models })
    return models
  } catch {
    const models = cached?.models ?? spec.fallback
    // Age the cache so the next request retries after FAILURE_RETRY_MS, not TTL_MS.
    cache.set(harness, { at: Date.now() - TTL_MS + FAILURE_RETRY_MS, models })
    return models
  }
}
