/** Docker slot provisioning, start-scoped setup and run configuration. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ContainerPoolOptions, SlotState } from './container-pool.js'
import { assertDockerNetworkName } from './docker-network.js'
import { containerShell, dockerCli, type DockerCli } from './docker-cli.js'
import { buildCommandFor, isInside } from './docker-preflight.js'
const execFileAsync = promisify(execFile)

export async function provisionSlot(
  opts: ContainerPoolOptions,
  index: number,
  onProgress: (m: string) => void,
): Promise<SlotState> {
  const name = `${opts.namePrefix}-${index}`
  // Tear down any stale container with the same name (idempotent).
  await execFileAsync('docker', ['rm', '-f', name]).catch(() => {})

  const args = buildContainerRunArgs(opts, index, name)

  onProgress(`[slot ${index}] docker run ${name}`)
  const cli = opts.cli ?? dockerCli
  const r = await cli(args, { timeoutMs: 120_000 })
  const containerId = r.stdout.trim()
  if (r.code !== 0 || !containerId) {
    // A missing image is the single most common cause and Docker reports it as
    // a registry/pull problem. Name the image and the build command so this
    // never again surfaces later as a message about a missing CONTAINER.
    const stderr = r.stderr.trim() || r.spawnError || `docker exited ${r.code}`
    const missingImage = /No such image|pull access denied|manifest unknown|not found: manifest|Unable to find image/i.test(stderr)
    throw new Error(
      missingImage
        ? `container-pool: cannot create slot ${index} — image ${opts.image} is not available on this host. ` +
          `Build it: ${buildCommandFor(opts.image)}. (docker: ${firstLine(stderr)})`
        : `container-pool: cannot create slot ${index} — ${firstLine(stderr)}`,
    )
  }
  // Before anything else touches the container, including this bridge's own
  // `docker exec`: the window between `run` and the filter being in place is
  // the only moment a slot has unrestricted egress, and the only thing running
  // in it is the idle `tail -f /dev/null` entrypoint.
  let armedStart = ''
  if (opts.afterCreate) {
    try {
      armedStart = await armContainerStart(opts, containerId, index, cli)
    } catch (error) {
      await cli(['rm', '-f', containerId], { timeoutMs: 30_000 })
      throw error instanceof Error
        ? new Error(`container-pool: slot ${index} was destroyed unused — ${error.message}`, { cause: error })
        : error
    }
  }
  await normalizeContainerHome(opts, containerId, cli)
  onProgress(`[slot ${index}] ready @ ${containerId.slice(0, 12)}`)
  return {
    containerId,
    index,
    busy: false,
    dead: false,
    lastSession: null,
    holdTimer: null,
    generation: 0,
    consecutiveFailures: 0,
    lastVerifiedAt: Date.now(),
    armedStart,
  }
}

/** Fields that identify one container INCARNATION, in one `docker inspect`. */
export const START_FORMAT = '{{.State.Running}} {{.State.StartedAt}}'

/** How many times arming may lose a race with a concurrent restart before it fails. */
const ARM_ATTEMPTS = 3

/**
 * Run `afterCreate` and return the container start it applies to.
 *
 * The start is read BEFORE and AFTER the hook, and the two must match. Reading
 * it only afterwards would record the wrong thing in the one case that matters:
 * a container that restarted DURING the hook would be stamped with the new
 * start while the hook's work went into the namespace that is already gone —
 * a slot that looks armed and is not. Losing the race repeatedly is reported as
 * a failure rather than retried forever, because a container restarting that
 * often is not a container to hand a request.
 */
export async function armContainerStart(
  opts: ContainerPoolOptions,
  containerId: string,
  index: number,
  cli: DockerCli,
): Promise<string> {
  const afterCreate = opts.afterCreate
  if (!afterCreate) return ''
  let lastSeen = ''
  for (let attempt = 0; attempt < ARM_ATTEMPTS; attempt++) {
    const before = await readContainerStart(cli, containerId)
    await afterCreate(containerId, index)
    const after = await readContainerStart(cli, containerId)
    if (after === before) return after
    lastSeen = after
  }
  throw new Error(
    `container-pool: slot ${index} restarted during afterCreate ${ARM_ATTEMPTS} times in a row ` +
      `(last observed start ${lastSeen}); its per-start setup cannot be established`,
  )
}

/** `.State.StartedAt` of a running container; throws if it is not running. */
async function readContainerStart(cli: DockerCli, containerId: string): Promise<string> {
  const result = await cli(['inspect', '-f', START_FORMAT, containerId], { timeoutMs: 30_000 })
  const [running = '', startedAt = ''] = result.stdout.trim().split(/\s+/u)
  if (result.code !== 0 || running !== 'true' || !startedAt) {
    const detail = result.stderr.trim() || result.stdout.trim() || `docker exited ${result.code}`
    throw new Error(`container ${containerId.slice(0, 12)} is not running — ${firstLine(detail)}`)
  }
  return startedAt
}

/**
 * Make a configured non-root HOME actually usable, as root inside the container.
 *
 * Docker creates the missing PARENTS of a bind mount as root:root. Mount
 * credentials at `$HOME/.local/share/opencode` in an image that has no
 * `$HOME/.local`, and Docker creates `$HOME/.local` and `$HOME/.local/share`
 * owned by root — after which the uid-1000 CLI cannot create
 * `$HOME/.local/state` and dies with `EACCES: permission denied, mkdir
 * '/home/node/.local/state'`, an error that names a path nobody configured.
 * Reproduced exactly on this host before this fix existed.
 *
 * So: create the XDG directories a CLI initializes and give the configured
 * identity the ancestor chain of every mount target. Ownership is applied
 * per-directory and never recursively, because a recursive chown would walk
 * INTO the bind mounts and rewrite ownership of the operator's host files.
 */
async function normalizeContainerHome(
  opts: ContainerPoolOptions,
  containerId: string,
  cli: DockerCli,
): Promise<void> {
  if (!opts.containerUser || !opts.containerHome) return
  const home = opts.containerHome
  const mountTargets = collectMountTargets(opts)
  const chainDirs = new Set<string>([home])
  for (const rel of ['.local', '.local/state', '.local/share', '.config', '.cache']) {
    chainDirs.add(posixJoin(home, rel))
  }
  for (const target of mountTargets) {
    if (!isInside(home, target) || target === home) continue
    // Every ancestor strictly between $HOME and the mount target, plus $HOME.
    let cursor = posixDirname(target)
    while (cursor.length >= home.length && isInside(home, cursor)) {
      chainDirs.add(cursor)
      if (cursor === home) break
      cursor = posixDirname(cursor)
    }
  }
  // Mount targets themselves are owned by whatever the host/volume provides;
  // chowning them would mutate host files.
  for (const target of mountTargets) chainDirs.delete(target)

  const quoted = [...chainDirs].map(shellQuote).join(' ')
  const script = `set -e; mkdir -p ${quoted}; chown ${opts.containerUser} ${quoted}`
  const result = await cli(containerShell(containerId, script, true), { timeoutMs: 30_000 })
  if (result.code !== 0) {
    throw new Error(
      `container-pool: cannot prepare HOME=${home} for ${opts.containerUser} inside ${opts.image} — ` +
        `${firstLine(result.stderr) || `exit ${result.code}`}. Without a writable HOME the CLI fails at ` +
        `request time with EACCES on a path you never configured.`,
    )
  }
}

function collectMountTargets(opts: ContainerPoolOptions): string[] {
  const targets: string[] = []
  if (opts.oauthMode === 'share') {
    for (const m of opts.shareMounts ?? []) {
      const target = m.slice(m.indexOf(':') + 1)
      if (target.startsWith('/')) targets.push(target)
    }
  } else {
    for (const v of opts.perSlotVolumes ?? []) targets.push(v.target)
  }
  if (opts.workspaceRoot) targets.push(opts.workspaceRoot)
  return targets
}

/** Container paths are POSIX regardless of the host platform, so do not use node:path. */
function posixDirname(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return '/'
  return path.slice(0, idx)
}

function posixJoin(base: string, rel: string): string {
  return `${base.replace(/\/+$/u, '')}/${rel}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
}

/** Compose `docker run` argv without invoking Docker. */
export function buildContainerRunArgs(
  opts: ContainerPoolOptions,
  index: number,
  name = `${opts.namePrefix}-${index}`,
): string[] {
  const memory = opts.memory ?? '4g'
  const cpus = opts.cpus ?? '2'
  const args = [
    'run', '-d',
    '--name', name,
    '--restart', restartPolicyFor(opts),
    '--memory', memory, '--memory-swap', memory,
    '--cpus', cpus,
  ]
  if (opts.network !== undefined) {
    args.push('--network', assertDockerNetworkName(opts.network))
  }
  if (Boolean(opts.containerUser) !== Boolean(opts.containerHome)) {
    throw new Error('container user and home must be configured together')
  }
  if (opts.containerUser && opts.containerHome) {
    if (!/^[1-9][0-9]*:[1-9][0-9]*$/u.test(opts.containerUser)) {
      throw new Error('invalid non-root container user')
    }
    if (!isSafeWorkspaceBindPath(opts.containerHome)) {
      throw new Error('invalid non-root container home')
    }
    args.push('--user', opts.containerUser, '--env', `HOME=${opts.containerHome}`)
  }
  if (opts.workspaceRoot) {
    if (!isSafeWorkspaceBindPath(opts.workspaceRoot)) {
      throw new Error(`invalid Docker workspace root: ${opts.workspaceRoot}`)
    }
    // Docker bind mounts are read-write unless `readonly` is present.
    // Source and target intentionally match so request cwd needs no rewrite.
    args.push(
      '--mount',
      `type=bind,source=${opts.workspaceRoot},target=${opts.workspaceRoot}`,
    )
  }
  if (opts.oauthMode === 'share') {
    for (const m of opts.shareMounts ?? []) args.push('-v', m)
  } else {
    if (!opts.perSlotVolumes || opts.perSlotVolumes.length === 0) {
      throw new Error('per-slot oauthMode requires at least one perSlotVolumes entry')
    }
    for (const v of opts.perSlotVolumes) args.push('-v', `${v.volumePrefix}-${index}:${v.target}`)
  }
  args.push(opts.image, 'tail', '-f', '/dev/null')
  return args
}

/**
 * The Docker restart policy a slot runs under.
 *
 * Without `afterCreate`, `on-failure:3` instead of `unless-stopped` — it caps
 * the docker-level restart loop so a poisoned image can't churn the daemon
 * forever, and reviving the container in place is a strictly cheaper recovery
 * than rebuilding it.
 *
 * WITH `afterCreate`, none at all. A restart policy revives a container with
 * fresh, empty namespaces — the setup the hook wrote is gone, the container id
 * and every mount are unchanged, and the revival happens with nothing in this
 * process observing it. The pool already models a dead slot correctly (`rm -f`
 * then `provisionSlot`, which re-runs the hook), so the honest configuration is
 * for a dead jailed container to be REPLACED, never revived. `tail -f /dev/null`
 * is the entrypoint, so a slot only dies when something killed it, which is a
 * container to discard rather than to bring back.
 *
 * This is one half of the invariant; the other is `ensureSlotUsable`, which
 * covers the restarts this bridge performs ITSELF — `terminateDockerExecution`
 * restarts a slot to kill a worker's process tree whenever the worker exits
 * non-cleanly, which a worker triggers simply by exiting non-zero. Removing the
 * policy without that gate would have closed the smaller of the two doors.
 */
function restartPolicyFor(opts: ContainerPoolOptions): string {
  return opts.afterCreate ? 'no' : 'on-failure:3'
}

function isSafeWorkspaceBindPath(path: string): boolean {
  return path.startsWith('/') && path !== '/' && !path.includes(',')
}

export async function destroySlot(containerId: string): Promise<void> {
  if (!containerId) return
  await execFileAsync('docker', ['rm', '-f', containerId]).catch(() => {})
}
