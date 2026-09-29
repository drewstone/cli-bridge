import { Worker } from 'node:worker_threads'
import type { SessionStore } from './store.js'

export type DurableMethod = 'appendRetainedDelta' | 'updateRetainedRun'
export type DurableRequest = {
  [K in DurableMethod]: { method: K; args: Parameters<SessionStore[K]> }
}[DurableMethod]

/** Acknowledgements arrive only after the worker's FULL WAL commit returns. */
export class DurableRunWriter {
  private readonly worker: Worker
  private readonly pending = new Map<number, {
    bytes: number
    resolve: () => void
    reject: (error: Error) => void
  }>()
  private bytes = 0
  private nextId = 0
  private failure: Error | null = null
  private closing = false
  private closed?: Promise<void>
  private readonly exited: Promise<number>
  private readonly ready: Promise<void>
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void

  constructor(dataDir: string, private readonly limits = { maxBytes: 32 * 1024 * 1024, maxRequests: 128 }) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // The service runs TypeScript directly; register the same maintained loader inside its worker.
    this.worker = new Worker(
      `const { workerData } = require('node:worker_threads');
       import('tsx/esm/api').then(({ tsImport }) => tsImport(workerData.module, workerData.parent));`,
      { eval: true, workerData: {
        dataDir,
        module: new URL('./durable-writer-worker.ts', import.meta.url).href,
        parent: import.meta.url,
      } },
    )
    this.worker.on('message', (message: { ready?: boolean; id?: number; error?: string }) => {
      if (message.ready) { this.readyResolve(); return }
      const entry = message.id === undefined ? undefined : this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id!)
      this.bytes -= entry.bytes
      if (message.error) entry.reject(new Error(message.error))
      else entry.resolve()
    })
    this.worker.on('error', (error) => this.fail(error instanceof Error ? error : new Error(String(error))))
    this.exited = new Promise((resolve) => this.worker.on('exit', (code) => {
      resolve(code)
      if (code !== 0 || !this.closing || this.pending.size) this.fail(new Error(`durable writer exited before acknowledgement (code ${code})`))
    }))
    // A constructor failure is also delivered to the first caller and shutdown.
    void this.ready.catch(() => {})
  }

  async open(): Promise<void> { await this.ready }

  commit(request: DurableRequest): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closing) return Promise.reject(new Error('durable writer is closed'))
    const bytes = Buffer.byteLength(JSON.stringify(request))
    if (this.pending.size >= this.limits.maxRequests || bytes > this.limits.maxBytes - this.bytes) {
      return Promise.reject(new Error('durable writer pending capacity exhausted'))
    }
    const id = ++this.nextId
    this.bytes += bytes
    return new Promise((resolve, reject) => {
      this.pending.set(id, { bytes, resolve, reject })
      try { this.worker.postMessage({ id, request }) } catch (error) {
        this.pending.delete(id)
        this.bytes -= bytes
        reject(error)
      }
    })
  }

  snapshot(): { pendingRequests: number; pendingBytes: number } {
    return { pendingRequests: this.pending.size, pendingBytes: this.bytes }
  }

  close(): Promise<void> {
    if (this.closed) return this.closed
    this.closing = true
    this.closed = this.drainAndClose()
    return this.closed
  }

  private async drainAndClose(): Promise<void> {
    try {
      await this.ready
      if (this.failure) throw this.failure
      // The port preserves order: close follows every accepted write.
      this.worker.postMessage({ close: true })
      const code = await this.exited
      if (code !== 0 || this.failure) throw this.failure ?? new Error('durable writer did not close cleanly')
    } catch (error) {
      await this.worker.terminate()
      throw error
    }
  }

  private fail(error: Error): void {
    this.failure ??= error
    this.readyReject(this.failure)
    for (const entry of this.pending.values()) entry.reject(this.failure)
    this.pending.clear()
    this.bytes = 0
  }
}
