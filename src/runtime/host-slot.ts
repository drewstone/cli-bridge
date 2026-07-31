import { constants as fsConstants, closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AdmissionRejectedError } from '../admission.js'

export interface HostSlotOptions {
  name: string
  maxActive: number
  lockDir: string
  queueTimeoutMs: number
  pollMs?: number
}

export interface HostSlotLease {
  release(): void
}

interface HostSlotLock {
  pid: number
  token: string
  at: string
  name: string
  slot: number
}

const DEFAULT_POLL_MS = 100

export async function acquireHostSlot(options: HostSlotOptions, signal?: AbortSignal): Promise<HostSlotLease> {
  validateOptions(options)
  mkdirSync(options.lockDir, { recursive: true, mode: 0o700 })

  const started = Date.now()
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  while (true) {
    if (signal?.aborted) {
      throw rejected(options, 'host slot acquisition aborted before queueing', 'aborted')
    }

    const lease = tryAcquireAnySlot(options)
    if (lease) return lease

    const elapsed = Date.now() - started
    if (options.queueTimeoutMs === 0 || elapsed >= options.queueTimeoutMs) {
      throw rejected(
        options,
        `${options.name} host slot timed out after ${options.queueTimeoutMs}ms`,
        'queue_timeout',
      )
    }

    await sleep(Math.min(pollMs, options.queueTimeoutMs - elapsed), signal, options)
  }
}

function tryAcquireAnySlot(options: HostSlotOptions): HostSlotLease | null {
  for (let slot = 0; slot < options.maxActive; slot += 1) {
    const lease = tryAcquireSlot(options, slot)
    if (lease) return lease
  }
  return null
}

function tryAcquireSlot(options: HostSlotOptions, slot: number, attempt = 0): HostSlotLease | null {
  const path = slotPath(options, slot)
  const token = randomUUID()
  let fd: number
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const holder = readLock(path)
    if (holder && isAlive(holder.pid)) return null
    if (attempt >= 2) return null
    try { unlinkSync(path) } catch {}
    return tryAcquireSlot(options, slot, attempt + 1)
  }

  const lock: HostSlotLock = {
    pid: process.pid,
    token,
    at: new Date().toISOString(),
    name: options.name,
    slot,
  }
  try {
    writeSync(fd, `${JSON.stringify(lock)}\n`)
  } finally {
    closeSync(fd)
  }

  let released = false
  return {
    release(): void {
      if (released) return
      released = true
      const current = readLock(path)
      if (current?.pid === process.pid && current.token === token) {
        try { unlinkSync(path) } catch {}
      }
    },
  }
}

function sleep(ms: number, signal: AbortSignal | undefined, options: HostSlotOptions): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(rejected(options, 'host slot acquisition aborted while queued', 'aborted'))
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(rejected(options, 'host slot acquisition aborted while queued', 'aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function rejected(
  options: HostSlotOptions,
  message: string,
  reason: AdmissionRejectedError['reason'],
): AdmissionRejectedError {
  return new AdmissionRejectedError(message, reason, {
    active: countActiveSlots(options),
    queued: 0,
    maxActive: options.maxActive,
    maxQueue: 0,
  })
}

function countActiveSlots(options: HostSlotOptions): number {
  let active = 0
  for (let slot = 0; slot < options.maxActive; slot += 1) {
    const lock = readLock(slotPath(options, slot))
    if (lock && isAlive(lock.pid)) active += 1
  }
  return active
}

function readLock(path: string): HostSlotLock | null {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<HostSlotLock>
    return typeof parsed.pid === 'number' && parsed.pid > 0 && typeof parsed.token === 'string'
      ? parsed as HostSlotLock
      : null
  } catch {
    try {
      const stat = statSync(path)
      if (Date.now() - stat.mtimeMs > 60_000) unlinkSync(path)
    } catch {}
    return null
  }
}

function slotPath(options: HostSlotOptions, slot: number): string {
  return join(options.lockDir, `${safeSegment(options.name)}-${slot}.json`)
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80) || 'slot'
}

function validateOptions(options: HostSlotOptions): void {
  if (!Number.isInteger(options.maxActive) || options.maxActive < 1) {
    throw new Error(`invalid maxActive: ${options.maxActive}`)
  }
  if (!Number.isInteger(options.queueTimeoutMs) || options.queueTimeoutMs < 0) {
    throw new Error(`invalid queueTimeoutMs: ${options.queueTimeoutMs}`)
  }
  if (!options.lockDir) {
    throw new Error('host slot lockDir is required')
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
