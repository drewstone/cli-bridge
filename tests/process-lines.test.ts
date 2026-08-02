import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readProcessLines } from '../src/backends/process-lines.js'

class FakeChild extends EventEmitter {
  exitCode: number | null = null
}

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
