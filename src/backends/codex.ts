/**
 * Codex CLI backend — stub.
 *
 * OpenAI's Codex CLI has a `codex exec` subcommand with a documented
 * JSON protocol, but session resume + streaming are less stable than
 * Claude Code's. Wire this up when needed.
 *
 * To implement: mirror the shape of claude.ts. `codex exec --session-id
 * <id> --output json` prints NDJSON; translate its `message` and `usage`
 * events to ChatDelta.
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

export class CodexBackend implements Backend {
  readonly name = 'codex'

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m.startsWith('codex') || m.startsWith('gpt-5-codex')
  }

  async health(): Promise<BackendHealth> {
    return {
      name: this.name,
      state: 'unavailable',
      detail: 'codex backend stubbed — see src/backends/codex.ts',
    }
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
