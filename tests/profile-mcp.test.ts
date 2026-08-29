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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  materializeMcpServersForOpencode,
  materializeMcpServersForPi,
  materializeMcpServersForKimi,
  materializeOpencodeMcpConfig,
  resolveMcpServers,
} from '../src/backends/profile-support.js'
import type { ChatRequest } from '../src/backends/types.js'

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
  it('writes headless permissions even when no MCP servers are declared', () => {
    const m = materializeOpencodeMcpConfig(null)
    expect(m).not.toBeNull()
    if (!m) return
    expect(m.serverNames).toEqual([])

    const written = JSON.parse(readFileSync(m.configPath, 'utf-8'))
    expect(written.permission).toMatchObject({
      external_directory: 'allow',
      bash: 'allow',
      edit: 'allow',
      read: 'allow',
      write: 'allow',
      webfetch: 'allow',
    })
    expect(written.mcp).toEqual({})
    m.cleanup()
    expect(existsSync(m.configPath)).toBe(false)
  })

  it('honors agent_profile.permissions over the headless allow defaults', () => {
    // The no-web arm sets webfetch:'deny'; it must reach opencode's config,
    // not be overwritten by the hardcoded headless 'allow'.
    const m = materializeOpencodeMcpConfig({
      permissions: { webfetch: 'deny', websearch: 'deny' },
    } as unknown as Parameters<typeof materializeOpencodeMcpConfig>[0])
    expect(m).not.toBeNull()
    if (!m) return
    const written = JSON.parse(readFileSync(m.configPath, 'utf-8'))
    expect(written.permission.webfetch).toBe('deny')
    expect(written.permission.websearch).toBe('deny')
    // untouched keys keep their headless default
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

    it('rejects obsolete plain-string profile values instead of retaining a compatibility path', () => {
      const r = req({
        agent_profile: {
          mcp: { coord: { command: 'tsx', args: ['plain.ts'] } },
        } as unknown as AgentProfile,
      })
      expect(() => resolveMcpServers(r, null)).toThrow()
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

  it('lifts agent_profile.mcp into the selected map (transport → type)', () => {
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

  it('refuses request-body MCP beside an exact agent_profile', () => {
    const r = req({
      agent_profile: {
        mcp: { echo: { command: 'from-profile' } },
      } as AgentProfile,
      mcp: {
        mcpServers: { echo: { command: 'from-body' } },
      },
    })
    expect(() => resolveMcpServers(r, null)).toThrow(
      /request mcp cannot accompany agent_profile/u,
    )
  })

  it('falls back to session.metadata.agent_profile when req.agent_profile is absent', () => {
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
    expect(merged).toEqual({ coord: { command: 'tsx' } })
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
})

describe('materializeMcpServersForOpencode', () => {
  it('writes opencode shape with command-as-array + headless permissions', () => {
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
    expect(written.permission.bash).toBe('allow')
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

describe('materializeMcpServersForKimi', () => {
  it('mounts project-local MCP and restores the original file', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cb-kimi-mcp-'))
    const configDir = join(cwd, '.kimi-code')
    const configPath = join(configDir, 'mcp.json')
    const original = JSON.stringify({
      settings: { source: 'project' },
      mcpServers: { project: { command: 'project-cmd' } },
    })
    try {
      mkdirSync(configDir)
      writeFileSync(configPath, original)
      const mounted = materializeMcpServersForKimi(
        { request: { command: 'request-cmd', args: ['--check'] } },
        cwd,
      )
      expect(mounted).not.toBeNull()
      if (!mounted) return
      expect(mounted.configPath).toBe(configPath)
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
        settings: { source: 'project' },
        mcpServers: {
          project: { command: 'project-cmd' },
          request: { command: 'request-cmd', args: ['--check'] },
        },
      })
      mounted.cleanup()
      expect(readFileSync(configPath, 'utf8')).toBe(original)
      expect(existsSync(`${configPath}.lock`)).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns null without creating project config for an empty map', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cb-kimi-mcp-'))
    try {
      expect(materializeMcpServersForKimi({ disabled: { command: 'x', enabled: false } }, cwd)).toBeNull()
      expect(existsSync(join(cwd, '.kimi-code'))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
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
