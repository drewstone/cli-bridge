/**
 * opencode backend — drives the `opencode` CLI. Covers two concrete
 * uses:
 *
 *   1. Vanilla opencode (OpenCode's native workflow against whatever
 *      provider you've configured in `opencode auth`)
 *   2. Kimi Code via the `opencode-kimi-full` plugin — OAuth device
 *      flow against `auth.kimi.com`, Kimi For Coding subscription
 *
 * Model-prefix dispatch the implementation should respect:
 *   - `kimi-for-coding` → opencode with kimi-full plugin active
 *   - `opencode/...`    → opencode with the configured default provider
 *
 * To implement:
 *   1. Install opencode + (optionally) the kimi-full plugin
 *   2. `opencode run --session <id>` with the prompt via stdin
 *   3. Translate its streaming NDJSON event log to ChatDelta
 *      (text, tool_calls, final result)
 *   4. Session resume: `opencode resume <id>` with a prompt appended
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

export class OpencodeBackend implements Backend {
  readonly name = 'opencode'

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m.startsWith('kimi-for-coding') || m.startsWith('opencode/') || m.startsWith('kimi-code')
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
