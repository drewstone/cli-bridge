/**
 * Factory Droid backend — stub.
 *
 * Model id scheme: `factory/<model>` — Factory's own model selector.
 * The CLI is `droid`; subscription-backed.
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

export class FactoryBackend implements Backend {
  readonly name = 'factory'

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'factory' || m.startsWith('factory/')
  }

  async health(): Promise<BackendHealth> {
    return { name: this.name, state: 'unavailable', detail: 'factory backend stubbed' }
  }

  // eslint-disable-next-line require-yield
  async *chat(
    _req: ChatRequest,
    _session: SessionRecord | null,
    _signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    throw new BackendError('factory backend not yet implemented', 'not_configured')
  }
}
