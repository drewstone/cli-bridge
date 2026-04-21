/**
 * Factory Droid backend — stub.
 *
 * Factory (https://docs.factory.ai/) ships a `droid` CLI — coding
 * agent with parallel droids and session context. Ships as `droid` on
 * the $PATH after install; subscription-backed.
 *
 * To implement: check the droid CLI's headless flags (`droid exec`?),
 * pick a stream format, mirror the Claude backend shape for session
 * resume + streaming.
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

export class FactoryBackend implements Backend {
  readonly name = 'factory'

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m.startsWith('factory/') || m.startsWith('droid/')
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
