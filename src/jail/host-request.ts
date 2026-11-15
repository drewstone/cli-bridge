import { BackendError, type ChatRequest } from '../backends/types.js'
import { authSourcesFor } from './auth-preserve.js'
import { vendorHostsFor } from './egress.js'
import { resolveJailSpec } from './resolve-spec.js'

/** The host jail one request runs under; a bridge-restart continuation resolves it the same way. */
export function hostRequestJail(req: ChatRequest, backendName: string, env: NodeJS.ProcessEnv): ChatRequest['jailSpec'] {
  const jailSpec = resolveJailSpec({
    execMode: req.execution?.kind === 'host' ? req.execution.jail?.mode : undefined,
    execRoot: req.execution?.kind === 'host' ? req.execution.jail?.root : undefined,
    execNetwork: req.execution?.kind === 'host' ? req.execution.jail?.network : undefined,
    cwd: req.cwd ?? process.cwd(),
    env,
  })
  const proxySecrets = req.agent_profile?.proxySecrets
  if (proxySecrets?.length && !jailSpec) {
    throw new BackendError('agent_profile.proxySecrets require execution.jail with network relay', 'parse_error')
  }
  if (jailSpec) {
    jailSpec.authSources = authSourcesFor(backendName)
    jailSpec.vendorHosts = vendorHostsFor(backendName)
    if (proxySecrets?.length) jailSpec.proxySecrets = proxySecrets
  }
  return jailSpec
}
