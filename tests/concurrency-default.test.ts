/**
 * Regression coverage for the cores-aware concurrency default.
 *
 * The bug this defends against (2026-06-01): a hardcoded default of 4 on
 * the 32-core production box starved the pr-reviewer's opencode lane of
 * executor slots — acquires timed out at in_flight=4/4, opencode's
 * readiness probe failed, its models 404'd, and reviews posted
 * "⚠️ Review Incomplete". The default must scale with cores while staying
 * bounded so neither tiny nor huge hosts misbehave.
 */

import { describe, expect, it } from 'vitest'
import { coresAwareConcurrency } from '../src/concurrency-default.js'

describe('coresAwareConcurrency', () => {
  it('scales the executor default on the 32-core box to 16, not the old fixed 4', () => {
    // The exact starvation regression: cores/2 must beat the old hardcoded 4.
    expect(coresAwareConcurrency({ ratio: 0.5, min: 4, max: 16, cores: 32 })).toBe(16)
  })

  it('floors at min on a scarce-core host so small boxes keep the safe cap', () => {
    // 2 cores * 0.5 = 1, which would over-throttle; floor keeps it at 4.
    expect(coresAwareConcurrency({ ratio: 0.5, min: 4, max: 16, cores: 2 })).toBe(4)
  })

  it('caps at max on a very large host so it cannot fork-bomb', () => {
    // 128 cores * 0.5 = 64; the cap holds it at 16 to bound memory pressure.
    expect(coresAwareConcurrency({ ratio: 0.5, min: 4, max: 16, cores: 128 })).toBe(16)
  })

  it('scales proportionally between floor and cap on a mid-size host', () => {
    expect(coresAwareConcurrency({ ratio: 0.5, min: 4, max: 16, cores: 16 })).toBe(8)
  })

  it('admission ratio (0.75) lands above executor concurrency so admission is not the bottleneck', () => {
    // 32 cores: admission default 24 > executor default 16 → executors limit, not admission.
    const admission = coresAwareConcurrency({ ratio: 0.75, min: 8, max: 24, cores: 32 })
    const executor = coresAwareConcurrency({ ratio: 0.5, min: 4, max: 16, cores: 32 })
    expect(admission).toBe(24)
    expect(admission).toBeGreaterThan(executor)
  })

  it('queue ratio (1.0) defaults to cores clamped 16..32', () => {
    expect(coresAwareConcurrency({ ratio: 1, min: 16, max: 32, cores: 32 })).toBe(32)
    expect(coresAwareConcurrency({ ratio: 1, min: 16, max: 32, cores: 8 })).toBe(16)
    expect(coresAwareConcurrency({ ratio: 1, min: 16, max: 32, cores: 64 })).toBe(32)
  })

  it('floors fractional results with Math.floor (never rounds a cap upward)', () => {
    // 6 cores * 0.75 = 4.5 → 8 (floored to 4 then raised to min 8).
    expect(coresAwareConcurrency({ ratio: 0.75, min: 8, max: 24, cores: 6 })).toBe(8)
    // 30 cores * 0.75 = 22.5 → 22, under the 24 cap.
    expect(coresAwareConcurrency({ ratio: 0.75, min: 8, max: 24, cores: 30 })).toBe(22)
  })
})
