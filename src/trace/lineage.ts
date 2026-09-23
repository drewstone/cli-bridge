/**
 * Session lineage a caller hands the harness child it asks the bridge to run.
 *
 * agent-runtime's bridge arm sends the worker's lineage ids as `x-tangle-*` request headers
 * (contract v1 of the operator's `lineage` tool, tangle-tools `lineage/README.md`). The bridge
 * turns them into the `TANGLE_*` environment of the child it spawns, so the harness session is the
 * run the caller already recorded, and a Claude Code child's SessionStart hook binds its session to
 * that run instead of minting a new one.
 *
 * A request without `x-tangle-run-id` stamps nothing: the child env stays byte-identical. Header
 * values are checked against a narrow charset and length, so a caller cannot inject arbitrary
 * environment content through them.
 */

import { hostname } from 'node:os'

const HEADER_KEYS = {
  'x-tangle-run-id': 'TANGLE_RUN_ID',
  'x-tangle-parent-run-id': 'TANGLE_PARENT_RUN_ID',
  'x-tangle-root-run-id': 'TANGLE_ROOT_RUN_ID',
  'x-tangle-edge-kind': 'TANGLE_EDGE_KIND',
  'x-tangle-operator': 'TANGLE_OPERATOR',
  'x-tangle-project': 'TANGLE_PROJECT',
  'x-tangle-account': 'TANGLE_ACCOUNT',
  'x-tangle-harness': 'TANGLE_HARNESS',
} as const

const OTEL_KEYS: Record<string, string> = {
  TANGLE_RUN_ID: 'tangle.run.id',
  TANGLE_PARENT_RUN_ID: 'tangle.parent_run.id',
  TANGLE_ROOT_RUN_ID: 'tangle.root_run.id',
  TANGLE_EDGE_KIND: 'tangle.edge.kind',
  TANGLE_OPERATOR: 'tangle.operator',
  TANGLE_PROJECT: 'tangle.project',
  TANGLE_ACCOUNT: 'tangle.account',
  TANGLE_HARNESS: 'tangle.harness',
  TANGLE_HOST: 'host.name',
}

/**
 * Every env key the lineage contract owns. The host sanitizer drops these from the inherited env:
 * a child's lineage comes only from its request (`SpawnOpts.lineageEnv`), never from the daemon,
 * whose own `TANGLE_*` would otherwise pass the `TANGLE_` prefix allowlist and make every
 * unstamped child look like a child of whatever shell restarted the bridge.
 */
export const LINEAGE_ENV_KEYS: ReadonlySet<string> = new Set([
  ...Object.values(HEADER_KEYS),
  'TANGLE_HOST',
  'TANGLE_CLAUDE_SESSION',
])

/** Ids, names, emails and project labels; nothing that could carry shell or env syntax. */
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:@+/-]{0,127}$/

export type HeaderReader = (name: string) => string | undefined

export function lineageHost(env: NodeJS.ProcessEnv = process.env): string {
  const name = (env.LINEAGE_HOST || hostname()).trim().toLowerCase()
  return name.endsWith('.local') ? name.slice(0, -'.local'.length) : name
}

/** Merge lineage ids into an OTEL_RESOURCE_ATTRIBUTES value, replacing earlier lineage keys. */
export function lineageOtelAttributes(existing: string | undefined, ids: Readonly<Record<string, string>>): string {
  const ours = new Set(Object.values(OTEL_KEYS))
  const kept = (existing ?? '')
    .split(',')
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0 && !ours.has((pair.split('=', 1)[0] ?? '').trim()))
  for (const [envKey, attr] of Object.entries(OTEL_KEYS)) {
    const value = ids[envKey]
    if (value) kept.push(`${attr}=${encodeURIComponent(value)}`)
  }
  return kept.join(',')
}

/**
 * The child env for a request's lineage headers, or null when the request carries no run id.
 * `TANGLE_HOST` is this bridge's host: the child runs here. `TANGLE_CLAUDE_SESSION` is cleared
 * so a Claude Code child takes the stamped run as its own.
 */
export function lineageChildEnv(
  header: HeaderReader,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | null {
  const ids: Record<string, string> = {}
  for (const [name, key] of Object.entries(HEADER_KEYS)) {
    const value = header(name)?.trim()
    if (value && SAFE_VALUE.test(value)) ids[key] = value
  }
  if (!ids.TANGLE_RUN_ID) return null
  ids.TANGLE_HOST = lineageHost(env)
  return { ...ids, TANGLE_CLAUDE_SESSION: '' }
}

/**
 * Merge a request's lineage over an already-sanitized child env. An undefined env means the
 * child inherits the bridge's whole environment, so the merge starts from that instead.
 */
export function withLineageEnv(
  env: NodeJS.ProcessEnv | undefined,
  lineage: Readonly<Record<string, string>> | null | undefined,
): NodeJS.ProcessEnv | undefined {
  if (!lineage) return env
  const base = env ?? process.env
  return {
    ...base,
    ...lineage,
    OTEL_RESOURCE_ATTRIBUTES: lineageOtelAttributes(base.OTEL_RESOURCE_ATTRIBUTES, lineage),
  }
}
