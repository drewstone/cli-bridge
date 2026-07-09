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
})
