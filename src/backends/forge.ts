/**
 * Forge Code backend — stub.
 *
 * Model id scheme: `forge/<provider>/<model>` — Forge is OSS,
 * multi-provider, BYOK. Typical ids: `forge/anthropic/claude-sonnet-4-5`,
 * `forge/openai/gpt-4o`.
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

export class ForgeBackend implements Backend {
  readonly name = 'forge'

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'forge' || m.startsWith('forge/')
  }

  async health(): Promise<BackendHealth> {
    return { name: this.name, state: 'unavailable', detail: 'forge backend stubbed' }
  }

  // eslint-disable-next-line require-yield
  async *chat(
    _req: ChatRequest,
    _session: SessionRecord | null,
    _signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    throw new BackendError('forge backend not yet implemented', 'not_configured')
  }
}
