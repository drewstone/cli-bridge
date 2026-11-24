/**
 * An operator whose OpenCode login and config live under XDG_DATA_HOME and XDG_CONFIG_HOME.
 *
 * Measured 2026-11-24: with the plan login only at `$XDG_DATA_HOME/opencode/auth.json`, /v1/models
 * (OpenCode's own catalog read, which honors XDG) reported the seat authenticated, yet every
 * fs-jail turn failed with "opencode: Unexpected server error" before any model call. The jail
 * seeded only `$HOME/.local/share/opencode` and `$HOME/.config/opencode`, so OpenCode started
 * inside it with no login.
 *
 * Real bwrap, the real OpencodeBackend and host spawner, and a stand-in opencode installed at
 * OPENCODE_INSTALL_DIR, the root the backend binds into the jail. Inside the jail the stand-in
 * reads its login from `$XDG_DATA_HOME/opencode` and its config from `$XDG_CONFIG_HOME/opencode`,
 * where OpenCode reads them, and reports what it found as an OpenCode JSON event. No model is called.
 */
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OpencodeBackend } from '../src/backends/opencode.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import { hostSpawner } from '../src/executors/host.js'
import { hostRequestJail } from '../src/jail/host-request.js'
import { LinuxBwrapJail } from '../src/jail/linux-bwrap.js'

const XDG_LOGIN = '{"opencode":{"type":"api","key":"plan-key-under-xdg-data-home"}}\n'
const XDG_CONFIG = '{"$schema":"https://opencode.ai/config.json","model":"opencode/from-xdg-config-home"}\n'
const HOME_LOGIN = '{"opencode":{"type":"api","key":"plan-key-under-home"}}\n'
const HOME_CONFIG = '{"$schema":"https://opencode.ai/config.json","model":"opencode/from-home-config"}\n'

interface Found {
  xdgData: string
  xdgConfig: string
  auth: string | null
  config: string | null
  dataEntries: string[] | null
  configEntries: string[] | null
  dataWritable: boolean
  configWritable: boolean
  hostVisible: boolean
}

/** OpenCode's own lookup: `$XDG_DATA_HOME/opencode/auth.json` and `$XDG_CONFIG_HOME/opencode`. */
const standIn = (hostPaths: string[]) => `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
try { fs.readFileSync(0) } catch {}
const read = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return null } }
const list = (dir) => { try { return fs.readdirSync(dir).sort() } catch { return null } }
const write = (file) => { try { fs.writeFileSync(file, 'written in the jail\\n'); return true } catch { return false } }
const data = path.join(process.env.XDG_DATA_HOME, 'opencode'), config = path.join(process.env.XDG_CONFIG_HOME, 'opencode')
const found = {
  xdgData: process.env.XDG_DATA_HOME, xdgConfig: process.env.XDG_CONFIG_HOME,
  auth: read(path.join(data, 'auth.json')), config: read(path.join(config, 'opencode.json')),
  dataEntries: list(data), configEntries: list(config),
}
// OpenCode writes its database beside the login and a .gitignore into its config directory at startup.
found.dataWritable = write(path.join(data, 'opencode.db'))
found.configWritable = write(path.join(config, '.gitignore'))
found.hostVisible = ${JSON.stringify(hostPaths)}.some((p) => fs.existsSync(p))
process.stdout.write(JSON.stringify({ type: 'text', sessionID: 'ses_xdg_login', part: { type: 'text', text: JSON.stringify(found) } }) + '\\n')
`

const ENV_KEYS = ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'OPENCODE_INSTALL_DIR'] as const

describe.skipIf(!new LinuxBwrapJail().isAvailable())('an fs-jailed OpenCode turn finds the login OpenCode finds', () => {
  let root: string
  beforeAll(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'opencode-xdg-login-'))) })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  async function turn(name: string, env: Record<(typeof ENV_KEYS)[number], string>, hostPaths: string[]) {
    const install = join(root, name, 'install'), workspace = join(root, name, 'work')
    await mkdir(join(install, 'bin'), { recursive: true })
    await mkdir(workspace, { recursive: true })
    const bin = join(install, 'bin', 'opencode')
    await writeFile(bin, standIn(hostPaths))
    await chmod(bin, 0o755)
    const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
    Object.assign(process.env, env)
    try {
      const request: ChatRequest = {
        cwd: workspace,
        session_id: `opencode-xdg-${name}`,
        mode: 'byob',
        model: 'opencode',
        messages: [{ role: 'user', content: 'Report the login you found.' }],
      }
      request.jailSpec = hostRequestJail(request, 'opencode',
        { ...process.env, BRIDGE_JAIL_MODE: 'fs-jail', BRIDGE_JAIL_NETWORK: 'none', BRIDGE_JAIL_BACKEND: 'bwrap' })
      expect(request.jailSpec?.readConfine, 'BRIDGE_JAIL_MODE=fs-jail resolves a read-confined host jail').toBe(true)
      const deltas: ChatDelta[] = []
      const backend = new OpencodeBackend({ bin, timeoutMs: 60_000, spawner: hostSpawner })
      for await (const delta of backend.chat(request, null, new AbortController().signal)) deltas.push(delta)
      const failure = deltas.find((delta) => delta.finish_reason === 'error')
      expect(failure, `turn failed: ${JSON.stringify(failure ?? {})}`).toBeUndefined()
      expect(deltas.at(-1)).toMatchObject({ finish_reason: 'stop' })
      const report = deltas.find((delta) => typeof delta.content === 'string')?.content
      expect(report, 'the stand-in reported what it found').toBeTypeOf('string')
      return { found: JSON.parse(report as string) as Found, jailRoot: request.jailSpec!.root }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  it('seeds the login and config from absolute XDG_DATA_HOME and XDG_CONFIG_HOME', async () => {
    const home = join(root, 'xdg', 'home'), xdgData = join(root, 'xdg', 'data'), xdgConfig = join(root, 'xdg', 'config')
    // The login exists only under XDG; $HOME has no OpenCode directories at all.
    await mkdir(home, { recursive: true })
    await mkdir(join(xdgData, 'opencode', 'log'), { recursive: true })
    await mkdir(join(xdgConfig, 'opencode', 'node_modules'), { recursive: true })
    await writeFile(join(xdgData, 'opencode', 'auth.json'), XDG_LOGIN, { mode: 0o600 })
    await writeFile(join(xdgData, 'opencode', 'log', 'host.log'), 'host-only log\n')
    await writeFile(join(xdgConfig, 'opencode', 'opencode.json'), XDG_CONFIG)
    await writeFile(join(xdgConfig, 'opencode', 'package.json'), '{}\n')

    const { found, jailRoot } = await turn('xdg', {
      HOME: home, XDG_DATA_HOME: xdgData, XDG_CONFIG_HOME: xdgConfig, OPENCODE_INSTALL_DIR: join(root, 'xdg', 'install'),
    }, [xdgData, xdgConfig])

    // The confined CLI reads the jail's own XDG directories, not the host's.
    expect(found.xdgData).toBe(join(jailRoot, '.local', 'share'))
    expect(found.xdgConfig).toBe(join(jailRoot, '.config'))
    expect(found.hostVisible, 'the fs-jail hides the host XDG directories').toBe(false)
    expect(found.auth, 'OpenCode finds the operator login inside the jail').toBe(XDG_LOGIN)
    expect(found.config, 'OpenCode finds the operator config inside the jail').toBe(XDG_CONFIG)
    // The seed filters still hold: only the login and the user config surface cross into the jail.
    expect(found.dataEntries).toEqual(['auth.json'])
    expect(found.configEntries).toEqual(['opencode.json'])
    // Both directories are writable seeds, so OpenCode's startup writes land in the jail.
    expect(found.dataWritable).toBe(true)
    expect(found.configWritable).toBe(true)
    expect((await readdir(join(xdgData, 'opencode'))).sort()).toEqual(['auth.json', 'log'])
    expect(existsSync(join(xdgConfig, 'opencode', '.gitignore')), 'the jailed turn never wrote the host config').toBe(false)
  }, 60_000)

  it('ignores relative XDG values and seeds the login from $HOME', async () => {
    const home = join(root, 'relative', 'home')
    await mkdir(join(home, '.local', 'share', 'opencode'), { recursive: true })
    await mkdir(join(home, '.config', 'opencode'), { recursive: true })
    await writeFile(join(home, '.local', 'share', 'opencode', 'auth.json'), HOME_LOGIN, { mode: 0o600 })
    await writeFile(join(home, '.config', 'opencode', 'opencode.json'), HOME_CONFIG)

    // The XDG base directory spec says a relative value is invalid and must be ignored.
    const { found } = await turn('relative', {
      HOME: home, XDG_DATA_HOME: 'opencode-xdg-relative/data', XDG_CONFIG_HOME: 'opencode-xdg-relative/config',
      OPENCODE_INSTALL_DIR: join(root, 'relative', 'install'),
    }, [home])

    expect(found.hostVisible, 'the fs-jail hides the host HOME').toBe(false)
    expect(found.auth).toBe(HOME_LOGIN)
    expect(found.config).toBe(HOME_CONFIG)
  }, 60_000)
})
