/**
 * Unit tests for `materializeMcpConfig` + `buildMcpAllowList` in
 * profile-support.ts. Verifies:
 *
 *   - profiles without `.mcp` produce null (no temp file written)
 *   - explicitly disabled servers (enabled: false) are dropped
 *   - claude/kimi materialization preserves stdio MCP servers and drops
 *     remote http/sse servers from their shared `mcp-config.json` shape
 *   - the produced JSON matches claude/kimi's expected
 *     `{ mcpServers: { name: { command, args, env } } }` shape
 *   - `cleanup()` is idempotent and removes the temp dir
 *   - allow-list builder produces the `mcp__<server>` glob format
 */

import { describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  defineAgentProfilePublicConfig as pub,
  defineAgentProfileSecretRef as secretRef,
} from '@tangle-network/agent-interface'
import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  buildMcpAllowList,
  isStdioMcpSpec,
  materializeMcpConfig,
  writeMcpConfigFile,
  materializeMcpServersForCodex,
  materializeMcpServersForFactory,
  materializeMcpServersForOpencode,
  materializeMcpServersForPi,
  materializeOpencodeMcpConfig,
  reapStalePiMcpConfigs,
  resolveMcpServers,
} from '../src/backends/profile-support.js'
import type { ChatRequest } from '../src/backends/types.js'

async function childResult(child: ReturnType<typeof spawn>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => { stdout += chunk.toString() })
  child.stderr?.on('data', chunk => { stderr += chunk.toString() })
  const code = await new Promise<number | null>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode)
      return
    }
    child.once('error', reject)
    child.once('exit', resolve)
  })
  return { code, stdout, stderr }
}

describe('materializeMcpConfig', () => {
  it('returns null when the profile has no mcp section', () => {
    expect(materializeMcpConfig(null)).toBeNull()
    expect(materializeMcpConfig({} as AgentProfile)).toBeNull()
    expect(materializeMcpConfig({ name: 'p' } as AgentProfile)).toBeNull()
  })

  it('returns null when every entry is filtered out', () => {
    const profile: AgentProfile = {
      mcp: {
        'disabled-stdio': { enabled: false },
      },
    }
    expect(materializeMcpConfig(profile)).toBeNull()
  })

  it('writes a claude/kimi-shaped mcp-config.json for stdio servers', () => {
    const profile: AgentProfile = {
      mcp: {
        coordinator: {
          command: 'tsx',
          args: [pub('/absolute/path/coordinator-mcp.ts')],
          env: { OUTDIR: pub('/tmp/x'), SCENARIO: pub('foo') },
        },
        // Mixed in a disabled entry to confirm it doesn't leak.
        ignored: { enabled: false },
      },
    }
    const m = materializeMcpConfig(profile)
    expect(m).not.toBeNull()
    if (!m) return
    expect(m.serverNames).toEqual(['coordinator'])
    const written = JSON.parse(readFileSync(m.configPath, 'utf-8'))
    expect(written).toEqual({
      mcpServers: {
        coordinator: {
          command: 'tsx',
          args: ['/absolute/path/coordinator-mcp.ts'],
          env: { OUTDIR: '/tmp/x', SCENARIO: 'foo' },
        },
      },
    })
    expect(statSync(dirname(m.configPath)).mode & 0o777).toBe(0o700)
    expect(statSync(m.configPath).mode & 0o777).toBe(0o600)
    m.cleanup()
    expect(existsSync(m.configPath)).toBe(false)
  })

  it('cleanup() is idempotent — second call must not throw even if the dir is gone', () => {
    const profile: AgentProfile = {
      mcp: { foo: { command: 'tsx', args: [pub('x.ts')] } },
    }
    const m = materializeMcpConfig(profile)
    expect(m).not.toBeNull()
    if (!m) return
    m.cleanup()
    expect(() => m.cleanup()).not.toThrow()
  })

  it('drops malformed entries silently rather than throwing', () => {
    const profile = {
      mcp: {
        'no-command': { args: ['x'] },
        'bad-command-type': { command: 123 as never },
        'string-instead-of-object': 'oops' as never,
        'good': { command: 'tsx', args: ['x.ts'] },
      },
    } as unknown as AgentProfile
    const m = materializeMcpConfig(profile)
    expect(m).not.toBeNull()
    if (!m) return
    expect(m.serverNames).toEqual(['good'])
    m.cleanup()
  })
})

describe('materializeOpencodeMcpConfig', () => {
  it('denies one-shot permissions by default even when no MCP servers are declared', () => {
    const m = materializeOpencodeMcpConfig(null)
    expect(m).not.toBeNull()
    if (!m) return
    expect(m.serverNames).toEqual([])

    const written = JSON.parse(readFileSync(m.configPath, 'utf-8'))
    expect(written.permission).toMatchObject({
      external_directory: 'deny',
      bash: 'deny',
      edit: 'deny',
      read: 'deny',
      write: 'deny',
      webfetch: 'deny',
    })
    expect(written.mcp).toEqual({})
    m.cleanup()
    expect(existsSync(m.configPath)).toBe(false)
  })

  it('honors profile restrictions without widening the one-shot default', () => {
    // The no-web arm sets webfetch:'deny'; it must reach opencode's config.
    const m = materializeOpencodeMcpConfig({
      permissions: { webfetch: 'deny', websearch: 'deny' },
    } as unknown as Parameters<typeof materializeOpencodeMcpConfig>[0])
    expect(m).not.toBeNull()
    if (!m) return
    const written = JSON.parse(readFileSync(m.configPath, 'utf-8'))
    expect(written.permission.webfetch).toBe('deny')
    expect(written.permission.websearch).toBe('deny')
    // untouched keys keep the fail-closed one-shot default
    expect(written.permission.bash).toBe('deny')
    m.cleanup()
  })

  it('writes allow only for the explicit named unattended profile policy', () => {
    const m = materializeOpencodeMcpConfig({
      metadata: { cliBridge: { interactionPolicy: 'unattended-allow-v1' } },
    } as unknown as Parameters<typeof materializeOpencodeMcpConfig>[0])
    const written = JSON.parse(readFileSync(m.configPath, 'utf-8'))
    expect(written.permission.bash).toBe('allow')
    m.cleanup()
  })
})

describe('buildMcpAllowList', () => {
  it('formats each name as mcp__<name> joined by commas', () => {
    expect(buildMcpAllowList(['coordinator'])).toBe('mcp__coordinator')
    expect(buildMcpAllowList(['a', 'b', 'c'])).toBe('mcp__a,mcp__b,mcp__c')
  })

  it('returns empty string for an empty list (caller must guard)', () => {
    expect(buildMcpAllowList([])).toBe('')
  })
})

describe('resolveMcpServers', () => {
  function req(overrides: Partial<ChatRequest>): ChatRequest {
    return {
      model: 'claude/sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      ...overrides,
    }
  }

  // These are the canary for the whole reason secret-refs are refused rather than rendered: an MCP
  // server's `args` become argv, which every process on the host can read through
  // /proc/<pid>/cmdline, outside every redaction channel. cli-bridge holds no secret provider, so
  // there is no correct way to resolve one here — only a loud refusal. Before this, a non-string
  // was silently dropped, which truncated the command line and spawned a broken server quietly.
  describe('secret-ref refusal', () => {
    it('refuses a secret-ref in profile mcp args, naming the key and never a value', () => {
      const r = req({
        agent_profile: {
          mcp: { coord: { command: 'tsx', args: [secretRef('COORD_TOKEN')] } },
        } as AgentProfile,
      })
      expect(() => resolveMcpServers(r, null)).toThrow(/secret-ref/)
      expect(() => resolveMcpServers(r, null)).toThrow(/COORD_TOKEN/)
    })

    it('refuses a secret-ref in profile mcp env', () => {
      const r = req({
        agent_profile: {
          mcp: { coord: { command: 'tsx', env: { TOKEN: secretRef('ENV_TOKEN') } } },
        } as AgentProfile,
      })
      expect(() => resolveMcpServers(r, null)).toThrow(/ENV_TOKEN/)
    })

    it('refuses a secret-ref in profile mcp headers', () => {
      const r = req({
        agent_profile: {
          mcp: { remote: { url: 'https://x/sse', headers: { Auth: secretRef('HDR_TOKEN') } } },
        } as AgentProfile,
      })
      expect(() => resolveMcpServers(r, null)).toThrow(/HDR_TOKEN/)
    })

    // The request body WINS over the profile on a name collision, so it decides the bytes that
    // reach argv. It must refuse for the same reason — this path used to drop silently.
    it('refuses a secret-ref in request-body mcpServers args', () => {
      const r = req({
        mcp: {
          mcpServers: {
            coord: { command: 'tsx', args: [secretRef('BODY_TOKEN') as unknown as string] },
          },
        },
      } as Partial<ChatRequest>)
      expect(() => resolveMcpServers(r, null)).toThrow(/BODY_TOKEN/)
    })

    it('refuses before materializeMcpConfig writes anything', () => {
      expect(() =>
        materializeMcpConfig({
          mcp: { coord: { command: 'tsx', args: [secretRef('NO_WRITE')] } },
        } as AgentProfile),
      ).toThrow(/NO_WRITE/)
    })

    it('still accepts plain pre-0.40 strings, so mid-migration profiles keep working', () => {
      const r = req({
        agent_profile: {
          mcp: { coord: { command: 'tsx', args: ['plain.ts'] } },
        } as unknown as AgentProfile,
      })
      expect(resolveMcpServers(r, null)?.coord?.args).toEqual(['plain.ts'])
    })
  })

  it('returns null when neither source supplies entries', () => {
    expect(resolveMcpServers(req({}), null)).toBeNull()
  })

  it('lifts request-body mcp.mcpServers into the merged map', () => {
    const r = req({
      mcp: {
        mcpServers: {
          echo: { command: 'node', args: ['./echo.js'] },
        },
      },
    })
    const merged = resolveMcpServers(r, null)
    expect(merged).toEqual({ echo: { command: 'node', args: ['./echo.js'] } })
  })

  it('lifts agent_profile.mcp into the merged map (transport → type)', () => {
    const r = req({
      agent_profile: {
        mcp: {
          coord: { transport: 'stdio', command: 'tsx', args: [pub('c.ts')] },
        },
      } as AgentProfile,
    })
    const merged = resolveMcpServers(r, null)
    expect(merged).toEqual({ coord: { type: 'stdio', command: 'tsx', args: ['c.ts'] } })
  })

  it('request-body wins on name collision with agent_profile.mcp', () => {
    const r = req({
      agent_profile: {
        mcp: { echo: { command: 'from-profile' } },
      } as AgentProfile,
      mcp: {
        mcpServers: { echo: { command: 'from-body' } },
      },
    })
    const merged = resolveMcpServers(r, null)
    expect(merged).toEqual({ echo: { command: 'from-body' } })
  })

  it('never executes an AgentProfile copied from durable legacy session metadata', () => {
    const merged = resolveMcpServers(
      req({}),
      {
        externalId: 'sess',
        backend: 'claude',
        internalId: 'int',
        cwd: null,
        metadata: {
          agent_profile: { mcp: { coord: { command: 'tsx' } } },
        },
      } as never,
    )
    expect(merged).toBeNull()
  })
})

describe('isStdioMcpSpec', () => {
  it('classifies entries with a command but no explicit type as stdio', () => {
    expect(isStdioMcpSpec({ command: 'tsx' })).toBe(true)
  })

  it('honours explicit type=stdio + requires command', () => {
    expect(isStdioMcpSpec({ type: 'stdio', command: 'tsx' })).toBe(true)
    expect(isStdioMcpSpec({ type: 'stdio' })).toBe(false)
  })

  it('rejects http/sse transports — not loadable via mcp-config.json', () => {
    expect(isStdioMcpSpec({ type: 'http', url: 'https://x' })).toBe(false)
    expect(isStdioMcpSpec({ type: 'sse', url: 'https://x' })).toBe(false)
  })

  it('rejects entries explicitly disabled', () => {
    expect(isStdioMcpSpec({ command: 'tsx', enabled: false })).toBe(false)
  })
})

describe('writeMcpConfigFile', () => {
  it('writes the canonical {mcpServers:{...}} JSON shape with stdio + remote servers', () => {
    const m = writeMcpConfigFile({
      echo: { command: 'node', args: ['./echo.js'], env: { FOO: 'bar' }, timeout: 5000 },
      remote: { type: 'http', url: 'https://example.com', headers: { Authorization: 'Bearer X' } },
    })
    expect(m).not.toBeNull()
    if (!m) return
    // stdio servers AND remote http/sse servers are both forwarded — Claude Code
    // (and kimi-code) load remote MCP from --mcp-config natively.
    expect(m.serverNames).toEqual(['echo', 'remote'])
    const written = JSON.parse(readFileSync(m.configPath, 'utf-8'))
    expect(written).toEqual({
      mcpServers: {
        echo: { command: 'node', args: ['./echo.js'], env: { FOO: 'bar' }, timeout: 5000 },
        remote: { type: 'http', url: 'https://example.com', headers: { Authorization: 'Bearer X' } },
      },
    })
    m.cleanup()
    expect(existsSync(m.configPath)).toBe(false)
  })

  it('returns null when given a null map (no entries at all)', () => {
    expect(writeMcpConfigFile(null)).toBeNull()
  })

  it('reaps generic, opencode, and codex credential roots after SIGKILL', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const os = require('node:os') as typeof import('node:os')
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'cb-private-config-crash-'))
    const marker = join(dir, 'roots.json')
    try {
      const isolatedTmp = join(dir, 'tmp')
      const isolatedHome = join(dir, 'home')
      const reaperMarker = join(dir, 'reaped.txt')
      fs.mkdirSync(isolatedTmp, { mode: 0o700 })
      fs.mkdirSync(isolatedHome, { mode: 0o700 })
      const isolatedEnv = {
        ...process.env,
        HOME: isolatedHome,
        TMPDIR: isolatedTmp,
        TMP: isolatedTmp,
        TEMP: isolatedTmp,
      }
      const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
      const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'backends', 'profile-support.ts')).href
      const reaperUrl = pathToFileURL(join(process.cwd(), 'src', 'runtime', 'private-temporary.ts')).href
      const source = [
        `import { writeMcpConfigFile, materializeMcpServersForOpencode, materializeMcpServersForCodex } from ${JSON.stringify(moduleUrl)}`,
        `import { existsSync, writeFileSync } from 'node:fs'`,
        `import { dirname } from 'node:path'`,
        `const generic = writeMcpConfigFile({ remote: { type: 'http', url: 'https://mcp.example.test', headers: { Authorization: 'Bearer generic-secret' } } })`,
        `const opencode = materializeMcpServersForOpencode({ remote: { type: 'http', url: 'https://mcp.example.test', headers: { Authorization: 'Bearer opencode-secret' } } })`,
        `const codex = materializeMcpServersForCodex({ remote: { type: 'http', url: 'https://mcp.example.test', headers: { Authorization: 'Bearer codex-secret' } } })`,
        `if (!generic || !codex) throw new Error('fixture did not materialize')`,
        `writeFileSync(${JSON.stringify(marker)}, JSON.stringify([dirname(generic.configPath), dirname(opencode.configPath), codex.homePath]))`,
        `process.kill(process.pid, 'SIGKILL')`,
      ].join(';')
      const child = spawnSync(process.execPath, [tsx, '-e', source], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: isolatedEnv,
      })
      expect(child.status).not.toBe(0)
      const roots = JSON.parse(readFileSync(marker, 'utf8')) as string[]
      expect(roots).toHaveLength(3)
      for (const root of roots) {
        expect(existsSync(root)).toBe(true)
        expect(statSync(root).mode & 0o777).toBe(0o700)
      }
      const reaper = spawnSync(process.execPath, [
        tsx,
        '-e',
        `import { writeFileSync } from 'node:fs'; import { reapStalePrivateTemporaryRoots } from ${JSON.stringify(reaperUrl)}; writeFileSync(${JSON.stringify(reaperMarker)}, String(reapStalePrivateTemporaryRoots()))`,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: isolatedEnv,
      })
      expect(reaper.status, reaper.stderr).toBe(0)
      expect(Number(readFileSync(reaperMarker, 'utf8'))).toBeGreaterThanOrEqual(3)
      for (const root of roots) expect(existsSync(root)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('private temporary ownership records', () => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'runtime', 'private-temporary.ts')).href

  function registryPath(isolatedTmp: string): string {
    const owner = typeof process.getuid === 'function' ? process.getuid() : 'user'
    return join(isolatedTmp, `cli-bridge-private-temp-registry-${owner}`)
  }

  function reap(isolatedEnv: NodeJS.ProcessEnv): number {
    const result = spawnSync(process.execPath, [tsx, '-e', [
      `import { reapStalePrivateTemporaryRoots } from ${JSON.stringify(moduleUrl)}`,
      `process.stdout.write(String(reapStalePrivateTemporaryRoots()))`,
    ].join(';')], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: isolatedEnv,
    })
    expect(result.status, result.stderr).toBe(0)
    return Number(result.stdout)
  }

  it('keeps the shared registry after cleanup so a parallel creator cannot lose it', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'cb-private-registry-'))
    const isolatedTmp = join(dir, 'tmp')
    const parent = join(dir, 'parent')
    fs.mkdirSync(isolatedTmp)
    fs.mkdirSync(parent)
    const isolatedEnv = { ...process.env, TMPDIR: isolatedTmp, TMP: isolatedTmp, TEMP: isolatedTmp }
    try {
      const source = [
        `import { createPrivateTemporaryRoot } from ${JSON.stringify(moduleUrl)}`,
        `const root = createPrivateTemporaryRoot(${JSON.stringify(parent)}, '.cli-bridge-test-')`,
        `root.cleanup()`,
      ].join(';')
      const child = spawnSync(process.execPath, [tsx, '-e', source], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: isolatedEnv,
      })
      expect(child.status, child.stderr).toBe(0)
      const registry = registryPath(isolatedTmp)
      expect(fs.statSync(registry).isDirectory()).toBe(true)
      expect(fs.readdirSync(registry)).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats a live reused pid with a different birth identity as stale', async () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'cb-private-pid-reuse-'))
    const isolatedTmp = join(dir, 'tmp')
    const parent = join(dir, 'parent')
    const marker = join(dir, 'root')
    fs.mkdirSync(isolatedTmp)
    fs.mkdirSync(parent)
    const isolatedEnv = { ...process.env, TMPDIR: isolatedTmp, TMP: isolatedTmp, TEMP: isolatedTmp }
    const source = [
      `import { writeFileSync } from 'node:fs'`,
      `import { createPrivateTemporaryRoot } from ${JSON.stringify(moduleUrl)}`,
      `void (async () => {`,
      `const root = createPrivateTemporaryRoot(${JSON.stringify(parent)}, '.cli-bridge-test-')`,
      `writeFileSync(${JSON.stringify(marker)}, root.path)`,
      `await new Promise(() => {})`,
      `})().catch(error => { console.error(error); process.exitCode = 1 })`,
    ].join(';')
    const owner = spawn(process.execPath, [tsx, '-e', source], {
      cwd: process.cwd(),
      env: isolatedEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    try {
      const deadline = Date.now() + 5_000
      while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      expect(fs.existsSync(marker)).toBe(true)
      const root = fs.readFileSync(marker, 'utf8')
      const registry = registryPath(isolatedTmp)
      const manifestPath = join(registry, fs.readdirSync(registry).find(name => name.endsWith('.json'))!)
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      manifest.processStart = 'linux:not-the-owner-birth'
      fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 })

      expect(reap(isolatedEnv)).toBe(1)
      expect(fs.existsSync(root)).toBe(false)
      expect(fs.existsSync(manifestPath)).toBe(false)
    } finally {
      owner.kill('SIGKILL')
      await childResult(owner).catch(() => {})
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses cleanup after the registered parent path is replaced', () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'cb-private-parent-swap-'))
    const isolatedTmp = join(dir, 'tmp')
    const parent = join(dir, 'parent')
    const movedParent = join(dir, 'parent-original')
    const marker = join(dir, 'root')
    fs.mkdirSync(isolatedTmp)
    fs.mkdirSync(parent)
    const isolatedEnv = { ...process.env, TMPDIR: isolatedTmp, TMP: isolatedTmp, TEMP: isolatedTmp }
    try {
      const source = [
        `import { writeFileSync } from 'node:fs'`,
        `import { createPrivateTemporaryRoot } from ${JSON.stringify(moduleUrl)}`,
        `const root = createPrivateTemporaryRoot(${JSON.stringify(parent)}, '.cli-bridge-test-')`,
        `writeFileSync(${JSON.stringify(marker)}, root.path)`,
        `process.kill(process.pid, 'SIGKILL')`,
      ].join(';')
      const child = spawnSync(process.execPath, [tsx, '-e', source], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: isolatedEnv,
      })
      expect(child.status).not.toBe(0)
      const originalRoot = fs.readFileSync(marker, 'utf8')
      const movedRoot = join(movedParent, originalRoot.slice(parent.length + 1))
      fs.renameSync(parent, movedParent)
      fs.mkdirSync(parent)
      const registry = registryPath(isolatedTmp)
      const manifestPath = join(registry, fs.readdirSync(registry).find(name => name.endsWith('.json'))!)

      expect(reap(isolatedEnv)).toBe(0)
      expect(fs.existsSync(movedRoot)).toBe(true)
      expect(fs.existsSync(manifestPath)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('materializeMcpServersForOpencode', () => {
  it('writes opencode shape with command-as-array + fail-closed permissions', () => {
    const m = materializeMcpServersForOpencode({
      echo: { command: 'node', args: ['./echo.js'], env: { FOO: 'bar' } },
    })
    expect(m.serverNames).toEqual(['echo'])
    const written = JSON.parse(readFileSync(m.configPath, 'utf-8'))
    expect(written.mcp).toEqual({
      echo: {
        type: 'local',
        command: ['node', './echo.js'],
        environment: { FOO: 'bar' },
        enabled: true,
      },
    })
    expect(written.permission.bash).toBe('deny')
    expect(statSync(dirname(m.configPath)).mode & 0o777).toBe(0o700)
    expect(statSync(m.configPath).mode & 0o777).toBe(0o600)
    m.cleanup()
  })

  it('returns a usable config even when the map is null (permission-only)', () => {
    const m = materializeMcpServersForOpencode(null)
    expect(m.serverNames).toEqual([])
    const written = JSON.parse(readFileSync(m.configPath, 'utf-8'))
    expect(written.mcp).toEqual({})
    m.cleanup()
  })
})

describe('materializeMcpServersForPi', () => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')

  it('writes a request-scoped config under cwd and removes only that config on cleanup', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-'))
    try {
      const m = materializeMcpServersForPi(
        { echo: { command: 'node', args: ['./echo.js'], env: { FOO: 'bar' } } },
        cwd,
      )
      expect(m).not.toBeNull()
      if (!m) return
      expect(m.configPath.startsWith(join(cwd, '.cli-bridge-pi-mcp-'))).toBe(true)
      expect(m.serverNames).toEqual(['echo'])
      expect(statSync(dirname(m.configPath)).mode & 0o777).toBe(0o700)
      expect(statSync(m.configPath).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(m.configPath, 'utf-8'))).toEqual({
        mcpServers: {
          echo: {
            command: 'node',
            args: ['./echo.js'],
            env: { FOO: 'bar' },
            directTools: true,
          },
        },
      })
      expect(existsSync(join(cwd, '.pi', 'mcp.json'))).toBe(false)
      m.cleanup()
      m.cleanup()
      expect(existsSync(m.configPath)).toBe(false)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reaps a private credential file left by SIGKILL', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-crash-'))
    const marker = join(cwd, 'config-path.txt')
    try {
      const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
      const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'backends', 'profile-support.ts')).href
      const source = [
        `import { materializeMcpServersForPi } from ${JSON.stringify(moduleUrl)}`,
        `import { writeFileSync } from 'node:fs'`,
        `const mounted = materializeMcpServersForPi({ remote: { type: 'http', url: 'https://mcp.example.test', headers: { Authorization: 'Bearer crash-secret' } } }, ${JSON.stringify(cwd)})`,
        `if (!mounted) throw new Error('fixture did not materialize')`,
        `writeFileSync(${JSON.stringify(marker)}, mounted.configPath)`,
        `process.kill(process.pid, 'SIGKILL')`,
      ].join(';')
      const child = spawnSync(process.execPath, [tsx, '-e', source], {
        cwd: process.cwd(),
        encoding: 'utf8',
      })
      expect(child.status).not.toBe(0)
      const configPath = readFileSync(marker, 'utf8')
      expect(existsSync(configPath)).toBe(true)
      expect(statSync(dirname(configPath)).mode & 0o777).toBe(0o700)
      expect(statSync(configPath).mode & 0o777).toBe(0o600)
      expect(reapStalePiMcpConfigs()).toBeGreaterThanOrEqual(1)
      expect(existsSync(configPath)).toBe(false)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('isolates overlapping Pi configs in one cwd', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-'))
    try {
      const alpha = materializeMcpServersForPi({ alpha: { command: 'a-cmd' } }, cwd)
      const beta = materializeMcpServersForPi({ beta: { command: 'b-cmd' } }, cwd)
      expect(alpha).not.toBeNull()
      expect(beta).not.toBeNull()
      if (!alpha || !beta) return
      expect(alpha.configPath).not.toBe(beta.configPath)
      expect(Object.keys(JSON.parse(readFileSync(alpha.configPath, 'utf-8')).mcpServers)).toEqual([
        'alpha',
      ])
      expect(Object.keys(JSON.parse(readFileSync(beta.configPath, 'utf-8')).mcpServers)).toEqual([
        'beta',
      ])

      alpha.cleanup()
      expect(existsSync(alpha.configPath)).toBe(false)
      expect(existsSync(beta.configPath)).toBe(true)
      beta.cleanup()
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('hardens Pi stdio children with an env -i boundary and rejects secret-shaped vars', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-'))
    try {
      const m = materializeMcpServersForPi({ safe: { command: 'node', args: ['server.js'], env: { MODE: 'test' } } }, cwd, { isolateChildren: true })
      expect(m).not.toBeNull()
      const server = JSON.parse(readFileSync(m!.configPath, 'utf8')).mcpServers.safe
      expect(server.command).toBe('/usr/bin/env')
      expect(server.env).toBeUndefined()
      expect(server.args).toContain('MODE=test')
      expect(server.args).toContain('--')
      expect(server.args.at(-2)).toBe('node')
      expect(server.args.at(-1)).toBe('server.js')
      expect(server.args.some((arg: string) => arg.includes('API_KEY') || arg.includes('TOKEN'))).toBe(false)
      m!.cleanup()
      expect(() => materializeMcpServersForPi({ unsafe: { command: 'node', env: { API_TOKEN: 'secret' } } }, cwd, { isolateChildren: true })).toThrow(/secret-shaped/u)
      expect(() => materializeMcpServersForPi({ unsafe: { command: 'node', env: { HOME: '/home/drew' } } }, cwd, { isolateChildren: true })).toThrow(/cannot override isolated environment key.*HOME/u)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('does not read or mutate the project .pi/mcp.json', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-'))
    const projectConfig = join(cwd, '.pi', 'mcp.json')
    try {
      fs.mkdirSync(join(cwd, '.pi'))
      const original = JSON.stringify({ mcpServers: { project: { command: 'project-cmd' } } })
      fs.writeFileSync(projectConfig, original)
      const m = materializeMcpServersForPi({ request: { command: 'request-cmd' } }, cwd)
      expect(m).not.toBeNull()
      expect(readFileSync(projectConfig, 'utf-8')).toBe(original)
      m?.cleanup()
      expect(readFileSync(projectConfig, 'utf-8')).toBe(original)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns null without creating files when no usable server exists', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-'))
    try {
      expect(materializeMcpServersForPi(null, cwd)).toBeNull()
      expect(materializeMcpServersForPi({ off: { command: 'x', enabled: false } }, cwd)).toBeNull()
      expect(fs.readdirSync(cwd)).toEqual([])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('cwd-native MCP lock ownership', () => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'backends', 'profile-support.ts')).href

  it('admits exactly one of two simultaneous first mounts', async () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-cwd-lock-race-'))
    const barrier = join(cwd, 'go')
    try {
      const source = [
        `import { existsSync, writeFileSync } from 'node:fs'`,
        `import { materializeMcpServersForFactory } from ${JSON.stringify(moduleUrl)}`,
        `void (async () => {`,
        `writeFileSync(${JSON.stringify(join(cwd, 'ready-'))} + process.pid, '')`,
        `while (!existsSync(${JSON.stringify(barrier)})) await new Promise(resolve => setTimeout(resolve, 5))`,
        `try { const mounted = materializeMcpServersForFactory({ echo: { command: 'echo' } }, ${JSON.stringify(cwd)}); process.stdout.write('acquired'); await new Promise(resolve => setTimeout(resolve, 300)); mounted?.cleanup() } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2 }`,
        `})().catch(error => { console.error(error); process.exitCode = 1 })`,
      ].join(';')
      const first = spawn(process.execPath, [tsx, '-e', source], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
      const second = spawn(process.execPath, [tsx, '-e', source], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
      const deadline = Date.now() + 5_000
      while (fs.readdirSync(cwd).filter(name => name.startsWith('ready-')).length < 2 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(fs.readdirSync(cwd).filter(name => name.startsWith('ready-'))).toHaveLength(2)
      fs.writeFileSync(barrier, '')
      const results = await Promise.all([childResult(first), childResult(second)])
      expect(results.filter(result => result.code === 0)).toHaveLength(1)
      expect(results.filter(result => result.code === 2)).toHaveLength(1)
      expect(results.find(result => result.code === 2)?.stderr).toMatch(/another run.*holds the mount/u)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('recovers the exact original config after a lock owner is SIGKILLed', async () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-cwd-lock-crash-'))
    const factoryDir = join(cwd, '.factory')
    const configPath = join(factoryDir, 'mcp.json')
    const ready = join(cwd, 'ready')
    const crash = join(cwd, 'crash')
    fs.mkdirSync(factoryDir)
    fs.writeFileSync(configPath, '{"keep":true}\n', { mode: 0o640 })
    try {
      const source = [
        `import { existsSync, writeFileSync } from 'node:fs'`,
        `import { materializeMcpServersForFactory } from ${JSON.stringify(moduleUrl)}`,
        `void (async () => {`,
        `const mounted = materializeMcpServersForFactory({ crash: { command: 'crash-cmd' } }, ${JSON.stringify(cwd)})`,
        `if (!mounted) throw new Error('fixture did not mount')`,
        `writeFileSync(${JSON.stringify(ready)}, '')`,
        `while (!existsSync(${JSON.stringify(crash)})) await new Promise(resolve => setTimeout(resolve, 5))`,
        `process.kill(process.pid, 'SIGKILL')`,
        `})().catch(error => { console.error(error); process.exitCode = 1 })`,
      ].join(';')
      const owner = spawn(process.execPath, [tsx, '-e', source], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
      const deadline = Date.now() + 5_000
      while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      expect(fs.existsSync(ready)).toBe(true)
      fs.writeFileSync(crash, '')
      await childResult(owner)

      const recovered = materializeMcpServersForFactory({ recovered: { command: 'ok' } }, cwd)
      expect(recovered).not.toBeNull()
      recovered?.cleanup()
      expect(fs.readFileSync(configPath, 'utf8')).toBe('{"keep":true}\n')
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o640)
      expect(fs.existsSync(`${configPath}.lock`)).toBe(false)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('preserves a config edited during the run and keeps the ownership lock', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-cwd-lock-edited-'))
    const factoryDir = join(cwd, '.factory')
    const configPath = join(factoryDir, 'mcp.json')
    fs.mkdirSync(factoryDir)
    fs.writeFileSync(configPath, '{"keep":true}\n', { mode: 0o640 })
    try {
      const mounted = materializeMcpServersForFactory({ temporary: { command: 'temporary' } }, cwd)
      expect(mounted).not.toBeNull()
      fs.writeFileSync(configPath, '{"user":"changed-during-run"}\n', { mode: 0o640 })

      expect(() => mounted?.cleanup()).toThrow(/changed during the run.*preserving/u)
      expect(fs.readFileSync(configPath, 'utf8')).toBe('{"user":"changed-during-run"}\n')
      expect(fs.existsSync(`${configPath}.lock`)).toBe(true)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('preserves a user-recreated file even when its bytes match the mounted config', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-cwd-lock-recreated-'))
    const factoryDir = join(cwd, '.factory')
    const configPath = join(factoryDir, 'mcp.json')
    try {
      const mounted = materializeMcpServersForFactory({ temporary: { command: 'temporary' } }, cwd)
      expect(mounted).not.toBeNull()
      const mountedBytes = fs.readFileSync(configPath, 'utf8')
      fs.rmSync(configPath)
      fs.writeFileSync(configPath, mountedBytes, { mode: 0o600 })

      expect(() => mounted?.cleanup()).toThrow(/changed during the run.*preserving/u)
      expect(fs.readFileSync(configPath, 'utf8')).toBe(mountedBytes)
      expect(fs.existsSync(`${configPath}.lock`)).toBe(true)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('preserves a file replaced after a crashed mount instead of deleting it during stale recovery', async () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-cwd-lock-stale-replaced-'))
    const factoryDir = join(cwd, '.factory')
    const configPath = join(factoryDir, 'mcp.json')
    const ready = join(cwd, 'ready')
    const crash = join(cwd, 'crash')
    try {
      const source = [
        `import { existsSync, writeFileSync } from 'node:fs'`,
        `import { materializeMcpServersForFactory } from ${JSON.stringify(moduleUrl)}`,
        `void (async () => {`,
        `materializeMcpServersForFactory({ crash: { command: 'crash-cmd' } }, ${JSON.stringify(cwd)})`,
        `writeFileSync(${JSON.stringify(ready)}, '')`,
        `while (!existsSync(${JSON.stringify(crash)})) await new Promise(resolve => setTimeout(resolve, 5))`,
        `process.kill(process.pid, 'SIGKILL')`,
        `})().catch(error => { console.error(error); process.exitCode = 1 })`,
      ].join(';')
      const owner = spawn(process.execPath, [tsx, '-e', source], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const deadline = Date.now() + 5_000
      while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      expect(fs.existsSync(ready)).toBe(true)
      fs.writeFileSync(crash, '')
      await childResult(owner)

      fs.rmSync(configPath)
      fs.writeFileSync(configPath, '{"user":"recreated-after-crash"}\n', { mode: 0o600 })
      expect(() => materializeMcpServersForFactory({ next: { command: 'next' } }, cwd))
        .toThrow(/changed after its owner exited.*preserving/u)
      expect(fs.readFileSync(configPath, 'utf8')).toBe('{"user":"recreated-after-crash"}\n')
      expect(fs.existsSync(`${configPath}.lock`)).toBe(true)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('materializeMcpServersForCodex', () => {
  it('writes a TOML config.toml with stdio servers under [mcp_servers.<name>]', () => {
    const m = materializeMcpServersForCodex({
      echo: { command: 'node', args: ['./echo.js'], env: { FOO: 'bar' } },
    })
    expect(m).not.toBeNull()
    if (!m) return
    expect(m.serverNames).toEqual(['echo'])
    const toml = readFileSync(join(m.homePath, 'config.toml'), 'utf-8')
    expect(toml).toContain('[mcp_servers.echo]')
    expect(toml).toContain('command = "node"')
    expect(toml).toContain('args = ["./echo.js"]')
    expect(toml).toContain('env = { FOO = "bar" }')
    expect(statSync(m.homePath).mode & 0o777).toBe(0o700)
    expect(statSync(join(m.homePath, 'config.toml')).mode & 0o777).toBe(0o600)
    m.cleanup()
    expect(existsSync(m.homePath)).toBe(false)
  })

  it('writes streamable-http servers as url + http_headers', () => {
    const m = materializeMcpServersForCodex({
      remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer X' } },
    })
    expect(m).not.toBeNull()
    if (!m) return
    const toml = readFileSync(join(m.homePath, 'config.toml'), 'utf-8')
    expect(toml).toContain('[mcp_servers.remote]')
    expect(toml).toContain('url = "https://mcp.example.com/mcp"')
    expect(toml).toContain('http_headers = { Authorization = "Bearer X" }')
    expect(toml).not.toContain('command =')
    m.cleanup()
  })

  it('copies auth.json from the source path when provided', () => {
    // Synth source auth file.
    const fs = require('node:fs') as typeof import('node:fs')
    const os = require('node:os') as typeof import('node:os')
    const srcDir = fs.mkdtempSync(join(os.tmpdir(), 'cb-codex-auth-src-'))
    const srcAuth = join(srcDir, 'auth.json')
    fs.writeFileSync(srcAuth, '{"token":"test"}')
    try {
      const m = materializeMcpServersForCodex(
        { echo: { command: 'node', args: ['echo.js'] } },
        srcAuth,
      )
      expect(m).not.toBeNull()
      if (!m) return
      const copied = readFileSync(join(m.homePath, 'auth.json'), 'utf-8')
      expect(copied).toBe('{"token":"test"}')
      expect(statSync(join(m.homePath, 'auth.json')).mode & 0o777).toBe(0o600)
      m.cleanup()
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true })
    }
  })

  it('returns null when the map is null', () => {
    expect(materializeMcpServersForCodex(null)).toBeNull()
  })

  it('skips names that would require TOML key quoting (defence-in-depth)', () => {
    const m = materializeMcpServersForCodex({
      'has space': { command: 'tsx' },
      'good-name': { command: 'tsx' },
    })
    expect(m).not.toBeNull()
    if (!m) return
    expect(m.serverNames).toEqual(['good-name'])
    m.cleanup()
  })
})
