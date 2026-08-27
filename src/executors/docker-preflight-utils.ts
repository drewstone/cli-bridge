import { throwIfExecutorAborted } from './types.js'
import type { DockerCli } from './docker-cli.js'

export function firstLine(text: string): string { return text.split('\n').map(line => line.trim()).find(Boolean) ?? '' }
export function compact(text: string): string { return text.split('\n').map(line => line.trim()).filter(Boolean).join(' ') }
export function shellQuote(value: string): string { return `'${value.replace(/'/gu, `'\\''`)}'` }

export async function runDockerCli(cli: DockerCli, args: string[], signal?: AbortSignal, timeoutMs?: number): Promise<Awaited<ReturnType<DockerCli>>> {
  throwIfExecutorAborted(signal)
  const result = await cli(args, { ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(signal ? { signal } : {}) })
  throwIfExecutorAborted(signal)
  return result
}
