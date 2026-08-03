import type { BackendExecutorConfig, Config } from '../config.js'
import { ContainerPool } from '../executors/container-pool.js'
import { provisionNetJail, type NetJailProvision } from '../executors/net-jail-network.js'
import { createDockerSpawner } from '../executors/docker.js'
import {
  buildCommandFor,
  DockerPreflightError,
  preflightDockerImage,
  preflightDockerSlot,
  type DockerPreflightMount,
  type DockerPreflightTarget,
  type PreflightFinding,
} from '../executors/docker-preflight.js'
import type { Spawner } from '../executors/types.js'
import { modelEndpointsFor, parseAllowList } from '../jail/net-allowlist.js'
import { registerPoolForMetrics, unregisterPoolForMetrics } from '../routes/metrics.js'
import type { BuildAppExtras } from './types.js'

function perSlotVolumePrefix(cfg: BackendExecutorConfig, mountIndex: number): string {
  const base = `${cfg.namePrefix ?? `cli-bridge-${cfg.name}-pool`}-oauth`
  return mountIndex === 0 ? base : `${base}${mountIndex}`
}
export function parseEnvPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

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
export async function buildExecutorForBackend(
  cfg: BackendExecutorConfig | undefined,
  extras: BuildAppExtras,
  bin: string,
  config: Config,
): Promise<Spawner | null> {
  if (!cfg || cfg.kind !== 'docker') return null
  if (!cfg.image || !cfg.poolSize || !cfg.containerConfigDir || !cfg.namePrefix || !cfg.resourceOwner) {
    throw new Error(
      `backend ${cfg.name} executor=docker but missing image/poolSize/containerConfigDir/namePrefix/resourceOwner`,
    )
  }
  let netJail: NetJailProvision | null = null
  let pool: ContainerPool | null = null
  try {
    // The net-jail is provisioned BEFORE the pool because the pool's containers
    // join its internal network at creation; a container cannot be re-jailed
    // afterwards. loadConfig has already refused any configuration this cannot
    // enforce, so reaching here with the mode on means it must succeed.
    netJail =
      config.netJailMode === 'net-jail'
        ? await provisionNetJail({
            backend: cfg.name,
            namePrefix: cfg.namePrefix,
            resourceOwner: cfg.resourceOwner,
            image: cfg.image,
            allow: [
              ...modelEndpointsFor(cfg.name, process.env),
              ...parseAllowList(config.netJailAllow.join(','), 'BRIDGE_NET_JAIL_ALLOW'),
            ],
            onProgress: (m) => console.log(`[${cfg.name}-pool] ${m}`),
          })
        : null
    if (netJail) {
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
    const slotMaxHoldMs = parseEnvPositiveInt('BRIDGE_SLOT_MAX_HOLD_MS', 600_000)
    const activeNetJail = netJail
    pool = await ContainerPool.create({
      size: cfg.poolSize,
      image: cfg.image,
      namePrefix: cfg.namePrefix,
      resourceOwner: cfg.resourceOwner,
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
      ...(activeNetJail ? { network: activeNetJail.network } : cfg.network ? { network: cfg.network } : {}),
      // Joining the internal network is not the jail. The deny lives in each
      // container's own network namespace, and it is written here — a slot whose
      // filter cannot be installed is destroyed instead of served.
      ...(activeNetJail ? { afterCreate: (id: string, i: number) => activeNetJail.applyFilter(id, `slot ${i}`) } : {}),
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
        `acquire-deadline=${acquireDeadlineMs}ms slot-hold=${slotMaxHoldMs}ms`,
    )
    // Probe a real slot: same image, same mounts, same user, same workdir the
    // executor will use. If this passes, `ok` on /health means the bridge has
    // demonstrated it can execute a command, not merely that it started.
    const liveContainers = pool.liveContainerIds()
    if (liveContainers.length === 0) {
      throw new Error(`backend ${cfg.name}: container pool provisioned no usable slots`)
    }
    const preflightWarnings: string[] = []
    const slotFindings: PreflightFinding[] = []
    for (const { slotIndex, containerId } of liveContainers) {
      // Slot 0 pays for the whole probe; every other slot is checked for the one
      // thing that is genuinely per-slot — its own credential mounts. Skipping
      // them entirely is how a pool with zero credentials reported preflight ok.
      slotFindings.push(
        ...(await preflightDockerSlot(
          slotIndex === 0 ? target : preflightTargetFor(cfg, bin, slotIndex),
          containerId,
          undefined,
          preflightWarnings,
          slotIndex === 0 ? {} : { scope: 'credentials' },
        )),
      )
    }
    if (slotFindings.length > 0) {
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
    const spawner = createDockerSpawner({
      pool,
      backend: cfg.name,
      envPrefix: cfg.name.toUpperCase(),
      ...(cfg.workspaceRoot ? { workspaceRoot: cfg.workspaceRoot } : {}),
      pathMappings: [
        { host: cfg.hostConfigDir!, container: cfg.containerConfigDir! },
        ...(cfg.extraMounts ?? []),
        ...(cfg.workspaceRoot ? [{ host: cfg.workspaceRoot, container: cfg.workspaceRoot }] : []),
      ],
      pathInContainer: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      homeInContainer: cfg.containerHome ?? '/root',
      ...(cfg.containerUser ? { containerUser: cfg.containerUser } : {}),
      // The readiness probe must judge the SAME configuration the pool received,
      // for the slot it actually acquires — so it is derived here, from these
      // values, rather than reconstructed inside the executor.
      preflightTarget: (slotIndex) => preflightTargetFor(cfg, bin, slotIndex),
    })
    if (activeNetJail) extras.netJail.set(cfg.name, { network: activeNetJail.network, allow: activeNetJail.allow })
    registerPoolForMetrics(cfg.name, pool)
    let disposed = false
    extras.shutdownHooks.push(async () => {
      if (disposed) return
      disposed = true
      unregisterPoolForMetrics(cfg.name, pool!)
      extras.netJail.delete(cfg.name)
      const failures: unknown[] = []
      try {
        await pool!.destroy()
      } catch (error) {
        failures.push(error)
      }
      try {
        await netJail?.destroy()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, `backend ${cfg.name} executor cleanup failed`)
    })
    return spawner
  } catch (error) {
    unregisterPoolForMetrics(cfg.name, pool ?? undefined)
    extras.netJail.delete(cfg.name)
    const failures: unknown[] = []
    try {
      await pool?.destroy()
    } catch (cleanupError) {
      failures.push(cleanupError)
    }
    try {
      await netJail?.destroy()
    } catch (cleanupError) {
      failures.push(cleanupError)
    }
    if (failures.length > 0) {
      throw new AggregateError([error, ...failures], `backend ${cfg.name} startup and cleanup failed`)
    }
    throw error
  }
}
