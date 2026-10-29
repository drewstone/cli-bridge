import { DurableRunWriter } from './sessions/durable-writer.js'
/**
 * cli-bridge server entry — Hono on Node.
 *
 * Wires config → session store → backend registry → routes. The bearer
 * guard runs in one place (as Hono middleware); everything downstream
 * trusts the caller is authorized if it got this far.
 */

import { join, resolve } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { anyBackendSpawnsOnHost, assertListenerConfig, loadConfig, localHarnesses, type Config } from './config.js'
import { SessionStore } from './sessions/store.js'
import { BackendRegistry } from './backends/registry.js'
import { createLocalBackend } from './backends/local.js'
import { ClaudishBackend } from './backends/claudish.js'
import { CodexBackend } from './backends/codex.js'
import { FactoryBackend } from './backends/factory.js'
import { AmpBackend } from './backends/amp.js'
import { ForgeBackend } from './backends/forge.js'
import { AcpBackend } from './backends/acp.js'
import { NanoclawBackend } from './backends/nanoclaw.js'
import { PrimeBackend } from './backends/prime.js'
import { PassthroughBackend } from './backends/passthrough.js'
import { SandboxBackend } from './backends/sandbox.js'
import { createProfileCatalog, type ProfileCatalog } from './profiles/loader.js'
import { mountChatCompletions } from './routes/chat-completions.js'
import { mountHealth } from './routes/health.js'
import { mountModels } from './routes/models.js'
import { createNativeCatalog } from './native-catalog.js'
import { mountProfiles } from './routes/profiles.js'
import { mountSessions } from './routes/sessions.js'
import { mountRuns } from './routes/runs.js'
import { RetainedSessionService, mountRetainedSessions } from './sessions/retained.js'
import { mountCadRender } from './routes/cad-render.js'
import { mountImagesGenerate } from './routes/images-generate.js'
import { mountMetrics } from './routes/metrics.js'
import { AdmissionGate } from './admission.js'
import { scopedHostConcurrencyLimits } from './executors/scoped-host.js'
import { RunRegistry } from './runs/registry.js'
import { TraceEmitter } from './trace/emitter.js'
import { JsonlSpanSink, nullSpanSink } from './trace/sink.js'
import { selectJailBackend } from './jail/index.js'
import {
  acquireDataDirectoryLock,
  acquireInstanceLock,
  InstanceLockError,
  type InstanceLock,
} from './runtime/single-instance.js'
import { reapStalePrivateTemporaryRoots } from './runtime/private-temporary.js'
import { bindIncomingRequest } from './http/request-source.js'
import type { BridgeServer, StartServerOptions } from './server-options.js'
import { mountHubMcp } from './hub-mcp.js'

function parseEnvPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function parseEnvNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`invalid ${name}: expected a non-negative integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`invalid ${name}: expected a non-negative integer`)
  return value
}

export interface BuildAppExtras {
  shutdownHooks: Array<() => Promise<void>>
}

export async function buildApp(config: Config, cwd = process.cwd(), hubOptions?: StartServerOptions['hub']): Promise<{
  app: Hono
  sessions: SessionStore
  registry: BackendRegistry
  runs: RunRegistry
  catalog: ProfileCatalog
  extras: BuildAppExtras
}> {
  const sessions = new SessionStore(config.dataDir)
  const extras: BuildAppExtras = { shutdownHooks: [] }
  try {
  const registry = new BackendRegistry()
  const runs = new RunRegistry({
    replayRetentionMs: parseEnvPositiveInt('BRIDGE_RUN_REPLAY_RETENTION_MS', 60_000),
    identityRetentionMs: parseEnvPositiveInt('BRIDGE_RUN_IDENTITY_RETENTION_MS', 86_400_000),
    maxReplayDeltas: parseEnvPositiveInt('BRIDGE_RUN_MAX_REPLAY_DELTAS', 10_000),
    maxReplayBytes: parseEnvPositiveInt('BRIDGE_RUN_MAX_REPLAY_BYTES', 32 * 1024 * 1024),
    maxLifetimeMs: parseEnvNonNegativeInt('BRIDGE_RUN_MAX_LIFETIME_MS', 0),
  })
  extras.shutdownHooks.push(async () => await runs.shutdown())
  const durableWriter = config.asyncDurableWrites ? new DurableRunWriter(config.dataDir) : null
  if (durableWriter) {
    extras.shutdownHooks.push(() => durableWriter.close())
    await durableWriter.open()
  }
  const catalog = createProfileCatalog(config.sandboxProfilesDir)
  const admission = new AdmissionGate(config.admission)
  extras.shutdownHooks.push(async () => admission.close())

  const jailEnv = {
    BRIDGE_JAIL_MODE: config.jailMode,
    BRIDGE_JAIL_ROOT: config.jailRoot ?? undefined,
    BRIDGE_JAIL_RO_PATHS: config.jailReadablePaths.join(','),
    BRIDGE_JAIL_RW_PATHS: config.jailWritablePaths.join(','),
    BRIDGE_JAIL_FALLBACK: config.jailFallback,
  }
  // Register order matters — first match wins. Harness-specific backends
  // come first so a `claude-code/sonnet` doesn't get claimed by a
  // passthrough that happens to know a provider-prefixed model id.
  for (const [name, harness] of localHarnesses) {
    if (!config.backends.has(name)) continue
    const bin = config[`${name}Bin`]
    registry.register(createLocalBackend(config, name, {
      stateDir: join(config.dataDir, name), ...(name === 'pi' ? { jailEnv } : {}) }))
  }
  if (config.backends.has('claudish')) {
    if (!config.claudishUrl) {
      throw new Error('claudish backend enabled but CLAUDISH_URL is not set')
    }
    registry.register(new ClaudishBackend({
      bin: config.claudeBin,
      timeoutMs: config.claudeTimeoutMs,
      claudishUrl: config.claudishUrl,
    }))
  }
  for (const [name, Backend] of [['factory', FactoryBackend], ['amp', AmpBackend], ['forge', ForgeBackend]] as const) {
    if (config.backends.has(name)) registry.register(new Backend({ bin: config[`${name}Bin`], timeoutMs: config.cliTimeoutMsDefault }))
  }
  // ACP-protocol agents (driven via `<bin> acp`): hermes, openclaw. Registered when
  // BRIDGE_BACKENDS lists them; health reports `unavailable` if the binary is absent.
  for (const name of ['hermes', 'openclaw'] as const) {
    if (config.backends.has(name)) registry.register(new AcpBackend({ name, bin: config[`${name}Bin`], timeoutMs: config.cliTimeoutMsDefault }))
  }
  // NanoClaw: a Unix-socket client to the running NanoClaw daemon (not a spawned CLI).
  if (config.backends.has('nanoclaw')) {
    registry.register(new NanoclawBackend({ socketPath: config.nanoclawSocket, timeoutMs: config.cliTimeoutMsDefault }))
  }
  // prime-agent (the pi fork) — host-spawned `--mode rpc` with a bridge-owned
  // isolated HOME per run; see PrimeBackend for the daemon-avoidance contract.
  if (config.backends.has('prime')) {
    registry.register(new PrimeBackend({
      bin: config.primeBin,
      timeoutMs: config.primeTimeoutMs,
      stateDir: join(config.dataDir, 'prime'),
      ...(config.primeModelsJson ? { modelsJsonPath: config.primeModelsJson } : {}),
      ...(config.primePersistentAgentDir ? { persistentAgentDir: config.primePersistentAgentDir } : {}),
    }))
  }
  if (config.backends.has('passthrough')) {
    registry.register(new PassthroughBackend({
      openaiApiKey: config.openaiApiKey,
      anthropicApiKey: config.anthropicApiKey,
      moonshotApiKey: config.moonshotApiKey,
      zaiApiKey: config.zaiApiKey,
    }))
  }
  if (config.backends.has('sandbox')) {
    if (!config.sandboxApiUrl || !config.sandboxApiKey) {
      throw new Error('sandbox backend enabled but SANDBOX_API_URL + SANDBOX_API_KEY not set')
    }
    registry.register(new SandboxBackend({
      apiUrl: config.sandboxApiUrl,
      apiKey: config.sandboxApiKey,
      timeoutMs: config.sandboxTimeoutMs,
      resolveProfile: (id) => catalog.get(id),
    }))
  }

  // Retained sessions own one provider-native child across turns. The service
  // is created only after every backend is registered so capability discovery
  // and model routing use the same registry as one-shot chat.
  const codexBackend = registry.byName('codex')
  const nativeCatalog = createNativeCatalog(config, codexBackend instanceof CodexBackend ? codexBackend.readCatalog : undefined, cwd)
  const retained = new RetainedSessionService({ store: sessions, registry, runs, admitSubscription: nativeCatalog.admit })
  extras.shutdownHooks.unshift(async () => await retained.shutdown())

  const app = new Hono()
  const hub = hubOptions ? mountHubMcp(app, hubOptions) : undefined
  if (hub) extras.shutdownHooks.push(async () => hub.close())

  // Bearer guard — only active when BRIDGE_BEARER is set.
  if (config.bearer) {
    const expected = Buffer.from(config.bearer)
    app.use('*', async (c, next) => {
      if (c.req.path === '/health') return next()
      const header = c.req.header('authorization') ?? ''
      const supplied = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return c.json({ error: { message: 'Unauthorized', type: 'invalid_authentication_error' } }, 401)
      }
      return next()
    })
  }

  mountHealth(app, { registry, admission, runs })
  mountModels(app, { registry, catalog, opencodeBin: config.opencodeBin, piBin: config.piBin, cwd, describe: nativeCatalog.describe })
  mountSessions(app, { sessions, retained })
  mountRetainedSessions(app, retained, { includeSessionList: false, includeRunEvents: false })
  mountRuns(app, { runs, retainedRuns: retained, retainedStore: sessions })
  mountProfiles(app, { catalog })
  mountChatCompletions(app, {
    registry,
    sessions,
    retainedRuns: sessions,
    durableWriter: durableWriter ?? undefined,
    contextTransfers: retained,
    runs,
    admission,
    admissionReservedClients: config.admissionReservedClients,
    jailEnv,
    admitSubscription: async (request, backend, signal) => {
      await nativeCatalog.admit(request, backend, signal)
      return hub?.prepare(request, signal, backend)
    },
    trace: new TraceEmitter({
      sink: config.trace.enabled ? new JsonlSpanSink(config.trace) : nullSpanSink,
      maxToolSpans: config.trace.maxToolSpans,
    }),
  })
  mountCadRender(app)
  mountImagesGenerate(app)
  mountMetrics(app)

  app.get('/', (c) => c.json({
    name: 'cli-bridge',
    version: '0.3.0',
    scheme: 'bridge/<harness>/<model>',
    capabilities: {
      profileMaterialization: 'cli-bridge.profile-materialization.v2',
      usageCostProvenance: 'cli-bridge.usage-cost.v1',
      // Platform attachments carried outside the session-bound profile;
      // dispatchers gate on this flag and refuse loud when it is absent.
      runtimeAttachments: { mcp: true },
    },
    backends: registry.all().map(b => b.name),
    endpoints: [
      '/health',
      '/v1/models',
      '/v1/chat/completions',
      '/v1/sessions',
      '/v1/capabilities',
      '/v1/context-transfers',
      '/v1/context-transfers/:operationId',
      '/v1/context-transfer-environments/:environmentId',
      '/v1/sessions/:id/turns',
      '/v1/sessions/:id/input',
      '/v1/sessions/:id/events',
      '/v1/sessions/:id/status',
      '/v1/sessions/:id/steer',
      '/v1/sessions/:id/cancel',
      '/v1/sessions/:id/detach',
      '/v1/sessions/:id/close',
      '/v1/runs/:id',
      '/v1/runs/:id/events',
      '/v1/runs/:id/cancel',
      '/v1/runs/:runId/interactions/:interactionId/respond',
      '/cad/render',
      '/images/generate',
    ],
  }))

  return { app, sessions, registry, runs, catalog, extras }
  } catch (error) {
    try { await disposeApp({ sessions, extras }) } catch (cleanup) {
      throw new UnconfirmedBridgeCleanup([error, cleanup], 'CLI Bridge startup failed and cleanup was not confirmed')
    }
    throw error
  }
}

export type { BridgeServer, StartServerOptions } from './server-options.js'
export { loadConfig }
export { detectLocalSeats } from './local-seats.js'
export { listLocalModels } from './local-models.js'

class UnconfirmedBridgeCleanup extends AggregateError {}

async function disposeApp(built: Pick<Awaited<ReturnType<typeof buildApp>>, 'sessions' | 'extras'>): Promise<void> {
  const errors: unknown[] = []
  // Retained runs settle before the durable writer and database close.
  for (const hook of built.extras.shutdownHooks) {
    try { await hook() } catch (error) { errors.push(error) }
  }
  try { built.sessions.close() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'CLI Bridge shutdown could not confirm all owned resources closed')
}

export async function startServer(options: StartServerOptions = {}): Promise<BridgeServer> {
  const config = structuredClone(options.config ?? loadConfig())
  const cwd = resolve(options.cwd ?? process.cwd())
  assertListenerConfig(config, true)
  const jailFloor = config.jailMode
  if (jailFloor !== 'off' && anyBackendSpawnsOnHost(config.backends) && !(await selectJailBackend().isAvailable())) {
    if (config.jailFallback === 'warn') {
      console.warn(`[cli-bridge] WARNING: jail floor '${jailFloor}' is unavailable; requests run UNCONFINED (BRIDGE_JAIL_FALLBACK=warn).`)
    } else {
      throw new Error(`CLI Bridge jail floor '${jailFloor}' is unavailable. Enable a supported jail backend, or unset the jail floor.`)
    }
  }
  const dataDirectoryLock = acquireDataDirectoryLock(config.dataDir)
  let instanceLock: InstanceLock | undefined
  let built: Awaited<ReturnType<typeof buildApp>>
  const release = () => { instanceLock?.release(); dataDirectoryLock.release() }
  try {
    // The OS owns ephemeral listener allocation; a shared port-0 pidfile would serialize unrelated embedded servers.
    if (config.port !== 0) instanceLock = acquireInstanceLock(config.port)
    reapStalePrivateTemporaryRoots()
    built = await buildApp({ ...config, dataDir: dataDirectoryLock.dataDir }, cwd, options.hub)
  } catch (error) {
    if (!(error instanceof UnconfirmedBridgeCleanup)) release()
    throw error
  }
  let server: ReturnType<typeof serve>
  try {
    server = serve({
    fetch: ((request: Request, info?: { incoming?: import('node:http').IncomingMessage }) => {
      if (info?.incoming) bindIncomingRequest(request, info.incoming)
      return built.app.fetch(request)
    }) as typeof built.app.fetch,
    hostname: config.host,
    port: config.port,
    // Native run policy owns the execution deadline, including long streaming turns.
    serverOptions: { requestTimeout: 0, headersTimeout: 0, keepAliveTimeout: 0 },
    })
  } catch (error) {
    try { await disposeApp(built) } catch (cleanup) {
      throw new UnconfirmedBridgeCleanup([error, cleanup], 'CLI Bridge startup failed and cleanup was not confirmed')
    }
    release()
    throw error
  }
  let closed: Promise<void> | undefined
  const detach = () => {
    process.off('exit', release)
    process.off('SIGTERM', shutdown)
    process.off('SIGINT', shutdown)
    process.off('unhandledRejection', unhandledRejection)
    process.off('uncaughtException', uncaughtException)
  }
  const close = (): Promise<void> => closed ??= (async () => {
    detach()
    const stopped = new Promise<void>((resolve, reject) => server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else resolve()
    }))
    // Keep the listener rejection handled while awaiting native work shutdown.
    void stopped.catch(() => {})
    try {
      await disposeApp(built)
    } finally {
      if ('closeAllConnections' in server) server.closeAllConnections()
      await stopped
    }
    release()
  })()
  const shutdown = () => {
    const timer = setTimeout(() => process.exit(1), 5000).unref()
    void close().then(() => { clearTimeout(timer); process.exit(0) }, (error) => {
      console.error('[cli-bridge] shutdown failed', error)
      process.exit(1)
    })
  }
  const unhandledRejection = (reason: unknown) => {
    console.error('[cli-bridge] unhandledRejection — keeping process alive', reason instanceof Error ? reason.message : String(reason))
  }
  const uncaughtException = (error: Error) => {
    console.error('[cli-bridge] uncaughtException', error.message)
    if (isFatalServerStartupError(error)) process.exit(1)
  }
  try {
    if (!server.listening) await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
  } catch (error) {
    try { await close() } catch (cleanup) {
      throw new UnconfirmedBridgeCleanup([error, cleanup], 'CLI Bridge startup failed and cleanup was not confirmed')
    }
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') {
    await close()
    throw new Error('CLI Bridge listener has no TCP address')
  }
  const host = address.address.includes(':') ? `[${address.address}]` : address.address
  const url = `http://${host}:${address.port}`
  if (options.handleSignals !== false) {
    process.once('exit', release)
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
    process.on('unhandledRejection', unhandledRejection)
    process.on('uncaughtException', uncaughtException)
  }
  if (!options.quiet) {
    console.log(`[cli-bridge] listening on ${url} (host=${config.host})`)
    console.log(`[cli-bridge] backends: ${[...config.backends].join(', ')}`)
    console.log(`[cli-bridge] bearer: ${config.bearer ? 'required' : 'none (loopback only)'}`)
    console.log(`[cli-bridge] host admission: maxActive=${config.admission.maxActive} maxQueue=${config.admission.maxQueue}/class reservedActive=${config.admission.reservedActive} queueTimeoutMs=${config.admission.queueTimeoutMs} bulkQueueTimeoutMs=${config.admission.bulkQueueTimeoutMs}`)
    console.log(`[cli-bridge] reserved-lane clients: ${config.admissionReservedClients.join(', ') || 'none'}`)
    const scope = scopedHostConcurrencyLimits()
    if (scope.max < config.admission.maxActive) console.warn(`[cli-bridge] admission maxActive=${config.admission.maxActive} exceeds scoped-executor concurrency=${scope.max}; lower BRIDGE_HOST_CHAT_MAX_ACTIVE or raise CLI_BRIDGE_SCOPE_MAX_CONCURRENCY.`)
    if (config.admission.reservedActive > 0 && scope.reserved === 0) console.warn('[cli-bridge] admission reserves a lane but the executor does not; set CLI_BRIDGE_SCOPE_RESERVED_CONCURRENCY.')
    console.log(config.trace.enabled ? `[cli-bridge] traces: ${config.trace.file} (max ${config.trace.maxBytes} bytes × ${config.trace.maxFiles} files)` : '[cli-bridge] traces: off (BRIDGE_TRACE=off)')
    console.log(`[cli-bridge] jail default: ${jailFloor}${jailFloor !== 'off' ? ` root=${config.jailRoot ?? '<cwd>/.agent-home'}` : ''}`)
  }
  return { url, close }
}

if (import.meta.url === `file://${process.argv[1]}`) await startServer()

function isFatalServerStartupError(err: Error): boolean {
  if (err instanceof InstanceLockError) return true
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EADDRINUSE' || code === 'EACCES' || /listen|address already in use|already running on port/i.test(err.message)
}
