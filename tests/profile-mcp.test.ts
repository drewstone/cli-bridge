import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writeMcpConfigFile,
  materializeMcpServersForOpencode,
  materializeMcpServersForPi,
  materializeMcpServersForKimi,
} from '../src/backends/profile-mcp.js'
import {
  materializeMcpServersForCodex,
} from '../src/backends/codex-mcp.js'

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
  it('retains session state but removes credentials and stale config between materializations', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const os = require('node:os') as typeof import('node:os')
    const root = fs.mkdtempSync(join(os.tmpdir(), 'codex-session-home-'))
    const source = join(root, 'operator-auth.json')
    const home = join(root, 'session')
    fs.mkdirSync(home)
    fs.writeFileSync(source, '{"token":"fixture-only"}')
    try {
      const first = materializeMcpServersForCodex({ private: { command: 'tool', env: { TOKEN: 'fixture-mcp-only' } } }, source, home)!
      expect(fs.readFileSync(join(home, 'auth.json'), 'utf8')).toContain('fixture-only')
      fs.writeFileSync(join(home, 'native-state'), 'retained')
      first.cleanup()
      expect(fs.existsSync(join(home, 'auth.json'))).toBe(false)
      expect(fs.existsSync(join(home, 'config.toml'))).toBe(false)
      fs.rmSync(source)
      const next = materializeMcpServersForCodex(null, source, home)!
      expect(fs.readFileSync(join(home, 'config.toml'), 'utf8')).not.toContain('fixture-mcp-only')
      expect(fs.existsSync(join(home, 'auth.json'))).toBe(false)
      expect(fs.readFileSync(join(home, 'native-state'), 'utf8')).toBe('retained')
      next.cleanup()
      const oneShot = materializeMcpServersForCodex({ tool: { command: 'tool' } })!
      oneShot.cleanup()
      expect(fs.existsSync(oneShot.homePath)).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

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
