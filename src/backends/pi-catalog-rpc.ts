import { spawn } from 'node:child_process'
import { killTree } from '../executors/process-tree.js'
import { piToolProcessEnvironment } from './pi-process-environment.js'

const RPC_TIMEOUT_MS = 15_000
const MAX_STDOUT_BYTES = 4 * 1024 * 1024

export interface PiCatalogModel {
  readonly id: string
  readonly provider: string
  readonly api: string
  readonly baseUrl: string
  readonly [key: string]: unknown
}

export function readPiSelectedModel(options: {
  bin: string
  provider: string
  model: string
  agentDir: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
}): Promise<PiCatalogModel> {
  return readPiSelectedModelAndClose(options)
}

async function readPiSelectedModelAndClose(options: {
  bin: string
  provider: string
  model: string
  agentDir: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
}): Promise<PiCatalogModel> {
  options.signal.throwIfAborted()
  const child = spawn(options.bin, [
    '--mode',
    'rpc',
    '--provider',
    options.provider,
    '--model',
    options.model,
    '--no-session',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-builtin-tools',
    '--offline',
  ], {
    detached: process.platform !== 'win32',
    env: {
      ...piToolProcessEnvironment(options.env, {}),
      PI_CODING_AGENT_DIR: options.agentDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    return await new Promise<PiCatalogModel>((resolve, reject) => {
      let stdout = ''
      let stdoutBytes = 0
      let settled = false
      const timeout = setTimeout(() => {
        fail(new Error('pi catalog RPC timed out'))
      }, RPC_TIMEOUT_MS)

      const cleanup = (): void => {
        clearTimeout(timeout)
        options.signal.removeEventListener('abort', onAbort)
        child.stdout.removeAllListeners()
        child.stderr.removeAllListeners()
        child.removeAllListeners()
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error instanceof Error ? error : new Error('pi catalog RPC failed'))
      }
      const succeed = (model: PiCatalogModel): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(model)
      }
      const onAbort = (): void => {
        fail(options.signal.reason ?? new Error('pi catalog request aborted'))
      }

      options.signal.addEventListener('abort', onAbort, { once: true })
      child.on('error', fail)
      child.on('close', (code) => {
        fail(new Error(`pi catalog RPC exited before returning the selected model (${code ?? 'signal'})`))
      })
      child.stderr.on('data', () => {
        // Do not retain diagnostics from a process that can read provider auth.
      })
      child.stdout.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString()
        stdoutBytes += Buffer.byteLength(text)
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          fail(new Error('pi catalog RPC exceeded its output limit'))
          return
        }
        stdout += text
        while (true) {
          const newline = stdout.indexOf('\n')
          if (newline < 0) break
          const line = stdout.slice(0, newline)
          stdout = stdout.slice(newline + 1)
          let model: PiCatalogModel | null
          try {
            model = selectedModelFromLine(line)
          } catch (error) {
            fail(error)
            return
          }
          if (model) {
            succeed(model)
            return
          }
        }
      })
      child.stdin.on('error', fail)
      child.stdin.write('{"type":"get_state"}\n', (error) => {
        if (error) fail(error)
      })
    })
  } finally {
    child.stdin.destroy()
    await killTree(child, { gracefulMs: 250 })
  }
}

function selectedModelFromLine(line: string): PiCatalogModel | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.type !== 'response' || parsed.command !== 'get_state') {
    return null
  }
  if (parsed.success !== true || !isRecord(parsed.data) || !isRecord(parsed.data.model)) {
    throw new Error('pi catalog RPC did not return a selected model')
  }
  const model = parsed.data.model
  if (
    typeof model.id !== 'string'
    || typeof model.provider !== 'string'
    || typeof model.api !== 'string'
    || typeof model.baseUrl !== 'string'
  ) {
    throw new Error('pi catalog RPC returned malformed model metadata')
  }
  return model as PiCatalogModel
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
