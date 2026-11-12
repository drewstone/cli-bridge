import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { buildApp } from '../src/server.js'

describe('bridge capability advertisement', () => {
  it('advertises profile and cost receipt versions on the cheap root endpoint', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cli-bridge-capabilities-'))
    const config = loadConfig({
      BRIDGE_BACKENDS: '',
      BRIDGE_DATA_DIR: dataDir,
      BRIDGE_TRACE: 'off',
      SANDBOX_PROFILES_DIR: join(dataDir, 'profiles'),
      BRIDGE_BEARER: 'private-host-policy-bearer',
      BRIDGE_SUBSCRIPTIONS_ONLY: '1',
      BRIDGE_JAIL_MODE: 'fs-jail',
      BRIDGE_JAIL_FALLBACK: 'deny',
      BRIDGE_JAIL_NETWORK: 'relay',
      BRIDGE_JAIL_RELAY_ALLOW: 'private-host-name.invalid',
    })
    const built = await buildApp(config, dataDir, undefined, { get: async () => 'private-resolver-value' })
    config.subscriptionsOnly = false
    try {
      expect((await built.app.request('/')).status).toBe(401)
      const response = await built.app.request('/', { headers: { authorization: 'Bearer private-host-policy-bearer' } })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        name: 'cli-bridge',
        hostPolicy: { schema: 'cli-bridge.host-policy.v1', subscriptionsOnly: true,
          jail: { mode: 'fs-jail', fallback: 'deny', network: { default: 'relay', ceiling: 'relay' } },
          trustedPorts: { privateMcpSecrets: true, hub: false } },
        capabilities: {
          profileMaterialization: 'cli-bridge.profile-materialization.v2',
          usageCostProvenance: 'cli-bridge.usage-cost.v1',
        },
      })
      const publicWire = JSON.stringify(await (await built.app.request('/', { headers: { authorization: 'Bearer private-host-policy-bearer' } })).json())
      for (const privateValue of ['private-host-policy-bearer', 'private-resolver-value', 'private-host-name.invalid', dataDir])
        expect(publicWire).not.toContain(privateValue)
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
