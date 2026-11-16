/** Landlock fallback: filesystem allowlist and TCP ports, without namespace isolation. */
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JAIL_HOST_EGRESS_ENV } from '../config.js'
import { BackendError } from '../backends/types.js'
import { prepareEgress } from './egress.js'
import { prepareLinuxPaths, whichPath } from './linux-paths.js'
import { canonicalizeJailPath, type JailBackend, type JailSpec, type JailWrap } from './types.js'

const LAUNCHER = fileURLToPath(new URL('./landlock-exec.py', import.meta.url))
const beneath = (parent: string, path: string) => {
  const rel = relative(canonicalizeJailPath(parent), canonicalizeJailPath(path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
const refuse = (reason: string): never => { throw new BackendError(`Landlock jail refuses ${reason}`, 'not_configured') }

export class LinuxLandlockJail implements JailBackend {
  readonly name = 'landlock'
  readonly networkCapability = 'tcp-port' as const

  isAvailable(): boolean {
    if (process.platform !== 'linux') return false
    const python = whichPath('python3')
    if (!python) return false
    const probe = spawnSync(canonicalizeJailPath(python), ['-I', '-S', LAUNCHER, '--probe'], { stdio: 'ignore', timeout: 5000 })
    return probe.status === 0
  }

  async wrap(bin: string, args: string[], spec: JailSpec): Promise<JailWrap> {
    if (!spec.readConfine) refuse('write-jail: a host-wide read grant cannot hide sibling egress state; use fs-jail')
    if (!spec.hostEgressEnforced) refuse(`relay-grade isolation without ${JAIL_HOST_EGRESS_ENV}=1`)
    // Trusted service aliases currently require the namespace shim’s fixed listener.
    if (spec.trustedHostServices?.length) refuse('trusted host-service aliases: they require the namespace transport')
    const python = whichPath('python3')
    if (!python) refuse('an unavailable Python interpreter')
    const interpreter = canonicalizeJailPath(python!)
    const policy = await prepareLinuxPaths(bin, spec)
    let egress: Awaited<ReturnType<typeof prepareEgress>> | undefined
    let directory: string | undefined
    const cleanup = async () => {
      try { if (directory) await rm(directory, { recursive: true, force: true }) }
      finally { try { await egress?.cleanup() } finally { await policy.cleanup() } }
    }
    try {
      for (const path of policy.paths) {
        if (canonicalizeJailPath(path.source) !== canonicalizeJailPath(path.destination)) refuse('a remapped bind')
      }
      egress = await prepareEgress(spec, this.networkCapability)
      // Landlock grants are additive: a parent grant cannot mask a private subtree.
      if (egress.hiddenParent && policy.paths.some((p) => beneath(p.source, egress!.hiddenParent!))) refuse('a path grant exposing the hidden egress directory')
      const writable = policy.paths.filter((p) => p.writable)
      if (writable.some((p) => beneath(p.source, LAUNCHER) || beneath(p.source, interpreter))) refuse('writable launcher or interpreter storage')
      const parent = [tmpdir(), '/tmp'].find((p) => writable.every((rule) => !beneath(rule.source, p)))
      if (!parent) refuse('policy storage inside writable paths')
      directory = await mkdtemp(join(parent!, 'cli-bridge-landlock-'))
      const file = join(directory, 'policy.json')
      const paths = policy.paths.map((p) => ({ path: p.source, writable: p.writable, optional: p.optional }))
      // Devices are individual grants; host /proc and the rest of /dev stay closed.
      for (const path of ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom']) paths.push({ path, writable: true, optional: false })
      for (const path of egress.readablePaths ?? []) paths.push({ path, writable: false, optional: false })
      await writeFile(file, JSON.stringify({ paths, connect: egress.tcpConnectPorts ?? [], env: { ...egress.env, ...policy.env }, cwd: spec.projectDir, parent: process.pid }), { mode: 0o600 })
      return { bin: interpreter, args: ['-I', '-S', LAUNCHER, file, bin, ...args], effectiveHome: policy.root,
        effectiveNativeStore: policy.effectiveNativeStore, cleanup }
    } catch (error) { await cleanup(); throw error }
  }
}
