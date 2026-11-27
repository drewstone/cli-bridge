import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionRecord } from '../sessions/store.js'
import type { ChatRequest } from './types.js'

/**
 * Graph nodes can share a cwd and jail HOME. OpenCode initializes SQLite before
 * serving a turn, so separate native sessions must not race on that HOME's cold
 * default database. Keep a stable file for every resumable Bridge session.
 * Existing native sessions predate this binding and remain in their original
 * default store; neither their bytes nor native IDs are migrated.
 */
export function opencodeDatabaseEnv(req: ChatRequest, session: SessionRecord | null): NodeJS.ProcessEnv {
  if (!req.jailSpec) return {}
  const externalId = req.session_id ?? session?.externalId
  if (!externalId) return {}
  const key = createHash('sha256').update(externalId).digest('hex')
  const database = join(req.jailSpec.root, '.local', 'share', 'opencode', `bridge-session-${key}.db`)
  if (session?.internalId && !existsSync(database)) return {}
  return { OPENCODE_DB: database }
}
