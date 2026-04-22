/**
 * Factory Droid backend — spawns `droid exec` and streams output.
 *
 * Model id scheme: `factory/<model>` — Factory's own model selector
 * (or `factory/default` for the subscription default). The CLI is
 * `droid`, subscription-backed.
 *
 * Note: Factory's CLI is evolving; this implementation assumes a
 * non-interactive exec mode with plain-text output. When Factory
 * ships a stable streaming JSON format, switch to it — see opencode.ts
 * for the pattern.
 */

import { spawn } from 'node:child_process'
import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

export interface FactoryBackendOptions {
  bin: string
  timeoutMs: number
}

export class FactoryBackend implements Backend {
  readonly name = 'factory'
  constructor(private readonly opts: FactoryBackendOptions) {}

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'factory' || m.startsWith('factory/')
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
          resolve({ name: this.name, state: 'error', detail: `exit ${code}: ${stderr.slice(0, 200)}` })
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
    // Left as stub — droid's non-interactive flags are still evolving.
    // When Factory ships a stable exec + streaming JSON, follow the
    // opencode.ts pattern.
    throw new BackendError('factory backend awaits stable droid exec API', 'not_configured')
  }
}
