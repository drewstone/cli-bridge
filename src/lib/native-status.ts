import { spawn } from 'node:child_process'
import { killTree, killTreeSync } from '../executors/process-tree.js'

export interface NativeStatus { code: number | string; stdout: string; stderr: string }

/** Bounded native status/list process; never invokes a model or returns credentials publicly. */
export function probeNativeStatus(bin: string, args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv }): Promise<NativeStatus> {
  return new Promise<NativeStatus>((resolve, reject) => {
    if (options.signal?.aborted) { resolve({ code: 'ABORT_ERR', stdout: '', stderr: '' }); return }
    let interrupted: string | undefined
    const stop = (cause: string) => { interrupted = cause; killTreeSync(child, 'SIGKILL') }
    const onAbort = () => stop('ABORT_ERR')
    const child = spawn(bin, [...args], { cwd: options.cwd, env: options.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = '', bytes = 0, spawnError: string | undefined
    const collect = (text: string, error: boolean) => {
      bytes += Buffer.byteLength(text)
      if (bytes > 65536) { stop('OUTPUT_LIMIT'); return }
      if (error) stderr += text
      else stdout += text
    }
    child.stdout.setEncoding('utf8').on('data', (text: string) => collect(text, false))
    child.stderr.setEncoding('utf8').on('data', (text: string) => collect(text, true))
    child.once('error', (error: NodeJS.ErrnoException) => { spawnError = error.code ?? 'unknown' })
    child.once('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      void killTree(child, { gracefulMs: 0 }).then(() =>
        resolve({ code: interrupted ?? spawnError ?? code ?? 'unknown', stdout, stderr }), reject)
    })
    const timer = setTimeout(() => stop('ETIMEDOUT'), options.timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
  })
}
