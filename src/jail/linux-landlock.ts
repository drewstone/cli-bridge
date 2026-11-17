/** Landlock fallback: filesystem allowlist and TCP ports, without namespace isolation. */
import { existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JAIL_HOST_EGRESS_ENV } from '../config.js'
import { BackendError } from '../backends/types.js'
import { prepareEgress } from './egress.js'
import { prepareLinuxPaths, whichPath } from './linux-paths.js'
import { canonicalizeJailPath, isWithin, type JailBackend, type JailSpec, type JailWrap } from './types.js'

const LAUNCHER = fileURLToPath(new URL('./landlock-exec.py', import.meta.url))
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
    const policy = await prepareLinuxPaths(bin, spec, true)
    if (interpreter.startsWith('/nix/store/')) policy.paths.push({ source: '/nix/store', destination: '/nix/store', writable: false, optional: true })
    let egress: Awaited<ReturnType<typeof prepareEgress>> | undefined
    const cleanup = async () => {
      try { await egress?.cleanup() } finally { await policy.cleanup() }
    }
    try {
      for (const path of policy.paths) {
        if (canonicalizeJailPath(path.source) !== canonicalizeJailPath(path.destination)) refuse('a remapped bind')
      }
      const writable = policy.paths.filter((p) => p.writable)
      if (writable.some((p) => canonicalizeJailPath(p.source) !== resolve(p.source))) refuse('a redirected writable path')
      if (policy.paths.some((p) => !p.writable && (!p.optional || existsSync(p.source))
        && writable.some((w) => isWithin(w.source, p.source)))) refuse('a read-only path nested in a writable grant')
      egress = await prepareEgress(spec, this.networkCapability)
      // Landlock grants are additive: a parent grant cannot mask a private subtree.
      if (egress.hiddenParent && policy.paths.some((p) => isWithin(p.source, egress!.hiddenParent!))) refuse('a path grant exposing the hidden egress directory')
      if (writable.some((p) => isWithin(p.source, LAUNCHER) || isWithin(p.source, interpreter))) refuse('writable launcher or interpreter storage')
      const file = join(policy.directory, 'policy.json')
      const paths = policy.paths.map((p) => ({ path: p.source, writable: p.writable, optional: p.optional }))
      // Devices are individual grants; host /proc and the rest of /dev stay closed.
      for (const path of ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom']) paths.push({ path, writable: true, optional: false })
      for (const path of egress.readablePaths ?? []) paths.push({ path, writable: false, optional: false })
      const pinned = paths.flatMap((entry) => {
        try {
          const path = entry.writable ? resolve(entry.path) : canonicalizeJailPath(entry.path)
          const identity = statSync(path, { bigint: true })
          return [{ ...entry, path, dev: String(identity.dev), ino: String(identity.ino) }]
        } catch (error) {
          if (entry.optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return []
          throw error
        }
      })
      await writeFile(file, JSON.stringify({ paths: pinned, connect: egress.tcpConnectPorts ?? [], env: { ...egress.env, ...policy.env }, cwd: spec.projectDir, parent: process.pid }), { mode: 0o600 })
      return { bin: interpreter, args: ['-I', '-S', LAUNCHER, file, bin, ...args], effectiveHome: policy.root,
        effectiveNativeStore: policy.effectiveNativeStore, cleanup }
    } catch (error) { await cleanup(); throw error }
  }
}
