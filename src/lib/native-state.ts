import { join, resolve } from 'node:path'
import { backendHome } from '../jail/auth-preserve.js'
import { findGitDir } from '../jail/types.js'
import { readFile } from 'node:fs/promises'

export const nativeObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export function nativeJson(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('native state is not an object')
  return value as Record<string, unknown>
}
export async function readNativeState(path: string): Promise<Record<string, unknown>> {
  try { return nativeJson(await readFile(path, 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

/** Project exactly the read-only native settings selectors, then resolve their effective environment once. */
export async function readClaudeNativeContext(options: { cwd: string; env: NodeJS.ProcessEnv; flags: readonly string[] }) {
  const flags = options.flags.flatMap((flag, index) => flag === '--settings' || flag === '--setting-sources' ? [flag, options.flags[index + 1] ?? ''] : [])
  const root = findGitDir(options.cwd)?.repoRoot ?? options.cwd
  const index = flags.lastIndexOf('--setting-sources')
  const sources = (index < 0 ? 'user,project,local' : flags[index + 1] ?? '').split(',')
  const paths = [sources.includes('user') ? join(options.env.CLAUDE_CONFIG_DIR || join(options.env.HOME || backendHome(), '.claude'), 'settings.json') : null,
    sources.includes('project') ? join(root, '.claude/settings.json') : null, sources.includes('local') ? join(root, '.claude/settings.local.json') : null,
    ...flags.flatMap((flag, index) => flag === '--settings' && !flags[index + 1]!.trimStart().startsWith('{') ? [resolve(options.cwd, flags[index + 1]!)] : [])]
  const settings = await Promise.all(paths.filter((path): path is string => path !== null).map(readNativeState))
  for (let index = 0; index < flags.length; index++) if (flags[index] === '--settings' && flags[index + 1]!.trimStart().startsWith('{')) settings.push(nativeObject(JSON.parse(flags[index + 1]!)))
  return { settings, flags, env: Object.assign({}, options.env, ...settings.map((item) => nativeObject(item.env))) as NodeJS.ProcessEnv }
}
