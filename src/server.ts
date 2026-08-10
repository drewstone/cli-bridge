/**
 * cli-bridge server entry — Hono on Node.
 *
 * Wires config → session store → backend registry → routes. The bearer
 * guard runs in one place (as Hono middleware); everything downstream
 * trusts the caller is authorized if it got this far.
 */

import { join } from 'node:path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { anyBackendSpawnsOnHost, loadConfig, type Config } from './config.js'
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
import { mountCadRender } from './routes/cad-render.js'
import { mountImagesGenerate } from './routes/images-generate.js'
import { mountMetrics, registerPoolForMetrics } from './routes/metrics.js'
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
import { acquireInstanceLock, PortAlreadyBoundError } from './runtime/single-instance.js'

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
  const credentialTargetFor = (containerTarget: string): string | undefined => {
    if (!cfg.credentialFile) return undefined
    const full = `${containerHome}/${cfg.credentialFile}`
    if (!full.startsWith(`${containerTarget}/`)) return undefined
    return full.slice(containerTarget.length + 1)
  }
  const pairs: Array<{ host: string; container: string }> = [
    { host: cfg.hostConfigDir!, container: cfg.containerConfigDir! },
    ...(cfg.extraMounts ?? []),
  ]
  const mounts: DockerPreflightMount[] = pairs.map((pair, i) => {
    const credentialFile = credentialTargetFor(pair.container)
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
  const memory = process.env.BRIDGE_POOL_MEMORY || '4g'
  const cpus = process.env.BRIDGE_POOL_CPUS || '2'
  const maxQueueDepth = parseEnvPositiveInt('BRIDGE_POOL_MAX_QUEUE', cfg.poolSize * 4)
  const acquireDeadlineMs = parseEnvPositiveInt('BRIDGE_POOL_ACQUIRE_DEADLINE_MS', 60_000)
  const slotMaxHoldMs = parseEnvNonNegativeInt('BRIDGE_SLOT_MAX_HOLD_MS', 0)
  const pool = await ContainerPool.create({
    size: cfg.poolSize,
    image: cfg.image,
    namePrefix: cfg.namePrefix ?? `cli-bridge-${cfg.name}-pool`,
    oauthMode: cfg.oauthMode ?? 'share',
    memory,
    cpus,
    maxQueueDepth,
    acquireDeadlineMs,
    slotMaxHoldMs,
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
  console.log(
    `[${cfg.name}-pool] caps memory=${memory} cpus=${cpus} queue=${maxQueueDepth} ` +
      `acquire-deadline=${acquireDeadlineMs}ms ` +
        `slot-hold=${slotMaxHoldMs === 0 ? 'disabled' : `${slotMaxHoldMs}ms`}`,
  )
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
  if (netJail) extras.netJail.set(cfg.name, { network: netJail.network, allow: netJail.allow })

  return createDockerSpawner({
    pool,
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
  const registry = new BackendRegistry()
  const runs = new RunRegistry({
    replayRetentionMs: parseEnvPositiveInt('BRIDGE_RUN_REPLAY_RETENTION_MS', 60_000),
    identityRetentionMs: parseEnvPositiveInt('BRIDGE_RUN_IDENTITY_RETENTION_MS', 86_400_000),
    maxReplayDeltas: parseEnvPositiveInt('BRIDGE_RUN_MAX_REPLAY_DELTAS', 10_000),
  })
  const extras: BuildAppExtras = { shutdownHooks: [], netJail: new Map() }
  const catalog = createProfileCatalog(config.sandboxProfilesDir)
  const admission = new AdmissionGate(config.admission)
  extras.shutdownHooks.push(async () => admission.close())
  const trace = new TraceEmitter({
    sink: config.trace.enabled
      ? new JsonlSpanSink({
          file: config.trace.file,
          maxBytes: config.trace.maxBytes,
          maxFiles: config.trace.maxFiles,
        })
      : nullSpanSink,
    maxToolSpans: config.trace.maxToolSpans,
  })

  // Register order matters — first match wins. Harness-specific backends
  // come first so a `claude-code/sonnet` doesn't get claimed by a
  // passthrough that happens to know a provider-prefixed model id.
  if (config.backends.has('claude')) {
    const spawner = await buildExecutorForBackend(config.executors.claude, extras, config.claudeBin, config)
    registry.register(new ClaudeBackend({
      bin: config.claudeBin,
      timeoutMs: config.claudeTimeoutMs,
      harness: 'claude-code',
      ...(spawner ? { spawner } : {}),
    }))
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
  if (config.backends.has('codex')) {
    const spawner = await buildExecutorForBackend(config.executors.codex, extras, config.codexBin, config)
    registry.register(new CodexBackend({
      bin: config.codexBin,
      timeoutMs: config.codexTimeoutMs,
      ...(spawner ? { spawner } : {}),
    }))
  }
  if (config.backends.has('opencode')) {
    const spawner = await buildExecutorForBackend(config.executors.opencode, extras, config.opencodeBin, config)
    registry.register(new OpencodeBackend({
      bin: config.opencodeBin,
      timeoutMs: config.opencodeTimeoutMs,
      ...(spawner ? { spawner } : {}),
    }))
  }
  if (config.backends.has('kimi')) {
    const spawner = await buildExecutorForBackend(config.executors.kimi, extras, config.kimiBin, config)
    registry.register(new KimiBackend({
      bin: config.kimiBin,
      timeoutMs: config.kimiTimeoutMs,
      harness: 'kimi-code',
      ...(spawner ? { spawner } : {}),
    }))
  }
  if (config.backends.has('gemini')) {
    const spawner = await buildExecutorForBackend(config.executors.gemini, extras, config.geminiBin, config)
    registry.register(new GeminiBackend({
      bin: config.geminiBin,
      timeoutMs: config.geminiTimeoutMs,
      ...(spawner ? { spawner } : {}),
    }))
  }
  if (config.backends.has('factory')) {
    registry.register(new FactoryBackend({ bin: config.factoryBin, timeoutMs: config.cliTimeoutMsDefault }))
  }
  if (config.backends.has('amp')) {
    registry.register(new AmpBackend({ bin: config.ampBin, timeoutMs: config.cliTimeoutMsDefault }))
  }
  if (config.backends.has('forge')) {
    registry.register(new ForgeBackend({ bin: config.forgeBin, timeoutMs: config.cliTimeoutMsDefault }))
  }
  // ACP-protocol agents (driven via `<bin> acp`): hermes, openclaw. Registered when
  // BRIDGE_BACKENDS lists them; health reports `unavailable` if the binary is absent.
  if (config.backends.has('hermes')) {
    registry.register(new AcpBackend({ name: 'hermes', bin: config.hermesBin, timeoutMs: config.cliTimeoutMsDefault }))
  }
  if (config.backends.has('openclaw')) {
    registry.register(new AcpBackend({ name: 'openclaw', bin: config.openclawBin, timeoutMs: config.cliTimeoutMsDefault }))
  }
  // NanoClaw: a Unix-socket client to the running NanoClaw daemon (not a spawned CLI).
  if (config.backends.has('nanoclaw')) {
    registry.register(new NanoclawBackend({ socketPath: config.nanoclawSocket, timeoutMs: config.cliTimeoutMsDefault }))
  }
  if (config.backends.has('pi')) {
    const spawner = await buildExecutorForBackend(config.executors.pi, extras, config.piBin, config)
    registry.register(new PiBackend({
      bin: config.piBin,
      timeoutMs: config.piTimeoutMs,
      ...(spawner ? { spawner } : {}),
    }))
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

  const app = new Hono()

  // Bearer guard — only active when BRIDGE_BEARER is set.
  if (config.bearer) {
    app.use('*', async (c, next) => {
      if (c.req.path === '/health') return next()
      const header = c.req.header('authorization') ?? ''
      const tok = header.startsWith('Bearer ') ? header.slice(7) : ''
      if (!constantTimeEqual(tok, config.bearer!)) {
        return c.json({ error: { message: 'Unauthorized', type: 'invalid_authentication_error' } }, 401)
      }
      return next()
    })
  }

  mountHealth(app, { registry, admission })
  mountModels(app, { registry, catalog, opencodeBin: config.opencodeBin, piBin: config.piBin })
  mountSessions(app, { sessions })
  mountRuns(app, { runs })
  mountProfiles(app, { catalog })
  mountChatCompletions(app, {
    registry,
    sessions,
    runs,
    admission,
    admissionReservedClients: config.admissionReservedClients,
    netJail: extras.netJail,
    trace,
  })
  mountCadRender(app)
  mountImagesGenerate(app)
  mountMetrics(app)

  app.get('/', (c) => c.json({
    name: 'cli-bridge',
    version: '0.2.0',
    scheme: 'bridge/<harness>/<model>',
    capabilities: {
      profileMaterialization: 'cli-bridge.profile-materialization.v2',
      usageCostProvenance: 'cli-bridge.usage-cost.v1',
    },
    backends: registry.all().map(b => b.name),
    endpoints: [
      '/health',
      '/v1/models',
      '/v1/chat/completions',
      '/v1/sessions',
      '/v1/runs/:id',
      '/v1/runs/:id/cancel',
      '/cad/render',
      '/images/generate',
    ],
  }))

  return { app, sessions, registry, runs, catalog, extras }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let acc = 0
  for (let i = 0; i < a.length; i++) acc |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return acc === 0
}

export async function startServer(): Promise<void> {
  const config = loadConfig()

  // Single-instance guard — refuse to start a second bridge on the same
  // BRIDGE_PORT. Acquired BEFORE buildApp opens sessions.sqlite so two
  // instances never share that DB. A clean exit here keeps systemd happy:
  // Type=simple + Restart=always retries, and a dead predecessor's stale
  // lock is reclaimed automatically (see single-instance.ts).
  let instanceLock
  try {
    instanceLock = acquireInstanceLock(config.port)
  } catch (err) {
    if (err instanceof PortAlreadyBoundError) {
      console.error(`[cli-bridge] ${err.message}`)
      process.exit(1)
    }
    throw err
  }

  let built
  try {
    built = await buildApp(config)
  } catch (err) {
    // A preflight failure is an operator message, not a stack trace: it already
    // contains the observation and the command that fixes it.
    if (err instanceof DockerPreflightError) {
      console.error(`[cli-bridge] FATAL: ${err.message}`)
      instanceLock.release()
      process.exit(1)
    }
    instanceLock.release()
    throw err
  }
  const { app, sessions, extras } = built
  // Drop the lock on hard exit too — graceful shutdown also releases, but
  // a process.exit() path (fatal error) must not strand the pidfile.
  process.once('exit', () => instanceLock.release())
  const server = serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
    // Pass timeouts at create-time so they apply to the http.Server
    // before it starts accepting. Setting them post-listen has the
    // same effect for new sockets, but doing it here is bulletproof.
    serverOptions: {
      requestTimeout: 0,
      headersTimeout: 0,
      keepAliveTimeout: 0,
    },
  }, (info) => {
    console.log(`[cli-bridge] listening on http://${info.address}:${info.port}  (host=${config.host})`)
    console.log(`[cli-bridge] backends: ${[...config.backends].join(', ')}`)
    console.log(`[cli-bridge] bearer: ${config.bearer ? 'required' : 'none (loopback only)'}`)
    console.log(
      `[cli-bridge] host admission: maxActive=${config.admission.maxActive} maxQueue=${config.admission.maxQueue}/class ` +
      `reservedActive=${config.admission.reservedActive} (bulk ceiling ${config.admission.maxActive - config.admission.reservedActive}) ` +
      `queueTimeoutMs=${config.admission.queueTimeoutMs} bulkQueueTimeoutMs=${config.admission.bulkQueueTimeoutMs}`,
    )
    console.log(`[cli-bridge] reserved-lane clients: ${config.admissionReservedClients.join(', ') || 'none'}`)
    // Two gates ration host concurrency. If the executor's ceiling is the lower
    // one, admission stops being the limiter that its numbers claim to be, and
    // a caller admitted by the lane queues again at the executor.
    const scope = scopedHostConcurrencyLimits()
    if (scope.max < config.admission.maxActive) {
      console.warn(
        `[cli-bridge] admission maxActive=${config.admission.maxActive} exceeds scoped-executor ` +
        `concurrency=${scope.max}: the executor is the real ceiling. Lower BRIDGE_HOST_CHAT_MAX_ACTIVE ` +
        `or raise CLI_BRIDGE_SCOPE_MAX_CONCURRENCY so one gate owns the limit.`,
      )
    }
    if (config.admission.reservedActive > 0 && scope.reserved === 0) {
      console.warn(
        '[cli-bridge] host admission reserves a lane but the scoped executor reserves none: ' +
        'a reserved caller can clear admission and still be starved at the executor. ' +
        'Set CLI_BRIDGE_SCOPE_RESERVED_CONCURRENCY.',
      )
    }
    console.log(
      config.trace.enabled
        ? `[cli-bridge] traces: ${config.trace.file} (max ${config.trace.maxBytes} bytes × ${config.trace.maxFiles} files)`
        : '[cli-bridge] traces: off (BRIDGE_TRACE=off)',
    )
    // WORKER_FS_JAIL=1 is a shorthand that raises the operator jail floor to
    // fs-jail even when BRIDGE_JAIL_MODE is unset, so fold it into the effective
    // floor the startup gate + log report.
    const fsJailFlag = ['1', 'true', 'yes', 'on'].includes((process.env.WORKER_FS_JAIL ?? '').trim().toLowerCase())
    const jailFloor: 'off' | 'write-jail' | 'fs-jail' = fsJailFlag ? 'fs-jail' : config.jailMode
    console.log(`[cli-bridge] jail default: ${jailFloor}${jailFloor !== 'off' ? ` root=${config.jailRoot ?? '<cwd>/.agent-home'}` : ''}`)
    // Fail fast (don't go ready) if a jail is the operator floor but no jail
    // backend can run here — every host request would otherwise fail closed while
    // /health reports ready. Only relevant when some backend actually spawns on the
    // host: docker/remote-only deployments never hit the host jail. Honor
    // BRIDGE_JAIL_FALLBACK=warn, which runs unconfined-with-warning instead.
    const hasHostSpawn = anyBackendSpawnsOnHost(config.backends, config.executors)
    if (jailFloor !== 'off' && hasHostSpawn && !selectJailBackend().isAvailable()) {
      if (process.env.BRIDGE_JAIL_FALLBACK === 'warn') {
        console.warn(
          `[cli-bridge] WARNING: jail floor '${jailFloor}' set but no jail backend can run here; ` +
          'requests run UNCONFINED (BRIDGE_JAIL_FALLBACK=warn).',
        )
      } else {
        console.error(
          `[cli-bridge] FATAL: jail floor '${jailFloor}' set but no jail backend can run on this ` +
          'host — every host request would fail closed. Enable unprivileged user namespaces (Linux: ' +
          '`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` or `sudo chmod u+s /usr/bin/bwrap`), ' +
          'ensure sandbox-exec exists (macOS), set BRIDGE_JAIL_FALLBACK=warn, or unset the jail floor.',
        )
        process.exit(1)
      }
    }
    for (const cfg of Object.values(config.executors)) {
      if (cfg.kind === 'docker') {
        console.log(`[cli-bridge] ${cfg.name} executor: docker pool size=${cfg.poolSize} image=${cfg.image}`)
      }
    }
  })
  // Node's http server defaults requestTimeout=300_000 (5 min). Long
  // audit runs that stream tool_use deltas for 10–30 min get severed
  // mid-flight by that ceiling; without this bump every long run dies
  // at 300_700ms and the caller sees a truncated SSE stream with no
  // final stop event. 0 = no transport ceiling. The durable run's
  // execution.timeoutMs (or an explicit operator fallback) owns the process deadline.
  ;(server as { requestTimeout?: number }).requestTimeout = 0
  ;(server as { headersTimeout?: number }).headersTimeout = 0

  const shutdown = async (sig: string) => {
    console.log(`[cli-bridge] ${sig} — shutting down`)
    for (const hook of extras.shutdownHooks) {
      try { await hook() } catch {}
    }
    server.close(() => {
      sessions.close()
      instanceLock.release()
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 5000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  // ─── Anti-fragile error handlers ──────────────────────────────────
  // The bridge spawns long-running CLI subprocesses (claude-code,
  // kimi-code, opencode) and pipes their stdout/stderr through async
  // generators. A single unhandled promise rejection ANYWHERE in that
  // tree — a stream error mid-spawn, a backend throwing during a
  // request, an MCP stdio pipe glitch — would crash the whole bridge
  // under Node's default `--unhandled-rejections=throw`.
  // That killed in-flight requests + every other concurrent caller.
  //
  // The bridge is the local agentic sandbox for every harness on this
  // host (physim, codebench-matrix, blueprint-agent, manual curl). One
  // misbehaving caller should not take it down. Convert these into
  // structured log entries so we know they happened, but keep serving.
  //
  // Honest tradeoff: a true OOM or DB-corruption-on-startup will get
  // logged-and-survived here instead of crashing loud. Watchdogs that
  // pre-existed will not get the SIGCHLD they expect. Net: caller-level
  // failures stay isolated; consumers see error responses on their own
  // requests rather than every concurrent caller losing its connection.
  process.on('unhandledRejection', (reason, promise) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    console.error(`[cli-bridge] unhandledRejection — keeping process alive`, {
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 6).join('\n'),
      promise: String(promise).slice(0, 120),
    })
  })
  process.on('uncaughtException', (err) => {
    if (isFatalServerStartupError(err)) {
      console.error(`[cli-bridge] fatal server error — exiting`, {
        message: err.message,
        name: err.name,
        code: (err as NodeJS.ErrnoException).code,
      })
      process.exit(1)
    }
    console.error(`[cli-bridge] uncaughtException — keeping process alive`, {
      message: err.message,
      name: err.name,
      stack: err.stack?.split('\n').slice(0, 8).join('\n'),
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startServer()
}

function isFatalServerStartupError(err: Error): boolean {
  // A second instance racing for the same port is fatal — exit cleanly so
  // the operator sees the clear message rather than a survived exception.
  if (err instanceof PortAlreadyBoundError) return true
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'EADDRINUSE' || code === 'EACCES') return true
  return /listen|address already in use|already running on port/i.test(err.message)
}
