import type { AgentProfile } from '@tangle-network/agent-interface'
import { HubMcpScope, createHubMcpRoutes, lowerProfileConnections } from '@tangle-network/hub-sdk/mcp'
import type { Hono } from 'hono'
import type { StartServerOptions } from './server-options.js'
import { BackendError, type ChatRequest } from './backends/types.js'

const workspaceProfiles = new WeakMap<object, AgentProfile>()

export function workspaceProfile(req: ChatRequest, original: AgentProfile): AgentProfile {
  return (req.runtime_attachments && workspaceProfiles.get(req.runtime_attachments)) ?? original
}

export function mountHubMcp(app: Hono, options: NonNullable<StartServerOptions['hub']>) {
  const scope = new HubMcpScope(options)
  app.route('/hub/mcp', createHubMcpRoutes(scope))
  return {
    close: () => scope.close(),
    async prepare(req: ChatRequest, signal: AbortSignal, backend: string) {
      const profile = req.agent_profile as AgentProfile | undefined
      if (!profile?.connections?.length) return
      if (req.execution?.kind === 'sandbox' || backend === 'sandbox') {
        throw new BackendError(
          'Embedded Hub connections require local Bridge execution; use the Sandbox SDK for cloud grants. Run: tangle graph run --help',
          'not_configured', undefined, { providerDispatch: 'not_started' },
        )
      }
      signal.throwIfAborted()
      const resolved = await scope.resolveConnectionsToMcp(options.client, profile.connections, options.serverForGrant)
      try {
        signal.throwIfAborted()
        if (resolved.degraded) throw new BackendError(resolved.degraded.message, 'parse_error')
        const existing = req.runtime_attachments?.mcp ?? {}
        for (const name of Object.keys(resolved.mcp)) {
          if (Object.hasOwn(existing, name)) throw new BackendError(`Hub MCP alias ${JSON.stringify(name)} collides with a runtime attachment`, 'parse_error')
        }
        const { workspaceProfile } = lowerProfileConnections(profile, resolved.mcp)
        req.runtime_attachments = { mcp: { ...existing, ...resolved.mcp } }
        if (workspaceProfile) workspaceProfiles.set(req.runtime_attachments, workspaceProfile)
        return () => { for (const token of resolved.grantTokens) scope.revoke(token) }
      } catch (error) {
        for (const token of resolved.grantTokens) scope.revoke(token)
        throw error
      }
    },
  }
}
