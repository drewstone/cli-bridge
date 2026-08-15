/**
 * Unsettled-run harness.
 *
 * `Run.scheduleRetentionTimers()` is reached only from `finish()`, so every
 * retention bound the registry has — replay expiry AND identity expiry — is
 * armed by the run reaching a terminal state. A run whose backend never
 * terminates is therefore never forgotten and never releases its replay buffer.
 *
 * A bridge with no execution timeout (the default when neither the caller nor
 * the backend sets one) can accumulate these for the life of the process.
 *
 * Run with: node --expose-gc --import tsx scripts/measure-unsettled-runs.ts
 */

import { RunRegistry } from '../src/runs/registry.js'
import type { ChatDelta } from '../src/backends/types.js'
import { distinctPayload } from './measure-payload.js'

const RUNS = Number(process.env.MEASURE_RUNS ?? 150)
const DELTAS_PER_RUN = Number(process.env.MEASURE_DELTAS ?? 400)
const DELTA_BYTES = Number(process.env.MEASURE_DELTA_BYTES ?? 8192)
/**
 * Scaled down from the 6-hour production default so the harness finishes.
 * Code without the ceiling ignores this option, which is what makes the same
 * script a valid before/after measurement.
 */
const MAX_LIFETIME_MS = Number(process.env.MEASURE_LIFETIME_MS ?? 250)

function gc(): void {
  const collect = (globalThis as { gc?: () => void }).gc
  if (!collect) throw new Error('run with --expose-gc')
  for (let i = 0; i < 4; i += 1) collect()
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function main(): Promise<void> {
  // Deliberately SHORT retentions. If any bound were armed, everything would be
  // released within a second and the heap would stay flat.
  const registry = new RunRegistry({
    replayRetentionMs: 50,
    identityRetentionMs: 100,
    maxReplayDeltas: 10_000,
    maxLifetimeMs: MAX_LIFETIME_MS,
  })

  console.log(
    `runs=${RUNS} deltas/run=${DELTAS_PER_RUN} delta=${DELTA_BYTES}B — ` +
    `each run streams output and then NEVER terminates`,
  )
  console.log(
    `replayRetentionMs=50 identityRetentionMs=100 maxLifetimeMs=${MAX_LIFETIME_MS} ` +
    '(all deliberately tiny)',
  )
  console.log('')

  gc()
  const baseline = process.memoryUsage().heapUsed
  console.log(`baseline heapUsed=${mb(baseline)}`)
  console.log('')
  console.log(' runs   registry.size   heapUsed   growth/run')
  console.log(' ----   -------------   --------   ----------')

  const step = Math.max(1, Math.floor(RUNS / 10))
  for (let i = 0; i < RUNS; i += 1) {
    const { run } = registry.claim(`bridge-run-hung-${i}`, `digest-${i}`)
    // A backend that produced output and then hung: the async iterable never
    // returns, so `pump()` never calls `finish()`.
    const source = (async function* (): AsyncIterable<ChatDelta> {
      for (let d = 0; d < DELTAS_PER_RUN; d += 1) {
        yield { content: distinctPayload(DELTA_BYTES, i * DELTAS_PER_RUN + d) }
      }
      await new Promise(() => {})
    })()
    void run.pump(source)
    // Let the generator drain into the buffer, then leave the run hanging.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setTimeout(resolve, 0))

    if ((i + 1) % step === 0) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      gc()
      const heap = process.memoryUsage().heapUsed
      const size = (registry as unknown as { runs: Map<string, unknown> }).runs.size
      console.log(
        `${String(i + 1).padStart(5)}   ${String(size).padStart(13)}   ` +
        `${mb(heap).padStart(8)}   ${((heap - baseline) / (i + 1) / 1024).toFixed(0)} KB`,
      )
    }
  }

  // Wait far longer than every bound. Anything still held is held forever.
  await new Promise((resolve) => setTimeout(resolve, Math.max(1000, MAX_LIFETIME_MS * 4)))
  gc()
  const final = process.memoryUsage().heapUsed
  const size = (registry as unknown as { runs: Map<string, unknown> }).runs.size
  console.log('')
  console.log(
    `AFTER 1s (20x replay retention, 10x identity retention): ` +
    `registry.size=${size} heapUsed=${mb(final)} held=${mb(final - baseline)}`,
  )
  console.log(`held per unsettled run: ${((final - baseline) / RUNS / 1024).toFixed(0)} KB`)
  registry.clear()
}

void main()
