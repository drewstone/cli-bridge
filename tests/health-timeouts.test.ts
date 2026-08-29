import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveHealthProbeTimeoutMs,
  resolveRetainedHealthProbeTimeoutMs,
} from '../src/backends/health.js'

const originalWatchdog = process.env.BRIDGE_HEALTH_PROBE_TIMEOUT_MS
const originalRetained = process.env.BRIDGE_RETAINED_HEALTH_PROBE_TIMEOUT_MS

afterEach(() => {
  restore('BRIDGE_HEALTH_PROBE_TIMEOUT_MS', originalWatchdog)
  restore('BRIDGE_RETAINED_HEALTH_PROBE_TIMEOUT_MS', originalRetained)
})

describe('health probe timeout ownership', () => {
  it('keeps the public watchdog fast while retained admission tolerates a CLI cold start', () => {
    delete process.env.BRIDGE_HEALTH_PROBE_TIMEOUT_MS
    delete process.env.BRIDGE_RETAINED_HEALTH_PROBE_TIMEOUT_MS

    expect(resolveHealthProbeTimeoutMs()).toBe(3_500)
    expect(resolveRetainedHealthProbeTimeoutMs()).toBe(15_000)
  })

  it('configures the two waits independently', () => {
    process.env.BRIDGE_HEALTH_PROBE_TIMEOUT_MS = '1200'
    process.env.BRIDGE_RETAINED_HEALTH_PROBE_TIMEOUT_MS = '22000'

    expect(resolveHealthProbeTimeoutMs()).toBe(1_200)
    expect(resolveRetainedHealthProbeTimeoutMs()).toBe(22_000)
  })
})

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
