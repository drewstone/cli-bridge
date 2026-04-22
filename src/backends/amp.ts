/**
 * Sourcegraph Amp backend — stub; Amp's CLI has a non-interactive mode
 * but no documented streaming JSON as of 2026. Will implement when
 * upstream ships it.
 */

import { spawn } from 'node:child_process'
import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

export interface AmpBackendOptions {
  bin: string
  timeoutMs: number
}

export class AmpBackend implements Backend {
  readonly name = 'amp'
  constructor(private readonly opts: AmpBackendOptions) {}

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'amp' || m.startsWith('amp/')
  }

  async health(): Promise<BackendHealth> {
    return new Promise((resolve) => {
      const child = spawn(this.opts.bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''; let stderr = ''
      child.stdout.on('data', (b) => { stdout += b.toString() })
      child.stderr.on('data', (b) => { stderr += b.toString() })
      child.on('error', (err) => {
        resolve({ name: this.name, state: 'unavailable', detail: `spawn failed: ${err.message}` })
      })
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ name: this.name, state: 'ready', version: stdout.trim() || undefined })
        } else {
          resolve({ name: this.name, state: 'error', detail: `exit ${code}` })
        }
      })
    })
  }

  // eslint-disable-next-line require-yield
  async *chat(
    _req: ChatRequest,
    _session: SessionRecord | null,
    _signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    throw new BackendError('amp backend awaits stable streaming JSON mode', 'not_configured')
  }
}
