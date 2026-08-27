import { containerShell, dockerCli, type DockerCli } from './docker-cli.js'
import { buildCommandFor } from './docker-preflight.js'
import { dockerOwnerLabels, ensureOwnedDockerVolume, removeOwnedDockerResource } from './docker-resource-owner.js'
import type { ContainerPoolOptions, SlotState } from './container-pool-types.js'
import { buildContainerRunArgs, collectMountTargets, firstLine, posixDirname, posixJoin, shellQuote } from './container-pool-args.js'

const START_FORMAT = '{{.State.Running}} {{.State.StartedAt}}'
const ARM_ATTEMPTS = 3

export async function provisionSlot(opts: ContainerPoolOptions, index: number, onProgress: (message: string) => void): Promise<SlotState> {
  const name = `${opts.namePrefix}-${index}`
  const cli = opts.cli ?? dockerCli
  await removeOwnedDockerResource(cli, 'container', name, opts.resourceOwner)
  if (opts.oauthMode === 'per-slot') {
    if (!opts.perSlotVolumes?.length) throw new Error('per-slot oauthMode requires at least one perSlotVolumes entry')
    await Promise.all(opts.perSlotVolumes.map(({ volumePrefix }) => ensureOwnedDockerVolume(cli, `${volumePrefix}-${index}`, opts.resourceOwner)))
  }
  onProgress(`[slot ${index}] docker run ${name}`)
  const result = await cli(buildContainerRunArgs(opts, index, name), { timeoutMs: 120_000 })
  const containerId = result.stdout.trim()
  if (result.code !== 0 || !containerId) {
    const stderr = result.stderr.trim() || result.spawnError || `docker exited ${result.code}`
    const missingImage = /No such image|pull access denied|manifest unknown|not found: manifest|Unable to find image/i.test(stderr)
    throw new Error(missingImage
      ? `container-pool: cannot create slot ${index} — image ${opts.image} is not available on this host. Build it: ${buildCommandFor(opts.image)}. (docker: ${firstLine(stderr)})`
      : `container-pool: cannot create slot ${index} — ${firstLine(stderr)}`)
  }
  let armedStart = ''
  try {
    if (opts.afterCreate) armedStart = await armContainerStart(opts, containerId, index, cli)
    await normalizeContainerHome(opts, containerId, cli)
  } catch (error) {
    try { await removeOwnedDockerResource(cli, 'container', containerId, opts.resourceOwner) }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `container-pool: slot ${index} setup failed and its unused container could not be removed`) }
    throw error instanceof Error ? new Error(`container-pool: slot ${index} was destroyed unused — ${error.message}`, { cause: error }) : error
  }
  onProgress(`[slot ${index}] ready @ ${containerId.slice(0, 12)}`)
  return { containerId, index, busy: false, dead: false, recovering: false, recoveryTimer: null, lastSession: null, holdTimer: null, generation: 0, consecutiveFailures: 0, lastVerifiedAt: Date.now(), armedStart }
}

export async function armContainerStart(opts: ContainerPoolOptions, containerId: string, index: number, cli: DockerCli): Promise<string> {
  if (!opts.afterCreate) return ''
  let lastSeen = ''
  for (let attempt = 0; attempt < ARM_ATTEMPTS; attempt++) {
    const before = await readContainerStart(cli, containerId)
    await opts.afterCreate(containerId, index)
    const after = await readContainerStart(cli, containerId)
    if (after === before) return after
    lastSeen = after
  }
  throw new Error(`container-pool: slot ${index} restarted during afterCreate ${ARM_ATTEMPTS} times in a row (last observed start ${lastSeen}); its per-start setup cannot be established`)
}

export async function readContainerStart(cli: DockerCli, containerId: string): Promise<string> {
  const result = await cli(['inspect', '-f', START_FORMAT, containerId], { timeoutMs: 30_000 })
  const [running = '', startedAt = ''] = result.stdout.trim().split(/\s+/u)
  if (result.code !== 0 || running !== 'true' || !startedAt) {
    const detail = result.stderr.trim() || result.stdout.trim() || `docker exited ${result.code}`
    throw new Error(`container ${containerId.slice(0, 12)} is not running — ${firstLine(detail)}`)
  }
  return startedAt
}

async function normalizeContainerHome(opts: ContainerPoolOptions, containerId: string, cli: DockerCli): Promise<void> {
  if (!opts.containerUser || !opts.containerHome) return
  const home = opts.containerHome
  const chainDirs = new Set<string>([home, ...['.local', '.local/state', '.local/share', '.config', '.cache'].map(rel => posixJoin(home, rel))])
  for (const target of collectMountTargets(opts)) {
    if (!isInside(home, target) || target === home) continue
    let cursor = posixDirname(target)
    while (cursor.length >= home.length && isInside(home, cursor)) {
      chainDirs.add(cursor)
      if (cursor === home) break
      cursor = posixDirname(cursor)
    }
  }
  for (const target of collectMountTargets(opts)) chainDirs.delete(target)
  const result = await cli(containerShell(containerId, `set -e; mkdir -p ${[...chainDirs].map(shellQuote).join(' ')}; chown ${opts.containerUser} ${[...chainDirs].map(shellQuote).join(' ')}`, true), { timeoutMs: 30_000 })
  if (result.code !== 0) throw new Error(`container-pool: cannot prepare HOME=${home} for ${opts.containerUser} inside ${opts.image} — ${firstLine(result.stderr) || `exit ${result.code}`}. Without a writable HOME the CLI fails at request time with EACCES on a path you never configured.`)
}

function isInside(parent: string, child: string): boolean {
  const normalizedParent = parent.replace(/\/+$/u, '') || '/'
  return child === normalizedParent || child.startsWith(`${normalizedParent}/`)
}

export async function destroySlot(opts: ContainerPoolOptions, containerId: string): Promise<void> {
  if (containerId) await removeOwnedDockerResource(opts.cli ?? dockerCli, 'container', containerId, opts.resourceOwner)
}
