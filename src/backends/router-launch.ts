import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { ChatRequest } from './types.js'

/** Receipt-required deployments deliberately have no subscription fallback. */
export function routerReceiptsRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.BRIDGE_ROUTER_RECEIPTS_REQUIRED
  if (value === undefined || value === '0') return false
  if (value === '1') return true
  throw new Error('BRIDGE_ROUTER_RECEIPTS_REQUIRED must be 0 or 1')
}

export function routerBackendAllowed(name: string): boolean {
  return !routerReceiptsRequired() || name === 'codex'
}

export interface RouterLaunch {
  id: string
  nativeProvider: string
  baseUrl: string
  model: string
  key: string
  headers: Record<string, string>
  searchEnabled: boolean
  directory: string
}

/** Only public request coordinates, never the harness's private resume/thread ID. */
export function prepareRouterLaunch(req: ChatRequest, env: NodeJS.ProcessEnv = process.env): RouterLaunch | null {
  if (!routerReceiptsRequired(env)) return null
  const coordinates = {
    'x-tangle-environment-id': req.environment_id,
    'x-tangle-session-id': req.session_id,
    'x-tangle-execution-id': req.execution_id,
  }
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(coordinates)) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) {
      throw new Error(`Router receipt preflight: missing or invalid ${name}`)
    }
    headers[name] = value
  }
  const route = /^codex\/tangle\/([A-Za-z0-9][A-Za-z0-9._:/-]{0,511})$/u.exec(req.model)
  if (!route) throw new Error('Router receipt preflight: require codex/tangle/<explicit-model-route>')
  if (req.protectedModelCredential) {
    throw new Error('Router receipt preflight: Codex protected-model credentials are not verified')
  }
  if (typeof req.metadata?.router_web_search !== 'boolean') {
    throw new Error('Router receipt preflight: metadata.router_web_search must be an explicit boolean')
  }
  const rawUrl = env.TANGLE_ROUTER_URL
  if (!rawUrl || rawUrl !== rawUrl.trim()) throw new Error('Router receipt preflight: TANGLE_ROUTER_URL is required')
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new Error('Router receipt preflight: invalid Router URL') }
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'router.tangle.tools'
    || url.port || url.username || url.password || url.search || url.hash
    || !['/v1', '/v1/'].includes(url.pathname)
  ) throw new Error('Router receipt preflight: require the production Tangle Router HTTPS /v1 endpoint')
  const key = env.TANGLE_API_KEY
  if (!key || !/^(?=.{1,16384}$)[A-Za-z0-9._~+/-]+=*$/u.test(key)) {
    throw new Error('Router receipt preflight: TANGLE_API_KEY is missing or invalid')
  }
  const directory = env.BRIDGE_LAUNCH_RECORD_DIR
  if (!directory || !isAbsolute(directory)) {
    throw new Error('Router receipt preflight: BRIDGE_LAUNCH_RECORD_DIR must be an absolute private directory')
  }
  const id = randomUUID()
  return {
    id,
    // A fresh table cannot inherit auth, env_http_headers or routing from an operator's provider.
    nativeProvider: `tangle_receipt_${id.replaceAll('-', '')}`,
    baseUrl: `${url.origin}/v1`,
    model: route[1]!,
    key,
    headers,
    searchEnabled: req.metadata.router_web_search,
    directory,
  }
}

export function assertRouterCodexExecution(input: {
  bin: string
  environment: string | undefined
  jail: unknown
  flags: readonly string[]
  env: NodeJS.ProcessEnv
  resumedExternalId?: string
  launch: RouterLaunch
}): void {
  if (!isAbsolute(input.bin) || input.environment !== 'host' || input.jail) {
    throw new Error('Router receipt preflight: require an absolute Codex binary and an unwrapped host executor')
  }
  if (input.env.BRIDGE_HEALTH_READY_CACHE_TTL_MS && input.env.BRIDGE_HEALTH_READY_CACHE_TTL_MS !== '0') {
    throw new Error('Router receipt preflight: cached harness versions are not accepted')
  }
  if (input.resumedExternalId && input.resumedExternalId !== input.launch.headers['x-tangle-session-id']) {
    throw new Error('Router receipt preflight: resumed session does not match the receipt session')
  }
  // The existing materializer owns profile semantics. Refuse conflicting intent instead of silently replacing it.
  for (let i = 0; i < input.flags.length; i += 2) {
    if (!['-c', '--config'].includes(input.flags[i] ?? '') || !input.flags[i + 1]) {
      throw new Error('Router receipt preflight: unverified profile launch flag')
    }
    const override = input.flags[i + 1]!
    if (!/^(?:model_reasoning_effort|model_reasoning_summary|model_verbosity|developer_instructions|model_instructions_file)\s*=/u.test(override)) {
      throw new Error('Router receipt preflight: profile override is not verified for receipt routing')
    }
  }
}

export function assertRouterCodexVersion(version: string | undefined): void {
  if (version !== 'codex-cli 0.155.0') {
    throw new Error('Router receipt preflight: only codex-cli 0.155.0 has a verified native provider-inheritance contract')
  }
}

/**
 * Native -c overrides; no transport, process wrapper, or second adapter.
 *
 * Only the top-level keys are set. codex 0.155.0 rejects the legacy
 * `profile` / `profiles.<name>` pair outright ("legacy `profile` config is no
 * longer supported; use --profile <name> with <name>.config.toml instead"),
 * which aborts the launch before the first model call, and a config profile
 * could only restate the route these keys already own.
 *
 * `name` is required: an empty provider name fails config loading.
 * `--strict-config` (added at the launch site) turns any key this version does
 * not recognize into a refusal, so a silently ignored override cannot spend
 * unattributed tokens.
 */
export function codexRouterArgs(launch: RouterLaunch): string[] {
  const text = (value: string): string => JSON.stringify(value)
  const headers = Object.entries(launch.headers).map(([name, value]) => `${text(name)} = ${text(value)}`).join(', ')
  const provider = [
    'name = "Tangle Router"',
    `base_url = ${text(launch.baseUrl)}`,
    'env_key = "TANGLE_ROUTER_CREDENTIAL"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    'supports_standalone_web_search = false',
    `http_headers = { ${headers} }`,
  ].join(', ')
  return [
    '-c', `model_providers.${launch.nativeProvider} = { ${provider} }`,
    '-c', `model_provider = ${text(launch.nativeProvider)}`,
    '-c', `model = ${text(launch.model)}`,
    '-c', `web_search = ${text(launch.searchEnabled ? 'live' : 'disabled')}`,
  ]
}

export interface LaunchRecordInput {
  version: string
  profileDigest: string | null
  configuredTools: Record<string, boolean> | null
  mcpServers: string[]
}

/** Persist alongside the raw JSONL, without upgrading configuration evidence into billed spend. */
export function openRouterLaunchRecord(launch: RouterLaunch, input: LaunchRecordInput): {
  append(line: string): void
  observeTool(name: string): void
  terminal(kind: 'completed' | 'error'): void
  termination(outcome: 'stopped' | 'failed' | 'unknown'): void
  close(outcome: 'closed' | 'failed' | 'aborted'): void
} {
  const directory = join(launch.directory, launch.id)
  mkdirSync(directory, { mode: 0o700 })
  const transcriptPath = join(directory, 'transcript.jsonl')
  const recordPath = join(directory, 'launch.json')
  const fd = openSync(transcriptPath, 'wx', 0o600)
  const tools = new Set<string>()
  let closed = false
  const record = {
    schema: 'cli-bridge.router-launch.v1',
    launchId: launch.id,
    harness: 'codex',
    harnessVersion: input.version,
    profileDigest: input.profileDigest,
    inference: {
      baseUrl: launch.baseUrl,
      nativeProvider: launch.nativeProvider,
      modelRoute: launch.model,
      protocol: 'responses',
      headers: launch.headers,
      credentialSource: 'TANGLE_API_KEY',
      nativeConfiguration: 'confirmed',
      routerReceipts: 'unknown',
    },
    webSearch: {
      enabled: launch.searchEnabled,
      nativeControl: launch.searchEnabled ? 'live' : 'disabled',
      scope: 'codex-native-web-search',
      availability: 'unknown',
    },
    toolInventory: {
      configured: input.configuredTools,
      configuredMcpServers: input.mcpServers,
      nativeAvailable: null,
      status: 'unknown',
      observed: [] as string[],
    },
    transcript: 'transcript.jsonl',
    transcriptRedactions: ['launch Router credential'],
    status: 'prepared',
    processTermination: 'unknown' as 'stopped' | 'failed' | 'unknown',
    terminalEvent: null as 'completed' | 'error' | null,
    publication: 'unknown',
  }
  const syncDirectory = (path: string): void => {
    const directoryFd = openSync(path, 'r')
    try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
  }
  const persist = (): void => {
    const temporary = `${recordPath}.tmp`
    const recordFd = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(recordFd, `${JSON.stringify(record, null, 2)}\n`)
      fsyncSync(recordFd)
    } finally {
      closeSync(recordFd)
    }
    renameSync(temporary, recordPath)
    syncDirectory(directory)
  }
  try { persist(); syncDirectory(launch.directory) } catch (error) { closeSync(fd); throw error }
  return {
    append(line): void {
      if (closed) throw new Error('Router launch transcript is closed')
      // The native stream can echo credentials in diagnostics. Never retain this launch's raw key.
      writeFileSync(fd, `${line.replaceAll(launch.key, '[REDACTED_ROUTER_KEY]')}\n`)
    },
    observeTool(name): void { tools.add(name) },
    terminal(kind): void { record.terminalEvent = kind },
    termination(outcome): void { record.processTermination = outcome },
    close(outcome): void {
      if (closed) return
      closed = true
      try { fsyncSync(fd) } finally { closeSync(fd) }
      record.status = outcome
      record.toolInventory.observed = [...tools].sort()
      persist()
    },
  }
}
