import { DurableRunWriter } from './sessions/durable-writer.js'
/**
 * cli-bridge server entry — Hono on Node.
 *
 * Wires config → session store → backend registry → routes. The bearer
 * guard runs in one place (as Hono middleware); everything downstream
 * trusts the caller is authorized if it got this far.
 */

import { join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { anyBackendSpawnsOnHost, assertListenerConfig, loadConfig, localHarnesses, type Config } from './config.js'
import { SessionStore } from './sessions/store.js'
import { BackendRegistry } from './backends/registry.js'
import { ClaudeBackend } from './backends/claude.js'
import { ClaudishBackend } from './backends/claudish.js'
import { CodexBackend } from './backends/codex.js'
import { OpencodeBackend } from './backends/opencode.js'
import { KimiBackend } from './backends/kimi.js'
import { GeminiBackend } from './backends/gemini.js'
import { FactoryBackend } from './backends/factory.js'
import { AmpBackend } from './backends/amp.js'
import { ForgeBackend } from './backends/forge.js'
import { AcpBackend } from './backends/acp.js'
import { NanoclawBackend } from './backends/nanoclaw.js'
import { PiBackend } from './backends/pi.js'
import { PrimeBackend } from './backends/prime.js'
import { PassthroughBackend } from './backends/passthrough.js'
import { SandboxBackend } from './backends/sandbox.js'
import { createProfileCatalog, type ProfileCatalog } from './profiles/loader.js'
import { mountChatCompletions } from './routes/chat-completions.js'
import { mountHealth } from './routes/health.js'
import { mountModels } from './routes/models.js'
import { mountProfiles } from './routes/profiles.js'
import { mountSessions } from './routes/sessions.js'
import { mountRuns } from './routes/runs.js'
import { RetainedSessionService, mountRetainedSessions } from './sessions/retained.js'
import { mountCadRender } from './routes/cad-render.js'
import { mountImagesGenerate } from './routes/images-generate.js'
import { mountMetrics, registerPoolForMetrics } from './routes/metrics.js'
import { mountPoolMaintenance } from './routes/pool-maintenance.js'
import { PoolMaintenance } from './runtime/pool-maintenance.js'
import { ContainerPool } from './executors/container-pool.js'
import { provisionNetJail } from './executors/net-jail-network.js'
import { modelEndpointsFor, parseAllowList } from './jail/net-allowlist.js'
import type { EnforcedNetJail } from './jail/enforce-net-jail.js'
import { createDockerSpawner } from './executors/docker.js'
import {
  buildCommandFor,
  DockerPreflightError,
  preflightDockerImage,
  preflightDockerSlot,
  type DockerPreflightMount,
  type DockerPreflightTarget,
  type PreflightFinding,
} from './executors/docker-preflight.js'
import type { Spawner } from './executors/types.js'

/**
 * Volume-name prefix for per-slot credential mount `mountIndex`. Index 0 keeps
 * the historical `<namePrefix>-oauth` name so an existing per-slot login is not
 * orphaned by adding the second mount.
 */
function perSlotVolumePrefix(cfg: BackendExecutorConfig, mountIndex: number): string {
  const base = `${cfg.namePrefix ?? `cli-bridge-${cfg.name}-pool`}-oauth`
  return mountIndex === 0 ? base : `${base}${mountIndex}`
}
import type { BackendExecutorConfig } from './config.js'
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
  /** Disposers to await on graceful shutdown — pool teardown lives here. */
  shutdownHooks: Array<() => Promise<void>>
  /**
   * Backends whose worker containers were provisioned onto a verified net-jail
   * network. Written only after {@link provisionNetJail} has PROVEN the jail on
   * a throwaway container, so a membership test here is evidence rather than
   * intent — which is what lets the chat route refuse a net-jail request it
   * cannot honour instead of recording a policy it never applied.
   */
  netJail: Map<string, EnforcedNetJail>
}

/**
 * Describe a docker executor for the startup preflight. Kept next to the pool
 * wiring so the probed configuration is derived from the SAME values the pool
 * receives — a preflight that reconstructs the config independently can pass
 * while the real pool is misconfigured.
 */
function preflightTargetFor(cfg: BackendExecutorConfig, bin: string, slotIndex: number): DockerPreflightTarget {
  const containerHome = cfg.containerHome ?? '/root'
  // The mount the credential file belongs to, so the check runs against the
  // directory that actually holds auth rather than the first one configured.
  const credentialPath = cfg.credentialFile ? `${containerHome}/${cfg.credentialFile}` : undefined
  const mounts: DockerPreflightMount[] = [
    { host: cfg.hostConfigDir!, container: cfg.containerConfigDir! },
    ...(cfg.extraMounts ?? []),
  ].map((pair, i) => {
    const credentialFile = credentialPath?.startsWith(`${pair.container}/`)
      ? credentialPath.slice(pair.container.length + 1) : undefined
    return {
      // Per-slot mode gives THIS slot its own volumes, so the probe must name
      // this slot's volumes — probing slot 0's for every slot was evidence
      // about one slot while traffic went to all of them.
      source: cfg.oauthMode === 'per-slot' ? `${perSlotVolumePrefix(cfg, i)}-${slotIndex}` : pair.host,
      target: pair.container,
      kind: cfg.oauthMode === 'per-slot' ? 'volume' : 'bind',
      ...(credentialFile ? { credentialFile } : {}),
    }
  })
  return {
    backend: cfg.name,
    envPrefix: cfg.name.toUpperCase(),
    image: cfg.image!,
    bin,
    containerHome,
    ...(cfg.containerUser ? { containerUser: cfg.containerUser } : {}),
    ...(cfg.workspaceRoot ? { workspaceRoot: cfg.workspaceRoot } : {}),
    mounts,
    buildCommand: buildCommandFor(cfg.image!),
  }
}

/**
 * Build a Spawner for a backend, plus the shutdown hook that tears down
 * the underlying container pool when the bridge exits. Returns null when
 * the backend's executor is `host` — backends fall back to their default
 * hostSpawner in that case.
 *
 * Order matters. The image/daemon/mount checks run BEFORE provisioning,
 * because `docker run` against an absent image fails with a message about
 * pulling from a registry — not the build command the operator needs. The
 * slot checks run AFTER, against a real pool container, and end by executing
 * `<bin> --version` in the workdir the executor will cd into. Both throw, so
 * `startServer` never reaches `serve()` with a configuration that would fail
 * at first request.
 */
async function buildExecutorForBackend(
  cfg: BackendExecutorConfig | undefined,
  /**
   * The name the chat route resolves this backend by (`backend.name`). It keys the net-jail
   * registry, so it must equal the registered harness name, which differs from the executor
   * config name for claude (`claude-code`) and kimi (`kimi-code`).
   */
  routeName: string,
  extras: BuildAppExtras,
  bin: string,
  config: Config,
): Promise<Spawner | null> {
  if (!cfg || cfg.kind !== 'docker') return null
  if (!cfg.image || !cfg.poolSize || !cfg.containerConfigDir) {
    throw new Error(`backend ${cfg.name} executor=docker but missing image/poolSize/containerConfigDir`)
  }
  // The net-jail is provisioned BEFORE the pool because the pool's containers
  // join its internal network at creation; a container cannot be re-jailed
  // afterwards. loadConfig has already refused any configuration this cannot
  // enforce, so reaching here with the mode on means it must succeed.
  const netJail = config.netJailMode === 'net-jail'
    ? await provisionNetJail({
      backend: cfg.name,
      namePrefix: cfg.namePrefix ?? `cli-bridge-${cfg.name}-pool`,
      image: cfg.image,
      allow: [
        ...modelEndpointsFor(cfg.name, process.env),
        ...parseAllowList(config.netJailAllow.join(','), 'BRIDGE_NET_JAIL_ALLOW'),
      ],
      onProgress: (m) => console.log(`[${cfg.name}-pool] ${m}`),
    })
    : null
  if (netJail) {
    extras.shutdownHooks.push(() => netJail.destroy())
    console.log(
      `[${cfg.name}-pool] net-jail verified on ${netJail.network} — sole next hop ${netJail.relayIp} ` +
        '(Docker host, peer containers, link-local and IPv6 proven unreachable); egress denied except ' +
        netJail.entries.map((e) => `${e.host}:${e.port} (${e.source})`).join(', '),
    )
  }
  // Deliberately not switchable off. An operator who needs the bridge up
  // without a working container runtime wants <NAME>_EXECUTOR=host, not a
  // bridge that reports ready and fails every request.
  const target = preflightTargetFor(cfg, bin, 0)
  const imageFindings = await preflightDockerImage(target)
  if (imageFindings.length > 0) throw new DockerPreflightError(cfg.name, imageFindings)
  const caps = {
    memory: process.env.BRIDGE_POOL_MEMORY || '4g',
    cpus: process.env.BRIDGE_POOL_CPUS || '2',
    maxQueueDepth: parseEnvPositiveInt('BRIDGE_POOL_MAX_QUEUE', cfg.poolSize * 4),
    acquireDeadlineMs: parseEnvPositiveInt('BRIDGE_POOL_ACQUIRE_DEADLINE_MS', 60_000),
    maxAcquireDeadlineMs: parseEnvPositiveInt('BRIDGE_POOL_MAX_ACQUIRE_DEADLINE_MS', 900_000),
    slotMaxHoldMs: parseEnvNonNegativeInt('BRIDGE_SLOT_MAX_HOLD_MS', 0),
  }
  const pool = await ContainerPool.create({
    size: cfg.poolSize,
    image: cfg.image,
    namePrefix: cfg.namePrefix ?? `cli-bridge-${cfg.name}-pool`,
    oauthMode: cfg.oauthMode ?? 'share',
    strictSessionAffinity: cfg.name === 'codex' && cfg.oauthMode === 'per-slot',
    ...caps,
    ...(cfg.containerUser ? { containerUser: cfg.containerUser } : {}),
    ...(cfg.containerHome ? { containerHome: cfg.containerHome } : {}),
    ...(cfg.workspaceRoot ? { workspaceRoot: cfg.workspaceRoot } : {}),
    // The net-jail network supersedes any operator network; loadConfig refuses
    // a configuration where both are set, so this can never silently override.
    ...(netJail ? { network: netJail.network } : cfg.network ? { network: cfg.network } : {}),
    // Joining the internal network is not the jail. The deny lives in each
    // container's own network namespace, and it is written here — a slot whose
    // filter cannot be installed is destroyed instead of served.
    ...(netJail ? { afterCreate: (id: string, i: number) => netJail.applyFilter(id, `slot ${i}`) } : {}),
    // Every credential directory the CLI reads, not only the primary one: a pool
    // that mounts ~/.config/opencode alone has no auth.json in it, and the CLI
    // then authenticates against nothing and returns an empty completion.
    ...(cfg.oauthMode === 'share' || !cfg.oauthMode
      ? {
          shareMounts: [
            `${cfg.hostConfigDir}:${cfg.containerConfigDir}`,
            ...(cfg.extraMounts ?? []).map((m) => `${m.host}:${m.container}`),
          ],
        }
      : {
          perSlotVolumes: [
            { volumePrefix: perSlotVolumePrefix(cfg, 0), target: cfg.containerConfigDir },
            ...(cfg.extraMounts ?? []).map((m, i) => ({
              volumePrefix: perSlotVolumePrefix(cfg, i + 1),
              target: m.container,
            })),
          ],
        }),
    onProgress: (m) => console.log(`[${cfg.name}-pool] ${m}`),
  })
  console.log(`[${cfg.name}-pool] caps`, caps)
  registerPoolForMetrics(cfg.name, pool)
  extras.shutdownHooks.push(() => pool.destroy())

  // Probe a real slot: same image, same mounts, same user, same workdir the
  // executor will use. If this passes, `ok` on /health means the bridge has
  // demonstrated it can execute a command, not merely that it started.
  const liveContainers = pool.liveContainerIds()
  if (liveContainers.length === 0) {
    await pool.destroy()
    throw new Error(`backend ${cfg.name}: container pool provisioned no usable slots`)
  }
  const preflightWarnings: string[] = []
  const slotFindings: PreflightFinding[] = []
  for (const [slotIndex, containerId] of liveContainers.entries()) {
    // Slot 0 pays for the whole probe; every other slot is checked for the one
    // thing that is genuinely per-slot — its own credential mounts. Skipping
    // them entirely is how a pool with zero credentials reported preflight ok.
    slotFindings.push(...(await preflightDockerSlot(
      slotIndex === 0 ? target : preflightTargetFor(cfg, bin, slotIndex),
      containerId,
      undefined,
      preflightWarnings,
      slotIndex === 0 ? {} : { scope: 'credentials' },
    )))
  }
  if (slotFindings.length > 0) {
    await pool.destroy()
    throw new DockerPreflightError(cfg.name, slotFindings)
  }
  for (const warning of preflightWarnings) console.warn(`[${cfg.name}-pool] WARNING: ${warning}`)
  // The summary may not claim more than the probes established. Measured on this
  // host: two WARNING lines saying the credential volumes hold no auth.json,
  // followed immediately by "credential mounts ... all verified in-slot" — a
  // success message contradicting the warnings above it, in the same log, which
  // is the same defect as a 200 on a failed request.
  console.log(
    preflightWarnings.length === 0
      ? `[${cfg.name}-pool] preflight ok on ${liveContainers.length} slot(s) — image, credential mounts, HOME, ` +
        `workspace ${cfg.workspaceRoot}, and \`${bin} --version\` all verified in-slot`
      : `[${cfg.name}-pool] preflight passed with ${preflightWarnings.length} warning(s) on ` +
        `${liveContainers.length} slot(s) — image, HOME, workspace ${cfg.workspaceRoot} and ` +
        `\`${bin} --version\` verified in-slot; the warnings above are NOT verified and /health reports them`,
  )

  // Recorded only here: after the network was verified AND a pool of live slots
  // was actually created on it. Anything earlier would let the chat route
  // report a jail for containers that do not exist.
  if (netJail) extras.netJail.set(routeName, { network: netJail.network, allow: netJail.allow })

  return createDockerSpawner({
    pool,
    oauthMode: cfg.oauthMode ?? 'share',
    containerConfigDir: cfg.containerConfigDir,
    backend: cfg.name,
    envPrefix: cfg.name.toUpperCase(),
    ...(cfg.workspaceRoot ? { workspaceRoot: cfg.workspaceRoot } : {}),
    // The readiness probe must judge the SAME configuration the pool received,
    // for the slot it actually acquires — so it is derived here, from these
    // values, rather than reconstructed inside the executor.
    preflightTarget: (slotIndex) => preflightTargetFor(cfg, bin, slotIndex),
  })
}

export async function buildApp(config: Config): Promise<{
  app: Hono
  sessions: SessionStore
  registry: BackendRegistry
  runs: RunRegistry
  catalog: ProfileCatalog
  extras: BuildAppExtras
}> {
  const sessions = new SessionStore(config.dataDir)
  const extras: BuildAppExtras = { shutdownHooks: [], netJail: new Map() }
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
  // Validate the durable maintenance owner before any backend provisions Docker slots.
  const poolMaintenance = new PoolMaintenance(config.dataDir)
  extras.shutdownHooks.push(async () => await poolMaintenance.close())
  const durableWriter = config.asyncDurableWrites ? new DurableRunWriter(config.dataDir) : null
  if (durableWriter) {
    extras.shutdownHooks.push(() => durableWriter.close())
    await durableWriter.open()
  }
  const catalog = createProfileCatalog(config.sandboxProfilesDir)
  const admission = new AdmissionGate(config.admission)
  extras.shutdownHooks.push(async () => admission.close())

  // Register order matters — first match wins. Harness-specific backends
  // come first so a `claude-code/sonnet` doesn't get claimed by a
  // passthrough that happens to know a provider-prefixed model id.
  const nativeBackends = { claude: ClaudeBackend, codex: CodexBackend, opencode: OpencodeBackend,
    kimi: KimiBackend, gemini: GeminiBackend, pi: PiBackend }
  for (const [name, harness] of localHarnesses) {
    if (!config.backends.has(name)) continue
    const bin = config[`${name}Bin`]
    const Backend = nativeBackends[name]
    const spawner = await buildExecutorForBackend(config.executors[name], harness, extras, bin, config)
    registry.register(new Backend({ bin, harness, timeoutMs: config[`${name}TimeoutMs`],
      stateDir: join(config.dataDir, name), ...(spawner ? { spawner } : {}) }))
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
  const retained = new RetainedSessionService({ store: sessions, registry, runs })
  extras.shutdownHooks.unshift(async () => await retained.shutdown())

  const app = new Hono()

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
  mountModels(app, { registry, catalog, opencodeBin: config.opencodeBin, piBin: config.piBin })
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
    netJail: extras.netJail,
    trace: new TraceEmitter({
      sink: config.trace.enabled ? new JsonlSpanSink(config.trace) : nullSpanSink,
      maxToolSpans: config.trace.maxToolSpans,
    }),
  })
  mountCadRender(app)
  mountImagesGenerate(app)
  mountMetrics(app)
  mountPoolMaintenance(app, poolMaintenance, Boolean(config.bearer))

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
      '/v1/sessions/:id/transcript',
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
  assertListenerConfig(config, true)
  const fsJailFlag = ['1', 'true', 'yes', 'on'].includes((process.env.WORKER_FS_JAIL ?? '').trim().toLowerCase())
  const jailFloor = fsJailFlag ? 'fs-jail' : config.jailMode
  if (jailFloor !== 'off' && anyBackendSpawnsOnHost(config.backends, config.executors) && !selectJailBackend().isAvailable()) {
    if (process.env.BRIDGE_JAIL_FALLBACK === 'warn') {
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
    built = await buildApp({ ...config, dataDir: dataDirectoryLock.dataDir })
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
    for (const executor of Object.values(config.executors)) {
      if (executor.kind === 'docker') console.log(`[cli-bridge] ${executor.name} executor: docker pool size=${executor.poolSize} image=${executor.image}`)
    }
  }
  return { url, close }
}

if (import.meta.url === `file://${process.argv[1]}`) await startServer()

function isFatalServerStartupError(err: Error): boolean {
  if (err instanceof InstanceLockError) return true
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EADDRINUSE' || code === 'EACCES' || /listen|address already in use|already running on port/i.test(err.message)
}
