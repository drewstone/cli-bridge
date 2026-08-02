import { describe, expect, it } from 'vitest'

import { sanitizeHostEnv } from '../src/executors/host.js'

describe('sanitizeHostEnv PWD/cwd agreement', () => {
  it('overrides the inherited PWD with the spawn cwd', () => {
    // The daemon's own PWD leaks into children otherwise, and CLIs that
    // resolve their working directory from $PWD (opencode) then operate in
    // the bridge's directory instead of the request workspace.
    const out = sanitizeHostEnv({ HOME: '/home/x', PATH: '/bin', PWD: '/srv/bridge' }, '/work/cell-1')
    expect(out?.PWD).toBe('/work/cell-1')
  })

  it('sets PWD from cwd even when the parent env has none', () => {
    const out = sanitizeHostEnv({ HOME: '/home/x', PATH: '/bin' }, '/work/cell-2')
    expect(out?.PWD).toBe('/work/cell-2')
  })

  it('keeps the inherited PWD when no cwd is given (spawn inherits the daemon cwd)', () => {
    const out = sanitizeHostEnv({ HOME: '/home/x', PATH: '/bin', PWD: '/srv/bridge' })
    expect(out?.PWD).toBe('/srv/bridge')
  })

  it('forwards dynamically selected MCP tools while dropping unrelated environment', () => {
    const out = sanitizeHostEnv({
      HOME: '/home/x',
      PATH: '/bin',
      MCP_DIRECT_TOOLS: 'coordination,records',
      UNRELATED_SECRET: 'must-not-cross',
    })
    expect(out?.MCP_DIRECT_TOOLS).toBe('coordination,records')
    expect(out?.UNRELATED_SECRET).toBeUndefined()
  })

  it('forwards Pi native configuration controls', () => {
    const out = sanitizeHostEnv({
      HOME: '/home/x',
      PATH: '/bin',
      PI_CODING_AGENT_DIR: '/work/cell-1/.pi-agent',
      PI_CODING_AGENT_SESSION_DIR: '/work/cell-1/.pi-sessions',
      PI_PACKAGE_DIR: '/opt/pi',
      UNRELATED_SECRET: 'must-not-cross',
    })
    expect(out?.PI_CODING_AGENT_DIR).toBe('/work/cell-1/.pi-agent')
    expect(out?.PI_CODING_AGENT_SESSION_DIR).toBe('/work/cell-1/.pi-sessions')
    expect(out?.PI_PACKAGE_DIR).toBe('/opt/pi')
    expect(out?.UNRELATED_SECRET).toBeUndefined()
  })
})
