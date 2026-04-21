/**
 * opencode backend — stub.
 *
 * The intended use for opencode in this bridge is piggybacking on
 * `opencode-kimi-full` to reach a Kimi For Coding subscription. That
 * plugin does OAuth against auth.kimi.com; opencode handles the session
 * + headers. Our job is just to spawn opencode in a workdir and relay.
 *
 * To implement:
 *   1. Install opencode + the kimi-full plugin (see scripts/install-backends.sh)
 *   2. `opencode run --session <id> --plugin kimi-full` with the prompt on stdin
 *   3. Translate its event stream to ChatDelta
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

export class OpencodeBackend implements Backend {
  readonly name = 'opencode'

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m.startsWith('kimi-for-coding') || m.startsWith('opencode/')
  }

  async health(): Promise<BackendHealth> {
    return {
      name: this.name,
      state: 'unavailable',
      detail: 'opencode backend stubbed — see src/backends/opencode.ts',
    }
  }

  // eslint-disable-next-line require-yield
  async *chat(
    _req: ChatRequest,
    _session: SessionRecord | null,
    _signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    throw new BackendError('opencode backend not yet implemented', 'not_configured')
  }
}
