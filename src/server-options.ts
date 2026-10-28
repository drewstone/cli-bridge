import type { AgentProfileMcpServer } from '@tangle-network/agent-interface'
import type { HubClient } from '@tangle-network/hub-sdk'
import type { HubMcpScopeOptions } from '@tangle-network/hub-sdk/mcp'
import type { Config } from './config.js'

export interface StartServerOptions {
  /** Omit to use environment configuration. Port 0 selects an ephemeral listener. */
  config?: Config
  cwd?: string
  /** Embedded callers retain ownership of signals and process-wide error handlers. */
  handleSignals?: boolean
  quiet?: boolean
  /** Embedded one-shot runs share this listener's revocable Hub scope. */
  hub?: HubMcpScopeOptions & {
    client: HubClient
    serverForGrant(token: string): AgentProfileMcpServer
  }
}

export interface BridgeServer {
  url: string
  /** Stop only this listener and its owned work, then release its durable writer lock. */
  close(): Promise<void>
}
