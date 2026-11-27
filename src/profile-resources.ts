/**
 * GitHub resources an AgentProfile names, fetched before the harness starts.
 *
 * A profile can name its skills, files, tools, agents, commands and
 * instructions by GitHub reference. Materialization writes bytes synchronously
 * and refuses a reference it cannot read ("github refs need async
 * pre-resolution"), so the Bridge fetches every reference to inline bytes when
 * it admits the request, with the resolver the Sandbox SDK and agent-runtime
 * use. The declared profile stays the request's identity: its digest, the
 * session binding and the receipts name the references. Only the files written
 * to the workspace carry the fetched bytes.
 *
 * The fetched resources are found again by the declared resources' content,
 * not by the request object: the chat route copies a request to add its
 * timeout, and a context transfer builds a new request from its plan, and both
 * must write the bytes admission fetched. Every admission fetches again, so a
 * reference to a branch is as fresh as the turn that names it.
 *
 * A reference pinned to a full commit names fixed bytes, so the Bridge keeps
 * what it fetched for it and later turns reuse it instead of fetching again.
 */
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type {
  AgentProfile,
  AgentProfileResourceRef as ResourceRef,
  AgentProfileResources as Resources,
} from '@tangle-network/agent-interface'
import { resolveAgentProfileResources } from '@tangle-network/agent-profile-materialize'
import { BackendError, type ChatRequest } from './backends/types.js'

/** Requests whose admission already fetched; a retained turn and the chat route both admit. */
const admitted = new WeakSet<ChatRequest>()

/** Fetched resources by the declared resources' content key, oldest first; bounded by total bytes. */
const resolvedResources = new Map<string, { resources: Resources; bytes: number }>()
const MAX_RESOLVED_BYTES = 256 * 1024 * 1024
let resolvedBytes = 0

/** Bodies of commit-pinned references, oldest first; bounded by total bytes. */
const pinned = new Map<string, ResourceRef>()
const MAX_PINNED_BYTES = 64 * 1024 * 1024
let pinnedBytes = 0

const COMMIT = /^[0-9a-f]{40}$/

function pinnedKey(ref: ResourceRef): string | null {
  if (ref.kind !== 'github' || ref.repository === undefined || ref.ref === undefined) return null
  return COMMIT.test(ref.ref) ? `${ref.repository}@${ref.ref}:${ref.path}#${ref.name ?? basename(ref.path)}` : null
}

function contentBytes(ref: ResourceRef): number {
  return ref.kind === 'inline' ? Buffer.byteLength(ref.content) : 0
}

function keep(key: string, resolved: ResourceRef): void {
  if (resolved.kind !== 'inline' || pinned.has(key)) return
  const bytes = contentBytes(resolved)
  if (bytes > MAX_PINNED_BYTES) return
  pinned.set(key, resolved)
  pinnedBytes += bytes
  for (const [oldest, ref] of pinned) {
    if (pinnedBytes <= MAX_PINNED_BYTES) break
    pinned.delete(oldest)
    pinnedBytes -= contentBytes(ref)
  }
}

/** JSON with object keys sorted, so equal resources give one key whatever their key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function resourcesKey(resources: Resources): string {
  return createHash('sha256').update(stableJson(resources)).digest('hex')
}

function remember(key: string, resources: Resources): void {
  const previous = resolvedResources.get(key)
  if (previous !== undefined) {
    resolvedResources.delete(key)
    resolvedBytes -= previous.bytes
  }
  const bytes = refsOf(resources).reduce((total, ref) => total + contentBytes(ref), 0)
  resolvedResources.set(key, { resources, bytes })
  resolvedBytes += bytes
  for (const [oldest, entry] of resolvedResources) {
    if (resolvedBytes <= MAX_RESOLVED_BYTES || oldest === key) break
    resolvedResources.delete(oldest)
    resolvedBytes -= entry.bytes
  }
}

/** Apply `map` to every reference, in one fixed order. */
function mapRefs(resources: Resources, map: (ref: ResourceRef) => ResourceRef): Resources {
  const list = (values: ResourceRef[] | undefined) => values?.map(map)
  return {
    ...resources,
    ...(resources.files === undefined
      ? {}
      : { files: resources.files.map((mount) => ({ ...mount, resource: map(mount.resource) })) }),
    ...(resources.tools === undefined ? {} : { tools: list(resources.tools) }),
    ...(resources.skills === undefined ? {} : { skills: list(resources.skills) }),
    ...(resources.agents === undefined ? {} : { agents: list(resources.agents) }),
    ...(resources.commands === undefined ? {} : { commands: list(resources.commands) }),
    ...(typeof resources.instructions === 'object' ? { instructions: map(resources.instructions) } : {}),
  }
}

function refsOf(resources: Resources): ResourceRef[] {
  const refs: ResourceRef[] = []
  mapRefs(resources, (ref) => {
    refs.push(ref)
    return ref
  })
  return refs
}

/**
 * Fetch the GitHub resources of the request's profile. A request whose run
 * executes in a Sandbox is left alone: the Sandbox SDK resolves its own. A
 * reference that cannot be fetched fails the request before any harness starts.
 */
export async function resolveProfileResources(
  req: ChatRequest,
  profile: AgentProfile | null,
  backend: string,
  signal: AbortSignal,
): Promise<void> {
  if (admitted.has(req) || req.execution?.kind === 'sandbox' || backend === 'sandbox') return
  await fetchProfileResources(profile, signal)
  admitted.add(req)
}

/** Fetch the GitHub resources a profile names, so the workspace written for it carries their bytes. */
export async function fetchProfileResources(profile: AgentProfile | null, signal: AbortSignal): Promise<void> {
  const resources = profile?.resources
  if (resources === undefined || refsOf(resources).every((ref) => ref.kind === 'inline')) return
  const known = mapRefs(resources, (ref) => {
    const key = pinnedKey(ref)
    const hit = key === null ? undefined : pinned.get(key)
    if (hit === undefined || key === null) return ref
    pinned.delete(key)
    pinned.set(key, hit)
    return hit
  })
  let resolved: AgentProfile
  try {
    signal.throwIfAborted()
    resolved = await resolveAgentProfileResources({ ...profile, resources: known } as AgentProfile, {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }),
    })
  } catch (error) {
    if (signal.aborted) throw new BackendError('The request was aborted while its profile resources were fetched', 'aborted', error)
    const message = error instanceof Error ? error.message : String(error)
    throw new BackendError(`AgentProfile resources could not be fetched: ${message}`, 'upstream', error, {
      providerDispatch: 'not_started',
    })
  }
  const declared = refsOf(resources)
  const fetched = refsOf(resolved.resources ?? {})
  for (const [index, ref] of declared.entries()) {
    const key = pinnedKey(ref)
    const value = fetched[index]
    if (key !== null && value !== undefined) keep(key, value)
  }
  remember(resourcesKey(resources), resolved.resources ?? {})
}

/** The profile to materialize: the given one, with the resources fetched for it in place of their references. */
export function withResolvedResources(profile: AgentProfile): AgentProfile {
  if (profile.resources === undefined) return profile
  const key = resourcesKey(profile.resources)
  const entry = resolvedResources.get(key)
  if (entry === undefined) return profile
  resolvedResources.delete(key)
  resolvedResources.set(key, entry)
  return { ...profile, resources: entry.resources }
}
