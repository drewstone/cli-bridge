/**
 * Sourcegraph Amp backend — stub.
 *
 * Amp is Sourcegraph's coding CLI (https://ampcode.com/). Ships as
 * `amp` on the $PATH after install. Has its own session + context
 * tracking; subscription-backed like Claude Code and Kimi Code.
 *
 * To implement: check `amp exec` or `amp run` for headless mode,
 * pick a stream format, mirror the Claude backend shape.
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

export class AmpBackend implements Backend {
  readonly name = 'amp'

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m.startsWith('amp/') || m.startsWith('sourcegraph/')
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
