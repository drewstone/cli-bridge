import type { EnforcedNetJail } from '../jail/enforce-net-jail.js'

export interface BuildAppExtras {
  /** Disposers to await on graceful shutdown — pool teardown lives here. */
  shutdownHooks: Array<() => Promise<void>>
  /** Backends with a provisioned and verified network jail. */
  netJail: Map<string, EnforcedNetJail>
}

export interface StartServerOptions {
  /** Additional lifecycle cleanup, primarily for embedders and real-process tests. */
  shutdownHooks?: Array<() => Promise<void>>
  /** One absolute signal-to-exit deadline shared by all cleanup work. */
  shutdownTimeoutMs?: number
}

export interface BuiltServer {
  app: import('hono').Hono
  sessions: import('../sessions/store.js').SessionStore
  registry: import('../backends/registry.js').BackendRegistry
  runs: import('../runs/registry.js').RunRegistry
  catalog: import('../profiles/loader.js').ProfileCatalog
  extras: BuildAppExtras
}
