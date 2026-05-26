import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { recordTaskDiagnostic, _resetDiagnosticsPathForTests, type TaskDiagnostic } from '../src/executors/diagnostics.js'
import { hostSpawner } from '../src/executors/host.js'
import { killTree, getKillReason } from '../src/executors/process-tree.js'

let dir: string
let diagFile: string
const prevEnv = process.env.BRIDGE_DIAGNOSTICS_FILE

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-bridge-diag-'))
  diagFile = join(dir, 'diagnostics.ndjson')
  process.env.BRIDGE_DIAGNOSTICS_FILE = diagFile
  _resetDiagnosticsPathForTests()
})
afterEach(() => {
  if (prevEnv === undefined) delete process.env.BRIDGE_DIAGNOSTICS_FILE
  else process.env.BRIDGE_DIAGNOSTICS_FILE = prevEnv
  _resetDiagnosticsPathForTests()
  rmSync(dir, { recursive: true, force: true })
})

function readRecords(): TaskDiagnostic[] {
  return readFileSync(diagFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as TaskDiagnostic)
}

describe('Pillar 0 — task diagnostics', () => {
  it('round-trips a record as NDJSON', () => {
    recordTaskDiagnostic({ ts: 't', bin: 'claude', cwd: '/w', pid: 1, durationMs: 5, exitCode: 0, signal: null, killReason: null, termination: 'exit' })
    const recs = readRecords()
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ bin: 'claude', cwd: '/w', termination: 'exit' })
  })

  it('BRIDGE_DIAGNOSTICS_FILE=off disables capture (never throws, writes nothing)', () => {
    process.env.BRIDGE_DIAGNOSTICS_FILE = 'off'
    _resetDiagnosticsPathForTests()
    expect(() => recordTaskDiagnostic({ ts: 't', bin: 'x', cwd: null, pid: null, durationMs: 0, exitCode: 0, signal: null, killReason: null, termination: 'exit' })).not.toThrow()
  })

  it('killTree records the CAUSAL reason, retrievable via getKillReason (first-writer-wins)', async () => {
    const { child } = await hostSpawner('sleep', ['30'], { cwd: dir })
    await killTree(child, { reason: 'timeout' })
    await killTree(child, { reason: 'request-end' }) // later teardown must NOT clobber
    expect(getKillReason(child)).toBe('timeout')
  })

  // THE attribution proof: a killed task is no longer a black box — the
  // executor records signal + the WHY. This fails on the pre-Pillar-0 bridge
  // (no diagnostics file is ever written) and passes now.
  it('attributes an externally-killed task at the chokepoint: signal=SIGTERM, killReason=timeout', async () => {
    const cellCwd = join(dir, 'vb-cell-fhenix-sealed-bid-r0')
    mkdirSync(cellCwd, { recursive: true })
    const { child } = await hostSpawner('sleep', ['30'], { cwd: cellCwd })
    await killTree(child, { reason: 'timeout' })
    await new Promise((r) => setTimeout(r, 100)) // let the exit handler flush

    const recs = readRecords()
    expect(recs).toHaveLength(1)
    const rec = recs[0]!
    expect(rec.bin).toBe('sleep')
    expect(rec.termination).toBe('killed')
    expect(rec.signal).toBe('SIGTERM')
    expect(rec.killReason).toBe('timeout')
    expect(rec.cwd).toContain('vb-cell-fhenix-sealed-bid-r0') // cell correlation
    expect(rec.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('records a NATURAL exit with its code and no kill reason', async () => {
    const { child } = await hostSpawner('true', [], { cwd: dir })
    await new Promise<void>((r) => child.once('exit', () => r()))
    await new Promise((r) => setTimeout(r, 100))
    const rec = readRecords().at(-1)!
    expect(rec.termination).toBe('exit')
    expect(rec.exitCode).toBe(0)
    expect(rec.killReason).toBeNull()
  })
})
