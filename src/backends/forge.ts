/**
 * Forge Code backend — stub. Forge (https://github.com/antinomyhq/forge)
 * is BYOK per-provider; runs your own keys through its harness. Less
 * subscription-arbitrage value than the paid CLIs, so wiring this up
 * is lower priority than claude / codex / opencode.
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import { hostSpawner } from '../executors/host.js'
import { versionHealth } from './health.js'

export interface ForgeBackendOptions {
  bin: string
  timeoutMs: number
}

export class ForgeBackend implements Backend {
  readonly name = 'forge'
  constructor(private readonly opts: ForgeBackendOptions) {}

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'forge' || m.startsWith('forge/')
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    return versionHealth(this.name, this.opts.bin, hostSpawner, undefined, signal)
  }

  // eslint-disable-next-line require-yield
  async *chat(
    _req: ChatRequest,
    _session: SessionRecord | null,
    _signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    throw new BackendError('forge backend stubbed — implement per forge CLI spec', 'not_configured')
  }
}
