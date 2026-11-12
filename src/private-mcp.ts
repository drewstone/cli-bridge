import type { AgentProfileConfigValue, AgentProfileSecretProvider } from '@tangle-network/agent-interface'
import type { StartServerOptions } from './server-options.js'
import type { RunSnapshot } from './runs/types.js'
import { BackendError, type ChatRequest } from './backends/types.js'

// A cloned request retains its attachment identity. Neither the values nor the provider enter JSON.
const credentials = new WeakMap<object, Map<string, string>>()
const protectedValues = new WeakMap<object, Set<string>>()

export function privateMcpCredentials(request: ChatRequest): ReadonlyMap<string, string> | undefined {
  return request.runtime_attachments && credentials.get(request.runtime_attachments)
}

/** The transport consumes this private snapshot before parsing or retaining child output. */
export type PrivateRunRedactionObserver = (run: Omit<Parameters<NonNullable<StartServerOptions['onRunRedaction']>>[0], 'redact'>, values: readonly string[], request: ChatRequest) => readonly string[] | void
export function privateExecutionRedaction(request: ChatRequest, run: Pick<RunSnapshot, 'id' | 'requestDigest'>, profileDigest: string | null, observe?: PrivateRunRedactionObserver): readonly string[] {
  const values = [...new Set([
    ...(privateMcpCredentials(request)?.values() ?? []),
    ...(request.runtime_attachments && protectedValues.get(request.runtime_attachments) || []),
    ...(request.runtimeCoordinationBearer ? [request.runtimeCoordinationBearer] : []),
  ])]
  const protected_ = observe?.({ runId: run.id, requestDigest: run.requestDigest, sessionId: request.session_id ?? null,
    profileDigest, cwd: request.cwd ?? null }, values, request)
  return protected_ || values
}

/** Host-owned grants share the existing private attachment identity, never its JSON value. */
export function protectExecutionValues(request: ChatRequest, values: readonly string[]): () => void {
  request.runtime_attachments ??= { mcp: {} }
  const identity = request.runtime_attachments
  const protected_ = protectedValues.get(identity) ?? new Set<string>()
  for (const value of values) protected_.add(value)
  protectedValues.set(identity, protected_)
  return () => {
    for (const value of values) protected_.delete(value)
    if (protected_.size === 0) protectedValues.delete(identity)
  }
}

/** Resolve only declared MCP references for an embedded host's private Claude/Codex config. */
export async function preparePrivateMcp(
  request: ChatRequest,
  provider: AgentProfileSecretProvider | undefined,
  backend: string,
  signal: AbortSignal,
): Promise<(() => void) | undefined> {
  const references = new Map<string, { header: boolean }>()
  for (const server of Object.values(request.agent_profile?.mcp ?? {})) {
    if (server.enabled === false) continue
    for (const value of server.args ?? []) {
      if (value.kind === 'secret-ref') throw new BackendError('MCP secrets cannot appear in argv; use env or headers', 'parse_error')
    }
    for (const [kind, values] of [['env', server.env], ['headers', server.headers]] as const) {
      for (const value of Object.values(values ?? {})) {
        if (value.kind !== 'secret-ref') continue
        if (value.format !== undefined && value.format !== 'raw' && value.format !== 'bearer')
          throw new BackendError('MCP secret reference format must be raw or bearer', 'parse_error')
        references.set(value.key, { header: kind === 'headers' || references.get(value.key)?.header === true })
      }
    }
  }
  if (!references.size) return
  if (!provider) throw new BackendError('This Bridge has no host-owned MCP secret provider', 'not_configured')
  if (!['claude', 'claude-code', 'codex'].includes(backend) || request.execution?.kind === 'sandbox')
    throw new BackendError(`Private MCP credentials require a local Claude or Codex private config; backend ${JSON.stringify(backend)} is unsupported`, 'not_configured')
  const values = new Map<string, string>()
  for (const [key, { header }] of references) {
    signal.throwIfAborted()
    let value: string | undefined
    try { value = await provider.get(key) }
    catch { throw new BackendError(`MCP secret ${JSON.stringify(key)} could not be resolved by its host`, 'not_configured') }
    signal.throwIfAborted()
    if (typeof value !== 'string' || !value.trim() || value.length > 16 * 1024 || value.includes('\0') || (header && /[\r\n]/u.test(value)))
      throw new BackendError(`MCP secret ${JSON.stringify(key)} is missing or invalid for its declared destination`, 'not_configured')
    values.set(key, value)
  }
  request.runtime_attachments ??= { mcp: {} }
  const identity = request.runtime_attachments
  credentials.set(identity, values)
  return () => { credentials.delete(identity); values.clear() }
}

/** Backend admission is checked again at the only boundary that writes private MCP config. */
export function resolvePrivateMcpValue(
  value: AgentProfileConfigValue,
  destination?: { backend: string; privateMcpConfig: boolean; secrets?: ReadonlyMap<string, string> },
): string | undefined {
  if (value?.kind !== 'secret-ref' || !destination?.secrets?.has(value.key)) return
  if (!destination.privateMcpConfig || !['claude', 'claude-code', 'codex'].includes(destination.backend))
    throw new BackendError('MCP credentials cannot be written to a nonprivate backend config', 'parse_error')
  const raw = destination.secrets.get(value.key)!
  return value.format === 'bearer' ? `Bearer ${raw}` : raw
}
