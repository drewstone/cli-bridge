import type { AgentProfile } from '@tangle-network/agent-interface'
import { HubMcpScope, createHubMcpRoutes, lowerProfileConnections } from '@tangle-network/hub-sdk/mcp'
import type { Hono } from 'hono'
import type { StartServerOptions } from './server-options.js'
import { BackendError, type ChatRequest } from './backends/types.js'

const workspaceProfiles = new WeakMap<ChatRequest, AgentProfile>()

export function workspaceProfile(req: ChatRequest, original: AgentProfile): AgentProfile {
  return workspaceProfiles.get(req) ?? original
}

export function mountHubMcp(app: Hono, options: NonNullable<StartServerOptions['hub']>) {
  const scope = new HubMcpScope(options)
  app.route('/hub/mcp', createHubMcpRoutes(scope))
  return {
    close: () => scope.close(),
    async prepare(req: ChatRequest, signal: AbortSignal) {
      const profile = req.agent_profile as AgentProfile | undefined
      if (!profile?.connections?.length) return
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
        if (workspaceProfile) workspaceProfiles.set(req, workspaceProfile)
        req.runtime_attachments = { mcp: { ...existing, ...resolved.mcp } }
      } catch (error) {
        for (const token of resolved.grantTokens) scope.revoke(token)
        throw error
      }
    },
  }
}
