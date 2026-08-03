import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { DockerCli } from './docker-cli.js'

export const DOCKER_OWNER_LABEL = 'com.tangle.cli-bridge.owner'
export const DOCKER_KIND_LABEL = 'com.tangle.cli-bridge.kind'

type DockerResourceKind = 'container' | 'network' | 'volume'

/**
 * Stable ownership for Docker objects created by one bridge data directory.
 *
 * Docker names are host-global while the bridge process lock is data-dir-local.
 * Hashing the absolute data directory and host uid makes two bridge instances
 * choose different defaults, while preserving the same names across restarts.
 */
export function dockerResourceOwner(dataDir: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown'
  return createHash('sha256').update(`${uid}\0${resolve(dataDir)}`).digest('hex')
}

export function defaultDockerNamePrefix(backend: string, ownerId: string): string {
  return `cli-bridge-${backend}-${ownerId.slice(0, 12)}-pool`
}

export function dockerOwnerLabels(ownerId: string, kind: string): string[] {
  assertOwnerId(ownerId)
  return [
    '--label', `${DOCKER_OWNER_LABEL}=${ownerId}`,
    '--label', `${DOCKER_KIND_LABEL}=${kind}`,
  ]
}

/** Remove a Docker object only after proving this bridge owns it. */
export async function removeOwnedDockerResource(
  cli: DockerCli,
  resourceKind: DockerResourceKind,
  name: string,
  ownerId: string,
): Promise<void> {
  assertOwnerId(ownerId)
  assertDockerObjectName(name)
  const observed = await readDockerResourceOwner(cli, resourceKind, name)
  if (observed === null) return
  if (observed !== ownerId) {
    throw new Error(
      `refusing to remove Docker ${resourceKind} ${name}: it belongs to bridge owner ` +
        `${observed || '<unlabelled>'}, not ${ownerId}`,
    )
  }
  const args = resourceKind === 'container'
    ? ['rm', '-f', name]
    : [resourceKind, 'rm', name]
  const removed = await cli(args, { timeoutMs: 30_000 })
  if (removed.code !== 0 && !isMissingDockerObject(removed.stderr)) {
    throw new Error(
      `could not remove owned Docker ${resourceKind} ${name}: ` +
        `${firstLine(removed.stderr) || removed.spawnError || `docker exited ${removed.code}`}`,
    )
  }
}

/** Create a persistent credential volume, or prove the existing one is ours. */
export async function ensureOwnedDockerVolume(
  cli: DockerCli,
  name: string,
  ownerId: string,
): Promise<void> {
  assertOwnerId(ownerId)
  assertDockerObjectName(name)
  const observed = await readDockerResourceOwner(cli, 'volume', name)
  if (observed !== null) {
    if (observed !== ownerId) {
      throw new Error(
        `refusing to mount Docker volume ${name}: it belongs to bridge owner ` +
          `${observed || '<unlabelled>'}, not ${ownerId}`,
      )
    }
    return
  }
  const created = await cli([
    'volume', 'create',
    ...dockerOwnerLabels(ownerId, 'credential-volume'),
    name,
  ], { timeoutMs: 30_000 })
  if (created.code !== 0) {
    throw new Error(
      `could not create Docker credential volume ${name}: ` +
        `${firstLine(created.stderr) || created.spawnError || `docker exited ${created.code}`}`,
    )
  }
  // Docker returns success when `volume create` races an existing volume.
  // Inspect after creation so a same-name foreign volume is never mounted.
  const ownerAfterCreate = await readDockerResourceOwner(cli, 'volume', name)
  if (ownerAfterCreate !== ownerId) {
    throw new Error(
      `Docker volume ${name} was created or claimed concurrently by bridge owner ` +
        `${ownerAfterCreate || '<unlabelled>'}; expected ${ownerId}`,
    )
  }
}

async function readDockerResourceOwner(
  cli: DockerCli,
  resourceKind: DockerResourceKind,
  name: string,
): Promise<string | null> {
  const inspect = await cli([
    resourceKind, 'inspect', '-f', ownerFormatFor(resourceKind), name,
  ], { timeoutMs: 30_000 })
  if (inspect.code !== 0) {
    if (isMissingDockerObject(inspect.stderr)) return null
    throw new Error(
      `could not inspect Docker ${resourceKind} ${name}: ` +
        `${firstLine(inspect.stderr) || inspect.spawnError || `docker exited ${inspect.code}`}`,
    )
  }
  const owner = inspect.stdout.trim()
  return owner === '<no value>' ? '' : owner
}

function ownerFormatFor(resourceKind: DockerResourceKind): string {
  return resourceKind === 'container'
    ? `{{ index .Config.Labels "${DOCKER_OWNER_LABEL}" }}`
    : `{{ index .Labels "${DOCKER_OWNER_LABEL}" }}`
}

function isMissingDockerObject(stderr: string): boolean {
  return /no such (?:object|container|network|volume)|not found/iu.test(stderr)
}

function assertOwnerId(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error('invalid Docker resource identity')
}

function assertDockerObjectName(value: string): void {
  if (value.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value)) {
    throw new Error(`invalid Docker resource name: ${value}`)
  }
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
}
