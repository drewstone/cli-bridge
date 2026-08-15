/**
 * Live-window harness for one durable run's replay buffer.
 *
 * The registry caps retained deltas by COUNT (`maxReplayDeltas`, default
 * 10,000). It does not cap them by SIZE, so the heap a single live run holds is
 * `maxReplayDeltas * (whatever the backend emits per delta)`. This measures the
 * heap held by one run while it streams, for a delta size a real agent produces
 * (a file read or a tool result, not a token).
 *
 * Run with: node --expose-gc --import tsx scripts/measure-live-run-buffer.ts
 */

import { RunRegistry } from '../src/runs/registry.js'
import type { ChatDelta } from '../src/backends/types.js'
import { distinctPayload } from './measure-payload.js'

const DELTA_BYTES = Number(process.env.MEASURE_DELTA_BYTES ?? 16 * 1024)
const DELTAS = Number(process.env.MEASURE_DELTAS ?? 12_000)

function gc(): void {
  const collect = (globalThis as { gc?: () => void }).gc
  if (!collect) throw new Error('run with --expose-gc')
  for (let i = 0; i < 4; i += 1) collect()
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function main(): Promise<void> {
  const registry = new RunRegistry({
    replayRetentionMs: 60_000,
    identityRetentionMs: 86_400_000,
    maxReplayDeltas: 10_000,
  })

  console.log(
    `one run, delta=${(DELTA_BYTES / 1024).toFixed(0)}KB, deltas emitted=${DELTAS}, ` +
    `maxReplayDeltas=10000 (a COUNT cap, not a byte cap)`,
  )
  console.log(`total streamed through the run: ${mb(DELTAS * DELTA_BYTES)}`)
  console.log('')

  gc()
  const baseline = process.memoryUsage().heapUsed
  console.log(`baseline heapUsed=${mb(baseline)}`)
  console.log('')
  console.log('deltas emitted   retained deltas   heapUsed   held by buffer')
  console.log('--------------   ---------------   --------   --------------')

  const { run } = registry.claim('bridge-run-live', 'digest-live')

  const source = (async function* (): AsyncIterable<ChatDelta> {
    for (let i = 0; i < DELTAS; i += 1) {
      yield { content: distinctPayload(DELTA_BYTES, i) }
      if ((i + 1) % 2000 === 0) {
        gc()
        const heap = process.memoryUsage().heapUsed
        const snap = run.snapshot()
        console.log(
          `${String(i + 1).padStart(14)}   ${String(snap.replay.retainedDeltas).padStart(15)}   ` +
          `${mb(heap).padStart(8)}   ${mb(heap - baseline)}`,
        )
      }
    }
    yield { finish_reason: 'stop' }
  })()

  await run.pump(source)

  gc()
  const peak = process.memoryUsage().heapUsed
  const snap = run.snapshot()
  console.log('')
  console.log(
    `AT TERMINAL: retained deltas=${snap.replay.retainedDeltas} ` +
    `heapUsed=${mb(peak)} held=${mb(peak - baseline)}`,
  )
  console.log(
    `This heap stays held for replayRetentionMs (60 s default) AFTER the run ends, ` +
    `and is multiplied by every concurrent run.`,
  )
  registry.clear()
}

void main()
