import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readProcessLines, waitForProcessClose } from '../src/backends/process-lines.js'

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
}

describe('waitForProcessClose', () => {
  it('returns at once for a child that already closed after a signal death', async () => {
    // Node leaves `exitCode` null after a signal. Checking only `exitCode` waited
    // for another 'close' event, so this read never returned.
    const child = new FakeChild()
    child.signalCode = 'SIGKILL'
    child.emit('close', null, 'SIGKILL')

    await expect(waitForProcessClose(child as never)).resolves.toEqual({ code: null, signal: 'SIGKILL' })
  })

  it('reports the exit status or signal from a later close event', async () => {
    const killed = new FakeChild()
    const killedExit = waitForProcessClose(killed as never)
    killed.emit('close', null, 'SIGTERM')
    await expect(killedExit).resolves.toEqual({ code: null, signal: 'SIGTERM' })

    const exited = new FakeChild()
    const exitedExit = waitForProcessClose(exited as never)
    exited.emit('close', 0, null)
    await expect(exitedExit).resolves.toEqual({ code: 0, signal: null })
  })
})

describe('readProcessLines', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels the losing progress timer after every stdout line', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const stdout = new PassThrough()
    const iterator = readProcessLines({
      child: child as never,
      stdout,
      progressIntervalMs: 30_000,
    })[Symbol.asyncIterator]()

    for (let index = 0; index < 1_000; index += 1) {
      const pending = iterator.next()
      stdout.write(`line-${index}\n`)
      await expect(pending).resolves.toEqual({
        done: false,
        value: { kind: 'line', line: `line-${index}` },
      })
      expect(vi.getTimerCount()).toBe(0)
    }

    await iterator.return?.()
    stdout.destroy()
  })

  it('emits repeated progress while one pending line read remains idle', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const stdout = new PassThrough()
    const iterator = readProcessLines({
      child: child as never,
      stdout,
      progressIntervalMs: 50,
    })[Symbol.asyncIterator]()

    const firstProgress = iterator.next()
    await vi.advanceTimersByTimeAsync(50)
    await expect(firstProgress).resolves.toEqual({
      done: false,
      value: { kind: 'progress', seq: 1, elapsedMs: 50 },
    })

    const secondProgress = iterator.next()
    await vi.advanceTimersByTimeAsync(50)
    await expect(secondProgress).resolves.toEqual({
      done: false,
      value: { kind: 'progress', seq: 2, elapsedMs: 100 },
    })

    const line = iterator.next()
    stdout.write('alive\n')
    await expect(line).resolves.toEqual({
      done: false,
      value: { kind: 'line', line: 'alive' },
    })
    expect(vi.getTimerCount()).toBe(0)

    await iterator.return?.()
    stdout.destroy()
  })

  it('ends after a child closes even when stdout never emits end', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const stdout = new PassThrough()
    const iterator = readProcessLines({
      child: child as never,
      stdout,
      progressIntervalMs: 30_000,
    })[Symbol.asyncIterator]()

    const pending = iterator.next()
    child.exitCode = 0
    child.emit('close', 0)
    await vi.advanceTimersByTimeAsync(50)

    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    expect(vi.getTimerCount()).toBe(0)
    stdout.destroy()
  })
})
