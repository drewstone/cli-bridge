import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { containerShell, type DockerCli } from './docker-cli.js'
import { grantPrivateTreeToUid } from './private-path-access.js'
import { createPrivateTemporaryRoot, type PrivateTemporaryRoot } from '../runtime/private-temporary.js'
import { runDockerCli, compact, firstLine, shellQuote } from './docker-preflight-utils.js'
import type { DockerPreflightMount, DockerPreflightTarget, PreflightFinding } from './docker-preflight.js'

export function checkWorkspaceRootSource(target: DockerPreflightTarget): PreflightFinding[] {
  const root = target.workspaceRoot!
  const envKey = `${target.envPrefix}_DOCKER_WORKSPACE_ROOT`
  if (!isAbsolute(root)) return [{ check: 'workspace-root', detail: `${envKey}=${root} is not an absolute path, so it cannot be bind-mounted at the identical path`, remedy: `set ${envKey} to an absolute host directory` }]
  try {
    if (!statSync(root).isDirectory()) return [{ check: 'workspace-root', detail: `${envKey}=${root} exists but is not a directory`, remedy: 'point it at a directory' }]
    return []
  } catch {
    try { mkdirSync(root, { recursive: true }); return [] }
    catch (error) { return [{ check: 'workspace-root', detail: `${envKey}=${root} does not exist and cannot be created (${error instanceof Error ? error.message : String(error)})`, remedy: `create it, or point ${envKey} at a directory this process can write` }] }
  }
}

export function checkBindSource(target: DockerPreflightTarget, mount: DockerPreflightMount): PreflightFinding[] {
  if (!isAbsolute(mount.source)) return [{ check: 'mount-source', detail: `bind source ${mount.source} (mounted at ${mount.target}) is not an absolute path`, remedy: `set ${target.envPrefix}_DOCKER_HOST_CONFIG_DIR to an absolute host path` }]
  try {
    if (!statSync(mount.source).isDirectory()) return [{ check: 'mount-source', detail: `bind source ${mount.source} (mounted at ${mount.target}) exists but is not a directory`, remedy: `point ${target.envPrefix}_DOCKER_HOST_CONFIG_DIR at a directory` }]
    return []
  } catch {
    try { mkdirSync(mount.source, { recursive: true }); return [] }
    catch (error) { return [{ check: 'mount-source', detail: `bind source ${mount.source} (mounted at ${mount.target}) does not exist and cannot be created (${error instanceof Error ? error.message : String(error)})`, remedy: `create it, or point ${target.envPrefix}_DOCKER_HOST_CONFIG_DIR at an existing directory` }] }
  }
}

export async function checkCredentialMounts(target: DockerPreflightTarget, containerId: string, cli: DockerCli, warnings: string[], missingCredentials: 'warn' | 'fail', signal?: AbortSignal): Promise<PreflightFinding[]> {
  const findings: PreflightFinding[] = []
  for (const mount of target.mounts) {
    if (target.containerUser && !isInside(target.containerHome, mount.target)) {
      findings.push({ check: 'auth-mount-home', detail: `credentials are mounted at ${mount.target} but the CLI runs as ${target.containerUser} with HOME=${target.containerHome}, so it never looks there`, remedy: `set ${target.envPrefix}_DOCKER_CONTAINER_CONFIG_DIR to a path under ${target.containerHome}, or unset ${target.envPrefix}_DOCKER_USER/${target.envPrefix}_DOCKER_HOME to run as the image's root identity` })
      continue
    }
    const readable = await runDockerCli(cli, containerShell(containerId, `test -r ${shellQuote(mount.target)} && test -x ${shellQuote(mount.target)}`), signal)
    if (readable.code !== 0) {
      const owner = await runDockerCli(cli, containerShell(containerId, `ls -ld ${shellQuote(mount.target)} 2>&1; id`), signal)
      findings.push({ check: 'auth-mount-readable', detail: `credential mount ${mount.target} is not readable by the user the CLI runs as (${compact(owner.stdout)})`, remedy: mountPermissionRemedy(target, mount, 'readable') })
      continue
    }
    const probe = `${mount.target}/.cli-bridge-preflight-write`
    const writable = await runDockerCli(cli, containerShell(containerId, `: > ${shellQuote(probe)} && rm -f ${shellQuote(probe)}`), signal)
    if (writable.code !== 0) findings.push({ check: 'auth-mount-writable', detail: `credential mount ${mount.target} is not writable by ${target.containerUser ?? 'the image default user'}, so ${target.bin} cannot persist session state or a refreshed token (${compact(writable.stderr) || `exit ${writable.code}`})`, remedy: mountPermissionRemedy(target, mount, 'writable') })
    findings.push(...await checkCredentialPresence(target, mount, containerId, cli, warnings, missingCredentials, signal))
  }
  return findings
}

function mountPermissionRemedy(target: DockerPreflightTarget, mount: DockerPreflightMount, need: 'readable' | 'writable'): string {
  const uid = target.containerUser?.split(':')[0]
  if (mount.kind === 'volume') return `fix ownership inside the volume: \`docker run --rm -u 0:0 -v ${mount.source}:${mount.target} ${target.image} chown -R ${target.containerUser ?? '0:0'} ${mount.target}\``
  return `${need === 'writable' ? `chmod u+w ${mount.source}, ` : ''}or make ${target.envPrefix}_DOCKER_HOST_CONFIG_DIR=${mount.source} ${need} by ${uid ? `uid ${uid}` : 'the image default user'} on the host${uid ? ` (\`chown -R ${target.containerUser} ${mount.source}\`), or unset ${target.envPrefix}_DOCKER_USER` : ''}`
}

export async function checkCredentialPresence(target: DockerPreflightTarget, mount: DockerPreflightMount, containerId: string, cli: DockerCli, warnings: string[], missingCredentials: 'warn' | 'fail', signal?: AbortSignal): Promise<PreflightFinding[]> {
  const loginHint = `log in on the host so the credentials land in ${mount.source}, or run \`docker exec -it <slot> ${target.bin} auth login\` inside the pool container`
  const report = (check: string, detail: string): PreflightFinding[] => missingCredentials === 'warn' ? (warnings.push(`${target.backend}: ${detail} — ${loginHint}.`), []) : [{ check, detail: `${target.backend}: ${detail}`, remedy: loginHint }]
  if (mount.credentialFile) {
    const path = `${mount.target}/${mount.credentialFile}`
    const present = await runDockerCli(cli, containerShell(containerId, `test -e ${shellQuote(path)}`), signal)
    if (present.code !== 0) return report('auth-mount-credentials', `${path} does not exist, so ${target.bin} has NO credentials in ${mount.source} -> ${mount.target}. It will start and authenticate against nothing, which surfaces as an empty completion rather than an auth error`)
    return []
  }
  const listing = await runDockerCli(cli, containerShell(containerId, `ls -A ${shellQuote(mount.target)} 2>/dev/null | head -1`), signal)
  return listing.code === 0 && listing.stdout.trim() === '' ? report('auth-mount-empty', `credential mount ${mount.source} -> ${mount.target} is EMPTY. ${target.bin} will start but have nothing to authenticate with, which surfaces as an empty completion rather than an auth error`) : []
}

export async function checkWorkspaceMount(target: DockerPreflightTarget, containerId: string, cli: DockerCli, signal?: AbortSignal): Promise<PreflightFinding[]> {
  const workspaceRoot = target.workspaceRoot!
  let privateRoot: PrivateTemporaryRoot | null = null
  const token = randomBytes(8).toString('hex')
  try {
    privateRoot = createPrivateTemporaryRoot(workspaceRoot, '.cli-bridge-preflight-')
    writeFileSync(join(privateRoot.path, 'private-config'), token, { mode: 0o600, flag: 'wx' })
    if (target.containerUser) await grantPrivateTreeToUid(privateRoot.path, Number(target.containerUser.split(':')[0]))
  } catch (error) {
    privateRoot?.cleanup()
    return [{ check: 'workspace-private-files', detail: `${target.envPrefix}_DOCKER_WORKSPACE_ROOT=${workspaceRoot} cannot host private generated CLI config for ${target.containerUser ?? 'the image default user'} (${error instanceof Error ? error.message : String(error)})`, remedy: `point ${target.envPrefix}_DOCKER_WORKSPACE_ROOT at a directory this process can write and ensure the Linux acl package is installed when ${target.envPrefix}_DOCKER_USER differs from the bridge uid` }]
  }
  const containerRoot = join(workspaceRoot, basename(privateRoot.path))
  const containerMarker = join(containerRoot, 'private-config')
  try {
    const readback = await runDockerCli(cli, ['exec', '--workdir', workspaceRoot, containerId, 'cat', containerMarker], signal)
    if (readback.code !== 0 || readback.stdout.trim() !== token) return [{ check: 'workspace-mounted', detail: `${target.envPrefix}_DOCKER_WORKSPACE_ROOT=${workspaceRoot} is configured but is NOT mounted into the pool container at that path — the executor would cd into a directory that does not exist and docker would report exit 127, the same status as "command not found" (${firstLine(readback.stderr) || `read back ${JSON.stringify(readback.stdout.slice(0, 60))}`})`, remedy: `verify with \`docker inspect --format '{{json .Mounts}}' ${containerId.slice(0, 12)}\` and report it as a bridge bug` }]
    const runtimeWrite = join(containerRoot, 'runtime-write')
    const writeBack = await runDockerCli(cli, containerShell(containerId, `: > ${shellQuote(runtimeWrite)} && rm -f ${shellQuote(runtimeWrite)}`), signal)
    if (writeBack.code !== 0) return [{ check: 'workspace-writable-in-container', detail: `${workspaceRoot} is mounted into the container but not writable by ${target.containerUser ?? 'the image default user'} (${compact(writeBack.stderr)})`, remedy: target.containerUser ? `chown ${workspaceRoot} on the host to uid ${target.containerUser.split(':')[0]}, or unset ${target.envPrefix}_DOCKER_USER` : `check host permissions on ${workspaceRoot}` }]
    return []
  } finally { try { privateRoot.cleanup() } catch { /* best effort */ } }
}

export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
