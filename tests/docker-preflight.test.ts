/**
 * Defect 1 — a runtime image can be absent and nothing notices until traffic.
 * Defect 3 — auth volumes can land at /root while the CLI runs as a user whose
 *            HOME is elsewhere, producing EACCES on a path nobody configured.
 * Defect E — a setting that is accepted must be honoured.
 *
 * The measured facts these tests encode, all reproduced on this host:
 *
 *   docker run <absent image>                    -> exit 125,
 *     "pull access denied ... repository does not exist" (a REGISTRY message
 *     for a local build problem)
 *   --user 1000:1000 --env HOME=/home/node with creds at /root/.config/opencode
 *     -> `cat /root/.config/opencode/auth.json` = Permission denied,
 *        `/home/node/.config/opencode` = No such file or directory
 *   -v <host>:/home/node/.local/share/opencode in an image without
 *     /home/node/.local -> Docker creates the parents root:root, then
 *     `mkdir -p /home/node/.local/state` = Permission denied
 *   the installed cli-bridge-cli-runtime:latest lacked
 *     /home/node/.local/{share,state} even though the Dockerfile creates them
 *     — i.e. the image had drifted from its Dockerfile, so only a LIVE probe
 *     can establish coherence.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildCommandFor,
  preflightDockerImage,
  preflightDockerSlot,
  type DockerPreflightTarget,
} from '../src/executors/docker-preflight.js'
import type { DockerCli, DockerCliResult } from '../src/executors/docker-cli.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const ok = (stdout = ''): DockerCliResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string, code = 1): DockerCliResult => ({ code, stdout: '', stderr })

function target(over: Partial<DockerPreflightTarget> = {}): DockerPreflightTarget {
  return {
    backend: 'opencode',
    envPrefix: 'OPENCODE',
    image: 'cli-bridge-cli-runtime:latest',
    bin: 'opencode',
    containerHome: '/root',
    mounts: [{ source: '/host/.config/opencode', target: '/root/.config/opencode', kind: 'bind' }],
    buildCommand: buildCommandFor('cli-bridge-cli-runtime:latest'),
    ...over,
  }
}

// ─── phase 1: daemon, image, mount sources ───────────────────────────────

describe('preflightDockerImage — an absent image is named as an absent IMAGE', () => {
  it('reports the missing image and the exact build command', async () => {
    const cli: DockerCli = async (args) => {
      if (args[0] === 'version') return ok('27.5.1')
      if (args[0] === 'image') return fail('Error response from daemon: No such image: cli-bridge-cli-runtime:latest')
      return ok()
    }
    const source = tempDir('cli-bridge-preflight-mount-')
    const findings = await preflightDockerImage(target({
      mounts: [{ source, target: '/root/.config/opencode', kind: 'bind' }],
    }), cli)

    expect(findings.map((f) => f.check)).toEqual(['runtime-image'])
    expect(findings[0]!.detail).toContain('image cli-bridge-cli-runtime:latest does not exist on this host')
    // The failure must not describe a CONTAINER, which is how it used to read.
    expect(findings[0]!.detail).not.toMatch(/No such container/)
    expect(findings[0]!.remedy).toBe('build it: pnpm run docker:build:runtime')
  })

  it('names a custom image tag in the build command rather than the default script', () => {
    expect(buildCommandFor('my-runtime:dev'))
      .toBe('docker build -f docker/Dockerfile.cli-runtime -t my-runtime:dev .')
  })

  it('reports an unreachable daemon and stops, so the operator reads one cause', async () => {
    const cli: DockerCli = async () => ({ code: -1, stdout: '', stderr: 'Cannot connect to the Docker daemon' })
    const findings = await preflightDockerImage(target(), cli)
    expect(findings.map((f) => f.check)).toEqual(['docker-daemon'])
    expect(findings[0]!.remedy).toContain('OPENCODE_EXECUTOR=host')
  })

  it('creates a missing bind source instead of letting Docker root-own it', async () => {
    const parent = tempDir('cli-bridge-preflight-create-')
    const source = join(parent, 'nested', 'opencode')
    const cli: DockerCli = async (args) => (args[0] === 'version' ? ok('27.5.1') : ok('sha256:abc'))
    const findings = await preflightDockerImage(target({
      mounts: [{ source, target: '/root/.config/opencode', kind: 'bind' }],
    }), cli)
    expect(findings).toEqual([])
    expect(existsSync(source)).toBe(true)
  })

  it('reports a bind source that exists but is not a directory', async () => {
    const dir = tempDir('cli-bridge-preflight-file-')
    const file = join(dir, 'not-a-dir')
    writeFileSync(file, 'x')
    const cli: DockerCli = async (args) => (args[0] === 'version' ? ok('27.5.1') : ok('sha256:abc'))
    const findings = await preflightDockerImage(target({
      mounts: [{ source: file, target: '/root/.config/opencode', kind: 'bind' }],
    }), cli)
    expect(findings.map((f) => f.check)).toEqual(['mount-source'])
  })
})

// ─── phase 2: a real slot ────────────────────────────────────────────────

interface SlotBehaviour {
  uid?: string
  gid?: string
  home?: string
  homeWritable?: boolean
  homeWritableError?: string
  readableTargets?: string[]
  binaryPath?: string | null
  /** Host dir standing in for a live bind mount; null simulates "not mounted". */
  mountedWorkspace?: string | null
  versionExit?: number
}

function slotDocker(b: SlotBehaviour = {}): { cli: DockerCli; calls: string[][] } {
  const {
    uid = '0', gid = '0', home = '/root', homeWritable = true,
    homeWritableError = "mkdir: cannot create directory '/home/node/.local/state': Permission denied",
    readableTargets, binaryPath = '/usr/local/bin/opencode', mountedWorkspace, versionExit = 0,
  } = b
  const calls: string[][] = []
  const cli: DockerCli = async (args) => {
    calls.push(args)
    if (args[0] !== 'exec') return ok()
    const script = args[args.length - 1] ?? ''
    if (script.includes('id -u')) return ok(`${uid}\n${gid}\n${home}`)
    if (script.includes('HOME_WRITABLE')) {
      return homeWritable ? ok('HOME_WRITABLE\n') : { code: 3, stdout: '', stderr: homeWritableError }
    }
    if (script.includes('command -v')) return binaryPath ? ok(`${binaryPath}\n`) : fail('')
    if (script.startsWith('test -r ')) {
      const path = script.slice('test -r '.length).split(' ')[0]!.replace(/'/gu, '')
      return !readableTargets || readableTargets.includes(path) ? ok() : fail('')
    }
    if (script.includes('ls -ld')) return ok('drwx------ 2 root root 4096 /root/.config/opencode uid=1000(node)')
    // cat of the workspace marker: read the real host file when "mounted".
    if (args.includes('cat')) {
      const path = args[args.length - 1]!
      if (mountedWorkspace === null) {
        return fail(`OCI runtime exec failed: chdir to cwd ("${args[2]}") failed: no such file or directory`, 127)
      }
      try { return ok(readFileSync(path, 'utf8')) } catch { return fail('no such file', 1) }
    }
    if (args.includes('--version')) return versionExit === 0 ? ok('1.18.9') : { code: versionExit, stdout: '', stderr: 'boom' }
    return ok()
  }
  return { cli, calls }
}

describe('preflightDockerSlot — defect 3: an incoherent user/HOME/auth triple is rejected', () => {
  it('rejects credentials mounted at /root while the CLI runs as 1000:1000 with HOME=/home/node', async () => {
    const { cli } = slotDocker({ uid: '1000', gid: '1000', home: '/home/node' })
    const findings = await preflightDockerSlot(target({
      containerUser: '1000:1000',
      containerHome: '/home/node',
      mounts: [{ source: '/host/.config/opencode', target: '/root/.config/opencode', kind: 'bind' }],
    }), 'abcdef1234567890', cli)

    const auth = findings.find((f) => f.check === 'auth-mount-home')
    expect(auth).toBeDefined()
    expect(auth!.detail).toContain('mounted at /root/.config/opencode')
    expect(auth!.detail).toContain('HOME=/home/node, so it never looks there')
    expect(auth!.remedy).toContain('OPENCODE_DOCKER_CONTAINER_CONFIG_DIR')
  })

  it('rejects a HOME the CLI cannot write, quoting the EACCES the CLI would have hit', async () => {
    const { cli } = slotDocker({
      uid: '1000', gid: '1000', home: '/home/node', homeWritable: false,
    })
    const findings = await preflightDockerSlot(target({
      containerUser: '1000:1000',
      containerHome: '/home/node',
      mounts: [{ source: '/host/oc', target: '/home/node/.local/share/opencode', kind: 'bind' }],
    }), 'abcdef1234567890', cli)

    const writable = findings.find((f) => f.check === 'home-writable')
    expect(writable).toBeDefined()
    expect(writable!.detail).toContain("mkdir: cannot create directory '/home/node/.local/state': Permission denied")
    expect(writable!.remedy).toContain('pnpm run docker:build:runtime')
  })

  it('rejects a container whose actual identity or HOME disagrees with the configuration', async () => {
    const { cli } = slotDocker({ uid: '0', gid: '0', home: '/root' })
    const findings = await preflightDockerSlot(target({
      containerUser: '1000:1000', containerHome: '/home/node',
      mounts: [{ source: '/host/oc', target: '/home/node/.config/opencode', kind: 'bind' }],
    }), 'abcdef1234567890', cli)
    expect(findings.map((f) => f.check)).toContain('container-user')
    expect(findings.map((f) => f.check)).toContain('container-home')
  })

  it('rejects a credential mount the CLI user cannot read', async () => {
    const { cli } = slotDocker({ uid: '1000', gid: '1000', home: '/home/node', readableTargets: [] })
    const findings = await preflightDockerSlot(target({
      containerUser: '1000:1000', containerHome: '/home/node',
      mounts: [{ source: '/host/oc', target: '/home/node/.config/opencode', kind: 'bind' }],
    }), 'abcdef1234567890', cli)
    expect(findings.map((f) => f.check)).toContain('auth-mount-readable')
  })
})

describe('preflightDockerSlot — defect 4 at startup: a configured workspace must be MOUNTED', () => {
  it('rejects a workspace root that is configured but not mounted, and says why 127 lied', async () => {
    const workspace = tempDir('cli-bridge-preflight-ws-')
    const { cli } = slotDocker({ mountedWorkspace: null })
    const findings = await preflightDockerSlot(target({ workspaceRoot: workspace }), 'abcdef1234567890', cli)

    const mounted = findings.find((f) => f.check === 'workspace-mounted')
    expect(mounted).toBeDefined()
    expect(mounted!.detail).toContain('is NOT mounted into the pool container at that path')
    expect(mounted!.detail).toContain('the same status as "command not found"')
  })

  it('passes when the bind is live, proven by a marker round-trip, and leaves no marker behind', async () => {
    const workspace = tempDir('cli-bridge-preflight-ws-ok-')
    const { cli, calls } = slotDocker({ mountedWorkspace: workspace })
    const findings = await preflightDockerSlot(target({ workspaceRoot: workspace }), 'abcdef1234567890', cli)

    expect(findings).toEqual([])
    // The trivial exec ran in the workdir the executor will actually use.
    const versionCall = calls.find((c) => c.includes('--version'))
    expect(versionCall).toBeDefined()
    expect(versionCall!.slice(1, 3)).toEqual(['--workdir', workspace])
    // No preflight marker may survive in the operator's workspace.
    expect(readdirSync(workspace)).toEqual([])
  })

  it('rejects a container image whose CLI is absent, naming the rebuild', async () => {
    const { cli } = slotDocker({ binaryPath: null })
    const findings = await preflightDockerSlot(target(), 'abcdef1234567890', cli)
    const bin = findings.find((f) => f.check === 'cli-binary')
    expect(bin).toBeDefined()
    expect(bin!.remedy).toContain('pnpm run docker:build:runtime')
  })

  it('refuses to report ready unless a trivial command actually executed', async () => {
    const { cli } = slotDocker({ versionExit: 1 })
    const findings = await preflightDockerSlot(target(), 'abcdef1234567890', cli)
    expect(findings.map((f) => f.check)).toEqual(['trivial-exec'])
    expect(findings[0]!.detail).toContain('`opencode --version` failed inside the pool container')
  })

  it('passes a fully coherent root-user configuration', async () => {
    const { cli } = slotDocker()
    expect(await preflightDockerSlot(target(), 'abcdef1234567890', cli)).toEqual([])
  })
})

describe('the runtime image the Dockerfile promises', () => {
  it('pre-creates the non-root XDG tree, so a uid-1000 CLI has somewhere to put state', () => {
    const dockerfile = readFileSync(join(__dirname, '..', 'docker', 'Dockerfile.cli-runtime'), 'utf8')
    for (const dir of [
      '/home/node/.local/state',
      '/home/node/.local/share',
      '/home/node/.config',
      '/home/node/.cache',
    ]) {
      expect(dockerfile).toContain(dir)
    }
    expect(dockerfile).toMatch(/chown -R node:node \/home\/node/)
  })
})

describe('preflightDockerSlot — conditions worth saying but not worth refusing over', () => {
  it('warns (does not fail) when the credential mount is empty', async () => {
    // A first run legitimately starts with no credentials, so this must not
    // block startup. It still has to be said: an empty auth mount makes the CLI
    // start, authenticate against nothing, and return an empty completion —
    // which reads as a model problem rather than a missing login.
    const cli: DockerCli = async (args) => {
      const script = args[args.length - 1] ?? ''
      if (script.includes('id -u')) return ok('0\n0\n/root')
      if (script.includes('HOME_WRITABLE')) return ok('HOME_WRITABLE\n')
      if (script.includes('command -v')) return ok('/usr/local/bin/opencode\n')
      if (script.includes('ls -A')) return ok('')           // empty mount
      if (args.includes('--version')) return ok('1.18.9')
      return ok()
    }
    const warnings: string[] = []
    const findings = await preflightDockerSlot(target(), 'abcdef1234567890', cli, warnings)
    expect(findings).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('is EMPTY')
    expect(warnings[0]).toContain('empty completion')
    expect(warnings[0]).toContain('auth login')
  })

  it('stays silent when the credential mount has content', async () => {
    const cli: DockerCli = async (args) => {
      const script = args[args.length - 1] ?? ''
      if (script.includes('id -u')) return ok('0\n0\n/root')
      if (script.includes('HOME_WRITABLE')) return ok('HOME_WRITABLE\n')
      if (script.includes('command -v')) return ok('/usr/local/bin/opencode\n')
      if (script.includes('ls -A')) return ok('auth.json\n')
      if (args.includes('--version')) return ok('1.18.9')
      return ok()
    }
    const warnings: string[] = []
    expect(await preflightDockerSlot(target(), 'abcdef1234567890', cli, warnings)).toEqual([])
    expect(warnings).toEqual([])
  })
})
