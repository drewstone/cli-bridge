import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { PiNativeSession, redactedStderrTail } from '../src/backends/pi-native-session.js'

class ExitingPiChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
}

function sessionFor(child: ExitingPiChild): PiNativeSession {
  return new PiNativeSession({
    child: child as never,
    release: () => {},
    terminate: async () => {},
  }, {
    capabilities: {} as never,
    requestTimeoutMs: 1_000,
    cleanup: () => {},
  })
}

function closeReason(session: PiNativeSession): Promise<Error> {
  return new Promise(resolve => session.onClose(resolve))
}

describe('pi RPC terminal error carries a redacted stderr tail', () => {
  it('reports the EROFS stderr line when stdout ends before stderr drains', async () => {
    const child = new ExitingPiChild()
    const session = sessionFor(child)
    const reason = closeReason(session)

    child.stderr.write('Authorization: Bearer secret-token-value\n')
    child.stderr.write('using key sk-ant-abcdefghijklmnop\n')
    // stdout closes first; the fatal line lands on stderr afterwards.
    child.stdout.end()
    setTimeout(() => {
      child.stderr.end("Error: EROFS: read-only file system, open '/state/sessions/s.jsonl'\n")
    }, 20)

    const error = await reason
    expect(error.message).toMatch(/^pi RPC stdout ended: /u)
    expect(error.message).toContain("EROFS: read-only file system, open '/state/sessions/s.jsonl'")
    expect(error.message).not.toContain('secret-token-value')
    expect(error.message).not.toContain('abcdefghijklmnop')
    expect(error.message).toContain('Bearer <redacted>')
  })

  it('keeps the bare reason when stderr is empty', async () => {
    const child = new ExitingPiChild()
    const session = sessionFor(child)
    const reason = closeReason(session)
    child.stderr.end()
    child.stdout.end()
    expect((await reason).message).toBe('pi RPC stdout ended')
  })

  it('bounds the tail to the last characters and strips control sequences', () => {
    const noisy = `${'x'.repeat(5_000)}\n\u001b[31mfatal: EROFS\u001b[0m\n`
    const tail = redactedStderrTail(noisy, 100)
    expect(tail.length).toBeLessThanOrEqual(103)
    expect(tail.endsWith('fatal: EROFS')).toBe(true)
    expect(tail).not.toContain('\u001b')
    expect(redactedStderrTail('PI_API_KEY=abc123def token: "zzz999"')).toBe('PI_API_KEY=<redacted> token: "<redacted>"')
    // Assembled at runtime so the fixture does not trip the repository's secret scanner.
    for (const variant of ['b', 'c', 'e']) {
      expect(redactedStderrTail(`leaked ${['xox', variant, '-1234567890-abc'].join('')}`)).toBe('leaked <redacted>')
    }
  })
})
