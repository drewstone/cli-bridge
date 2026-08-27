/** Live checks for the Docker image, mounts, and a real pool slot. */

import { containerShell, dockerCli, type DockerCli } from './docker-cli.js'
import { throwIfExecutorAborted, type ExecutorFinding } from './types.js'
import {
  checkBindSource,
  checkCredentialMounts,
  checkCredentialPresence,
  checkWorkspaceMount,
  checkWorkspaceRootSource,
  isInside,
} from './docker-preflight-mounts.js'
import { runDockerCli, compact, firstLine, shellQuote } from './docker-preflight-utils.js'

export interface DockerPreflightMount {
  source: string
  target: string
  kind: 'bind' | 'volume'
  credentialFile?: string
}
export interface DockerPreflightTarget {
  backend: string
  envPrefix: string
  image: string
  bin: string
  containerUser?: string | undefined
  containerHome: string
  mounts: DockerPreflightMount[]
  workspaceRoot?: string | undefined
  buildCommand: string
}
export type PreflightFinding = ExecutorFinding
export type PreflightScope = 'full' | 'credentials' | 'request-path'

export class DockerPreflightError extends Error {
  constructor(readonly backend: string, readonly findings: PreflightFinding[]) {
    super(formatPreflightFailure(backend, findings)); this.name = 'DockerPreflightError'
  }
}

export function formatPreflightFailure(backend: string, findings: PreflightFinding[]): string {
  const lines = findings.map((finding, index) => `  ${index + 1}. [${finding.check}] ${finding.detail}\n     fix: ${finding.remedy}`)
  return `${backend} docker executor is not usable on this host — refusing to open the port with a configuration that would fail at first request:\n${lines.join('\n')}`
}

export const RUNTIME_IMAGE_BUILD_COMMAND = 'pnpm run docker:build:runtime'
export function buildCommandFor(image: string): string {
  return image === 'cli-bridge-cli-runtime:latest' ? RUNTIME_IMAGE_BUILD_COMMAND : `docker build -f docker/Dockerfile.cli-runtime -t ${image} .`
}

export async function preflightDockerImage(target: DockerPreflightTarget, cli: DockerCli = dockerCli): Promise<PreflightFinding[]> {
  const findings: PreflightFinding[] = []
  const version = await cli(['version', '--format', '{{.Server.Version}}'])
  if (version.code !== 0) return [{ check: 'docker-daemon', detail: `${target.envPrefix}_EXECUTOR=docker but the Docker daemon is not reachable (${firstLine(version.stderr) || version.spawnError || `docker exited ${version.code}`})`, remedy: `start Docker, or set ${target.envPrefix}_EXECUTOR=host to run the CLI on this host instead` }]
  const image = await cli(['image', 'inspect', '--format', '{{.Id}}', target.image])
  if (image.code !== 0) findings.push({ check: 'runtime-image', detail: `image ${target.image} does not exist on this host, so no pool container can be created`, remedy: `build it: ${target.buildCommand}` })
  for (const mount of target.mounts) if (mount.kind === 'bind') findings.push(...checkBindSource(target, mount))
  if (target.workspaceRoot) findings.push(...checkWorkspaceRootSource(target))
  return findings
}

export async function preflightDockerSlot(
  target: DockerPreflightTarget,
  containerId: string,
  cli: DockerCli = dockerCli,
  warnings: string[] = [],
  opts: { scope?: PreflightScope; signal?: AbortSignal } = {},
): Promise<PreflightFinding[]> {
  const findings: PreflightFinding[] = []
  const scope = opts.scope ?? 'full'
  const signal = opts.signal
  throwIfExecutorAborted(signal)
  if (scope === 'credentials') return checkCredentialMounts(target, containerId, cli, warnings, 'warn', signal)
  if (scope === 'request-path') {
    findings.push(...await checkCredentialMounts(target, containerId, cli, warnings, 'fail', signal))
    if (target.workspaceRoot) findings.push(...await checkWorkspaceMount(target, containerId, cli, signal))
    return findings
  }
  const identity = await runDockerCli(cli, containerShell(containerId, 'printf "%s\\n%s\\n%s" "$(id -u)" "$(id -g)" "$HOME"'), signal)
  if (identity.code !== 0) return [{ check: 'container-exec', detail: `cannot exec into freshly provisioned container ${containerId.slice(0, 12)} (${firstLine(identity.stderr)})`, remedy: 'check the Docker daemon and whether something outside the bridge is removing containers' }]
  const [uid = '', gid = '', home = ''] = identity.stdout.split('\n')
  if (target.containerUser && `${uid}:${gid}` !== target.containerUser) findings.push({ check: 'container-user', detail: `${target.envPrefix}_DOCKER_USER=${target.containerUser} but processes inside the container run as ${uid}:${gid}`, remedy: `set ${target.envPrefix}_DOCKER_USER=${uid}:${gid}, or use an image whose default user is ${target.containerUser}` })
  if (home.trim() !== target.containerHome) findings.push({ check: 'container-home', detail: `the CLI inside the container sees HOME=${home.trim() || '(unset)'} but the bridge mounts credentials against ${target.containerHome}`, remedy: `set ${target.envPrefix}_DOCKER_HOME=${home.trim() || '/root'} so credential mounts land where the CLI reads them` })
  const stateProbe = await runDockerCli(cli, containerShell(containerId, 'set -e; for d in "$HOME" "$HOME/.local/state" "$HOME/.local/share" "$HOME/.config" "$HOME/.cache"; do mkdir -p "$d" 2>&1 || { echo "MKDIR_FAILED $d"; ls -ld "$d" "$(dirname "$d")" 2>&1; exit 3; }; done; probe="$HOME/.local/state/.cli-bridge-preflight"; : > "$probe" || { echo "WRITE_FAILED $probe"; exit 4; }; rm -f "$probe"; echo HOME_WRITABLE'), signal)
  if (stateProbe.code !== 0 || !stateProbe.stdout.includes('HOME_WRITABLE')) findings.push({ check: 'home-writable', detail: `HOME=${target.containerHome} is not writable inside the container for ${target.containerUser ?? 'the image default user'}: ${compact(stateProbe.stdout + ' ' + stateProbe.stderr)}`, remedy: `rebuild the runtime image so ${target.containerHome} and its XDG subdirectories exist and are owned by that user (${target.buildCommand}), or set ${target.envPrefix}_DOCKER_HOME to a directory that user owns` })
  findings.push(...await checkCredentialMounts(target, containerId, cli, warnings, 'warn', signal))
  if (target.workspaceRoot) findings.push(...await checkWorkspaceMount(target, containerId, cli, signal))
  const which = await runDockerCli(cli, containerShell(containerId, `command -v ${shellQuote(target.bin)} || exit 1`), signal)
  if (which.code !== 0 || !which.stdout.trim()) findings.push({ check: 'cli-binary', detail: `${target.bin} is not on PATH inside ${target.image} for ${target.containerUser ?? 'the image default user'}`, remedy: `rebuild the image with that CLI installed (${target.buildCommand}), or set ${target.envPrefix}_DOCKER_IMAGE to an image that has it` })
  if (findings.length === 0) {
    const execArgs = ['exec']
    if (target.workspaceRoot) execArgs.push('--workdir', target.workspaceRoot)
    execArgs.push(containerId, target.bin, '--version')
    const trivial = await runDockerCli(cli, execArgs, signal, 60_000)
    if (trivial.code !== 0) findings.push({ check: 'trivial-exec', detail: `\`${target.bin} --version\` failed inside the pool container (exit ${trivial.code}${target.workspaceRoot ? ` with --workdir ${target.workspaceRoot}` : ''}): ${compact(trivial.stderr + ' ' + trivial.stdout).slice(0, 400)}`, remedy: `run \`docker exec ${target.workspaceRoot ? `-w ${target.workspaceRoot} ` : ''}<slot> ${target.bin} --version\` against a pool container to reproduce, then rebuild the image (${target.buildCommand}) if the CLI is broken inside it` })
  }
  return findings
}

export { checkCredentialPresence, isInside }
