import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

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

export async function waitForProcessClose(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode
  return await new Promise((resolve) => {
    child.once('close', (code) => resolve(typeof code === 'number' ? code : null))
  })
}
