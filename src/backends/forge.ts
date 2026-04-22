/**
 * Forge Code backend — stub. Forge (https://github.com/antinomyhq/forge)
 * is BYOK per-provider; runs your own keys through its harness. Less
 * subscription-arbitrage value than the paid CLIs, so wiring this up
 * is lower priority than claude / codex / opencode.
 */

import { spawn } from 'node:child_process'
import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

export interface ForgeBackendOptions {
  bin: string
  timeoutMs: number
}

export class ForgeBackend implements Backend {
  readonly name = 'forge'
  constructor(private readonly opts: ForgeBackendOptions) {}

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'forge' || m.startsWith('forge/')
  }

  async health(): Promise<BackendHealth> {
    return new Promise((resolve) => {
      const child = spawn(this.opts.bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (b) => { stderr += b.toString() })
      child.on('error', (err) => {
        resolve({ name: this.name, state: 'unavailable', detail: `spawn failed: ${err.message}` })
      })
      child.on('close', (code) => {
        resolve({
          name: this.name,
          state: code === 0 ? 'ready' : 'error',
          detail: code === 0 ? undefined : `exit ${code}: ${stderr.slice(0, 200)}`,
        })
      })
    })
  }

  // eslint-disable-next-line require-yield
  async *chat(
    _req: ChatRequest,
    _session: SessionRecord | null,
    _signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    throw new BackendError('forge backend stubbed — implement per forge CLI spec', 'not_configured')
  }
}
