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
import type { AgentProfile } from '@tangle-network/sandbox'
import {
  buildMcpAllowList,
  materialiseMcpConfig,
  materialiseOpencodeMcpConfig,
} from '../src/backends/profile-support.js'

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
