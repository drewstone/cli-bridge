import type { ChatRequest } from '../backends/types.js'
import type { SessionProfileBinding } from './store.js'

/** Resume authority shared by admission and native session updates. */
export function legacyRequestMetadata(req: ChatRequest, request: Record<string, unknown>, binding: SessionProfileBinding | null): Record<string, unknown> {
  return {
    ...(Object.keys(request).length > 0 ? { request_metadata: request } : {}),
    model: req.model,
    ...(req.agent_profile ? { agent_profile: req.agent_profile } : {}),
    ...(binding ? { agent_profile_binding: binding } : {}),
    ...(req.execution ? { execution: req.execution } : {}),
    ...(req.env ? { env: req.env } : {}),
    ...(req.context ? { context: req.context } : {}),
    ...(req.providerOptions ? { provider_options: req.providerOptions } : {}),
    ...(req.mcp ? { mcp: req.mcp } : {}),
    ...(req.profile_materialization_receipt ? { profile_materialization: req.profile_materialization_receipt } : {}),
  }
}
