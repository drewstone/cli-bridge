/**
 * Unit tests for `materialiseMcpConfig` + `buildMcpAllowList` in
 * profile-support.ts. Verifies:
 *
 *   - profiles without `.mcp` produce null (no temp file written)
 *   - explicitly disabled servers (enabled: false) are dropped
 *   - servers without `command` (remote http/sse) are dropped — local
 *     CLIs only support stdio MCP via --mcp-config
 *   - the produced JSON matches claude/kimi's expected
 *     `{ mcpServers: { name: { command, args, env } } }` shape
 *   - `cleanup()` is idempotent and removes the temp dir
 *   - allow-list builder produces the `mcp__<server>` glob format
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentProfile } from '@tangle-network/sandbox'
import {
  buildMcpAllowList,
  isStdioMcpSpec,
  materialiseMcpConfig,
  materialiseMcpServersForClaudeKimi,
  materialiseMcpServersForCodex,
  materialiseMcpServersForOpencode,
  materialiseOpencodeMcpConfig,
  resolveMcpServers,
} from '../src/backends/profile-support.js'
import type { ChatRequest } from '../src/backends/types.js'

describe('materialiseMcpConfig', () => {
  it('returns null when the profile has no mcp section', () => {
    expect(materialiseMcpConfig(null)).toBeNull()
    expect(materialiseMcpConfig({} as AgentProfile)).toBeNull()
    expect(materialiseMcpConfig({ name: 'p' } as AgentProfile)).toBeNull()
  })

  it('returns null when every entry is filtered out (disabled or remote)', () => {
    const profile: AgentProfile = {
      mcp: {
        'remote-http': { transport: 'http', url: 'https://example.com/mcp' },
        'disabled-stdio': { command: '/usr/bin/foo', enabled: false },
      },
    }
    expect(materialiseMcpConfig(profile)).toBeNull()
  })

  it('writes a claude/kimi-shaped mcp-config.json for stdio servers', () => {
    const profile: AgentProfile = {
      mcp: {
        coordinator: {
          command: 'tsx',
          args: ['/absolute/path/coordinator-mcp.ts'],
          env: { OUTDIR: '/tmp/x', SCENARIO: 'foo' },
        },
        // Mixed in a disabled entry to confirm it doesn't leak.
        ignored: { command: 'echo', enabled: false },
      },
    }
    const m = materialiseMcpConfig(profile)
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
      mcp: { foo: { command: 'tsx', args: ['x.ts'] } },
    }
    const m = materialiseMcpConfig(profile)
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
    const m = materialiseMcpConfig(profile)
    expect(m).not.toBeNull()
    if (!m) return
    expect(m.serverNames).toEqual(['good'])
    m.cleanup()
  })
})

describe('materialiseOpencodeMcpConfig', () => {
  it('writes headless permissions even when no MCP servers are declared', () => {
    const m = materialiseOpencodeMcpConfig(null)
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
          coord: { transport: 'stdio', command: 'tsx', args: ['c.ts'] },
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

describe('materialiseMcpServersForClaudeKimi', () => {
  it('writes the canonical {mcpServers:{...}} JSON shape', () => {
    const m = materialiseMcpServersForClaudeKimi({
      echo: { command: 'node', args: ['./echo.js'], env: { FOO: 'bar' }, timeout: 5000 },
      remote: { type: 'http', url: 'https://example.com' }, // dropped
    })
    expect(m).not.toBeNull()
    if (!m) return
    expect(m.serverNames).toEqual(['echo'])
    const written = JSON.parse(readFileSync(m.configPath, 'utf-8'))
    expect(written).toEqual({
      mcpServers: {
        echo: { command: 'node', args: ['./echo.js'], env: { FOO: 'bar' }, timeout: 5000 },
      },
    })
    m.cleanup()
    expect(existsSync(m.configPath)).toBe(false)
  })

  it('returns null when given a null map (no entries at all)', () => {
    expect(materialiseMcpServersForClaudeKimi(null)).toBeNull()
  })
})

describe('materialiseMcpServersForOpencode', () => {
  it('writes opencode shape with command-as-array + headless permissions', () => {
    const m = materialiseMcpServersForOpencode({
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
    const m = materialiseMcpServersForOpencode(null)
    expect(m.serverNames).toEqual([])
    const written = JSON.parse(readFileSync(m.configPath, 'utf-8'))
    expect(written.mcp).toEqual({})
    m.cleanup()
  })
})

describe('materialiseMcpServersForCodex', () => {
  it('writes a TOML config.toml with stdio servers under [mcp_servers.<name>]', () => {
    const m = materialiseMcpServersForCodex({
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
    const m = materialiseMcpServersForCodex({
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
      const m = materialiseMcpServersForCodex(
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
    expect(materialiseMcpServersForCodex(null)).toBeNull()
  })

  it('skips names that would require TOML key quoting (defence-in-depth)', () => {
    const m = materialiseMcpServersForCodex({
      'has space': { command: 'tsx' },
      'good-name': { command: 'tsx' },
    })
    expect(m).not.toBeNull()
    if (!m) return
    expect(m.serverNames).toEqual(['good-name'])
    m.cleanup()
  })
})
