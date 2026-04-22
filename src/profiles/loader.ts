/**
 * AgentProfile catalog loader — reads JSON files from a directory, one
 * per profile. The id is the basename without `.json`.
 *
 * Profiles are loaded eagerly at server start so list / lookup are
 * synchronous + fast. Add a watch later if hot-reload becomes useful.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import type { AgentProfile } from '@tangle-network/sandbox'

export interface ProfileEntry {
  id: string
  profile: AgentProfile
  path: string
  loadedAt: string
}

export interface ProfileCatalog {
  list(): ProfileEntry[]
  get(id: string): AgentProfile | null
  reload(): void
}

export function createProfileCatalog(dir: string): ProfileCatalog {
  let entries: ProfileEntry[] = []

  function load(): void {
    entries = []
    if (!existsSync(dir)) return
    let st
    try { st = statSync(dir) } catch { return }
    if (!st.isDirectory()) return

    for (const name of readdirSync(dir)) {
      if (extname(name) !== '.json') continue
      const id = basename(name, '.json')
      const path = join(dir, name)
      try {
        const raw = readFileSync(path, 'utf8')
        const profile = JSON.parse(raw) as AgentProfile
        entries.push({ id, profile, path, loadedAt: new Date().toISOString() })
      } catch (err) {
        // Skip malformed profiles; surface via console so operator notices.
        console.warn(`[profiles] skipped ${path}: ${(err as Error).message}`)
      }
    }
  }

  load()

  return {
    list: () => entries.slice(),
    get: (id) => entries.find((e) => e.id === id)?.profile ?? null,
    reload: load,
  }
}
