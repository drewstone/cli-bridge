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

export const nativeIdentifier = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value) ? value : undefined
