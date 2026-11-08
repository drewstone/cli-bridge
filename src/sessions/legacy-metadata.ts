import type { ChatRequest } from '../backends/types.js'
import { omitRuntimeCoordinationEnv } from './retained/contract.js'
import type { SessionProfileBinding } from './store.js'

/** Resume authority shared by admission and native session updates. */
export function legacyRequestMetadata(req: ChatRequest, request: Record<string, unknown>, binding: SessionProfileBinding | null): Record<string, unknown> {
  const sessionEnv = omitRuntimeCoordinationEnv(req.env)
  return {
    ...(Object.keys(request).length > 0 ? { request_metadata: request } : {}),
    model: req.model,
    ...(req.agent_profile ? { agent_profile: req.agent_profile } : {}),
    ...(binding ? { agent_profile_binding: binding } : {}),
    ...(req.execution ? { execution: req.execution } : {}),
    ...(sessionEnv ? { env: sessionEnv } : {}),
    ...(req.context ? { context: req.context } : {}),
    ...(req.providerOptions ? { provider_options: req.providerOptions } : {}),
    ...(req.mcp ? { mcp: req.mcp } : {}),
    ...(req.profile_materialization_receipt ? { profile_materialization: req.profile_materialization_receipt } : {}),
  }
}
