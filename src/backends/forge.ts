/**
 * Forge Code backend — stub.
 *
 * Forge (https://github.com/antinomyhq/forge) is an OSS coding CLI.
 * It talks to providers directly (BYOK) but has nice session + tool
 * plumbing worth wrapping if you want to unify its workflow with the
 * proprietary CLIs on the same cli-bridge endpoint.
 *
 * To implement: `forge` binary on $PATH, invoke non-interactively,
 * capture output stream, translate to ChatDelta.
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

export class ForgeBackend implements Backend {
  readonly name = 'forge'

  matches(model: string): boolean {
    return model.toLowerCase().startsWith('forge/')
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
