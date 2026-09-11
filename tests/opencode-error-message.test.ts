import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { OpencodeBackend } from '../src/backends/opencode.js'
import type { ChatRequest } from '../src/backends/types.js'
import type { SpawnResult, Spawner } from '../src/executors/types.js'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  exitCode: number | null = null
}

function streamingSpawner(lines: Array<Record<string, unknown>>): Spawner {
  return async (): Promise<SpawnResult> => {
    const child = new FakeChild()
    queueMicrotask(() => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`)
      child.stdout.end()
      child.stderr.end()
      setTimeout(() => {
        child.exitCode = 0
        child.emit('close', 0)
      }, 10)
    })
    return { child: child as never, release() {}, spawnError: () => null }
  }
}

/**
 * Every opencode error is a NamedError: `{ name, data: { message, ... } }`. There is no
 * top-level `error.message` on any of them, and opencode's own reader takes `data.message`
 * first. Reading only `error.message` therefore missed every error and reported each one as
 * a raw JSON dump truncated at 400 chars — which is exactly where `data` got cut off.
 */
describe('opencode error event message extraction', () => {
  const errorFrom = async (event: Record<string, unknown>): Promise<string> => {
    const backend = new OpencodeBackend({
      bin: 'opencode',
      timeoutMs: 0,
      spawner: streamingSpawner([event]),
    } as unknown as ConstructorParameters<typeof OpencodeBackend>[0])
    const request = {
      model: 'opencode/zai-coding-plan/glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as ChatRequest
    try {
      for await (const _ of backend.chat(request, null, new AbortController().signal)) { /* drain */ }
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    return ''
  }

  it('reads the provider message out of error.data.message', async () => {
    const message = await errorFrom({
      type: 'error',
      timestamp: 1789101762046,
      sessionID: 'ses_test',
      error: {
        name: 'APIError',
        data: { message: 'Rate limit reached for requests', statusCode: 429, isRetryable: true },
      },
    })
    expect(message).toContain('Rate limit reached for requests')
    expect(message).not.toContain('without a message')
  })

  it('still reads a top-level error.message when one is present', async () => {
    const message = await errorFrom({ type: 'error', error: { message: 'plain top-level message' } })
    expect(message).toContain('plain top-level message')
  })

  it('falls back to the error name rather than dumping the raw event', async () => {
    const message = await errorFrom({ type: 'error', error: { name: 'ProviderAuthError' } })
    expect(message).toContain('ProviderAuthError')
    expect(message).not.toContain('without a message')
  })

  it('keeps the raw-event fallback when the event carries no readable error at all', async () => {
    const message = await errorFrom({ type: 'error', error: {} })
    expect(message).toContain('without a message')
  })
})
