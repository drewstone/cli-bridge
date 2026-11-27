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
 * A reference pinned to a full commit names fixed bytes, so the Bridge keeps
 * what it fetched for it and later turns reuse it instead of fetching again.
 */
import { basename } from 'node:path'
import type {
  AgentProfile,
  AgentProfileResourceRef as ResourceRef,
  AgentProfileResources as Resources,
} from '@tangle-network/agent-interface'
import { resolveAgentProfileResources } from '@tangle-network/agent-profile-materialize'
import { BackendError, type ChatRequest } from './backends/types.js'

const resolvedResources = new WeakMap<ChatRequest, Resources>()

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
 * Fetch the GitHub resources of the request's profile, once per request. A
 * request whose run executes in a Sandbox is left alone: the Sandbox SDK
 * resolves its own. A reference that cannot be fetched fails the request before
 * any harness starts.
 */
export async function resolveProfileResources(
  req: ChatRequest,
  profile: AgentProfile | null,
  backend: string,
  signal: AbortSignal,
): Promise<void> {
  if (resolvedResources.has(req)) return
  if (req.execution?.kind === 'sandbox' || backend === 'sandbox') return
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
  resolvedResources.set(req, resolved.resources ?? {})
}

/** The profile to materialize: the given one, with the request's fetched resources in place of their references. */
export function withResolvedResources(req: ChatRequest, profile: AgentProfile): AgentProfile {
  const resources = resolvedResources.get(req)
  return resources === undefined ? profile : { ...profile, resources }
}
