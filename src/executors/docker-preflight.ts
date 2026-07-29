/**
 * Prove a docker-executor configuration COHERENT before the port opens.
 *
 * The failure this exists to prevent: the bridge boots, reports backends,
 * answers /health, accepts requests, and only discovers at first traffic that
 * the runtime image was never built on this host — then reports it as a missing
 * *container*. Same shape for a workspace root that is configured but not
 * mounted, and for a container user whose HOME has neither the credentials nor
 * a writable state directory.
 *
 * Two properties make these checks worth their startup cost:
 *
 *   1. They probe the LIVE configuration, not the declared one. Measured on
 *      this host: `cli-bridge-cli-runtime:latest` lacked
 *      /home/node/.local/{share,state} even though docker/Dockerfile.cli-runtime
 *      creates them — the installed image had drifted from its Dockerfile. No
 *      amount of parse-time validation can see that; only a probe can.
 *
 *   2. Every finding carries the command or env var that fixes it. A startup
 *      failure whose message does not contain its own remedy just moves the
 *      guessing earlier.
 *
 * Split in two phases because they need different preconditions:
 *   - `preflightDockerImage` runs BEFORE the pool is provisioned (a `docker run`
 *     against a missing image fails with a message about pulling, which is not
 *     what the operator needs to read).
 *   - `preflightDockerSlot` runs AFTER, against a REAL pool slot — the same
 *     container that will serve traffic, with the same mounts and the same user.
 *     Its last check runs `<bin> --version` in the workdir the executor will
 *     actually cd into, so a bridge that reaches "ok" has proven it can execute
 *     a trivial command.
 */

import { mkdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { isAbsolute, join, relative, sep } from 'node:path'
import { containerShell, dockerCli, type DockerCli } from './docker-cli.js'
import type { ExecutorFinding } from './types.js'

export interface DockerPreflightMount {
  /** Host path for a bind, or docker volume name for a per-slot volume. */
  source: string
  /** Absolute path inside the container. */
  target: string
  kind: 'bind' | 'volume'
  /**
   * Path, relative to `target`, of the file whose presence proves the CLI can
   * authenticate from this mount. Checked instead of mere non-emptiness:
   * measured on this host, ~/.config/opencode holds 6 files and NO auth.json
   * (opencode keeps it in ~/.local/share/opencode), so "the directory is not
   * empty" passes on a mount that cannot authenticate — and the resulting empty
   * completions read as a model problem.
   */
  credentialFile?: string
}

export interface DockerPreflightTarget {
  /** Backend name, lowercase: 'opencode', 'claude', … */
  backend: string
  /** Env-var prefix used in remedies: 'OPENCODE', 'CLAUDE', … */
  envPrefix: string
  image: string
  /** CLI argv[0] the executor will run inside the container. */
  bin: string
  /** Configured numeric identity, or undefined when containers run as the image default. */
  containerUser?: string | undefined
  /** HOME the CLI will see inside the container. '/root' when no user is configured. */
  containerHome: string
  mounts: DockerPreflightMount[]
  /** Host directory bind-mounted at the identical path, when configured. */
  workspaceRoot?: string | undefined
  /** Command that builds `image`, quoted into remedies. */
  buildCommand: string
}

/**
 * One finding, in the shape every executor reports. Aliased rather than
 * redeclared so a startup finding and a readiness finding cannot drift apart:
 * `/health` renders exactly what the startup preflight would have printed.
 */
export type PreflightFinding = ExecutorFinding

/**
 * How far to probe, and how hard to judge what is found.
 *
 *   `full`         — everything, at startup, before the port opens.
 *   `credentials`  — only what is genuinely per-slot, for slots 1..N at startup.
 *   `request-path` — what a REQUEST depends on, for a live readiness verdict:
 *                    this slot's credential mounts and the workspace bind. The
 *                    `<bin> --version` exec is deliberately absent because the
 *                    caller (`versionHealth`) runs it through the real spawner
 *                    immediately afterwards, in this same resolved cwd.
 *
 * `request-path` also judges missing credentials differently, and that is the
 * point of the distinction rather than an accident of it — see
 * `checkCredentialPresence`.
 */
export type PreflightScope = 'full' | 'credentials' | 'request-path'

export class DockerPreflightError extends Error {
  constructor(readonly backend: string, readonly findings: PreflightFinding[]) {
    super(formatPreflightFailure(backend, findings))
    this.name = 'DockerPreflightError'
  }
}

export function formatPreflightFailure(backend: string, findings: PreflightFinding[]): string {
  const lines = findings.map((f, i) => `  ${i + 1}. [${f.check}] ${f.detail}\n     fix: ${f.remedy}`)
  return (
    `${backend} docker executor is not usable on this host — refusing to open the port ` +
    `with a configuration that would fail at first request:\n${lines.join('\n')}`
  )
}

/** The default runtime-image build command, so callers do not restate it. */
export const RUNTIME_IMAGE_BUILD_COMMAND = 'pnpm run docker:build:runtime'

export function buildCommandFor(image: string): string {
  const DEFAULT_IMAGE = 'cli-bridge-cli-runtime:latest'
  if (image === DEFAULT_IMAGE) return RUNTIME_IMAGE_BUILD_COMMAND
  return `docker build -f docker/Dockerfile.cli-runtime -t ${image} .`
}

/**
 * Phase 1 — daemon reachable, image present, bind sources usable. Returns the
 * findings rather than throwing so a caller can report every problem at once
 * instead of making the operator fix them one restart at a time.
 */
export async function preflightDockerImage(
  target: DockerPreflightTarget,
  cli: DockerCli = dockerCli,
): Promise<PreflightFinding[]> {
  const findings: PreflightFinding[] = []

  const version = await cli(['version', '--format', '{{.Server.Version}}'])
  if (version.code !== 0) {
    findings.push({
      check: 'docker-daemon',
      detail:
        `${target.envPrefix}_EXECUTOR=docker but the Docker daemon is not reachable ` +
        `(${firstLine(version.stderr) || version.spawnError || `docker exited ${version.code}`})`,
      remedy: `start Docker, or set ${target.envPrefix}_EXECUTOR=host to run the CLI on this host instead`,
    })
    // Nothing below can be probed without a daemon; report the one real cause.
    return findings
  }

  const image = await cli(['image', 'inspect', '--format', '{{.Id}}', target.image])
  if (image.code !== 0) {
    findings.push({
      check: 'runtime-image',
      detail: `image ${target.image} does not exist on this host, so no pool container can be created`,
      remedy: `build it: ${target.buildCommand}`,
    })
  }

  for (const mount of target.mounts) {
    // Binds only, because this phase stats the HOST path and a docker volume has
    // none. It is NOT the credential check — that one runs against every mount
    // regardless of kind, inside the container, in `checkCredentialMounts`. The
    // distinction is worth stating: skipping volumes here reads like the bug
    // where the empty-credential warning was skipped for volumes, and it is not.
    if (mount.kind !== 'bind') continue
    findings.push(...checkBindSource(target, mount))
  }

  // The workspace bind is a host directory too. Docker would create it as
  // root:root at `docker run` time, after which a non-root CLI cannot write in
  // the directory the caller's files are supposed to land in.
  if (target.workspaceRoot) findings.push(...checkWorkspaceRootSource(target))

  return findings
}

function checkWorkspaceRootSource(target: DockerPreflightTarget): PreflightFinding[] {
  const root = target.workspaceRoot!
  const envKey = `${target.envPrefix}_DOCKER_WORKSPACE_ROOT`
  if (!isAbsolute(root)) {
    return [{
      check: 'workspace-root',
      detail: `${envKey}=${root} is not an absolute path, so it cannot be bind-mounted at the identical path`,
      remedy: `set ${envKey} to an absolute host directory`,
    }]
  }
  try {
    if (!statSync(root).isDirectory()) {
      return [{
        check: 'workspace-root',
        detail: `${envKey}=${root} exists but is not a directory`,
        remedy: `point ${envKey} at a directory`,
      }]
    }
    return []
  } catch {
    try {
      mkdirSync(root, { recursive: true })
      return []
    } catch (err) {
      return [{
        check: 'workspace-root',
        detail:
          `${envKey}=${root} does not exist and cannot be created ` +
          `(${err instanceof Error ? err.message : String(err)})`,
        remedy: `create it, or point ${envKey} at a directory this process can write`,
      }]
    }
  }
}

function checkBindSource(target: DockerPreflightTarget, mount: DockerPreflightMount): PreflightFinding[] {
  if (!isAbsolute(mount.source)) {
    return [{
      check: 'mount-source',
      detail: `bind source ${mount.source} (mounted at ${mount.target}) is not an absolute path`,
      remedy: `set ${target.envPrefix}_DOCKER_HOST_CONFIG_DIR to an absolute host path`,
    }]
  }
  try {
    const st = statSync(mount.source)
    if (!st.isDirectory()) {
      return [{
        check: 'mount-source',
        detail: `bind source ${mount.source} (mounted at ${mount.target}) exists but is not a directory`,
        remedy:
          `Docker would mount it as a file and the CLI would not find its credentials — point ` +
          `${target.envPrefix}_DOCKER_HOST_CONFIG_DIR at a directory`,
      }]
    }
    return []
  } catch {
    // Absent is recoverable: Docker would create it as an empty root-owned
    // directory, which loses the operator's credentials silently. Create it
    // here so ownership is the invoking user's and the loss is visible.
    try {
      mkdirSync(mount.source, { recursive: true })
      return []
    } catch (err) {
      return [{
        check: 'mount-source',
        detail:
          `bind source ${mount.source} (mounted at ${mount.target}) does not exist and cannot be created ` +
          `(${err instanceof Error ? err.message : String(err)})`,
        remedy: `create it, or point ${target.envPrefix}_DOCKER_HOST_CONFIG_DIR at an existing directory`,
      }]
    }
  }
}

/**
 * Phase 2 — probe a real, provisioned slot. Checks, in dependency order:
 * identity/HOME agreement, HOME writability for the CLI's state directory,
 * credential mounts landing inside that HOME and being readable, the workspace
 * bind proven live by a marker round-trip, the CLI resolving on PATH, and
 * finally a trivial execution in the real workdir.
 */
export async function preflightDockerSlot(
  target: DockerPreflightTarget,
  containerId: string,
  cli: DockerCli = dockerCli,
  /** Sink for conditions worth saying but not worth refusing to start over. */
  warnings: string[] = [],
  /**
   * `credentials` probes only what is per-slot: the credential mounts. Every
   * other check (image identity, HOME, PATH, the trivial exec) is a property of
   * the image and the configured user, identical in every slot. Per-slot OAUTH
   * volumes are NOT identical — each slot has its own — so probing slot 0 alone
   * was evidence about one slot while traffic was routed to all of them.
   *
   * `request-path` is the live readiness verdict; see `PreflightScope`.
   */
  opts: { scope?: PreflightScope } = {},
): Promise<PreflightFinding[]> {
  const findings: PreflightFinding[] = []
  const scope = opts.scope ?? 'full'
  if (scope === 'credentials') {
    return await checkCredentialMounts(target, containerId, cli, warnings, 'warn')
  }
  if (scope === 'request-path') {
    // Exactly what a request depends on and nothing a request does not: this
    // slot's credentials, and the workspace bind still being live. Adding the
    // image-invariant checks here would spend four docker execs per /health on
    // properties that cannot have changed since startup.
    findings.push(...(await checkCredentialMounts(target, containerId, cli, warnings, 'fail')))
    if (target.workspaceRoot) {
      findings.push(...(await checkWorkspaceMount(target, containerId, cli)))
    }
    return findings
  }

  // --- identity + HOME agreement -----------------------------------------
  const identity = await cli(containerShell(containerId, 'printf "%s\\n%s\\n%s" "$(id -u)" "$(id -g)" "$HOME"'))
  if (identity.code !== 0) {
    return [{
      check: 'container-exec',
      detail: `cannot exec into freshly provisioned container ${containerId.slice(0, 12)} (${firstLine(identity.stderr)})`,
      remedy: 'check the Docker daemon and whether something outside the bridge is removing containers',
    }]
  }
  const [uid = '', gid = '', home = ''] = identity.stdout.split('\n')
  if (target.containerUser && `${uid}:${gid}` !== target.containerUser) {
    findings.push({
      check: 'container-user',
      detail:
        `${target.envPrefix}_DOCKER_USER=${target.containerUser} but processes inside the container run as ` +
        `${uid}:${gid}`,
      remedy: `set ${target.envPrefix}_DOCKER_USER=${uid}:${gid}, or use an image whose default user is ${target.containerUser}`,
    })
  }
  if (home.trim() !== target.containerHome) {
    findings.push({
      check: 'container-home',
      detail:
        `the CLI inside the container sees HOME=${home.trim() || '(unset)'} but the bridge mounts credentials ` +
        `against ${target.containerHome}`,
      remedy:
        `set ${target.envPrefix}_DOCKER_HOME=${home.trim() || '/root'} so credential mounts land where the CLI reads them`,
    })
  }

  // --- HOME is writable for CLI state ------------------------------------
  // The measured failure: a bind target under $HOME whose parents did not exist
  // in the image makes Docker create them root-owned, after which a non-root CLI
  // cannot mkdir beside them and reports EACCES on an unrelated path
  // ($HOME/.local/state). Probe the exact directories a CLI initializes.
  const stateProbe = await cli(containerShell(
    containerId,
    'set -e; for d in "$HOME" "$HOME/.local/state" "$HOME/.local/share" "$HOME/.config" "$HOME/.cache"; do ' +
    'mkdir -p "$d" 2>&1 || { echo "MKDIR_FAILED $d"; ls -ld "$d" "$(dirname "$d")" 2>&1; exit 3; }; done; ' +
    'probe="$HOME/.local/state/.cli-bridge-preflight"; : > "$probe" || { echo "WRITE_FAILED $probe"; exit 4; }; ' +
    'rm -f "$probe"; echo HOME_WRITABLE',
  ))
  if (stateProbe.code !== 0 || !stateProbe.stdout.includes('HOME_WRITABLE')) {
    findings.push({
      check: 'home-writable',
      detail:
        `HOME=${target.containerHome} is not writable inside the container for ` +
        `${target.containerUser ?? 'the image default user'}: ${compact(stateProbe.stdout + ' ' + stateProbe.stderr)}`,
      remedy:
        `rebuild the runtime image so ${target.containerHome} and its XDG subdirectories exist and are owned by ` +
        `that user (${target.buildCommand}), or set ${target.envPrefix}_DOCKER_HOME to a directory that user owns`,
    })
  }

  // --- credential mounts land inside HOME, are usable, and hold credentials
  findings.push(...(await checkCredentialMounts(target, containerId, cli, warnings, 'warn')))

  // --- the workspace bind is proven LIVE at the exec path ----------------
  if (target.workspaceRoot) {
    findings.push(...(await checkWorkspaceMount(target, containerId, cli)))
  }

  // --- the CLI resolves for that user ------------------------------------
  const which = await cli(containerShell(containerId, `command -v ${shellQuote(target.bin)} || exit 1`))
  const resolved = which.stdout.trim()
  if (which.code !== 0 || !resolved) {
    findings.push({
      check: 'cli-binary',
      detail: `${target.bin} is not on PATH inside ${target.image} for ${target.containerUser ?? 'the image default user'}`,
      remedy: `rebuild the image with that CLI installed (${target.buildCommand}), or set ${target.envPrefix}_DOCKER_IMAGE to an image that has it`,
    })
  }

  // --- a trivial command actually executes, in the real workdir ----------
  // Skipped only when an earlier finding already explains why it cannot work,
  // so the operator reads the cause rather than a second symptom of it.
  if (findings.length === 0) {
    const execArgs = ['exec']
    if (target.workspaceRoot) execArgs.push('--workdir', target.workspaceRoot)
    execArgs.push(containerId, target.bin, '--version')
    const trivial = await cli(execArgs, { timeoutMs: 60_000 })
    if (trivial.code !== 0) {
      findings.push({
        check: 'trivial-exec',
        detail:
          `\`${target.bin} --version\` failed inside the pool container ` +
          `(exit ${trivial.code}${target.workspaceRoot ? ` with --workdir ${target.workspaceRoot}` : ''}): ` +
          `${compact(trivial.stderr + ' ' + trivial.stdout).slice(0, 400)}`,
        remedy:
          `run \`docker exec ${target.workspaceRoot ? `-w ${target.workspaceRoot} ` : ''}<slot> ${target.bin} --version\` ` +
          `against a pool container to reproduce, then rebuild the image (${target.buildCommand}) if the CLI is broken inside it`,
      })
    }
  }

  return findings
}

/**
 * Everything about a credential mount that is per-SLOT, probed inside the
 * container so a per-slot docker volume is checked the same way as a host bind.
 *
 * Three things, in dependency order:
 *
 *   1. The mount lands inside the HOME the CLI will have; otherwise it never
 *      looks there.
 *   2. It is readable AND writable by the user the CLI runs as. The write check
 *      exists because a CLI writes into its own config dir (session state,
 *      refreshed tokens): without it, a read-only mount could only be caught by
 *      the catch-all `<bin> --version` probe, whose remedy is "rebuild the
 *      image" — a neighbouring cause, and the operator goes and rebuilds a
 *      perfectly good image.
 *   3. It actually holds credentials. Checking the named credential FILE rather
 *      than non-emptiness matters: measured on this host, ~/.config/opencode has
 *      6 entries and no auth.json (opencode keeps it in ~/.local/share/opencode),
 *      so the old check passed on a mount that cannot authenticate. The failure
 *      that produces is a model-shaped one: the CLI starts, authenticates
 *      against nothing, and the caller gets an empty completion.
 *
 * `missingCredentials` decides what absence MEANS, and the two answers are both
 * right for their own caller. At startup it is a warning: a first run
 * legitimately has no credentials, and the remedy is to log in inside a pool
 * container — which requires the pool to exist, so refusing to start would
 * remove the only route to the fix. For a readiness verdict it is a finding: the
 * requests are what /health is answering about, and every one of them will come
 * back empty. Measured on this host, that difference is the whole bug — the
 * startup warning went to stdout and /health went on reporting `ready`.
 */
async function checkCredentialMounts(
  target: DockerPreflightTarget,
  containerId: string,
  cli: DockerCli,
  warnings: string[],
  missingCredentials: 'warn' | 'fail',
): Promise<PreflightFinding[]> {
  const findings: PreflightFinding[] = []
  for (const mount of target.mounts) {
    if (target.containerUser && !isInside(target.containerHome, mount.target)) {
      findings.push({
        check: 'auth-mount-home',
        detail:
          `credentials are mounted at ${mount.target} but the CLI runs as ${target.containerUser} with ` +
          `HOME=${target.containerHome}, so it never looks there`,
        remedy:
          `set ${target.envPrefix}_DOCKER_CONTAINER_CONFIG_DIR to a path under ${target.containerHome}, or unset ` +
          `${target.envPrefix}_DOCKER_USER/${target.envPrefix}_DOCKER_HOME to run as the image's root identity`,
      })
      continue
    }
    const readable = await cli(containerShell(
      containerId,
      `test -r ${shellQuote(mount.target)} && test -x ${shellQuote(mount.target)}`,
    ))
    if (readable.code !== 0) {
      const owner = await cli(containerShell(containerId, `ls -ld ${shellQuote(mount.target)} 2>&1; id`))
      findings.push({
        check: 'auth-mount-readable',
        detail:
          `credential mount ${mount.target} is not readable by the user the CLI runs as ` +
          `(${compact(owner.stdout)})`,
        remedy: mountPermissionRemedy(target, mount, 'readable'),
      })
      // A mount that cannot be read cannot be probed further; the reason for
      // every later failure on it would be this one.
      continue
    }
    const probe = `${mount.target}/.cli-bridge-preflight-write`
    const writable = await cli(containerShell(
      containerId,
      `: > ${shellQuote(probe)} && rm -f ${shellQuote(probe)}`,
    ))
    if (writable.code !== 0) {
      findings.push({
        check: 'auth-mount-writable',
        detail:
          `credential mount ${mount.target} is not writable by ${target.containerUser ?? 'the image default user'}, ` +
          `so ${target.bin} cannot persist session state or a refreshed token ` +
          `(${compact(writable.stderr) || `exit ${writable.code}`})`,
        remedy: mountPermissionRemedy(target, mount, 'writable'),
      })
    }
    findings.push(...(await checkCredentialPresence(target, mount, containerId, cli, warnings, missingCredentials)))
  }
  return findings
}

function mountPermissionRemedy(
  target: DockerPreflightTarget,
  mount: DockerPreflightMount,
  need: 'readable' | 'writable',
): string {
  const uid = target.containerUser?.split(':')[0]
  if (mount.kind === 'volume') {
    return (
      `fix ownership inside the volume: ` +
      `\`docker run --rm -u 0:0 -v ${mount.source}:${mount.target} ${target.image} chown -R ` +
      `${target.containerUser ?? '0:0'} ${mount.target}\``
    )
  }
  const chmod = need === 'writable' ? `chmod u+w ${mount.source}, ` : ''
  return (
    `${chmod}or make ${target.envPrefix}_DOCKER_HOST_CONFIG_DIR=${mount.source} ${need} by ` +
    `${uid ? `uid ${uid}` : 'the image default user'} on the host` +
    (uid ? ` (\`chown -R ${target.containerUser} ${mount.source}\`), or unset ${target.envPrefix}_DOCKER_USER` : '')
  )
}

async function checkCredentialPresence(
  target: DockerPreflightTarget,
  mount: DockerPreflightMount,
  containerId: string,
  cli: DockerCli,
  warnings: string[],
  missingCredentials: 'warn' | 'fail',
): Promise<PreflightFinding[]> {
  const loginHint =
    `log in on the host so the credentials land in ${mount.source}, or run ` +
    `\`docker exec -it <slot> ${target.bin} auth login\` inside the pool container`
  /** One absence, reported as a warning or a finding depending on who asked. */
  const report = (check: string, detail: string): PreflightFinding[] => {
    if (missingCredentials === 'warn') {
      warnings.push(`${target.backend}: ${detail} — ${loginHint}.`)
      return []
    }
    return [{ check, detail: `${target.backend}: ${detail}`, remedy: loginHint }]
  }
  if (mount.credentialFile) {
    const path = `${mount.target}/${mount.credentialFile}`
    const present = await cli(containerShell(containerId, `test -e ${shellQuote(path)}`))
    if (present.code !== 0) {
      return report(
        'auth-mount-credentials',
        `${path} does not exist, so ${target.bin} has NO credentials in ${mount.source} -> ${mount.target}. ` +
        `It will start and authenticate against nothing, which surfaces as an empty completion rather than an ` +
        `auth error`,
      )
    }
    return []
  }
  const listing = await cli(containerShell(containerId, `ls -A ${shellQuote(mount.target)} 2>/dev/null | head -1`))
  if (listing.code === 0 && listing.stdout.trim() === '') {
    return report(
      'auth-mount-empty',
      `credential mount ${mount.source} -> ${mount.target} is EMPTY. ${target.bin} will start but have nothing ` +
      `to authenticate with, which surfaces as an empty completion rather than an auth error`,
    )
  }
  return []
}

/**
 * Prove the bind by round-tripping a marker: write it on the host inside the
 * workspace root, read it back at the SAME absolute path inside the container.
 * `test -d` alone would pass on a path that merely exists in the image — which
 * is exactly how an unmounted workspace stays invisible until traffic arrives.
 */
async function checkWorkspaceMount(
  target: DockerPreflightTarget,
  containerId: string,
  cli: DockerCli,
): Promise<PreflightFinding[]> {
  const workspaceRoot = target.workspaceRoot!
  const markerName = `.cli-bridge-preflight-${randomBytes(6).toString('hex')}`
  const hostMarker = join(workspaceRoot, markerName)
  const containerMarker = `${workspaceRoot}/${markerName}`
  const token = randomBytes(8).toString('hex')
  try {
    writeFileSync(hostMarker, token)
  } catch (err) {
    return [{
      check: 'workspace-writable',
      detail: `${target.envPrefix}_DOCKER_WORKSPACE_ROOT=${workspaceRoot} is not writable on the host (${err instanceof Error ? err.message : String(err)})`,
      remedy: `point ${target.envPrefix}_DOCKER_WORKSPACE_ROOT at a directory this process can write`,
    }]
  }
  try {
    const readback = await cli(['exec', '--workdir', workspaceRoot, containerId, 'cat', containerMarker])
    if (readback.code !== 0 || readback.stdout.trim() !== token) {
      return [{
        check: 'workspace-mounted',
        detail:
          `${target.envPrefix}_DOCKER_WORKSPACE_ROOT=${workspaceRoot} is configured but is NOT mounted into the pool ` +
          `container at that path — the executor would cd into a directory that does not exist and docker would ` +
          `report exit 127, the same status as "command not found" ` +
          `(${firstLine(readback.stderr) || `read back ${JSON.stringify(readback.stdout.slice(0, 60))}`})`,
        remedy:
          `this indicates the pool did not receive the workspace bind; verify with ` +
          `\`docker inspect --format '{{json .Mounts}}' ${containerId.slice(0, 12)}\` and report it as a bridge bug`,
      }]
    }
    // The writability check the CLI actually depends on: it writes INTO the
    // workspace, and a read-only bind would fail only once a tool call runs.
    const writeBack = await cli(containerShell(containerId, `: > ${shellQuote(`${containerMarker}.rw`)} && rm -f ${shellQuote(`${containerMarker}.rw`)}`))
    if (writeBack.code !== 0) {
      return [{
        check: 'workspace-writable-in-container',
        detail:
          `${workspaceRoot} is mounted into the container but not writable by ` +
          `${target.containerUser ?? 'the image default user'} (${compact(writeBack.stderr)})`,
        remedy:
          target.containerUser
            ? `chown ${workspaceRoot} on the host to uid ${target.containerUser.split(':')[0]}, or unset ${target.envPrefix}_DOCKER_USER`
            : `check host permissions on ${workspaceRoot}`,
      }]
    }
    return []
  } finally {
    try { rmSync(hostMarker, { force: true }) } catch { /* best-effort */ }
  }
}

/** True when `child` is `parent` or lives beneath it. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
}

function compact(text: string): string {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).join(' ')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}
