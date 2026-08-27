import { assertDockerNetworkName } from './docker-network.js'
import { dockerOwnerLabels } from './docker-resource-owner.js'
import type { ContainerPoolOptions } from './container-pool-types.js'

export function buildContainerRunArgs(opts: ContainerPoolOptions, index: number, name = `${opts.namePrefix}-${index}`): string[] {
  const memory = opts.memory ?? '4g'
  const cpus = opts.cpus ?? '2'
  const args = ['run', '-d', '--name', name, ...dockerOwnerLabels(opts.resourceOwner, 'pool-slot'), '--restart', restartPolicyFor(opts), '--memory', memory, '--memory-swap', memory, '--cpus', cpus]
  if (opts.network !== undefined) args.push('--network', assertDockerNetworkName(opts.network))
  if (Boolean(opts.containerUser) !== Boolean(opts.containerHome)) throw new Error('container user and home must be configured together')
  if (opts.containerUser && opts.containerHome) {
    if (!/^[1-9][0-9]*:[1-9][0-9]*$/u.test(opts.containerUser)) throw new Error('invalid non-root container user')
    if (!isSafeWorkspaceBindPath(opts.containerHome)) throw new Error('invalid non-root container home')
    args.push('--user', opts.containerUser, '--env', `HOME=${opts.containerHome}`)
  }
  if (opts.workspaceRoot) {
    if (!isSafeWorkspaceBindPath(opts.workspaceRoot)) throw new Error(`invalid Docker workspace root: ${opts.workspaceRoot}`)
    args.push('--mount', `type=bind,source=${opts.workspaceRoot},target=${opts.workspaceRoot}`)
  }
  if (opts.oauthMode === 'share') {
    for (const mount of opts.shareMounts ?? []) args.push('-v', mount)
  } else {
    if (!opts.perSlotVolumes || opts.perSlotVolumes.length === 0) throw new Error('per-slot oauthMode requires at least one perSlotVolumes entry')
    for (const volume of opts.perSlotVolumes) args.push('-v', `${volume.volumePrefix}-${index}:${volume.target}`)
  }
  args.push(opts.image, 'tail', '-f', '/dev/null')
  return args
}

export function collectMountTargets(opts: ContainerPoolOptions): string[] {
  const targets: string[] = []
  if (opts.oauthMode === 'share') {
    for (const mount of opts.shareMounts ?? []) {
      const target = mount.slice(mount.indexOf(':') + 1)
      if (target.startsWith('/')) targets.push(target)
    }
  } else {
    for (const volume of opts.perSlotVolumes ?? []) targets.push(volume.target)
  }
  if (opts.workspaceRoot) targets.push(opts.workspaceRoot)
  return targets
}

export function posixDirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

export function posixJoin(base: string, rel: string): string { return `${base.replace(/\/+$/u, '')}/${rel}` }
export function shellQuote(value: string): string { return `'${value.replace(/'/gu, `'\\''`)}'` }
export function firstLine(text: string): string { return text.split('\n').map(line => line.trim()).find(Boolean) ?? '' }

function restartPolicyFor(opts: ContainerPoolOptions): string { return opts.afterCreate ? 'no' : 'on-failure:3' }
function isSafeWorkspaceBindPath(path: string): boolean { return path.startsWith('/') && path !== '/' && !path.includes(',') }
