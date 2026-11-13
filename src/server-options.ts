import type { AgentProfileMcpServer, AgentProfileSecretProvider } from '@tangle-network/agent-interface'
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
  /** Trusted embedded-host port. Values stay outside requests, profiles and durable records. */
  mcpSecrets?: AgentProfileSecretProvider
  /** Live host-only redaction authority, valid through terminal capture and revoked at server close. */
  onRunRedaction?: (run: Readonly<{
    runId: string
    requestDigest: string
    sessionId: string | null
    profileDigest: string | null
    cwd: string | null
    redact(bytes: Uint8Array): Uint8Array
  }>) => void
  /** Embedded local one-shot runs share this listener's revocable Hub scope. */
  hub?: HubMcpScopeOptions & {
    client: HubClient
    serverForGrant(token: string): AgentProfileMcpServer
  }
}

export interface BridgeServer {
  url: string
  /** Host-only listener authority from Runtime's actual bound publicUrl resolver; never an HTTP route. */
  registerCoordinationEndpoint(input: { runId: string; actorId: string; url: string; signal: AbortSignal }): () => void
  /** In-process embedder authority only: no HTTP route, request field or environment variable registers one. Only a
   * bearer-authenticated request's `runtime_attachments.mcp` entry naming this exact loopback URL claims it, with that
   * request's own resolved secret-refs. Identical registrations share the route until the last revoke; different paths
   * are refused. `runId` is audit context, never authority. */
  registerPrivateMcpEndpoint(input: {
    runId: string
    url: string
    paths: Readonly<Record<string, readonly ('GET' | 'POST' | 'DELETE')[]>>
    signal: AbortSignal
  }): () => void
  /** Stop only this listener and its owned work, then release its durable writer lock. */
  close(): Promise<void>
}
