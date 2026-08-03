/**
 * Sourcegraph Amp backend — stub; Amp's CLI has a non-interactive mode
 * but no documented streaming JSON as of 2026. Will implement when
 * upstream ships it.
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import { hostSpawner } from '../executors/host.js'
import { versionHealth } from './health.js'

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

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    return versionHealth(this.name, this.opts.bin, hostSpawner, undefined, signal)
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
