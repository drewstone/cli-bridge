/** Trusted host scopes grant routes; authored profiles and HTTP requests cannot register one. */
import type { AgentProfileMcpServer } from '@tangle-network/agent-interface'
import { BackendError, type ChatRequest, type McpServerSpec } from './backends/types.js'
import { claimTrustedHostService, registerTrustedHostService, type TrustedHostServiceOwner } from './jail/egress-relay.js'
import { selectJailBackend } from './jail/index.js'
import { privateMcpCredentials, protectExecutionValues, resolvePrivateMcpValue } from './private-mcp.js'
import { isSafeWireIdentifier } from './runs/identifiers.js'
import { RUNTIME_COORDINATION_ENV_NAME } from './sessions/retained/contract.js'
import type { JailSpec } from './jail/types.js'
import type { BridgeServer } from './server-options.js'

/** `strip` names the lower-case native headers whose values moved into the trusted claim. */
type Binding = { canonicalUrl: string; nativeUrl: string; field: 'url' | 'hub-env'; strip: readonly string[] }
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
function bindClaim(
  request: ChatRequest, spec: JailSpec, alias: string, binding: Omit<Binding, 'nativeUrl'>,
  owner: TrustedHostServiceOwner, headers?: Readonly<Record<string, string>>,
): () => void {
  const identity = request.runtime_attachments!
  const bindings = privateBindings.get(identity) ?? new Map<string, Binding>()
  if (bindings.has(alias)) return refused('A private MCP alias already has a trusted host-service binding')
  const claim = claimTrustedHostService(owner, headers)
  let releaseProtected = () => {}
  const release = () => {
    try { claim.revoke() } finally {
      bindings.delete(alias)
      if (!bindings.size) privateBindings.delete(identity)
      if (spec.trustedHostServices) spec.trustedHostServices = spec.trustedHostServices.filter((entry) => entry !== claim.registration)
      releaseProtected()
    }
  }
  // Anything that fails after the claim revokes it and removes this alias before the error leaves.
  try {
    bindings.set(alias, { ...binding, nativeUrl: claim.nativeUrl })
    privateBindings.set(identity, bindings)
    releaseProtected = protectExecutionValues(request, claim.protectedValues)
    spec.trustedHostServices = [...(spec.trustedHostServices ?? []), claim.registration]
  } catch (error) { release(); throw error }
  return release
}

/** Bind every entry or none: a refusal releases the bindings made before it. */
function bindEach<T>(entries: readonly T[], bind: (entry: T) => () => void): () => void {
  const releases: Array<() => void> = []
  try { for (const entry of entries) releases.push(bind(entry)) }
  catch (error) { for (const release of releases) release(); throw error }
  return () => { for (const release of releases.splice(0)) release() }
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
    const hub = binding.field === 'hub-env'
    if ((hub ? server.env?.TANGLE_HUB_MCP_ENDPOINT : server.url) !== binding.canonicalUrl) return refused(`MCP endpoint ${JSON.stringify(alias)} changed after trusted admission`)
    const headers = Object.fromEntries(Object.entries(server.headers ?? {}).filter(([name]) => !binding.strip.includes(name.toLowerCase())))
    rewritten[alias] = hub ? { ...server, env: { ...server.env, TANGLE_HUB_MCP_ENDPOINT: binding.nativeUrl } }
      : { ...server, url: binding.nativeUrl, ...(server.headers ? { headers } : {}) }
  }
  return rewritten
}

export function createHostServiceBindings(bearerRequired: boolean, quiet = false) {
  // Operator audit context, silenced with startServer's startup lines. Run ids here are never authority.
  const audit = (event: 'register' | 'claim', runIds: readonly string[], url: string) => {
    if (!quiet) process.stderr.write(`[host-services] private-mcp ${event} run=${runIds.join(',')} endpoint=${new URL(url).host}\n`)
  }
  let listener: string | undefined
  let closed = false
  const hubReleases = new Set<() => void>()
  const coordinators = new Map<string, { runId: string; actorId: string; signal: AbortSignal; owner: TrustedHostServiceOwner; revoke(): void }>()
  // One owner per exact URL; identical registrations share it until the last registrant's revoke.
  const privateEndpoints = new Map<string, { paths: string; owner: TrustedHostServiceOwner; runIds: Map<() => void, string>; release(): void }>()
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
    registerPrivateMcpEndpoint(input: Parameters<BridgeServer['registerPrivateMcpEndpoint']>[0]): () => void {
      if (closed || input.signal.aborted || !isSafeWireIdentifier(input.runId))
        return refused('Private MCP registration requires a live signal and a safe run id')
      if (input.url.includes('?')) return refused('Private MCP registration refuses a URL with a query string')
      const paths = JSON.stringify(Object.keys(input.paths).sort().map((suffix) => [suffix, [...new Set(input.paths[suffix])].sort()]))
      let endpoint = privateEndpoints.get(input.url)
      if (endpoint && endpoint.paths !== paths) return refused('That private MCP endpoint is already registered with different paths')
      if (!endpoint) {
        const service = registerTrustedHostService({ url: input.url, paths: input.paths })
        endpoint = { paths, owner: service.owner, runIds: new Map(), release: service.revoke }
        privateEndpoints.set(input.url, endpoint)
      }
      const owned = endpoint
      const revoke = () => {
        if (!owned.runIds.delete(revoke)) return
        input.signal.removeEventListener('abort', revoke)
        if (owned.runIds.size) return
        privateEndpoints.delete(input.url)
        owned.release()
      }
      owned.runIds.set(revoke, input.runId)
      input.signal.addEventListener('abort', revoke, { once: true })
      audit('register', [input.runId], input.url)
      return revoke
    },
    async prepareCoordination(request: ChatRequest, backend: string): Promise<() => void> {
      const attachments = Object.entries(request.runtime_attachments?.mcp ?? {}).filter(([, server]) =>
        Object.values(server.headers ?? {}).some((value) => value.kind === 'secret-ref' && value.key === RUNTIME_COORDINATION_ENV_NAME))
      const spec = attachments.length ? await relaySpec(request, backend) : undefined
      if (!spec) return () => {}
      return bindEach(attachments, ([alias, server]) => {
        const authorization = Object.entries(server.headers ?? {}).filter(([name]) => name.toLowerCase() === 'authorization')
        const value = authorization[0]?.[1]
        const owner = server.url && coordinators.get(server.url)
        if (closed || !owner || owner.signal.aborted || !request.runtimeCoordinationBearer || authorization.length !== 1 ||
          !value || value.kind !== 'secret-ref' || value.key !== RUNTIME_COORDINATION_ENV_NAME || value.format !== 'bearer') {
          return refused('Framework coordination requires its live host-owned listener and exact private token reference')
        }
        return bindClaim(request, spec, alias, { canonicalUrl: server.url!, field: 'url', strip: ['authorization'] },
          owner.owner, { Authorization: `Bearer ${request.runtimeCoordinationBearer}` })
      })
    },
    /** Claims come only from this authenticated request's runtime_attachments, carrying only its own resolved secret-refs. */
    async preparePrivateEndpoints(request: ChatRequest, backend: string): Promise<() => void> {
      // bwrap unshares the network, so an authored loopback URL could only hang; only an attachment claims a registered route.
      // A sandbox request carries no jailSpec unless the sandbox backend runs it, whose loopback is its own.
      const authored = Object.entries(request.agent_profile?.mcp ?? {}).find(([, server]) => URL.canParse(server.url ?? '')
        && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(server.url!).hostname))?.[0]
      const jail = authored && request.jailSpec && backend !== 'sandbox' ? selectJailBackend() : undefined
      if (jail?.name === 'bwrap' && await jail.isAvailable())
        return refused(`MCP server ${JSON.stringify(authored)} is on host loopback; a jailed seat reaches it only as a runtime attachment to a live host-registered private endpoint`)
      const bound = request.runtime_attachments && privateBindings.get(request.runtime_attachments)
      const attachments = Object.entries(request.runtime_attachments?.mcp ?? {})
        .filter(([alias, server]) => /^http:/iu.test(server.url ?? '') && !bound?.has(alias))
      const spec = attachments.length ? await relaySpec(request, backend) : undefined
      if (!spec) return () => {}
      if (!bearerRequired) return refused('Private MCP routing requires a bearer-authenticated Bridge')
      const destination = { backend, privateMcpConfig: true, secrets: privateMcpCredentials(request) }
      return bindEach(attachments, ([alias, server]) => {
        const endpoint = privateEndpoints.get(server.url!)
        if (!endpoint) return refused(`Plain-HTTP MCP attachment ${JSON.stringify(alias)} in the jail requires a live host-registered private endpoint`)
        const headers: Record<string, string> = {}
        for (const [name, value] of Object.entries(server.headers ?? {})) {
          if (value.kind !== 'secret-ref')
            return refused(`Private MCP attachment header ${JSON.stringify(name)} must be a secret-ref; the relay forwards no other header`)
          headers[name] = resolvePrivateMcpValue(value, destination) ?? refused('A private MCP attachment secret was not resolved by its host')
        }
        const strip = Object.keys(headers).map((name) => name.toLowerCase())
        const release = bindClaim(request, spec, alias, { canonicalUrl: server.url!, field: 'url', strip }, endpoint.owner, headers)
        audit('claim', [...endpoint.runIds.values()], server.url!)
        return release
      })
    },
    async prepareHub(request: ChatRequest, backend: string, servers: Record<string, AgentProfileMcpServer>, tokens: readonly string[]): Promise<() => void> {
      const spec = await relaySpec(request, backend)
      if (!spec) return () => {}
      if (closed || !listener) return refused('Hub host-service routing requires this Bridge actual loopback listener')
      return bindEach(Object.entries(servers), ([alias, server]) => {
        const env = server.env?.TANGLE_HUB_MCP_ENDPOINT
        const raw = server.url ?? (env?.kind === 'public' ? env.value : undefined)
        const expected = tokens.map((token) => `${listener}/hub/mcp/grants/${token}`).find((url) => url === raw)
        if (!expected) return refused('The Hub MCP configuration does not name a grant on this owned listener')
        const service = registerTrustedHostService({ url: expected, paths: { '/tools': ['GET'], '/call': ['POST'] } })
        let release: () => void
        try { release = bindClaim(request, spec, alias, { canonicalUrl: expected, field: server.url ? 'url' : 'hub-env', strip: [] }, service.owner) }
        catch (error) { service.revoke(); throw error }
        const cleanup = () => { if (hubReleases.delete(cleanup)) { try { release() } finally { service.revoke() } } }
        hubReleases.add(cleanup)
        return cleanup
      })
    },
    close() {
      closed = true
      listener = undefined
      for (const release of [...hubReleases]) release()
      for (const { revoke } of [...coordinators.values()]) revoke()
      for (const { runIds } of [...privateEndpoints.values()]) for (const revoke of [...runIds.keys()]) revoke()
    },
  }
}
