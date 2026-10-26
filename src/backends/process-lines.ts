import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { finished } from 'node:stream/promises'
import { describeCliExit, type SpawnResult } from '../executors/types.js'
import { classifyHarnessFailure, throwHarnessFailure } from './harness-failure.js'

export type ProcessLineEvent =
  | { kind: 'line'; line: string }
  | { kind: 'progress'; seq: number; elapsedMs: number }

interface ReadProcessLinesOptions {
  child: ChildProcess
  stdout: NodeJS.ReadableStream
  progressIntervalMs?: number
}

export async function* readProcessLines(
  opts: ReadProcessLinesOptions,
): AsyncIterable<ProcessLineEvent> {
  const rl = createInterface({ input: opts.stdout })
  const lineIter = rl[Symbol.asyncIterator]()
  const readLine = (): Promise<{ kind: 'line'; result: IteratorResult<string> }> =>
    lineIter.next().then((result) => ({ kind: 'line' as const, result }))
  let lineReady = readLine()
  let progressSeq = 0
  const progressIntervalMs = opts.progressIntervalMs
  let closeTimer: ReturnType<typeof setTimeout> | undefined

  // A child can close without ending its stdout stream cleanly. Close readline
  // after a short drain window so the pending iterator read resolves as done.
  // Do not race every line against one shared close promise: each Promise.race
  // attaches another reaction to that unresolved promise and retains the whole
  // chain until process exit.
  const closeAfterDrain = (): void => {
    if (closeTimer) return
    closeTimer = setTimeout(() => rl.close(), 50)
    closeTimer.unref?.()
  }
  opts.child.once('close', closeAfterDrain)
  if (opts.child.exitCode !== null) closeAfterDrain()

  try {
    while (true) {
      let progressTimer: ReturnType<typeof setTimeout> | undefined
      const races: Array<Promise<
        | { kind: 'line'; result: IteratorResult<string> }
        | { kind: 'progress' }
      >> = [
        lineReady,
      ]

      if (progressIntervalMs !== undefined) {
        races.push(new Promise((resolve) => {
          progressTimer = setTimeout(() => resolve({ kind: 'progress' as const }), progressIntervalMs)
          progressTimer.unref?.()
        }))
      }

      let next: Awaited<(typeof races)[number]>
      try {
        next = await Promise.race(races)
      } finally {
        // A busy subprocess normally wins this race with stdout. Leaving the
        // losing timer alive once per event made memory scale with stream rate:
        // 200,000 Pi events retained 538 MB until their 30-second timers fired.
        // Only the one timer for the current wait may remain live.
        if (progressTimer) clearTimeout(progressTimer)
      }
      if (next.kind === 'progress') {
        progressSeq += 1
        yield {
          kind: 'progress',
          seq: progressSeq,
          elapsedMs: progressSeq * progressIntervalMs!,
        }
        continue
      }

      lineReady = readLine()
      const { value, done } = next.result
      if (done) break
      yield { kind: 'line', line: value }
    }
  } finally {
    opts.child.off('close', closeAfterDrain)
    if (closeTimer) clearTimeout(closeTimer)
    rl.close()
  }
}

/** How a child ended: its exit status, or `code: null` and the signal that killed it. */
export interface ProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
}

/**
 * A `code: null` result is a process that never reported an exit status, so the
 * turn it was running is incomplete. Callers must report it as a failure, never
 * as a clean stop: the stream readers once skipped `null` beside `0`, and a
 * Claude Code turn killed by a signal mid-tool reached clients as `stop`.
 */
export async function waitForProcessClose(child: ChildProcess): Promise<ProcessExit> {
  // A signal death leaves `exitCode` null, so checking it alone waited forever
  // for a 'close' that had already fired before the stream reader finished.
  const signalCode = typeof child.signalCode === 'string' ? child.signalCode : null
  if (child.exitCode !== null || signalCode !== null) {
    await Promise.all([child.stdout, child.stderr].filter((stream) => stream !== null).map(
      (stream) => finished(stream!, { readable: true, writable: false, cleanup: true }),
    ))
    return { code: child.exitCode, signal: signalCode }
  }
  return await new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({
      code: typeof code === 'number' ? code : null,
      signal: typeof signal === 'string' ? signal : null,
    }))
  })
}

/** Called only after the native protocol reader reaches EOF; never drain over unread frames. */
export async function assertSuccessfulHarnessExit(
  spawned: SpawnResult,
  label: string,
  diagnostics: () => string,
): Promise<void> {
  const exit = await waitForProcessClose(spawned.child)
  const failure = classifyHarnessFailure(exit, diagnostics())
  if (failure) {
    const message = await describeCliExit(spawned, label, exit.code, failure.message, exit.signal)
    throwHarnessFailure({ ...failure, message })
  }
}
