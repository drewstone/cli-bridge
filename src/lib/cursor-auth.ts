import { constants } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** One protected source for execution and inventory; credentials never enter argv or receipts. */
export async function cursorEnvironment(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (env.CURSOR_API_KEY?.trim()) return { ...env }
  const path = env.CURSOR_API_KEY_FILE || join(env.HOME || homedir(), '.config/fleet/secrets/CURSOR_SERVICE_TOKEN')
  let file
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...env }; throw new Error('Cannot open protected Cursor token file') }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('Cursor token file must be owner-only and owned by the bridge user')
    const token = (await file.readFile('utf8')).trim()
    if (!token || /[\r\n\0]/u.test(token)) throw new Error('Cursor token file is empty or malformed')
    return { ...env, CURSOR_API_KEY: token }
  } finally { await file.close() }
}

/** A plan reading older than this cannot vouch for a window. */
const CURSOR_PLAN_READING_MAX_AGE_MS = 60 * 60_000
/** The highest window share a turn may start at; past it the plan's included usage may not cover the turn. */
const CURSOR_PLAN_WINDOW_LIMIT = 0.9

/**
 * Whether the enrolled Cursor token is a flat-rate plan's headless credential with room, from the
 * plan reading the seat manager writes (`CURSOR_PLAN_READING_FILE`: `{ ok, plan, windows: [{ used }] }`,
 * `used` in 0..1). It counts only while the reading is fresh, names a plan and every window is below
 * 90%. With no reading the token stays an API key, which the subscription guard refuses.
 */
export async function cursorPlanHasRoom(env: NodeJS.ProcessEnv, now = Date.now()): Promise<boolean> {
  const path = env.CURSOR_PLAN_READING_FILE
  if (!path?.trim()) return false
  try {
    if (now - (await stat(path)).mtimeMs > CURSOR_PLAN_READING_MAX_AGE_MS) return false
    const reading = JSON.parse(await readFile(path, 'utf8')) as { ok?: unknown; plan?: unknown; windows?: unknown }
    const windows = Array.isArray(reading.windows) ? reading.windows as Array<{ used?: unknown }> : []
    return reading.ok === true && typeof reading.plan === 'string' && reading.plan.trim() !== '' && windows.length > 0
      && windows.every((window) => typeof window?.used === 'number' && window.used >= 0 && window.used < CURSOR_PLAN_WINDOW_LIMIT)
  } catch {
    return false
  }
}
