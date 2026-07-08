/**
 * Forge Code backend — stub. Forge (https://github.com/antinomyhq/forge,
 * binary `forgecode`) is BYOK per-provider; runs your own keys through
 * its harness. Two properties make it lower-leverage than the other CLIs
 * and keep chat() unimplemented for now: it emits only plain-text stdout
 * on the `-p` run path (weaker tool-call telemetry), and it mounts MCP
 * via `forgecode mcp import` into GLOBAL config (per-run mounting is
 * stateful and concurrency-unsafe). Health + bin resolution are wired so
 * the backend reports availability correctly.
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import { hostSpawner } from '../executors/host.js'
import type { Spawner } from '../executors/types.js'
import { versionHealth } from './health.js'

export interface ForgeBackendOptions {
  bin: string
  timeoutMs: number
  /** Subprocess spawner. Defaults to host spawn. */
  spawner?: Spawner
}

export class ForgeBackend implements Backend {
  readonly name = 'forge'
  private readonly spawner: Spawner
  constructor(private readonly opts: ForgeBackendOptions) {
    this.spawner = opts.spawner ?? hostSpawner
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'forge' || m.startsWith('forge/')
  }

  async health(): Promise<BackendHealth> {
    return versionHealth(this.name, this.opts.bin, this.spawner)
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
