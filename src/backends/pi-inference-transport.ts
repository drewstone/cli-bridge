import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { zstdDecompress } from 'node:zlib'
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import type { AgentProfileModelHints } from '@tangle-network/agent-interface'
import { resolvePiAuthCredential } from './pi-auth-credential.js'
import { readPiSelectedModel, type PiCatalogModel } from './pi-catalog-rpc.js'
import { BackendError } from './types.js'

export const PI_API_MODES = [
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'mistral-conversations',
  'google-generative-ai',
  'google-vertex',
  'bedrock-converse-stream',
] as const

export type PiApiMode = typeof PI_API_MODES[number]

/** High enough for large image/tool contexts; operators can raise it explicitly. */
export const DEFAULT_PI_INFERENCE_MAX_REQUEST_BYTES = 256 * 1024 * 1024
const MAX_PROTECTED_CREDENTIAL_LENGTH = 16 * 1024
const MAX_COMPRESSED_INSPECTION_BYTES = 32 * 1024 * 1024
const MAX_CONCURRENT_COMPRESSED_INSPECTIONS = 2

export interface PiInferenceSelection {
  provider: string
  model: string
}

export interface PiInferenceCredentialOverride {
  token: string
  digest: `sha256:${string}`
  baseUrl: string
  baseUrlDigest: `sha256:${string}`
}

/**
 * Everything the trusted bridge needs to authenticate and forward one Pi run.
 * The upstream credential never enters a Pi-owned file, argument, or process.
 */
export interface ResolvedPiInferenceTransport {
  provider: string
  model: string
  upstreamBaseUrl: string
  apiMode: PiApiMode
  upstreamApiKey: string
  /** Refresh an expiring subscription credential without exposing refresh auth to Pi. */
  resolveUpstreamApiKey?: (signal: AbortSignal) => Promise<string>
  /** True when the endpoint came from a protected request header. */
  requestScopedEndpoint?: boolean
  /** Finite per-request memory boundary for the model-binding JSON inspection. */
  maxRequestBytes: number
  providerConfig: Record<string, unknown>
  modelConfig: Record<string, unknown>
  sourceAgentDir: string
  /** Trusted root under which cli-bridge creates one opaque directory per external session. */
  sourceSessionDir: string
}

export type PiInferenceTransportResolver = (
  selection: PiInferenceSelection,
  signal: AbortSignal,
  credential?: PiInferenceCredentialOverride,
) => Promise<ResolvedPiInferenceTransport>

export interface ProvisionedPiInferenceTransport {
  agentDir: string
  sessionDir: string
  upstreamBaseUrl: string
  /** Request-scoped marker used only to carry Router's typed pre-dispatch proof through Pi. */
  providerDispatchMarker: string
  /** True when the endpoint came from a protected request header. */
  requestScopedEndpoint?: boolean
  apiMode: PiApiMode
  /** Exact profile cap applied to this run's isolated model catalog, when requested. */
  appliedMaxTotalOutputTokens?: number
  localBaseUrl: string
  traffic(): PiInferenceTrafficSnapshot
  cleanup(): Promise<void>
}

/**
 * Reserve the exact native Pi session before the child can receive a prompt.
 *
 * Pi creates a session header in memory and defers the first file write until
 * an assistant message ends. An interrupted first turn therefore loses the
 * session file even though the bridge already emitted and stored its id. A
 * valid header makes Pi open the same file and append the user message before
 * the first model response, so a later `--session <id>` has a durable target.
 *
 * The caller owns the directory and the id. This function never generates or
 * substitutes an id, and it refuses an existing id whose cwd differs.
 */
export function ensurePiSessionFile(
  sessionDir: string,
  sessionId: string,
  cwd: string,
  options: { readonly createIfMissing?: boolean } = {},
): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(sessionId)) {
    throw new BackendError(
      `backend pi cannot reserve invalid internal session id "${sessionId}"`,
      'upstream',
    )
  }

  mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  const existing = (): string | null => {
    let found: string | null = null
    for (const name of readdirSync(sessionDir)) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(sessionDir, name)
      const header = readPiSessionHeader(path)
      if (!header) continue
      if (header.type !== 'session' || header.id !== sessionId) continue
      if (header.cwd !== cwd) {
        throw new BackendError(
          `backend pi found internal session ${sessionId} under ${sessionDir} with cwd `
          + `"${String(header.cwd ?? '')}" instead of "${cwd}"`,
          'upstream',
        )
      }
      if (found) {
        throw new BackendError(
          `backend pi found multiple internal session files for ${sessionId} under ${sessionDir}`,
          'upstream',
        )
      }
      found = path
    }
    return found
  }

  const found = existing()
  if (found) return found

  if (options.createIfMissing === false) {
    throw new BackendError(
      `backend pi cannot resume internal session ${sessionId}: no matching Pi session file exists in ${sessionDir}`,
      'upstream',
    )
  }

  const timestamp = new Date().toISOString()
  // The stable name is the per-id lock. Timestamped filenames would let
  // concurrent first turns create different valid files after an empty scan.
  const file = join(sessionDir, `${sessionId}.jsonl`)
  const header = {
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp,
    cwd,
  }

  // Write the whole header before atomically linking it to the stable name.
  // A competing caller either links first or observes that complete file.
  const candidate = join(sessionDir, `.${randomBytes(16).toString('hex')}.reserve`)
  try {
    writeFileSync(candidate, `${JSON.stringify(header)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    linkSync(candidate, file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const raced = existing()
    if (raced) return raced
    throw new BackendError(
      `backend pi could not reserve internal session ${sessionId} at ${file}; `
      + 'the target path already exists but is not a matching Pi session',
      'upstream',
      error,
    )
  } finally {
    try { unlinkSync(candidate) } catch { /* best effort */ }
  }
  return file
}

/** Read only the bounded session header, not a complete historical transcript. */
function readPiSessionHeader(path: string): { type?: unknown; id?: unknown; cwd?: unknown } | null {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, 'r')
    const bytes = Buffer.alloc(64 * 1024)
    const read = readSync(descriptor, bytes, 0, bytes.length, 0)
    const newline = bytes.indexOf(0x0a)
    if (newline === -1 || newline >= read) return null
    return JSON.parse(bytes.toString('utf8', 0, newline)) as {
      type?: unknown
      id?: unknown
      cwd?: unknown
    }
  } catch {
    return null
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

export interface PiInferenceTrafficSnapshot {
  /** All HTTP requests received while this run's scoped token was live. */
  requests: number
  /** Billable/generative requests forwarded to the configured provider. */
  generationRequests: number
  /** Non-generative provider requests such as countTokens. */
  auxiliaryRequests: number
  /** Requests refused before any upstream call. */
  rejectedRequests: number
  /** Forwarded requests whose upstream exchange failed. */
  failedRequests: number
  /** Exchanges that had not settled when Pi exited. */
  inFlightRequests: number
}

interface ModelsFile {
  providers?: Record<string, unknown>
}

interface ProviderRecord extends Record<string, unknown> {
  baseUrl?: unknown
  api?: unknown
  apiKey?: unknown
  headers?: unknown
  authHeader?: unknown
  compat?: unknown
  models?: unknown
}

const SAFE_MODEL_FIELDS = [
  'id',
  'name',
  'api',
  'reasoning',
  'thinkingLevelMap',
  'input',
  'cost',
  'contextWindow',
  'maxTokens',
  'compat',
] as const

export interface AppliedPiModelHints {
  modelConfig: Record<string, unknown>
  appliedMaxTotalOutputTokens?: number
}

/**
 * Apply only model controls that Pi can prove through its isolated models.json.
 *
 * Pi's native maxTokens includes hidden reasoning. The operator catalog remains
 * the upper bound, and the source model object is never mutated.
 */
export function applyPiModelHints(
  modelConfig: Record<string, unknown>,
  modelHints: AgentProfileModelHints | undefined,
): AppliedPiModelHints {
  const isolatedModelConfig = structuredClone(modelConfig)
  if (modelHints === undefined) return { modelConfig: isolatedModelConfig }
  if (!isRecord(modelHints) || Array.isArray(modelHints)) {
    throw new BackendError(
      'backend pi cannot apply agent_profile.model because it is not an object',
      'parse_error',
    )
  }

  const unsupported: string[] = []
  if (modelHints.maxVisibleOutputTokens !== undefined) unsupported.push('maxVisibleOutputTokens')
  if (modelHints.maxReasoningTokens !== undefined) unsupported.push('maxReasoningTokens')
  const metadata = modelHints.metadata
  if (metadata !== undefined && (!isRecord(metadata) || Array.isArray(metadata))) {
    throw new BackendError(
      'backend pi cannot apply agent_profile.model.metadata because it is not an object',
      'parse_error',
    )
  }
  if (metadata !== undefined && Object.keys(metadata).length > 0) {
    unsupported.push(...Object.keys(metadata).map(key => `metadata.${key}`))
  }
  if (unsupported.length > 0) {
    throw new BackendError(
      `backend pi cannot enforce agent_profile.model field(s): ${unsupported.sort().join(', ')}; `
      + 'the selected Pi runner exposes only maxTotalOutputTokens as a numeric completion cap',
      'not_configured',
    )
  }

  const requested = modelHints.maxTotalOutputTokens
  if (requested === undefined) return { modelConfig: isolatedModelConfig }
  if (!isPositiveSafeInteger(requested)) {
    throw new BackendError(
      'backend pi agent_profile.model.maxTotalOutputTokens must be a positive safe integer',
      'parse_error',
    )
  }
  const operatorMaxTokens = isolatedModelConfig.maxTokens
  if (!isPositiveSafeInteger(operatorMaxTokens)) {
    throw new BackendError(
      'backend pi cannot apply agent_profile.model.maxTotalOutputTokens because the operator model '
      + 'has no valid maxTokens cap to lower',
      'not_configured',
    )
  }
  if (requested > operatorMaxTokens) {
    throw new BackendError(
      `backend pi agent_profile.model.maxTotalOutputTokens ${requested} exceeds the operator model cap ${operatorMaxTokens}`,
      'parse_error',
    )
  }

  isolatedModelConfig.maxTokens = requested
  return { modelConfig: isolatedModelConfig, appliedMaxTotalOutputTokens: requested }
}

/**
 * Resolve the same provider credential Pi would use, but do so in a trusted,
 * tool-free helper process before the coding agent starts.
 */
export function createPiInferenceTransportResolver(options: {
  bin: string
  env?: NodeJS.ProcessEnv
  agentDir?: string
  sessionDir?: string
  maxRequestBytes?: number
}): PiInferenceTransportResolver {
  const trustedEnv = options.env ?? process.env
  const maxRequestBytes = resolveMaxRequestBytes(options.maxRequestBytes, trustedEnv)
  const sourceAgentDir = resolve(
    options.agentDir
      ?? trustedEnv.PI_CODING_AGENT_DIR?.trim()
      ?? (trustedEnv.HOME?.trim() ? join(trustedEnv.HOME, '.pi', 'agent') : undefined)
      ?? join(homedir(), '.pi', 'agent'),
  )
  const sourceSessionDir = resolve(
    options.sessionDir
      ?? trustedEnv.PI_CODING_AGENT_SESSION_DIR?.trim()
      ?? join(sourceAgentDir, 'sessions'),
  )

  return async (selection, signal, credential) => {
    const config = readConfiguredTransport(sourceAgentDir, selection)
      ?? await readCatalogTransport({
        bin: options.bin,
        selection,
        env: trustedEnv,
        signal,
      })
    if (credential !== undefined) {
      const expectedDigest = `sha256:${createHash('sha256').update(credential.token).digest('hex')}` as const
      const expectedBaseUrlDigest = `sha256:${createHash('sha256').update(credential.baseUrl).digest('hex')}` as const
      if (
        !credential.token
        || credential.token.length > MAX_PROTECTED_CREDENTIAL_LENGTH
        || /[\r\n\0]/u.test(credential.token)
        || credential.digest !== expectedDigest
        || credential.baseUrlDigest !== expectedBaseUrlDigest
      ) {
        throw new BackendError(
          `backend pi cannot establish isolated inference auth for ${selection.provider}/${selection.model}: `
          + 'the request-scoped credential is empty, malformed, or has a mismatched digest',
          'not_configured',
        )
      }
      return {
        ...config,
        upstreamBaseUrl: validateProtectedUpstreamBaseUrl(credential.baseUrl, selection),
        upstreamApiKey: credential.token,
        requestScopedEndpoint: true,
        maxRequestBytes,
        sourceAgentDir,
        sourceSessionDir,
      }
    }
    let resolvedCredential: Awaited<ReturnType<typeof resolvePiAuthCredential>>
    try {
      resolvedCredential = await resolvePiAuthCredential({
        bin: options.bin,
        provider: selection.provider,
        model: selection.model,
        apiMode: config.apiMode,
        env: trustedEnv,
        signal,
      })
    } catch (error) {
      throw new BackendError(
        `backend pi cannot establish isolated inference auth for ${selection.provider}/${selection.model}`,
        'not_configured',
        error,
      )
    }

    return {
      ...config,
      upstreamApiKey: resolvedCredential.token,
      ...(resolvedCredential.refreshable
        ? { resolveUpstreamApiKey: resolvedCredential.resolve }
        : {}),
      maxRequestBytes,
      sourceAgentDir,
      sourceSessionDir,
    }
  }
}

function validateProtectedUpstreamBaseUrl(
  baseUrl: string,
  selection: PiInferenceSelection,
): string {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new BackendError(
      `backend pi protected provider ${selection.provider}/${selection.model} has an invalid HTTPS gateway URL`,
      'not_configured',
    )
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new BackendError(
      `backend pi protected provider ${selection.provider}/${selection.model} requires an HTTPS gateway URL without credentials, query, or fragment`,
      'not_configured',
    )
  }
  return parsed.toString().replace(/\/$/u, '')
}

function readConfiguredTransport(
  sourceAgentDir: string,
  selection: PiInferenceSelection,
): Omit<
  ResolvedPiInferenceTransport,
  | 'upstreamApiKey'
  | 'resolveUpstreamApiKey'
  | 'maxRequestBytes'
  | 'sourceAgentDir'
  | 'sourceSessionDir'
> | null {
  const modelsPath = join(sourceAgentDir, 'models.json')
  let parsed: ModelsFile
  try {
    parsed = JSON.parse(readFileSync(modelsPath, 'utf8')) as ModelsFile
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new BackendError(
      `backend pi cannot read ${modelsPath} before isolated inference starts`,
      'not_configured',
      error,
    )
  }

  const rawProvider = parsed.providers?.[selection.provider]
  if (rawProvider === undefined) return null
  if (!isRecord(rawProvider)) throw new BackendError(
    `backend pi provider ${selection.provider} has malformed configuration in ${modelsPath}`,
    'not_configured',
  )
  const provider = rawProvider as ProviderRecord
  if (isRecord(provider.headers) && Object.keys(provider.headers).length > 0) {
    throw new BackendError(
      `backend pi provider ${selection.provider} uses custom request headers that `
      + 'pi auth cannot resolve for the trusted forwarding process',
      'not_configured',
    )
  }

  const rawModels = Array.isArray(provider.models) ? provider.models : []
  const rawModel = rawModels.find((candidate) =>
    isRecord(candidate) && candidate.id === selection.model,
  )
  if (rawModel === undefined) {
    throw new BackendError(
      `backend pi model ${selection.provider}/${selection.model} has no explicit entry in ${modelsPath}; `
      + 'the bridge refuses to combine dynamic model metadata with custom provider auth controls',
      'not_configured',
    )
  }
  if (!isRecord(rawModel)) throw new BackendError(
    `backend pi model ${selection.provider}/${selection.model} has malformed configuration in ${modelsPath}`,
    'not_configured',
  )
  if (isRecord(rawModel.headers) && Object.keys(rawModel.headers).length > 0) {
    throw new BackendError(
      `backend pi model ${selection.provider}/${selection.model} uses custom request headers that `
      + 'pi auth cannot resolve for the trusted forwarding process',
      'not_configured',
    )
  }

  const baseUrl = typeof rawModel.baseUrl === 'string'
    ? rawModel.baseUrl.trim()
    : typeof provider.baseUrl === 'string'
      ? provider.baseUrl.trim()
      : ''
  const api = typeof rawModel.api === 'string'
    ? rawModel.api.trim()
    : typeof provider.api === 'string'
      ? provider.api.trim()
      : ''
  const upstreamBaseUrl = validateUpstreamBaseUrl(baseUrl, selection)
  if (!(PI_API_MODES as readonly string[]).includes(api)) {
    throw new BackendError(
      `backend pi provider ${selection.provider}/${selection.model} has unsupported or missing api mode "${api}"`,
      'not_configured',
    )
  }

  const modelConfig: Record<string, unknown> = {}
  for (const field of SAFE_MODEL_FIELDS) {
    if (rawModel[field] !== undefined) modelConfig[field] = structuredClone(rawModel[field])
  }
  modelConfig.id = selection.model
  modelConfig.api = api

  const providerConfig: Record<string, unknown> = {
    api,
    ...(provider.compat !== undefined ? { compat: structuredClone(provider.compat) } : {}),
    ...(typeof provider.authHeader === 'boolean' ? { authHeader: provider.authHeader } : {}),
  }

  return {
    provider: selection.provider,
    model: selection.model,
    upstreamBaseUrl,
    apiMode: api as PiApiMode,
    providerConfig,
    modelConfig,
  }
}

async function readCatalogTransport(options: {
  bin: string
  selection: PiInferenceSelection
  env: NodeJS.ProcessEnv
  signal: AbortSignal
}): Promise<Omit<
  ResolvedPiInferenceTransport,
  | 'upstreamApiKey'
  | 'resolveUpstreamApiKey'
  | 'maxRequestBytes'
  | 'sourceAgentDir'
  | 'sourceSessionDir'
>> {
  let model: PiCatalogModel
  const catalogAgentDir = mkdtempSync(join(tmpdir(), '.cli-bridge-pi-catalog-'))
  chmodSync(catalogAgentDir, 0o700)
  try {
    model = await readPiSelectedModel({
      bin: options.bin,
      provider: options.selection.provider,
      model: options.selection.model,
      agentDir: catalogAgentDir,
      env: options.env,
      signal: options.signal,
    })
  } catch (error) {
    throw new BackendError(
      `backend pi cannot read canonical model metadata for ${options.selection.provider}/${options.selection.model}`,
      'not_configured',
      error,
    )
  } finally {
    rmSync(catalogAgentDir, { recursive: true, force: true })
  }
  if (model.provider !== options.selection.provider || model.id !== options.selection.model) {
    throw new BackendError(
      `backend pi returned model metadata for ${model.provider}/${model.id} instead of `
      + `${options.selection.provider}/${options.selection.model}`,
      'not_configured',
    )
  }
  if (isRecord(model.headers) && Object.keys(model.headers).length > 0) {
    throw new BackendError(
      `backend pi model ${model.provider}/${model.id} uses custom request headers that `
      + 'pi auth cannot resolve for the trusted forwarding process',
      'not_configured',
    )
  }
  const api = model.api.trim()
  if (!(PI_API_MODES as readonly string[]).includes(api)) {
    throw new BackendError(
      `backend pi provider ${model.provider}/${model.id} has unsupported or missing api mode "${api}"`,
      'not_configured',
    )
  }
  const modelConfig: Record<string, unknown> = {}
  for (const field of SAFE_MODEL_FIELDS) {
    if (model[field] !== undefined) modelConfig[field] = structuredClone(model[field])
  }
  modelConfig.id = options.selection.model
  modelConfig.api = api

  return {
    provider: options.selection.provider,
    model: options.selection.model,
    upstreamBaseUrl: validateUpstreamBaseUrl(model.baseUrl.trim(), options.selection),
    apiMode: api as PiApiMode,
    providerConfig: { api },
    modelConfig,
  }
}

function validateUpstreamBaseUrl(baseUrl: string, selection: PiInferenceSelection): string {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new BackendError(
      `backend pi provider ${selection.provider}/${selection.model} has invalid baseUrl "${baseUrl}"`,
      'not_configured',
    )
  }
  const localHttp = parsed.protocol === 'http:' && isLocalHostname(parsed.hostname)
  if ((parsed.protocol !== 'https:' && !localHttp) || parsed.username || parsed.password) {
    throw new BackendError(
      `backend pi provider ${selection.provider}/${selection.model} baseUrl must be HTTPS `
      + 'or loopback HTTP, without embedded credentials',
      'not_configured',
    )
  }
  if (parsed.search || parsed.hash) {
    throw new BackendError(
      `backend pi provider ${selection.provider}/${selection.model} baseUrl cannot contain query or fragment data`,
      'not_configured',
    )
  }
  return parsed.toString().replace(/\/$/u, '')
}

export async function provisionPiInferenceTransport(
  resolved: ResolvedPiInferenceTransport,
  options: {
    /** External caller session id. Omit only for Pi's explicit --no-session mode. */
    sessionId?: string
    /** Workspace Pi can read. Persistent session storage must remain outside it. */
    projectDir?: string
    /** Model hints from the exact AgentProfile selected for this run. */
    modelHints?: AgentProfileModelHints
  } = {},
): Promise<ProvisionedPiInferenceTransport> {
  assertExactModelBinding(resolved)
  const applied = applyPiModelHints(resolved.modelConfig, options.modelHints)
  const proxy = await startScopedProxy(resolved)
  let agentDir: string | null = null
  try {
    // The fs jail mounts a fresh /tmp and then re-exposes this exact directory.
    // Keeping the scoped token outside the workspace stops sibling workspaces
    // and sibling Pi sessions from discovering it through the project bind.
    const parent = tmpdir()
    mkdirSync(parent, { recursive: true })
    agentDir = mkdtempSync(join(parent, '.cli-bridge-pi-inference-'))
    chmodSync(agentDir, 0o700)
    const models = {
      providers: {
        [resolved.provider]: {
          ...resolved.providerConfig,
          baseUrl: proxy.localBaseUrl,
          apiKey: proxy.scopedApiKey,
          models: [applied.modelConfig],
        },
      },
    }
    writeFileSync(join(agentDir, 'models.json'), `${JSON.stringify(models, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    // Pi may create package/cache state at startup. Keep every write in the
    // request directory; never point it back at the credential-bearing source.
    mkdirSync(join(agentDir, 'npm'), { mode: 0o700 })
    const sessionDir = provisionSessionDirectory(resolved, agentDir, options)

    let cleaned = false
    return {
      agentDir,
      sessionDir,
      upstreamBaseUrl: resolved.upstreamBaseUrl,
      providerDispatchMarker: proxy.providerDispatchMarker,
      ...(resolved.requestScopedEndpoint ? { requestScopedEndpoint: true } : {}),
      apiMode: resolved.apiMode,
      ...(applied.appliedMaxTotalOutputTokens === undefined
        ? {}
        : { appliedMaxTotalOutputTokens: applied.appliedMaxTotalOutputTokens }),
      localBaseUrl: proxy.localBaseUrl,
      traffic: () => proxy.traffic(),
      cleanup: async () => {
        if (cleaned) return
        cleaned = true
        await proxy.close()
        rmSync(agentDir!, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await proxy.close()
    if (agentDir) rmSync(agentDir, { recursive: true, force: true })
    throw error
  }
}

interface ScopedProxy {
  localBaseUrl: string
  scopedApiKey: string
  providerDispatchMarker: string
  traffic(): PiInferenceTrafficSnapshot
  close(): Promise<void>
}

interface CompressedInspectionBudget {
  active: number
}

const PROVIDER_DISPATCH_MARKER_PREFIX = ' __tangle_provider_dispatch_not_started__:'

function providerDispatchMarkerText(marker: string): string {
  return `${PROVIDER_DISPATCH_MARKER_PREFIX}${marker}__`
}

/**
 * Preserve Router's one-sided pre-dispatch fact across Pi's error-message-only API.
 *
 * Pi's OpenAI adapter keeps `error.message` but drops unknown error fields. The local
 * proxy therefore appends a request-scoped marker to the message while retaining the
 * original `provider_dispatch` field. The random marker prevents a provider-supplied
 * message from manufacturing this proof.
 */
export function annotateProviderDispatchFailureBody(body: string, marker: string): string {
  if (!marker) return body
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return body
  const error = (parsed as { error?: unknown }).error
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return body
  if ((error as { provider_dispatch?: unknown }).provider_dispatch !== 'not_started') return body
  const markerText = providerDispatchMarkerText(marker)
  const record = error as { message?: unknown }
  const message = typeof record.message === 'string' ? record.message : ''
  if (message.includes(markerText)) return body
  record.message = `${message}${markerText}`
  return JSON.stringify(parsed)
}

/** Return Router's proof only when the exact request-scoped marker is present. */
export function providerDispatchFromPiFailure(
  message: string,
  marker: string | undefined,
): 'not_started' | undefined {
  return marker !== undefined && message.includes(providerDispatchMarkerText(marker))
    ? 'not_started'
    : undefined
}

/** Remove the transport marker before the bridge exposes the provider diagnostic. */
export function stripProviderDispatchMarker(message: string, marker: string | undefined): string {
  if (marker === undefined) return message
  return message.replaceAll(providerDispatchMarkerText(marker), '').trim()
}

async function startScopedProxy(resolved: ResolvedPiInferenceTransport): Promise<ScopedProxy> {
  const scopedApiKey = scopedInferenceCredential(resolved.apiMode)
  const providerDispatchMarker = randomBytes(24).toString('base64url')
  const traffic: PiInferenceTrafficSnapshot = {
    requests: 0,
    generationRequests: 0,
    auxiliaryRequests: 0,
    rejectedRequests: 0,
    failedRequests: 0,
    inFlightRequests: 0,
  }
  const compressedInspectionBudget: CompressedInspectionBudget = { active: 0 }
  const server = createServer((request, response) => {
    traffic.requests += 1
    void forwardRequest(
      request,
      response,
      resolved,
      scopedApiKey,
      providerDispatchMarker,
      traffic,
      compressedInspectionBudget,
    )
  })
  server.on('clientError', (_error, socket) => socket.destroy())

  await listenLoopback(server)
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new BackendError('backend pi isolated inference proxy did not expose a TCP address', 'not_configured')
  }

  let closed = false
  return {
    localBaseUrl: `http://127.0.0.1:${address.port}`,
    scopedApiKey,
    providerDispatchMarker,
    traffic: () => ({ ...traffic }),
    close: async () => {
      if (closed) return
      closed = true
      server.closeAllConnections()
      await closeServer(server)
    },
  }
}

async function forwardRequest(
  request: IncomingMessage,
  response: ServerResponse,
  resolved: ResolvedPiInferenceTransport,
  scopedApiKey: string,
  providerDispatchMarker: string,
  traffic: PiInferenceTrafficSnapshot,
  compressedInspectionBudget: CompressedInspectionBudget,
): Promise<void> {
  if (!request.socket.remoteAddress || !isLoopbackAddress(request.socket.remoteAddress)) {
    traffic.rejectedRequests += 1
    writeProxyError(response, 403, 'loopback clients only')
    return
  }

  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
  let authenticated = requestUrl.search.includes(scopedApiKey)
  for (const [name, raw] of Object.entries(request.headers)) {
    if (raw === undefined || isHopByHopHeader(name) || name.toLowerCase() === 'accept-encoding') continue
    const values = Array.isArray(raw) ? raw : [raw]
    for (const value of values) {
      if (value.includes(scopedApiKey)) authenticated = true
    }
  }
  if (!authenticated) {
    traffic.rejectedRequests += 1
    writeProxyError(response, 401, 'invalid scoped inference credential')
    return
  }

  const method = request.method ?? 'POST'
  const requestKind = inferenceRequestKind(resolved.apiMode, method, requestUrl.pathname)
  if (!requestKind) {
    traffic.rejectedRequests += 1
    writeProxyError(response, 404, 'scoped inference route not found')
    return
  }

  const abort = new AbortController()
  const abortClientRequest = (): void => abort.abort()
  request.once('aborted', abortClientRequest)
  response.once('close', () => {
    if (!response.writableEnded) abortClientRequest()
  })

  const contentEncoding = normalizedContentEncoding(request.headers['content-encoding'])
  if (contentEncoding !== undefined && contentEncoding !== 'identity' && contentEncoding !== 'zstd') {
    traffic.rejectedRequests += 1
    request.resume()
    writeProxyError(response, 400, 'unsupported or malformed inference content encoding')
    return
  }
  const compressed = contentEncoding === 'zstd'
  if (compressed && compressedInspectionBudget.active >= MAX_CONCURRENT_COMPRESSED_INSPECTIONS) {
    traffic.rejectedRequests += 1
    request.resume()
    writeProxyError(response, 429, 'too many compressed inference requests are being inspected')
    return
  }
  if (compressed) compressedInspectionBudget.active += 1
  let compressedBudgetHeld = compressed
  const releaseCompressedBudget = (): void => {
    if (!compressedBudgetHeld) return
    compressedBudgetHeld = false
    compressedInspectionBudget.active -= 1
  }
  response.once('close', releaseCompressedBudget)

  let requestBody: Buffer
  try {
    requestBody = await readRequestBody(
      request,
      compressed
        ? Math.min(resolved.maxRequestBytes, MAX_COMPRESSED_INSPECTION_BYTES)
        : resolved.maxRequestBytes,
    )
  } catch (error) {
    releaseCompressedBudget()
    traffic.rejectedRequests += 1
    request.resume()
    if (error instanceof RequestTooLargeError) {
      writeProxyError(
        response,
        413,
        compressed
          ? `compressed inference request exceeds the ${MAX_COMPRESSED_INSPECTION_BYTES}-byte wire limit`
          : `scoped inference request exceeds the configured ${resolved.maxRequestBytes}-byte maximum`,
      )
    } else {
      writeProxyError(response, 400, 'could not read scoped inference request')
    }
    return
  }

  let inspectionBody: Buffer
  try {
    inspectionBody = await inferenceInspectionBody(
      requestBody,
      contentEncoding,
      resolved.maxRequestBytes,
    )
  } catch (error) {
    releaseCompressedBudget()
    traffic.rejectedRequests += 1
    if (error instanceof RequestTooLargeError) {
      writeProxyError(
        response,
        413,
        `compressed inference request expands beyond the ${MAX_COMPRESSED_INSPECTION_BYTES}-byte inspection limit`,
      )
    } else {
      writeProxyError(response, 400, 'unsupported or malformed inference content encoding')
    }
    return
  }

  let upstreamApiKey: string
  try {
    upstreamApiKey = resolved.resolveUpstreamApiKey
      ? await resolved.resolveUpstreamApiKey(abort.signal)
      : resolved.upstreamApiKey
    if (
      upstreamApiKey.length === 0
      || upstreamApiKey.length > MAX_PROTECTED_CREDENTIAL_LENGTH
      || /[\r\n\0]/u.test(upstreamApiKey)
    ) {
      throw new Error('refreshed inference credential is malformed')
    }
  } catch {
    traffic.failedRequests += 1
    writeProxyError(response, 502, 'upstream authentication refresh failed')
    return
  }

  const scopedAccountId = resolved.apiMode === 'openai-codex-responses'
    ? openAiCodexAccountId(scopedApiKey)
    : null
  const upstreamAccountId = resolved.apiMode === 'openai-codex-responses'
    ? openAiCodexAccountId(upstreamApiKey)
    : null

  const headers = new Headers()
  for (const [name, raw] of Object.entries(request.headers)) {
    if (raw === undefined || isHopByHopHeader(name) || name.toLowerCase() === 'accept-encoding') continue
    const values = Array.isArray(raw) ? raw : [raw]
    for (const value of values) {
      if (resolved.apiMode === 'openai-codex-responses' && name.toLowerCase() === 'chatgpt-account-id') {
        if (upstreamAccountId !== null) headers.append(name, upstreamAccountId)
        continue
      }
      headers.append(name, value.split(scopedApiKey).join(upstreamApiKey))
    }
  }
  // Node's fetch transparently decompresses upstream bodies. Asking for the
  // identity representation avoids a second compression boundary, and the
  // response path below still strips content-encoding if an upstream ignores it.
  headers.set('accept-encoding', 'identity')
  const upstreamUrl = appendPath(
    resolved.upstreamBaseUrl,
    requestUrl,
    scopedApiKey,
    upstreamApiKey,
  )
  if (!requestTargetsSelectedModel(
    resolved.apiMode,
    requestUrl.pathname,
    upstreamUrl.pathname,
    inspectionBody,
    resolved.model,
  )) {
    traffic.rejectedRequests += 1
    const observedModel = requestBodyModel(inspectionBody)
    writeProxyError(
      response,
      403,
      `scoped inference credential for "${resolved.model}" cannot access `
      + `${observedModel === null ? 'a request with no model' : `model "${observedModel}"`}`,
    )
    return
  }

  if (requestKind === 'generation') traffic.generationRequests += 1
  else traffic.auxiliaryRequests += 1
  traffic.inFlightRequests += 1

  try {
    const hasBody = method !== 'GET' && method !== 'HEAD'
    const upstream = await fetch(upstreamUrl, {
      method,
      headers,
      ...(hasBody ? { body: requestBody } : {}),
      signal: abort.signal,
      redirect: 'manual',
    })

    const responseHeaders: Record<string, string | string[]> = {}
    upstream.headers.forEach((value, name) => {
      if (!isHopByHopHeader(name) && name.toLowerCase() !== 'content-encoding') {
        responseHeaders[name] = value
          .split(upstreamApiKey)
          .join(scopedApiKey)
        if (upstreamAccountId !== null && scopedAccountId !== null) {
          responseHeaders[name] = responseHeaders[name]
            .split(upstreamAccountId)
            .join(scopedAccountId)
        }
      }
    })

    if (!upstream.ok) {
      // Error responses are small JSON envelopes in the supported OpenAI-compatible
      // protocols. Buffer them once so the exact Router proof survives Pi's adapter,
      // while still redacting the upstream credential before it reaches the child.
      const rawBody = await upstream.text()
      const body = annotateProviderDispatchFailureBody(
        rawBody,
        providerDispatchMarker,
      ).split(upstreamApiKey).join(scopedApiKey)
      const redactedBody = upstreamAccountId !== null && scopedAccountId !== null
        ? body.split(upstreamAccountId).join(scopedAccountId)
        : body
      delete responseHeaders['content-length']
      response.writeHead(upstream.status, responseHeaders)
      response.end(redactedBody)
      return
    }

    response.writeHead(upstream.status, responseHeaders)
    if (!upstream.body) {
      response.end()
      return
    }
    const body = Readable.fromWeb(upstream.body as never)
    const identity = resolved.apiMode === 'openai-completions'
      && upstream.headers.get('content-type')?.toLowerCase().includes('text/event-stream')
      ? createOpenAiResponseIdentityStream()
      : undefined
    const redaction = createCredentialRedactionStream(upstreamApiKey, scopedApiKey)
    const accountRedaction = upstreamAccountId !== null && scopedAccountId !== null
      ? createCredentialRedactionStream(upstreamAccountId, scopedAccountId)
      : undefined
    if (identity) {
      if (accountRedaction) await pipeline(body, identity, redaction, accountRedaction, response)
      else await pipeline(body, identity, redaction, response)
    } else {
      if (accountRedaction) await pipeline(body, redaction, accountRedaction, response)
      else await pipeline(body, redaction, response)
    }
  } catch (error) {
    traffic.failedRequests += 1
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined)
      return
    }
    writeProxyError(response, 502, 'upstream request failed')
  } finally {
    traffic.inFlightRequests -= 1
  }
}

async function inferenceInspectionBody(
  body: Buffer,
  contentEncoding: string | undefined,
  maxBytes: number,
): Promise<Buffer> {
  if (contentEncoding === undefined || contentEncoding === 'identity') return body
  if (contentEncoding !== 'zstd') throw new Error('unsupported inference content encoding')
  return await decompressZstd(body, Math.min(maxBytes, MAX_COMPRESSED_INSPECTION_BYTES))
}

function decompressZstd(body: Buffer, maxOutputLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zstdDecompress(body, { maxOutputLength }, (error, result) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
          reject(new RequestTooLargeError())
        } else {
          reject(error)
        }
        return
      }
      resolve(result)
    })
  })
}

function normalizedContentEncoding(value: string | string[] | undefined): string | undefined {
  const encoding = Array.isArray(value)
    ? value.join(',').trim().toLowerCase()
    : value?.trim().toLowerCase()
  return encoding === '' ? undefined : encoding
}

function scopedInferenceCredential(apiMode: PiApiMode): string {
  if (apiMode !== 'openai-codex-responses') return randomBytes(32).toString('base64url')
  const accountId = `scoped-${randomBytes(16).toString('base64url')}`
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1_000) + 24 * 60 * 60,
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: 'pro',
    },
  })).toString('base64url')
  return `${header}.${payload}.${randomBytes(24).toString('base64url')}`
}

function openAiCodexAccountId(token: string): string | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
    if (!isRecord(parsed)) return null
    const auth = parsed['https://api.openai.com/auth']
    if (!isRecord(auth) || typeof auth.chatgpt_account_id !== 'string') return null
    const accountId = auth.chatgpt_account_id.trim()
    if (
      accountId.length === 0
      || accountId.length > 512
      || /[\r\n\0]/u.test(accountId)
    ) return null
    return accountId
  } catch {
    return null
  }
}

function appendPath(
  baseUrl: string,
  incoming: URL,
  scopedApiKey: string,
  upstreamApiKey: string,
): URL {
  const upstream = new URL(baseUrl)
  const prefix = upstream.pathname.replace(/\/$/u, '')
  const suffix = incoming.pathname.startsWith('/') ? incoming.pathname : `/${incoming.pathname}`
  upstream.pathname = `${prefix}${suffix}` || '/'
  // Google-compatible clients may authenticate in a query parameter instead
  // of a header. The local token is URL-safe, so exact replacement preserves
  // every other query value while keeping the daemon credential bridge-owned.
  upstream.search = incoming.search.split(scopedApiKey).join(upstreamApiKey)
  return upstream
}

function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' || normalized.endsWith('.localhost')
    || normalized === '127.0.0.1' || normalized === '::1'
}

/** Keep the run token useful only for the selected model protocol. */
function inferenceRequestKind(
  apiMode: PiApiMode,
  method: string,
  pathname: string,
): 'generation' | 'auxiliary' | null {
  if (method !== 'POST') return null
  switch (apiMode) {
    case 'openai-completions':
      return pathname === '/chat/completions' ? 'generation' : null
    case 'openai-responses':
      return pathname === '/responses' ? 'generation' : null
    case 'azure-openai-responses':
      return pathname === '/responses' ? 'generation' : null
    case 'openai-codex-responses':
      return pathname === '/codex/responses' ? 'generation' : null
    case 'anthropic-messages':
      return pathname === '/v1/messages' ? 'generation' : null
    case 'mistral-conversations':
      return pathname === '/v1/chat/completions' ? 'generation' : null
    case 'google-generative-ai':
    case 'google-vertex': {
      const request = parseGoogleModelRequest(pathname)
      if (request?.action === 'countTokens') return 'auxiliary'
      return request ? 'generation' : null
    }
    case 'bedrock-converse-stream':
      return /^\/model\/[^/]+\/(?:converse|converse-stream)$/u.test(pathname)
        ? 'generation'
        : null
  }
}

function requestTargetsSelectedModel(
  apiMode: PiApiMode,
  requestPathname: string,
  upstreamPathname: string,
  body: Buffer,
  selectedModel: string,
): boolean {
  switch (apiMode) {
    case 'openai-completions':
    case 'openai-responses':
    case 'openai-codex-responses':
    case 'anthropic-messages':
    case 'mistral-conversations':
      return requestBodyModel(body) === selectedModel
    case 'azure-openai-responses':
      return azureRequestTargetsSelectedModel(upstreamPathname, body, selectedModel)
    case 'google-generative-ai':
    case 'google-vertex': {
      const request = parseGoogleModelRequest(requestPathname)
      const expected = googleModelResource(apiMode, selectedModel)
      return request !== null && expected !== null && request.resource === expected
    }
    case 'bedrock-converse-stream': {
      const match = requestPathname.match(/^\/model\/([^/]+)\/(?:converse|converse-stream)$/u)
      return match !== null && decodePathSegment(match[1]!) === selectedModel
    }
  }
}

function requestBodyModel(body: Buffer): string | null {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown
    return isRecord(parsed) && typeof parsed.model === 'string' ? parsed.model : null
  } catch {
    return null
  }
}

function azureRequestTargetsSelectedModel(
  pathname: string,
  body: Buffer,
  selectedModel: string,
): boolean {
  let parsed: Record<string, unknown>
  try {
    const value = body.length === 0 ? {} : JSON.parse(body.toString('utf8')) as unknown
    if (!isRecord(value)) return false
    parsed = value
  } catch {
    return false
  }

  const pathModel = azureDeploymentModel(pathname)
  const bodyHasModel = Object.hasOwn(parsed, 'model')
  if (pathModel !== null && pathModel !== selectedModel) return false
  if (bodyHasModel && parsed.model !== selectedModel) return false
  return pathModel === selectedModel || parsed.model === selectedModel
}

function azureDeploymentModel(pathname: string): string | null {
  const match = pathname.match(/\/deployments\/([^/]+)\/responses$/u)
  return match ? decodePathSegment(match[1]!) : null
}

function parseGoogleModelRequest(
  pathname: string,
): { resource: string; action: 'countTokens' | 'streamGenerateContent' | 'generateContent' } | null {
  const match = pathname.match(
    /^\/(?:v\d+(?:beta\d*)?\/)?(.+):(countTokens|streamGenerateContent|generateContent)$/u,
  )
  if (!match) return null
  const resource = decodePathSegment(match[1]!)
  if (resource === null) return null
  return {
    resource,
    action: match[2] as 'countTokens' | 'streamGenerateContent' | 'generateContent',
  }
}

/** Mirrors the model-resource normalization in @google/genai 1.52 used by Pi 0.83. */
function googleModelResource(
  apiMode: 'google-generative-ai' | 'google-vertex',
  selectedModel: string,
): string | null {
  if (
    !selectedModel
    || selectedModel.includes('..')
    || /[?&#%]/u.test(selectedModel)
  ) return null
  if (apiMode === 'google-generative-ai') {
    return selectedModel.startsWith('models/') || selectedModel.startsWith('tunedModels/')
      ? selectedModel
      : `models/${selectedModel}`
  }
  if (
    selectedModel.startsWith('publishers/')
    || selectedModel.startsWith('projects/')
    || selectedModel.startsWith('models/')
  ) {
    return selectedModel
  }
  const parts = selectedModel.split('/')
  if (parts.length === 1) return `publishers/google/models/${selectedModel}`
  if (parts.length === 2 && parts.every(Boolean)) {
    return `publishers/${parts[0]}/models/${parts[1]}`
  }
  return null
}

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

class RequestTooLargeError extends Error {}

async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const contentLength = request.headers['content-length']
  if (contentLength !== undefined) {
    const declaredBytes = Number(contentLength)
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw new RequestTooLargeError()
    }
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes) throw new RequestTooLargeError()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function createCredentialRedactionStream(secret: string, replacement: string): Transform {
  const secretBytes = Buffer.from(secret)
  const replacementBytes = Buffer.from(replacement)
  let pending = Buffer.alloc(0)

  return new Transform({
    transform(chunk, _encoding, callback) {
      pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      while (pending.length > 0) {
        const match = pending.indexOf(secretBytes)
        if (match >= 0) {
          if (match > 0) this.push(pending.subarray(0, match))
          this.push(replacementBytes)
          pending = pending.subarray(match + secretBytes.length)
          continue
        }

        const retained = matchingSecretPrefixLength(pending, secretBytes)
        const safeBytes = pending.length - retained
        if (safeBytes > 0) this.push(pending.subarray(0, safeBytes))
        pending = pending.subarray(safeBytes)
        break
      }
      callback()
    },
    flush(callback) {
      if (pending.length > 0) this.push(pending)
      callback()
    },
  })
}

/**
 * Carry an OpenAI provider snapshot through Pi's response-model field.
 * Pi preserves `responseModel` but drops `system_fingerprint`, so the bridge
 * encodes the fingerprint as an opaque `model@fingerprint` identity.
 */
export function rewriteOpenAiSseLine(line: string): string {
  const newline = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''
  const content = newline ? line.slice(0, -newline.length) : line
  if (!content.startsWith('data:')) return line
  const data = content.slice('data:'.length).trimStart()
  if (data === '[DONE]') return line
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return line
  }
  if (!isRecord(parsed)) return line
  const model = typeof parsed.model === 'string' ? parsed.model : undefined
  const fingerprint = typeof parsed.system_fingerprint === 'string'
    ? parsed.system_fingerprint
    : undefined
  if (
    !model
    || model.includes('@')
    || !fingerprint
    || !/^[A-Za-z0-9._-]{1,256}$/u.test(fingerprint)
  ) return line
  return `data: ${JSON.stringify({ ...parsed, model: `${model}@${fingerprint}` })}${newline}`
}

function createOpenAiResponseIdentityStream(): Transform {
  let pending = ''
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline + 1)
        pending = pending.slice(newline + 1)
        this.push(rewriteOpenAiSseLine(line))
        newline = pending.indexOf('\n')
      }
      callback()
    },
    flush(callback) {
      if (pending) this.push(rewriteOpenAiSseLine(pending))
      callback()
    },
  })
}

function matchingSecretPrefixLength(value: Buffer, secret: Buffer): number {
  const maximum = Math.min(value.length, secret.length - 1)
  for (let length = maximum; length > 0; length -= 1) {
    if (value.subarray(value.length - length).equals(secret.subarray(0, length))) return length
  }
  return 0
}

function assertExactModelBinding(resolved: ResolvedPiInferenceTransport): void {
  if (!Number.isSafeInteger(resolved.maxRequestBytes) || resolved.maxRequestBytes <= 0) {
    throw new BackendError(
      'backend pi isolated inference maxRequestBytes must be a positive safe integer',
      'not_configured',
    )
  }
  if (
    !resolved.model
    || !resolved.upstreamApiKey
    || /[\r\n\0]/u.test(resolved.upstreamApiKey)
    || resolved.modelConfig.id !== resolved.model
    || resolved.modelConfig.api !== resolved.apiMode
  ) {
    throw new BackendError(
      'backend pi isolated inference config must preserve the exact selected model and API mode',
      'not_configured',
    )
  }
  if (
    (resolved.apiMode === 'google-generative-ai' || resolved.apiMode === 'google-vertex')
    && googleModelResource(resolved.apiMode, resolved.model) === null
  ) {
    throw new BackendError(
      `backend pi cannot bind ${resolved.apiMode} model "${resolved.model}" to one exact request path`,
      'not_configured',
    )
  }
  if (resolved.apiMode === 'azure-openai-responses') {
    const configuredPath = `${new URL(resolved.upstreamBaseUrl).pathname.replace(/\/$/u, '')}/responses`
    const deployment = azureDeploymentModel(configuredPath)
    if (deployment !== null && deployment !== resolved.model) {
      throw new BackendError(
        `backend pi Azure deployment "${deployment}" does not match selected model "${resolved.model}"`,
        'not_configured',
      )
    }
  }
}

function resolveMaxRequestBytes(
  explicit: number | undefined,
  env: NodeJS.ProcessEnv,
): number {
  const configured = explicit ?? (
    env.CLI_BRIDGE_PI_MAX_REQUEST_BYTES?.trim()
      ? Number(env.CLI_BRIDGE_PI_MAX_REQUEST_BYTES)
      : DEFAULT_PI_INFERENCE_MAX_REQUEST_BYTES
  )
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    throw new BackendError(
      'CLI_BRIDGE_PI_MAX_REQUEST_BYTES must be a positive safe integer',
      'not_configured',
    )
  }
  return configured
}

function provisionSessionDirectory(
  resolved: ResolvedPiInferenceTransport,
  agentDir: string,
  options: { sessionId?: string; projectDir?: string },
): string {
  if (!options.sessionId) {
    const ephemeral = join(agentDir, 'sessions')
    mkdirSync(ephemeral, { recursive: true, mode: 0o700 })
    return ephemeral
  }

  const configuredSessionRoot = resolve(resolved.sourceSessionDir)
  const projectDir = options.projectDir ? realpathSync(resolve(options.projectDir)) : null
  if (projectDir && isWithin(projectDir, configuredSessionRoot)) {
    throw new BackendError(
      `backend pi session root ${configuredSessionRoot} is inside the readable workspace; `
      + 'set PI_CODING_AGENT_SESSION_DIR to a directory outside the request cwd',
      'not_configured',
    )
  }
  // Resolve after creation so a configured symlink cannot make the lexical
  // check above pass while placing persistent sessions inside the workspace.
  mkdirSync(configuredSessionRoot, { recursive: true, mode: 0o700 })
  const sessionRoot = realpathSync(configuredSessionRoot)
  if (projectDir && isWithin(projectDir, sessionRoot)) {
    throw new BackendError(
      `backend pi session root ${sessionRoot} resolves inside the readable workspace; `
      + 'set PI_CODING_AGENT_SESSION_DIR to a directory outside the request cwd',
      'not_configured',
    )
  }
  const digest = createHash('sha256')
    .update('cli-bridge/pi-session\0')
    .update(options.sessionId)
    .digest('hex')
  const sessionDir = join(sessionRoot, 'cli-bridge', digest)
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  chmodSync(sessionDir, 0o700)
  return sessionDir
}

function isWithin(base: string, candidate: string): boolean {
  const rel = relative(base, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isHopByHopHeader(name: string): boolean {
  return [
    'connection',
    'content-length',
    'host',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ].includes(name.toLowerCase())
}

function writeProxyError(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: { message } }))
}

async function listenLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolvePromise()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
