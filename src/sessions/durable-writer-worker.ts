import { parentPort, workerData } from 'node:worker_threads'
import { SessionStore } from './store.js'
import type { DurableRequest } from './durable-writer.js'

const port = parentPort!
const store = new SessionStore(workerData.dataDir)
const pending: Array<{ id: number; request: DurableRequest }> = []
let scheduled = false

function flush(): void {
  scheduled = false
  if (!pending.length) return
  const batch = pending.splice(0)
  try {
    const outcomes = store.commitRetainedRunWrites(batch.map((item) => item.request))
    batch.forEach((item, index) => port.postMessage({ id: item.id, ...outcomes[index] }))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    for (const item of batch) port.postMessage({ id: item.id, error: detail })
  }
}
port.on('message', (message: { id: number; request: DurableRequest; close?: boolean }) => {
  if (message.close) {
    flush()
    store.close()
    port.close()
    return
  }
  pending.push(message)
  if (!scheduled) {
    scheduled = true
    setImmediate(flush)
  }
})
port.postMessage({ ready: true })
