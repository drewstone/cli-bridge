import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { buildApp } from '../src/server.js'

describe('bridge capability advertisement', () => {
  it('advertises profile and cost receipt versions on the cheap root endpoint', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cli-bridge-capabilities-'))
    const built = await buildApp(loadConfig({
      BRIDGE_BACKENDS: '',
      BRIDGE_DATA_DIR: dataDir,
      BRIDGE_TRACE: 'off',
      SANDBOX_PROFILES_DIR: join(dataDir, 'profiles'),
    }))
    try {
      const response = await built.app.request('/')
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        name: 'cli-bridge',
        capabilities: {
          profileMaterialization: 'cli-bridge.profile-materialization.v2',
          usageCostProvenance: 'cli-bridge.usage-cost.v1',
        },
      })
      const { run } = built.runs.claim('persistent-default', 'digest')
      expect(run.snapshot().lifetimeExpiresAt).toBeNull()
    } finally {
      built.runs.clear()
      built.sessions.close()
      for (const shutdown of built.extras.shutdownHooks) await shutdown()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
