import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { BackendError } from './types.js'

const execFileAsync = promisify(execFile)

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

export interface PiInferenceSelection {
  provider: string
  model: string
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
) => Promise<ResolvedPiInferenceTransport>

export interface ProvisionedPiInferenceTransport {
  agentDir: string
  sessionDir: string
  upstreamBaseUrl: string
  apiMode: PiApiMode
  /** Exact profile cap applied to this run's isolated model catalog, when requested. */
  appliedMaxTokens?: number
  localBaseUrl: string
  traffic(): PiInferenceTrafficSnapshot
  cleanup(): Promise<void>
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

const SUPPORTED_PROFILE_MODEL_METADATA = new Set(['maxTokens'])

export interface AppliedPiModelMetadata {
  modelConfig: Record<string, unknown>
  appliedMaxTokens?: number
}

/**
 * Apply only model controls that Pi can prove through its isolated models.json.
 *
 * The operator catalog remains the upper bound. A profile may lower that bound
 * for one run, but the source model object is never mutated and unknown metadata
 * is refused instead of being retained as if Pi had applied it.
 */
export function applyPiModelMetadata(
  modelConfig: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
): AppliedPiModelMetadata {
  const isolatedModelConfig = structuredClone(modelConfig)
  if (metadata === undefined) return { modelConfig: isolatedModelConfig }
  if (!isRecord(metadata) || Array.isArray(metadata)) {
    throw new BackendError(
      'backend pi cannot apply agent_profile.model.metadata because it is not an object',
      'parse_error',
    )
  }

  const unsupported = Object.keys(metadata).filter((key) => !SUPPORTED_PROFILE_MODEL_METADATA.has(key))
  if (unsupported.length > 0) {
    throw new BackendError(
      `backend pi cannot apply agent_profile.model.metadata field(s): ${unsupported.sort().join(', ')}; `
      + 'the selected Pi model has no proven native lowering for them',
      'not_configured',
    )
  }

  if (!Object.hasOwn(metadata, 'maxTokens')) return { modelConfig: isolatedModelConfig }
  const requested = metadata.maxTokens
  if (!isPositiveSafeInteger(requested)) {
    throw new BackendError(
      'backend pi agent_profile.model.metadata.maxTokens must be a positive safe integer',
      'parse_error',
    )
  }
  const operatorMaxTokens = isolatedModelConfig.maxTokens
  if (!isPositiveSafeInteger(operatorMaxTokens)) {
    throw new BackendError(
      'backend pi cannot apply agent_profile.model.metadata.maxTokens because the operator model '
      + 'has no valid maxTokens cap to lower',
      'not_configured',
    )
  }
  if (requested > operatorMaxTokens) {
    throw new BackendError(
      `backend pi agent_profile.model.metadata.maxTokens ${requested} exceeds the operator model cap ${operatorMaxTokens}`,
      'parse_error',
    )
  }

  isolatedModelConfig.maxTokens = requested
  return { modelConfig: isolatedModelConfig, appliedMaxTokens: requested }
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

  return async (selection, signal) => {
    const config = readConfiguredTransport(sourceAgentDir, selection)
    let stdout: string
    try {
      const result = await execFileAsync(
        options.bin,
        [
          'auth',
          'print-api-key',
          '--provider', selection.provider,
          '--model', selection.model,
        ],
        {
          env: trustedEnv,
          encoding: 'utf8',
          signal,
          maxBuffer: 1024 * 1024,
        },
      )
      stdout = result.stdout
    } catch (error) {
      throw new BackendError(
        `backend pi cannot establish isolated inference auth for ${selection.provider}/${selection.model}`,
        'not_configured',
      )
    }

    const upstreamApiKey = stdout.trim()
    if (!upstreamApiKey || /[\r\n\0]/u.test(upstreamApiKey)) {
      throw new BackendError(
        `backend pi cannot establish isolated inference auth for ${selection.provider}/${selection.model}: `
        + 'pi auth returned no single-line credential',
        'not_configured',
      )
    }

    return {
      ...config,
      upstreamApiKey,
      maxRequestBytes,
      sourceAgentDir,
      sourceSessionDir,
    }
  }
}

function readConfiguredTransport(
  sourceAgentDir: string,
  selection: PiInferenceSelection,
): Omit<
  ResolvedPiInferenceTransport,
  'upstreamApiKey' | 'maxRequestBytes' | 'sourceAgentDir' | 'sourceSessionDir'
> {
  const modelsPath = join(sourceAgentDir, 'models.json')
  let parsed: ModelsFile
  try {
    parsed = JSON.parse(readFileSync(modelsPath, 'utf8')) as ModelsFile
  } catch (error) {
    throw new BackendError(
      `backend pi requires ${modelsPath} to pin the selected provider endpoint and API mode before spawn`,
      'not_configured',
      error,
    )
  }

  const rawProvider = parsed.providers?.[selection.provider]
  if (!isRecord(rawProvider)) {
    throw new BackendError(
      `backend pi provider ${selection.provider} has no explicit entry in ${modelsPath}; `
      + 'define its baseUrl, api, and model there so isolated forwarding cannot guess',
      'not_configured',
    )
  }
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
  if (!isRecord(rawModel)) {
    throw new BackendError(
      `backend pi model ${selection.provider}/${selection.model} has no explicit entry in ${modelsPath}; `
      + 'the bridge refuses to infer model controls from a different catalog',
      'not_configured',
    )
  }
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
    /** Model metadata from the exact AgentProfile selected for this run. */
    modelMetadata?: Record<string, unknown>
  } = {},
): Promise<ProvisionedPiInferenceTransport> {
  assertExactModelBinding(resolved)
  const applied = applyPiModelMetadata(resolved.modelConfig, options.modelMetadata)
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
      apiMode: resolved.apiMode,
      ...(applied.appliedMaxTokens === undefined
        ? {}
        : { appliedMaxTokens: applied.appliedMaxTokens }),
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
  traffic(): PiInferenceTrafficSnapshot
  close(): Promise<void>
}

async function startScopedProxy(resolved: ResolvedPiInferenceTransport): Promise<ScopedProxy> {
  const scopedApiKey = randomBytes(32).toString('base64url')
  const traffic: PiInferenceTrafficSnapshot = {
    requests: 0,
    generationRequests: 0,
    auxiliaryRequests: 0,
    rejectedRequests: 0,
    failedRequests: 0,
    inFlightRequests: 0,
  }
  const server = createServer((request, response) => {
    traffic.requests += 1
    void forwardRequest(request, response, resolved, scopedApiKey, traffic)
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
  traffic: PiInferenceTrafficSnapshot,
): Promise<void> {
  if (!request.socket.remoteAddress || !isLoopbackAddress(request.socket.remoteAddress)) {
    traffic.rejectedRequests += 1
    writeProxyError(response, 403, 'loopback clients only')
    return
  }

  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
  const headers = new Headers()
  let authenticated = requestUrl.search.includes(scopedApiKey)
  for (const [name, raw] of Object.entries(request.headers)) {
    if (raw === undefined || isHopByHopHeader(name) || name.toLowerCase() === 'accept-encoding') continue
    const values = Array.isArray(raw) ? raw : [raw]
    for (const value of values) {
      if (value.includes(scopedApiKey)) authenticated = true
      headers.append(name, value.split(scopedApiKey).join(resolved.upstreamApiKey))
    }
  }
  // Node's fetch transparently decompresses upstream bodies. Asking for the
  // identity representation avoids a second compression boundary, and the
  // response path below still strips content-encoding if an upstream ignores it.
  headers.set('accept-encoding', 'identity')
  if (!authenticated) {
    traffic.rejectedRequests += 1
    writeProxyError(response, 401, 'invalid scoped inference credential')
    return
  }

  const upstreamUrl = appendPath(
    resolved.upstreamBaseUrl,
    requestUrl,
    scopedApiKey,
    resolved.upstreamApiKey,
  )
  const method = request.method ?? 'POST'
  const requestKind = inferenceRequestKind(resolved.apiMode, method, requestUrl.pathname)
  if (!requestKind) {
    traffic.rejectedRequests += 1
    writeProxyError(response, 404, 'scoped inference route not found')
    return
  }

  let requestBody: Buffer
  try {
    requestBody = await readRequestBody(request, resolved.maxRequestBytes)
  } catch (error) {
    traffic.rejectedRequests += 1
    request.resume()
    if (error instanceof RequestTooLargeError) {
      writeProxyError(
        response,
        413,
        `scoped inference request exceeds the configured ${resolved.maxRequestBytes}-byte maximum`,
      )
    } else {
      writeProxyError(response, 400, 'could not read scoped inference request')
    }
    return
  }
  if (!requestTargetsSelectedModel(
    resolved.apiMode,
    requestUrl.pathname,
    upstreamUrl.pathname,
    requestBody,
    resolved.model,
  )) {
    traffic.rejectedRequests += 1
    writeProxyError(response, 403, 'scoped inference credential cannot access that model')
    return
  }

  if (requestKind === 'generation') traffic.generationRequests += 1
  else traffic.auxiliaryRequests += 1
  traffic.inFlightRequests += 1
  const abort = new AbortController()
  request.once('aborted', () => abort.abort())

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
          .split(resolved.upstreamApiKey)
          .join(scopedApiKey)
      }
    })
    response.writeHead(upstream.status, responseHeaders)
    if (!upstream.body) {
      response.end()
      return
    }
    const body = Readable.fromWeb(upstream.body as never)
    await pipeline(
      body,
      createCredentialRedactionStream(resolved.upstreamApiKey, scopedApiKey),
      response,
    )
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
