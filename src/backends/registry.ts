/**
 * Backend registry — resolves a model id to the backend that should
 * serve it. First-match wins; order registered is precedence.
 *
 * Precedence choice: CLI-backed backends BEFORE passthrough. If the
 * caller has `claude` installed and asks for `claude-3-5-sonnet`, they
 * get the subscription via Claude Code, not the metered API. That's the
 * whole point of cli-bridge.
 */

import type { Backend } from './types.js'

export class BackendRegistry {
  private readonly backends: Backend[] = []

  register(backend: Backend): this {
    this.backends.push(backend)
    return this
  }

  resolve(model: string): Backend | null {
    for (const b of this.backends) {
      if (b.matches(model)) return b
    }
    return null
  }

  byName(name: string): Backend | null {
    return this.backends.find(b => b.name === name) ?? null
  }

  all(): readonly Backend[] {
    return this.backends
  }
}
