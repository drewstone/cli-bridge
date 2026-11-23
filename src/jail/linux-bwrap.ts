/** Linux namespace jail. The shared path policy owns filesystem grants. */
import { spawnSync } from 'node:child_process'
import { prepareEgress } from './egress.js'
import { prepareLinuxPaths, whichPath } from './linux-paths.js'
import type { JailBackend, JailSpec, JailWrap } from './types.js'
export { toolchainReadPaths, isSafeReadPath } from './linux-paths.js'
const BWRAP_BIN = 'bwrap'

export class LinuxBwrapJail implements JailBackend {
  readonly name = 'bwrap'
  readonly networkCapability = 'namespace' as const
  isAvailable(): boolean {
    return process.platform === 'linux' && !!whichPath(BWRAP_BIN) && canRunUnprivileged()
  }
  async wrap(bin: string, args: string[], spec: JailSpec): Promise<JailWrap> {
    const policy = await prepareLinuxPaths(bin, spec)
    let egress: Awaited<ReturnType<typeof prepareEgress>> | undefined
    try {
      egress = await prepareEgress(spec)
      const argv = ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net']
      // Keep mount ordering: /tmp is private before explicit paths reappear.
      if (spec.readConfine) argv.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp')
      for (const path of policy.paths) {
        argv.push(path.writable ? '--bind' : path.optional ? '--ro-bind-try' : '--ro-bind', path.source, path.destination)
        if (!spec.readConfine && path.source === '/') argv.push('--proc', '/proc', '--dev', '/dev')
      }
      for (const [alias, target] of policy.links) argv.push('--symlink', target, alias)
      argv.push(...egress.bwrapArgs)
      for (const [key, value] of Object.entries({ ...egress.env, ...policy.env })) argv.push('--setenv', key, value)
      argv.push('--chdir', spec.projectDir, '--die-with-parent', ...egress.prefix, bin, ...args)
      const activeEgress = egress
      // --unshare-pid makes bwrap the reaper of the command, which runs as PID 2 and
      // reaches the Bridge only as bwrap's exit status: 134 for a SIGABRT death.
      return { bin: BWRAP_BIN, args: argv, effectiveHome: policy.root, effectiveNativeStore: policy.effectiveNativeStore,
        exitStatusCarriesSignal: true,
        cleanup: async () => { try { await activeEgress.cleanup() } finally { await policy.cleanup() } } }
    } catch (error) { try { await egress?.cleanup() } finally { await policy.cleanup() }; throw error }
  }
}

let probed: boolean | undefined
function canRunUnprivileged(): boolean {
  if (probed !== undefined) return probed
  try {
    const r = spawnSync(BWRAP_BIN, ['--unshare-user', '--ro-bind', '/', '/', '--', 'true'], {
      timeout: 5000,
      stdio: 'ignore',
    })
    probed = r.status === 0
  } catch {
    probed = false
  }
  return probed
}
