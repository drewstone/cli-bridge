import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseJailPathList, resolveJailSpec } from '../src/jail/resolve-spec.js'

const work = mkdtempSync(join(tmpdir(), 'jail-allowlist-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe('operator jail path allowlists', () => {
  it('parses a comma or colon list into unique absolute paths', () => {
    expect(parseJailPathList('/opt/a,/opt/b:/opt/a, ', 'X')).toEqual(['/opt/a', '/opt/b'])
    expect(parseJailPathList(undefined, 'X')).toEqual([])
  })

  it('refuses a relative path, /, /home and the operator home itself', () => {
    expect(() => parseJailPathList('opt/a', 'X')).toThrow(/not an absolute path/)
    for (const bad of ['/', '/home', homedir()]) {
      expect(() => parseJailPathList(bad, 'X')).toThrow(/re-open the home tree/)
    }
    expect(parseJailPathList(join(homedir(), '.hermes'), 'X')).toEqual([join(homedir(), '.hermes')])
  })

  it('lands on the spec: read-only extras only under fs-jail, writable extras under both modes', () => {
    const cwd = join(work, 'run1')
    const fs = resolveJailSpec({ cwd, env: { WORKER_FS_JAIL: '1', BRIDGE_JAIL_RO_PATHS: '/opt/tool', BRIDGE_JAIL_RW_PATHS: '/var/tmp/hermes-state' } })
    expect(fs?.readConfine).toBe(true)
    expect(fs?.extraReadablePaths).toEqual(['/opt/tool'])
    expect(fs?.extraWritablePaths).toEqual(['/var/tmp/hermes-state'])
    const wj = resolveJailSpec({ cwd, env: { BRIDGE_JAIL_MODE: 'write-jail', BRIDGE_JAIL_RO_PATHS: '/opt/tool', BRIDGE_JAIL_RW_PATHS: '/var/tmp/x' } })
    expect(wj?.readConfine).toBeUndefined()
    expect(wj?.extraReadablePaths).toBeUndefined()
    expect(wj?.extraWritablePaths).toEqual(['/var/tmp/x'])
    expect(resolveJailSpec({ cwd, env: { BRIDGE_JAIL_RO_PATHS: '/opt/tool' } })).toBeNull()
  })

  it('refuses a bind at or above the working directory', () => {
    const cwd = join(work, 'run2')
    expect(() => resolveJailSpec({ cwd, env: { WORKER_FS_JAIL: '1', BRIDGE_JAIL_RO_PATHS: work } })).toThrow(/ancestor/)
    expect(() => resolveJailSpec({ cwd, env: { WORKER_FS_JAIL: '1', BRIDGE_JAIL_RW_PATHS: cwd } })).toThrow(/ancestor/)
  })
})
