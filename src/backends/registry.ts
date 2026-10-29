/** Ordered backend lookup for registered local harnesses and sandbox execution. */

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
