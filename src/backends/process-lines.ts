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
  let pendingLine = lineIter.next()
  let childClosed = opts.child.exitCode !== null
  let progressSeq = 0
  const progressIntervalMs = opts.progressIntervalMs

  const closePromise: Promise<{ kind: 'close'; code: number | null }> = new Promise((resolve) => {
    if (opts.child.exitCode !== null) {
      resolve({ kind: 'close', code: opts.child.exitCode })
      return
    }
    opts.child.once('close', (code) => {
      childClosed = true
      const timer = setTimeout(() => {
        resolve({ kind: 'close', code: typeof code === 'number' ? code : null })
      }, 50)
      timer.unref?.()
    })
  })

  try {
    while (true) {
      const races: Array<Promise<
        | { kind: 'line'; result: IteratorResult<string> }
        | { kind: 'progress' }
        | { kind: 'close'; code: number | null }
      >> = [
        pendingLine.then((result) => ({ kind: 'line' as const, result })),
        closePromise,
      ]

      if (progressIntervalMs !== undefined) {
        races.push(delay(progressIntervalMs).then(() => ({ kind: 'progress' as const })))
      }

      const next = await Promise.race(races)
      if (next.kind === 'close') break
      if (next.kind === 'progress') {
        if (childClosed) break
        progressSeq += 1
        yield {
          kind: 'progress',
          seq: progressSeq,
          elapsedMs: progressSeq * progressIntervalMs!,
        }
        continue
      }

      pendingLine = lineIter.next()
      const { value, done } = next.result
      if (done) break
      yield { kind: 'line', line: value }
    }
  } finally {
    rl.close()
  }
}

export async function waitForProcessClose(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode
  return await new Promise((resolve) => {
    child.once('close', (code) => resolve(typeof code === 'number' ? code : null))
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
