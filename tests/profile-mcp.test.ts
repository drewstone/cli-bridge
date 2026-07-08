/**
 * Unit tests for the MCP materializers + `buildMcpAllowList` in
 * profile-support.ts. Verifies:
 *
 *   - explicitly disabled servers (enabled: false) are dropped
 *   - claude/kimi materialization preserves stdio MCP servers and forwards
 *     remote http/sse servers in the shared `mcp-config.json` shape
 *   - the produced JSON matches the expected per-harness shape
 *   - `cleanup()` is idempotent and removes the temp dir
 *   - allow-list builder produces the `mcp__<server>` glob format
 *   - the cwd-native (gemini/factory) + inline (acp) builders emit each
 *     CLI's schema
 */

import { describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  buildAcpMcpServers,
  buildMcpAllowList,
  isStdioMcpSpec,
  writeMcpConfigFile,
  materializeMcpServersForCodex,
  materializeMcpServersForFactory,
  materializeMcpServersForGemini,
  materializeMcpServersForOpencode,
  materializeMcpServersForPi,
  resolveMcpServers,
} from '../src/backends/profile-support.js'
import type { ChatRequest } from '../src/backends/types.js'

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

  it('writes the canonical {mcpServers} shape to <cwd>/.pi/mcp.json and removes it on cleanup', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-'))
    try {
      const m = materializeMcpServersForPi({
        echo: { command: 'node', args: ['./echo.js'], env: { FOO: 'bar' } },
      }, cwd)
      expect(m).not.toBeNull()
      if (!m) return
      expect(m.configPath).toBe(join(cwd, '.pi', 'mcp.json'))
      expect(m.serverNames).toEqual(['echo'])
      const written = JSON.parse(readFileSync(m.configPath, 'utf-8'))
      expect(written).toEqual({
        mcpServers: { echo: { command: 'node', args: ['./echo.js'], env: { FOO: 'bar' } } },
      })
      m.cleanup()
      expect(existsSync(m.configPath)).toBe(false)
      // The run created `.pi`, so cleanup removes it too.
      expect(existsSync(join(cwd, '.pi'))).toBe(false)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('merges into a pre-existing .pi/mcp.json (request wins) and restores original bytes on cleanup', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-'))
    try {
      fs.mkdirSync(join(cwd, '.pi'))
      const originalBytes = JSON.stringify({
        mcpServers: {
          existing: { command: 'existing-cmd' },
          echo: { command: 'stale-should-be-overridden' },
        },
        directTools: ['existing_tool'],
      })
      fs.writeFileSync(join(cwd, '.pi', 'mcp.json'), originalBytes)

      const m = materializeMcpServersForPi({ echo: { command: 'node' } }, cwd)
      expect(m).not.toBeNull()
      if (!m) return
      const written = JSON.parse(readFileSync(m.configPath, 'utf-8'))
      expect(written).toEqual({
        mcpServers: {
          existing: { command: 'existing-cmd' },
          echo: { command: 'node' },
        },
        // Non-mcpServers adapter settings in the original file survive the merge.
        directTools: ['existing_tool'],
      })
      m.cleanup()
      expect(readFileSync(m.configPath, 'utf-8')).toBe(originalBytes)
      expect(existsSync(join(cwd, '.pi'))).toBe(true)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns null when the map is null or every entry filters out', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-'))
    try {
      expect(materializeMcpServersForPi(null, cwd)).toBeNull()
      expect(materializeMcpServersForPi({ off: { command: 'x', enabled: false } }, cwd)).toBeNull()
      // No .pi dir is created for a no-op materialization.
      expect(existsSync(join(cwd, '.pi'))).toBe(false)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects an overlapping mount in the same cwd, allows a new mount after cleanup', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-'))
    try {
      const a = materializeMcpServersForPi({ alpha: { command: 'a-cmd' } }, cwd)
      expect(a).not.toBeNull()
      if (!a) return
      // A live lock (our own pid) blocks any second mount in this cwd —
      // request-scoped servers must never be shared across runs.
      expect(() => materializeMcpServersForPi({ beta: { command: 'b-cmd' } }, cwd))
        .toThrow(/one MCP-mounted run per workspace/)
      const afterReject = JSON.parse(readFileSync(a.configPath, 'utf-8'))
      expect(Object.keys(afterReject.mcpServers)).toEqual(['alpha'])

      a.cleanup()
      expect(existsSync(a.configPath)).toBe(false)
      expect(existsSync(join(cwd, '.pi'))).toBe(false)

      // Sequential reuse of the cwd works once the lock is released.
      const b = materializeMcpServersForPi({ beta: { command: 'b-cmd' } }, cwd)
      expect(b).not.toBeNull()
      b?.cleanup()
      // Double cleanup is a no-op.
      a.cleanup()
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('steals a stale lock left by a dead process', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-'))
    try {
      fs.mkdirSync(join(cwd, '.pi'))
      // PID 2^22-ish beyond pid_max on default Linux — guaranteed dead.
      fs.writeFileSync(join(cwd, '.pi', 'mcp.json.lock'), JSON.stringify({ pid: 3999999 }))
      const m = materializeMcpServersForPi({ echo: { command: 'node' } }, cwd)
      expect(m).not.toBeNull()
      if (!m) return
      const lock = JSON.parse(readFileSync(join(cwd, '.pi', 'mcp.json.lock'), 'utf-8'))
      expect(lock.pid).toBe(process.pid)
      m.cleanup()
      expect(existsSync(join(cwd, '.pi', 'mcp.json.lock'))).toBe(false)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('crash recovery: a dead run\'s leaked config is discarded, not adopted as original', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-'))
    try {
      fs.mkdirSync(join(cwd, '.pi'))
      // Simulate a crashed run: its request-scoped config (with a secret)
      // still on disk, its lock recording that there was NO original file.
      fs.writeFileSync(
        join(cwd, '.pi', 'mcp.json'),
        JSON.stringify({ mcpServers: { leaked: { command: 'x', env: { SECRET: 'dead-run-secret' } } } }),
      )
      fs.writeFileSync(join(cwd, '.pi', 'mcp.json.lock'), JSON.stringify({ pid: 3999999, originalBytes: null }))

      const m = materializeMcpServersForPi({ echo: { command: 'node' } }, cwd)
      expect(m).not.toBeNull()
      if (!m) return
      // The dead run's server must NOT survive into the new mount.
      const written = JSON.parse(readFileSync(m.configPath, 'utf-8'))
      expect(Object.keys(written.mcpServers)).toEqual(['echo'])
      m.cleanup()
      // Rolled-back original was "no file" — cleanup removes the config.
      expect(existsSync(m.configPath)).toBe(false)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('crash recovery: the dead run\'s recorded pre-mount file is restored before remounting', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-'))
    try {
      fs.mkdirSync(join(cwd, '.pi'))
      const trueOriginal = JSON.stringify({ mcpServers: { workspace: { command: 'ws-cmd' } } })
      fs.writeFileSync(
        join(cwd, '.pi', 'mcp.json'),
        JSON.stringify({ mcpServers: { workspace: { command: 'ws-cmd' }, leaked: { command: 'x' } } }),
      )
      fs.writeFileSync(
        join(cwd, '.pi', 'mcp.json.lock'),
        JSON.stringify({ pid: 3999999, originalBytes: trueOriginal }),
      )

      const m = materializeMcpServersForPi({ echo: { command: 'node' } }, cwd)
      expect(m).not.toBeNull()
      if (!m) return
      // New mount merges into the TRUE original (workspace server), with the
      // dead run's `leaked` server rolled back out.
      const written = JSON.parse(readFileSync(m.configPath, 'utf-8'))
      expect(Object.keys(written.mcpServers).sort()).toEqual(['echo', 'workspace'])
      m.cleanup()
      expect(readFileSync(m.configPath, 'utf-8')).toBe(trueOriginal)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('never restores through a symlink planted at the config path mid-run (fail-closed, lock kept)', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-'))
    const victim = join(cwd, 'victim.txt')
    try {
      fs.writeFileSync(victim, 'host file that must not be overwritten')
      fs.mkdirSync(join(cwd, '.pi'))
      const originalBytes = JSON.stringify({ mcpServers: { existing: { command: 'x' } } })
      fs.writeFileSync(join(cwd, '.pi', 'mcp.json'), originalBytes)

      const m = materializeMcpServersForPi({ echo: { command: 'node' } }, cwd)
      expect(m).not.toBeNull()
      if (!m) return
      // Sandboxed agent swaps the config for a symlink to a host file.
      fs.rmSync(m.configPath)
      fs.symlinkSync(victim, m.configPath)

      m.cleanup()
      // The victim file is untouched and the lock is retained fail-closed.
      expect(readFileSync(victim, 'utf-8')).toBe('host file that must not be overwritten')
      expect(existsSync(`${m.configPath}.lock`)).toBe(true)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('fails fast on a FIFO planted at the config path instead of blocking the host', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-'))
    try {
      fs.mkdirSync(join(cwd, '.pi'))
      execSync(`mkfifo ${JSON.stringify(join(cwd, '.pi', 'mcp.json'))}`)
      // A plain readFileSync here would block forever on the open FIFO.
      expect(() => materializeMcpServersForPi({ echo: { command: 'node' } }, cwd))
        .toThrow(/not a regular file|not readable as a regular file/)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('rejects an oversized workspace config instead of slurping it', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-'))
    try {
      fs.mkdirSync(join(cwd, '.pi'))
      fs.writeFileSync(join(cwd, '.pi', 'mcp.json'), 'x'.repeat(2 * 1024 * 1024))
      expect(() => materializeMcpServersForPi({ echo: { command: 'node' } }, cwd))
        .toThrow(/byte cap/)
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('refuses to mount when .pi itself is a symlinked directory', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-'))
    const hostDir = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-host-'))
    try {
      fs.symlinkSync(hostDir, join(cwd, '.pi'))
      expect(() => materializeMcpServersForPi({ echo: { command: 'node' } }, cwd))
        .toThrow(/not a real directory/)
      // Nothing was written through the link into the host directory.
      expect(fs.readdirSync(hostDir)).toEqual([])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(hostDir, { recursive: true, force: true })
    }
  })

  it('refuses to mount over a symlink planted at the config path before the run', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-'))
    const victim = join(cwd, 'victim.txt')
    try {
      fs.writeFileSync(victim, 'do not clobber')
      fs.mkdirSync(join(cwd, '.pi'))
      fs.symlinkSync(victim, join(cwd, '.pi', 'mcp.json'))
      expect(() => materializeMcpServersForPi({ echo: { command: 'node' } }, cwd))
        .toThrow(/backend pi failed to prepare MCP config/)
      expect(readFileSync(victim, 'utf-8')).toBe('do not clobber')
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('wraps fs failures in a typed BackendError instead of a raw fs throw', () => {
    const cwd = fs.mkdtempSync(join(os.tmpdir(), 'cb-pi-mcp-'))
    try {
      // A FILE named `.pi` makes mkdirSync fail deterministically (ENOTDIR/EEXIST).
      fs.writeFileSync(join(cwd, '.pi'), 'not a directory')
      expect(() => materializeMcpServersForPi({ echo: { command: 'node' } }, cwd))
        .toThrow(/backend pi failed to prepare MCP config/)
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

describe('materializeMcpServersForGemini', () => {
  it('writes remote http servers under httpUrl + trust into <cwd>/.gemini/settings.json', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cb-gem-mcp-'))
    try {
      const m = materializeMcpServersForGemini({
        youcom: { type: 'http', url: 'https://you.example/mcp', headers: { Authorization: 'Bearer X' } },
      }, cwd)
      expect(m).not.toBeNull()
      if (!m) return
      expect(m.configPath).toBe(join(cwd, '.gemini', 'settings.json'))
      const written = JSON.parse(readFileSync(m.configPath, 'utf-8'))
      expect(written.mcpServers).toEqual({
        youcom: { httpUrl: 'https://you.example/mcp', headers: { Authorization: 'Bearer X' }, trust: true },
      })
      m.cleanup()
      expect(existsSync(m.configPath)).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('writes stdio servers as command/args/env and preserves an existing settings key on merge', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const cwd = mkdtempSync(join(tmpdir(), 'cb-gem-mcp-'))
    try {
      fs.mkdirSync(join(cwd, '.gemini'))
      fs.writeFileSync(join(cwd, '.gemini', 'settings.json'), JSON.stringify({ theme: 'dark' }))
      const m = materializeMcpServersForGemini({ echo: { command: 'node', args: ['e.js'], env: { A: 'b' } } }, cwd)
      expect(m).not.toBeNull()
      if (!m) return
      const written = JSON.parse(readFileSync(m.configPath, 'utf-8'))
      expect(written.theme).toBe('dark')
      expect(written.mcpServers.echo).toEqual({ command: 'node', args: ['e.js'], env: { A: 'b' }, trust: true })
      m.cleanup()
      // Original settings restored verbatim (no mcpServers key).
      expect(JSON.parse(readFileSync(m.configPath, 'utf-8'))).toEqual({ theme: 'dark' })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns null when no usable servers remain', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cb-gem-mcp-'))
    try {
      expect(materializeMcpServersForGemini(null, cwd)).toBeNull()
      expect(materializeMcpServersForGemini({ off: { command: 'x', enabled: false } }, cwd)).toBeNull()
      expect(existsSync(join(cwd, '.gemini'))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('materializeMcpServersForFactory', () => {
  it('writes droid mcp.json shape (type + disabled) into <cwd>/.factory/mcp.json', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cb-fac-mcp-'))
    try {
      const m = materializeMcpServersForFactory({
        youcom: { type: 'http', url: 'https://you.example/mcp', headers: { Authorization: 'Bearer X' } },
        echo: { command: 'node', args: ['e.js'] },
      }, cwd)
      expect(m).not.toBeNull()
      if (!m) return
      expect(m.configPath).toBe(join(cwd, '.factory', 'mcp.json'))
      const written = JSON.parse(readFileSync(m.configPath, 'utf-8'))
      expect(written.mcpServers.youcom).toEqual({
        type: 'http', url: 'https://you.example/mcp', headers: { Authorization: 'Bearer X' }, disabled: false,
      })
      expect(written.mcpServers.echo).toEqual({ type: 'stdio', command: 'node', args: ['e.js'], disabled: false })
      m.cleanup()
      expect(existsSync(join(cwd, '.factory'))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('buildAcpMcpServers', () => {
  it('emits remote servers with type + list-shaped headers (ACP HttpMcpServer schema)', () => {
    expect(buildAcpMcpServers({
      youcom: { type: 'http', url: 'https://you.example/mcp', headers: { Authorization: 'Bearer X' } },
    })).toEqual([
      { type: 'http', name: 'youcom', url: 'https://you.example/mcp', headers: [{ name: 'Authorization', value: 'Bearer X' }] },
    ])
  })

  it('emits stdio servers with list-shaped env and drops disabled entries', () => {
    expect(buildAcpMcpServers({
      echo: { command: 'node', args: ['e.js'], env: { A: 'b' } },
      off: { command: 'x', enabled: false },
    })).toEqual([
      { name: 'echo', command: 'node', args: ['e.js'], env: [{ name: 'A', value: 'b' }] },
    ])
  })

  it('returns an empty array for a null map', () => {
    expect(buildAcpMcpServers(null)).toEqual([])
  })
})
