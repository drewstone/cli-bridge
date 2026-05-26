/**
 * Per-request env overrides — controlled merge of `chatRequestSchema.env` into
 * the spawn env, with a narrow safety allowlist.
 *
 * Why this is its own module: boot env is operator-controlled (trusted); request
 * env is untrusted network input on a bridge that serves multiple consumers
 * (VB, pr-reviewer, …). Letting any key through would let a request inject
 * PATH / LD_PRELOAD / NODE_OPTIONS into a sibling consumer's spawn. The
 * allowlist below restricts to search-axis knobs we deliberately want
 * controllable per-request — exactly what the search-MCP A/B needs
 * (TANGLE_SEARCH_DEFAULT_PROVIDER) and nothing more risky.
 *
 * Forbidden everywhere: secret-suffix keys (`_API_KEY`, `_TOKEN`, `_SECRET`,
 * `_PASSWORD`). Operators set those in the BOOT env where they belong and
 * won't appear in request logs / SSE traces / error envelopes.
 */

/** Prefixes a request may override. Narrow on purpose — widen explicitly. */
export const REQUEST_ENV_ALLOWED_PREFIXES = [
  'TANGLE_SEARCH_',
  'YDC_',
  'EXA_',
  'TAVILY_',
  'PERPLEXITY_',
  'PARALLEL_',
  'BRAVE_',
  'SERPAPI_',
  'SERPER_',
  'GOOGLE_CSE_',
] as const

const SECRET_SUFFIXES = ['_API_KEY', '_TOKEN', '_SECRET', '_PASSWORD'] as const

const MAX_REQUEST_ENV_KEYS = 16
const MAX_VALUE_BYTES = 4_096

export interface MergeResult {
  /** Merged env: base ∪ accepted request overrides (overrides win). */
  env: NodeJS.ProcessEnv
  /** Request keys that were dropped + the reason — surfaced for logs / debug. */
  dropped: Array<{ key: string; reason: string }>
}

/**
 * Merge per-request env overrides onto a base env. Drops (with reasons) any
 * key that fails the allowlist, hits the secret-suffix forbid list, exceeds
 * size limits, or arrives past the per-request count cap. Returns the merged
 * env and the dropped-list so the caller can log forensically. Never throws —
 * a malicious / malformed request can't break the spawn path.
 */
export function applyRequestEnvOverrides(
  base: NodeJS.ProcessEnv,
  requestEnv: Record<string, string> | undefined,
): MergeResult {
  const merged: NodeJS.ProcessEnv = { ...base }
  const dropped: Array<{ key: string; reason: string }> = []
  if (!requestEnv) return { env: merged, dropped }

  let accepted = 0
  for (const [rawKey, rawValue] of Object.entries(requestEnv)) {
    const key = String(rawKey)
    const value = rawValue == null ? '' : String(rawValue)
    if (accepted >= MAX_REQUEST_ENV_KEYS) {
      dropped.push({ key, reason: `over per-request cap of ${MAX_REQUEST_ENV_KEYS}` })
      continue
    }
    if (!isAllowedKey(key)) {
      dropped.push({ key, reason: 'key not on allowlist' })
      continue
    }
    if (SECRET_SUFFIXES.some((s) => key.endsWith(s))) {
      dropped.push({ key, reason: 'secret-suffix forbidden (set in boot env, not request)' })
      continue
    }
    if (value.length === 0) {
      dropped.push({ key, reason: 'empty value' })
      continue
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
      dropped.push({ key, reason: `value exceeds ${MAX_VALUE_BYTES} bytes` })
      continue
    }
    merged[key] = value
    accepted += 1
  }
  return { env: merged, dropped }
}

function isAllowedKey(key: string): boolean {
  // Allowlist is prefix-based; an exact key match against `TANGLE_SEARCH_` etc.
  // doesn't pass (must be a real var name like `TANGLE_SEARCH_DEFAULT_PROVIDER`).
  return REQUEST_ENV_ALLOWED_PREFIXES.some((p) => key.startsWith(p) && key.length > p.length)
}
