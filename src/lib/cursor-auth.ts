import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
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
