import type { AgentEnvironmentCapabilities } from '@tangle-network/agent-interface'
import type { BackendHealth, ChatDelta, ChatRequest, NativeSession, NativeSessionBackend } from './types.js'
import { versionHealth } from './health.js'
import { scopedHostSpawner } from '../executors/scoped-host.js'
import type { SessionRecord } from '../sessions/store.js'
import type { Spawner } from '../executors/types.js'
import { chatPi } from './pi-one-shot.js'
import { startPiNativeSession } from './pi-native-start.js'
import { piMcpAdapterAvailable, piNativeCapabilities, type PiBackendOptions } from './pi-config.js'

export type { PiBackendOptions } from './pi-config.js'
export { piMcpAdapterAvailable } from './pi-config.js'

export class PiBackend implements NativeSessionBackend {
  readonly name = 'pi'
  readonly nativeModes = ['byob'] as const
  private readonly spawner: Spawner

  constructor(private readonly opts: PiBackendOptions) {
    this.spawner = opts.spawner ?? scopedHostSpawner
  }

  matches(model: string): boolean {
    const normalized = model.toLowerCase()
    return normalized === 'pi' || normalized.startsWith('pi/')
  }

  async health(signal?: AbortSignal): Promise<BackendHealth> {
    return versionHealth(this.name, this.opts.bin, this.spawner, undefined, signal)
  }

  nativeCapabilities(): AgentEnvironmentCapabilities {
    return piNativeCapabilities()
  }

  startNativeSession(req: ChatRequest, session: SessionRecord | null, signal?: AbortSignal): Promise<NativeSession> {
    return startPiNativeSession(
      { bin: this.opts.bin, timeoutMs: this.opts.timeoutMs, spawner: this.spawner },
      req,
      session,
      signal,
    )
  }

  chat(req: ChatRequest, session: SessionRecord | null, signal: AbortSignal): AsyncIterable<ChatDelta> {
    return chatPi({ bin: this.opts.bin, timeoutMs: this.opts.timeoutMs, spawner: this.spawner }, req, session, signal)
  }
}
