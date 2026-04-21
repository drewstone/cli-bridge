/**
 * Codex CLI backend — stub.
 *
 * Model id scheme: `codex/<model>` where `<model>` is Codex's native
 * model name (default `gpt-5-codex`, or whatever the subscription
 * surfaces). `codex` alone defaults to the subscription's default.
 *
 * To implement: `codex exec --model <model> --session <id>` with the
 * prompt on stdin, parse its NDJSON event stream to ChatDelta.
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

export class CodexBackend implements Backend {
  readonly name = 'codex'

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'codex' || m.startsWith('codex/')
  }

  async health(): Promise<BackendHealth> {
    return { name: this.name, state: 'unavailable', detail: 'codex backend stubbed' }
  }

  // eslint-disable-next-line require-yield
  async *chat(
    _req: ChatRequest,
    _session: SessionRecord | null,
    _signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    throw new BackendError('codex backend not yet implemented', 'not_configured')
  }
}
