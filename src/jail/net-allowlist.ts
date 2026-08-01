/**
 * The net-jail allowlist — which `host:port` pairs a confined worker may reach,
 * and where each entry came from.
 *
 * Deny-by-default is only usable if the agent's own model endpoint survives it,
 * so the endpoint is DERIVED from the backend configuration rather than typed
 * by the caller. A caller asking for a net-jail names no hosts and still gets a
 * working agent; a caller who had to name the endpoint would eventually name
 * the wrong one, and the failure mode of a wrong entry is a jail that silently
 * denies the model or silently permits an extra host.
 *
 * Every entry carries its `source` so the startup log and every refusal can say
 * WHY a host is on the list. An allowlist you cannot explain is one nobody will
 * trust enough to keep narrow.
 */

export interface NetJailAllowEntry {
  /** Lowercased DNS name or IP literal. */
  host: string
  port: number
  /** The env var, config field, or backend default this entry came from. */
  source: string
}

/**
 * Hosts are used as Docker network-scoped aliases and as env-var payloads, so
 * the accepted shape is the intersection of "valid DNS name" and "one safe
 * token": letters, digits, dots and hyphens. Commas in particular are excluded
 * because the allowlist is comma-joined on the way to the relay.
 */
const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u

/** Default port for a scheme, so an operator can write a bare hostname. */
const SCHEME_PORTS: Record<string, number> = { 'https:': 443, 'http:': 80 }

/**
 * Parse one `host` or `host:port` token. A bare host defaults to 443: every
 * model endpoint this bridge talks to is HTTPS, and defaulting to 80 would
 * produce an allowlist that looks right and denies every real request.
 */
export function parseAllowEntry(raw: string, source: string): NetJailAllowEntry {
  const token = raw.trim()
  const idx = token.lastIndexOf(':')
  const host = (idx > 0 ? token.slice(0, idx) : token).toLowerCase()
  const portText = idx > 0 ? token.slice(idx + 1) : '443'
  const port = Number(portText)
  if (!HOST_PATTERN.test(host)) {
    throw new Error(
      `invalid net-jail allowlist host '${host}' (from ${source}): expected a DNS name or IP literal ` +
        'built from letters, digits, dots and hyphens',
    )
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid net-jail allowlist port '${portText}' (from ${source}): expected 1-65535`)
  }
  return { host, port, source }
}

/** Parse a comma-separated operator list. Empty input yields no entries. */
export function parseAllowList(raw: string | undefined, source: string): NetJailAllowEntry[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => parseAllowEntry(token, source))
}

/** Canonical `host:port` form — the comparison key everywhere downstream. */
export function formatAllowEntry(entry: NetJailAllowEntry): string {
  return `${entry.host}:${entry.port}`
}

/** Sorted, de-duplicated `host:port` list. Order is stable so two allowlists
 * built from differently-ordered sources compare equal. */
export function canonicalAllowList(entries: NetJailAllowEntry[]): string[] {
  return [...new Set(entries.map(formatAllowEntry))].sort()
}

/**
 * Turn a base URL into an allowlist entry, or null when it is absent/unparsable.
 * An unparsable base URL is not an error here: the backend would fail on it
 * long before the jail does, and inventing a host from a broken URL would put
 * something on the allowlist that nobody configured.
 */
function entryFromUrl(raw: string | null | undefined, source: string): NetJailAllowEntry | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (!HOST_PATTERN.test(host)) return null
  const port = url.port ? Number(url.port) : SCHEME_PORTS[url.protocol]
  if (!port) return null
  return { host, port, source }
}

/** Base-URL env vars the docker executor already proxies into worker
 * containers. These are where a "resolved backend config" base URL such as
 * `https://router.tangle.tools/v1` actually lives on this path. */
const BASE_URL_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'TANGLE_ROUTER_URL',
  'MOONSHOT_BASE_URL',
  'ZAI_BASE_URL',
] as const

/**
 * Per-backend model endpoint derivation.
 *
 *   `overrides` — env vars that, when set, ARE this CLI's endpoint. Any of them
 *     present suppresses `defaults`, because adding both would widen the jail
 *     to a provider the operator deliberately routed away from.
 *   `defaults` — where this CLI sends traffic when nothing is configured. These
 *     are per-CLI facts, not guesses at the caller's intent.
 *
 * Multi-provider CLIs (opencode, pi) have no single default endpoint, so they
 * derive only from configured base URLs. When none is set they yield nothing
 * and the operator is told to name the endpoint through `BRIDGE_NET_JAIL_ALLOW`
 * — better than handing back a jail that quietly denies the model.
 */
const BACKEND_ENDPOINTS: Record<string, { overrides: readonly string[]; defaults: readonly string[] }> = {
  claude: { overrides: ['ANTHROPIC_BASE_URL'], defaults: ['api.anthropic.com:443'] },
  kimi: { overrides: ['ANTHROPIC_BASE_URL', 'MOONSHOT_BASE_URL'], defaults: ['api.moonshot.ai:443'] },
  gemini: { overrides: [], defaults: ['generativelanguage.googleapis.com:443'] },
  // Codex authenticates against the ChatGPT web endpoint and calls the API
  // host; a jail with only one of the two leaves the CLI unable to start.
  codex: { overrides: ['OPENAI_BASE_URL'], defaults: ['api.openai.com:443', 'chatgpt.com:443'] },
  opencode: { overrides: BASE_URL_ENV_KEYS, defaults: [] },
  pi: { overrides: BASE_URL_ENV_KEYS, defaults: [] },
}

export function modelEndpointsFor(backend: string, env: NodeJS.ProcessEnv): NetJailAllowEntry[] {
  const spec = BACKEND_ENDPOINTS[backend] ?? { overrides: BASE_URL_ENV_KEYS, defaults: [] }
  const entries: NetJailAllowEntry[] = []
  for (const key of spec.overrides) {
    const entry = entryFromUrl(env[key], key)
    if (entry) entries.push(entry)
  }
  if (entries.length === 0) {
    for (const token of spec.defaults) {
      entries.push(parseAllowEntry(token, `${backend} default model endpoint`))
    }
  }
  return entries
}
