import assert from 'node:assert/strict'
import { once } from 'node:events'
import { loadConfig } from '../../src/config.ts'
import { AdmissionGate } from '../../src/admission.ts'
import { hostSpawner, hostExecutorSnapshot } from '../../src/executors/host.ts'

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(new Error('native lifecycle integration deadline')), 10_000)
process.once('SIGTERM', () => controller.abort())
const config = loadConfig()
const gate = new AdmissionGate({ ...config.admission, reconcileIntervalMs: 0 })
const children = []
const bounded = process.argv.includes('--bounded')
try {
  assert.equal(config.admission.maxActive, 0)
  assert.equal(config.admission.reservedActive, 0)
  const jobs = Array.from({ length: bounded ? 5 : 65 }, async (_, index) => {
    let spawned
    const slot = await gate.acquire({
      admissionClass: index % 2 ? 'bulk' : 'reserved', signal: controller.signal,
      work: { id: `native-${index}`, isFinished: () => spawned?.child.exitCode != null || spawned?.child.signalCode != null },
    })
    spawned = await hostSpawner('/bin/sh', ['-c', 'printf "ready\\n"; read -r release'], {
      signal: controller.signal, stdio: ['pipe', 'pipe', 'pipe'],
    })
    if (spawned.spawnError?.()) throw spawned.spawnError()
    const closed = once(spawned.child, 'close')
    children.push({ spawned, closed })
    slot.holdUntil(closed)
    assert.equal((await once(spawned.child.stdout, 'data', { signal: controller.signal }))[0].toString(), 'ready\n')
  })
  if (bounded) {
    await Promise.all(jobs.slice(0, 4))
    assert.equal(hostExecutorSnapshot().in_flight, 4)
    assert.equal(hostExecutorSnapshot().queued, 1)
    children[0].spawned.child.stdin.end('release\n')
    await children[0].closed
    await children[0].spawned.terminate()
    children[0].spawned.release()
  }
  await Promise.all(jobs)
  assert.equal(gate.snapshot().active, bounded ? 4 : 65)
  assert.equal(gate.snapshot().live, bounded ? 4 : 65)
  assert.equal(gate.snapshot().queued, 0)
  assert.equal(hostExecutorSnapshot().in_flight, bounded ? 4 : 65)
  assert.equal(hostExecutorSnapshot().max, bounded ? 4 : 0)
  for (const { spawned } of children) if (!spawned.child.stdin.writableEnded) spawned.child.stdin.end('release\n')
  for (const { closed } of children) assert.equal((await closed)[0], 0)
} finally {
  controller.abort()
  await Promise.all(children.map(async ({ spawned, closed }) => {
    await spawned.terminate()
    await closed
    spawned.release()
  }))
  gate.close()
  clearTimeout(timer)
}
await new Promise(resolve => setImmediate(resolve))
assert.equal(gate.snapshot().active, 0)
assert.equal(hostExecutorSnapshot().in_flight, 0)
console.log(JSON.stringify({ nativeChildren: bounded ? 5 : 65, admissionActive: 0, executorActive: 0, terminated: true }))
