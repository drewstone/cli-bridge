/**
 * Sourcegraph Amp backend — stub.
 *
 * Model id scheme: `amp/<model>` — Amp's own model selector. Amp is
 * subscription-backed; one seat per account.
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

export class AmpBackend implements Backend {
  readonly name = 'amp'

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'amp' || m.startsWith('amp/')
  }

  async health(): Promise<BackendHealth> {
    return { name: this.name, state: 'unavailable', detail: 'amp backend stubbed' }
  }

  // eslint-disable-next-line require-yield
  async *chat(
    _req: ChatRequest,
    _session: SessionRecord | null,
    _signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    throw new BackendError('amp backend not yet implemented', 'not_configured')
  }
}
