/**
 * Measured on this host after the credential mounts were made complete:
 *
 *   du -h /home/drew/.local/share/opencode/opencode.db   ->  36G
 *
 * That directory is where opencode keeps `auth.json`, so a docker executor has
 * to mount it to authenticate — which also puts every pool container inside the
 * operator's live 36 GB sqlite database. Measured consequence, 4 waves of 8
 * submissions against a 4-slot pool: 30/32 succeeded, both failures
 * `opencode exited 1: Unexpected error database is locked`. At the in-flight cap
 * of 4 it was 12/12.
 *
 * The primary mount already had an override (`<NAME>_DOCKER_HOST_CONFIG_DIR`);
 * the credential/state mounts derived from `$HOME` had none, so an operator could
 * not point them at a prepared directory. One knob for the whole set —
 * `<NAME>_DOCKER_HOST_HOME` — keeps the mounts coherent with each other, which a
 * per-directory override cannot: the point of the set is that it is one CLI's
 * home seen from two places.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-host-home-'))
  tempDirs.push(dir)
  return dir
}

describe('the host side of every credential mount can be moved as one set', () => {
  it('derives all credential mounts from OPENCODE_DOCKER_HOST_HOME', () => {
    const home = tempDir()
    const cfg = loadConfig({
      HOME: '/home/test',
      BRIDGE_BACKENDS: 'opencode',
      OPENCODE_EXECUTOR: 'docker',
      OPENCODE_DOCKER_HOST_HOME: home,
    }).executors.opencode!

    expect(cfg.hostConfigDir).toBe(join(home, '.config/opencode'))
    expect((cfg.extraMounts ?? []).map((m) => m.host)).toEqual([join(home, '.local/share/opencode')])
    // The container side is unchanged: the CLI still reads its own HOME.
    expect(cfg.containerConfigDir).toBe('/root/.config/opencode')
    expect((cfg.extraMounts ?? []).map((m) => m.container)).toEqual(['/root/.local/share/opencode'])
  })

  it('still lets the primary mount be overridden on its own', () => {
    const home = tempDir()
    const cfg = loadConfig({
      HOME: '/home/test',
      BRIDGE_BACKENDS: 'opencode',
      OPENCODE_EXECUTOR: 'docker',
      OPENCODE_DOCKER_HOST_HOME: home,
      OPENCODE_DOCKER_HOST_CONFIG_DIR: '/elsewhere/config',
    }).executors.opencode!

    expect(cfg.hostConfigDir).toBe('/elsewhere/config')
    expect((cfg.extraMounts ?? []).map((m) => m.host)).toEqual([join(home, '.local/share/opencode')])
  })

  it('rejects a relative host home instead of resolving it against the bridge cwd', () => {
    expect(() => loadConfig({
      HOME: '/home/test',
      BRIDGE_BACKENDS: 'opencode',
      OPENCODE_EXECUTOR: 'docker',
      OPENCODE_DOCKER_HOST_HOME: './ochome',
    })).toThrow(/OPENCODE_DOCKER_HOST_HOME.*absolute/s)
  })
})
