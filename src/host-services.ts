/** Trusted host scopes grant routes; authored profiles and HTTP requests cannot register one. */
import type { AgentProfileMcpServer } from '@tangle-network/agent-interface'
import { BackendError, type ChatRequest, type McpServerSpec } from './backends/types.js'
import { claimTrustedHostService, registerTrustedHostService, type TrustedHostServiceOwner } from './jail/egress-relay.js'
import { selectJailBackend } from './jail/index.js'
import { protectExecutionValues } from './private-mcp.js'
import { isSafeWireIdentifier } from './runs/identifiers.js'
import { RUNTIME_COORDINATION_ENV_NAME } from './sessions/retained/contract.js'
import type { JailSpec } from './jail/types.js'
import type { BridgeServer } from './server-options.js'

type Binding = { canonicalUrl: string; nativeUrl: string; field: 'url' | 'hub-env'; stripAuthorization: boolean }
const privateBindings = new WeakMap<object, Map<string, Binding>>()

function refused(message: string): never {
  throw new BackendError(message, 'not_configured', undefined, { providerDispatch: 'not_started' })
}

/** The same selected backend later consumes JailSpec; native URLs never assume a shim on other transports. */
async function relaySpec(request: ChatRequest, backend: string): Promise<JailSpec | undefined> {
  const spec = request.jailSpec
  if (!spec) return undefined
  const jail = selectJailBackend()
  if (jail.name === 'seatbelt') return undefined // Preserve the current Mac native URLs; no shim listener is installed there.
  if (!['claude', 'claude-code', 'codex', 'opencode'].includes(backend) || request.execution?.kind === 'sandbox') {
    return refused('This backend cannot consume trusted private host-service routing')
  }
  if (jail.name !== 'bwrap' || !await jail.isAvailable()) return refused('Trusted host-service routing requires the available Linux bwrap transport')
  spec.requireEnforcement = true
  return spec
}

// Callers bind only declared runtime attachments, so the request already carries its attachment identity.
function bindClaim(request: ChatRequest, spec: JailSpec, alias: string, binding: Omit<Binding, 'nativeUrl'>, claim: ReturnType<typeof claimTrustedHostService>): () => void {
  const identity = request.runtime_attachments!
  const bindings = privateBindings.get(identity) ?? new Map<string, Binding>()
  if (bindings.has(alias)) return refused('A private MCP alias already has a trusted host-service binding')
  bindings.set(alias, { ...binding, nativeUrl: claim.nativeUrl })
  privateBindings.set(identity, bindings)
  const releaseProtected = protectExecutionValues(request, claim.protectedValues)
  spec.trustedHostServices = [...(spec.trustedHostServices ?? []), claim.registration]
  return () => {
    try { claim.revoke() } finally {
      bindings.delete(alias)
      if (!bindings.size) privateBindings.delete(identity)
      spec.trustedHostServices = spec.trustedHostServices?.filter((entry) => entry !== claim.registration)
      releaseProtected()
    }
  }
}

/** Only normalized private config is rewritten. Profile, request and canonical audience remain untouched. */
export function privateHostServiceMcp(request: ChatRequest, servers: Record<string, McpServerSpec>, privateConfig: boolean): Record<string, McpServerSpec> {
  const bindings = request.runtime_attachments && privateBindings.get(request.runtime_attachments)
  if (!bindings?.size) return servers
  if (!privateConfig) return refused('This backend has no private MCP configuration for trusted host-service routing')
  const rewritten = { ...servers }
  for (const [alias, binding] of bindings) {
    const server = servers[alias]
    if (!server) return refused('The declared private host-service MCP alias was not materialized')
    if (binding.field === 'hub-env') {
      if (server.env?.TANGLE_HUB_MCP_ENDPOINT !== binding.canonicalUrl) return refused('The Hub stdio endpoint changed after trusted admission')
      rewritten[alias] = { ...server, env: { ...server.env, TANGLE_HUB_MCP_ENDPOINT: binding.nativeUrl } }
    } else {
      if (server.url !== binding.canonicalUrl) return refused('The framework MCP endpoint changed after trusted admission')
      const headers = Object.fromEntries(Object.entries(server.headers ?? {}).filter(([name]) => !binding.stripAuthorization || name.toLowerCase() !== 'authorization'))
      rewritten[alias] = { ...server, url: binding.nativeUrl, ...(server.headers ? { headers } : {}) }
    }
  }
  return rewritten
}

export function createHostServiceBindings() {
  let listener: string | undefined
  let closed = false
  const hubReleases = new Set<() => void>()
  const coordinators = new Map<string, { runId: string; actorId: string; signal: AbortSignal; owner: TrustedHostServiceOwner; revoke(): void }>()
  return {
    bindListener(url: string) {
      const origin = new URL(url)
      if (closed || listener || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port) return
      listener = origin.origin
    },
    registerCoordinationEndpoint(input: Parameters<BridgeServer['registerCoordinationEndpoint']>[0]): () => void {
      if (closed || input.signal.aborted || !isSafeWireIdentifier(input.runId) || !isSafeWireIdentifier(input.actorId)) return refused('Coordination registration requires a live owned run and actor listener')
      const url = new URL(input.url)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/mcp' || url.href !== input.url)
        return refused('Coordination registration requires the exact owned loopback MCP listener')
      const prior = coordinators.get(input.url)
      if (prior) {
        if (prior.runId === input.runId && prior.actorId === input.actorId && prior.signal === input.signal) return prior.revoke
        return refused('A different live run or actor already owns that coordination endpoint')
      }
      const service = registerTrustedHostService({ url: input.url, paths: { '': ['POST'] } })
      const revoke = () => {
        if (coordinators.get(input.url)?.owner !== service.owner) return
        input.signal.removeEventListener('abort', revoke)
        coordinators.delete(input.url)
        service.revoke()
      }
      coordinators.set(input.url, { runId: input.runId, actorId: input.actorId, signal: input.signal, owner: service.owner, revoke })
      input.signal.addEventListener('abort', revoke, { once: true })
      return revoke
    },
    async prepareCoordination(request: ChatRequest, backend: string): Promise<() => void> {
      const attachments = Object.entries(request.runtime_attachments?.mcp ?? {}).filter(([, server]) =>
        Object.values(server.headers ?? {}).some((value) => value.kind === 'secret-ref' && value.key === RUNTIME_COORDINATION_ENV_NAME))
      const spec = attachments.length ? await relaySpec(request, backend) : undefined
      if (!spec) return () => {}
      const releases: Array<() => void> = []
      try {
        for (const [alias, server] of attachments) {
          const authorization = Object.entries(server.headers ?? {}).filter(([name]) => name.toLowerCase() === 'authorization')
          const value = authorization[0]?.[1]
          const owner = server.url && coordinators.get(server.url)
          if (closed || !owner || owner.signal.aborted || !request.runtimeCoordinationBearer || authorization.length !== 1 ||
            !value || value.kind !== 'secret-ref' || value.key !== RUNTIME_COORDINATION_ENV_NAME || value.format !== 'bearer') {
            return refused('Framework coordination requires its live host-owned listener and exact private token reference')
          }
          const claim = claimTrustedHostService(owner.owner, { Authorization: `Bearer ${request.runtimeCoordinationBearer}` })
          try { releases.push(bindClaim(request, spec, alias, { canonicalUrl: server.url!, field: 'url', stripAuthorization: true }, claim)) }
          catch (error) { claim.revoke(); throw error }
        }
        return () => { for (const release of releases.splice(0)) release() }
      } catch (error) { for (const release of releases) release(); throw error }
    },
    async prepareHub(request: ChatRequest, backend: string, servers: Record<string, AgentProfileMcpServer>, tokens: readonly string[]): Promise<() => void> {
      const spec = await relaySpec(request, backend)
      if (!spec) return () => {}
      if (closed || !listener) return refused('Hub host-service routing requires this Bridge actual loopback listener')
      const releases: Array<() => void> = []
      try {
        for (const [alias, server] of Object.entries(servers)) {
          const env = server.env?.TANGLE_HUB_MCP_ENDPOINT
          const raw = server.url ?? (env?.kind === 'public' ? env.value : undefined)
          const expected = tokens.map((token) => `${listener}/hub/mcp/grants/${token}`).find((url) => url === raw)
          if (!expected) return refused('The Hub MCP configuration does not name a grant on this owned listener')
          const service = registerTrustedHostService({ url: expected, paths: { '/tools': ['GET'], '/call': ['POST'] } })
          const claim = claimTrustedHostService(service.owner)
          try {
            const release = bindClaim(request, spec, alias, { canonicalUrl: expected, field: server.url ? 'url' : 'hub-env', stripAuthorization: false }, claim)
            const cleanup = () => { if (hubReleases.delete(cleanup)) { try { release() } finally { service.revoke() } } }
            hubReleases.add(cleanup)
            releases.push(cleanup)
          } catch (error) { claim.revoke(); service.revoke(); throw error }
        }
        return () => { for (const release of releases.splice(0)) release() }
      } catch (error) { for (const release of releases) release(); throw error }
    },
    close() {
      closed = true
      listener = undefined
      for (const release of [...hubReleases]) release()
      for (const { revoke } of [...coordinators.values()]) revoke()
    },
  }
}
