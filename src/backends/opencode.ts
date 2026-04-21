/**
 * opencode backend — stub.
 *
 * Model id scheme: `opencode/<rest>` where `<rest>` is opencode's own
 * model spec (provider/model like `anthropic/claude-sonnet-4-5` or a
 * plugin alias like `kimi-for-coding`). opencode resolves it via its
 * configured auth.
 *
 * This is also the vehicle for Kimi Code: once `opencode-kimi-full` is
 * installed + OAuth'd, `opencode/kimi-for-coding` routes through your
 * Kimi For Coding subscription. (Moonshot gates that subscription to
 * approved coding agents — opencode is one, a direct HTTP forward is
 * not, which is why the opencode harness is the right path.)
 *
 * To implement: `opencode run --session <id>` with prompt on stdin,
 * translate its streaming NDJSON event log to ChatDelta.
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

export class OpencodeBackend implements Backend {
  readonly name = 'opencode'

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'opencode' || m.startsWith('opencode/')
  }

  async health(): Promise<BackendHealth> {
    return { name: this.name, state: 'unavailable', detail: 'opencode backend stubbed' }
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
