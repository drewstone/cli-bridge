import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { ContextTransferRequest } from '@tangle-network/agent-interface'
import { CodexContextTransfer } from '../src/backends/codex-context-transfer.js'
import type { SpawnResult } from '../src/executors/types.js'

const nativeId = '019f3889-c05e-70c3-ae9f-3077da9454c4'
// These tests isolate the transport; canonical admission and real model input
// are exercised by the receiver and pinned-binary consumer suites.
const request = {
  workspace: { cwd: { base: 'host', path: '/tmp/native-context-fixture' } },
  plan: { context: { messages: [
    { role: 'user', parts: [{ type: 'text', text: 'portable user marker' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'portable assistant marker' }] },
  ] } },
} as unknown as ContextTransferRequest

class Child extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
}

function transport(controller: AbortController, respond: (message: Record<string, unknown>, child: Child) => void) {
  const child = new Child()
  const commands: Record<string, unknown>[] = []
  let releases = 0
  let terminations = 0
  let cleanups = 0
  child.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split('\n')) {
      const message = JSON.parse(line) as Record<string, unknown>
      commands.push(message)
      queueMicrotask(() => respond(message, child))
    }
  })
  const client = new CodexContextTransfer({
    child: child as unknown as SpawnResult['child'],
    release: () => { releases += 1 },
    terminate: async () => { terminations += 1; child.emit('close', 0) },
  }, request, controller.signal, () => { cleanups += 1 })
  return { client, commands, counts: () => ({ releases, terminations, cleanups }) }
}

function acknowledge(message: Record<string, unknown>, child: Child): void {
  if (!message.method || message.method === 'initialized') return
  const result = message.method === 'thread/start'
    ? { thread: { id: nativeId, createdAt: 1_775_000_000 } }
    : {}
  child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`)
}

describe('Codex native import transport', () => {
  it('rejects a disconnected native injection and closes its owned process once', async () => {
    const fixture = transport(new AbortController(), (message, child) => {
      if (message.method === 'thread/inject_items') child.emit('close', 1)
      else acknowledge(message, child)
    })
    try {
      await fixture.client.initialize()
      const before = Date.now()
      const created = await fixture.client.createSession()
      expect(created.nativeSessionId).toBe(nativeId)
      // Codex reports whole seconds; the receipt orders creation after acceptance with the observed ACK time.
      expect(Date.parse(created.createdAt)).toBeGreaterThanOrEqual(before)
      await expect(fixture.client.importHistory(nativeId)).rejects.toThrow(/closed before acknowledgement/)
      expect(fixture.commands.map((command) => command.method)).toEqual(['initialize', 'initialized', 'thread/start', 'thread/inject_items'])
    } finally {
      await fixture.client.close()
      await fixture.client.close()
      expect(fixture.counts()).toEqual({ releases: 1, terminations: 1, cleanups: 1 })
    }
  })

  it('returns a bounded rejection without exposing an untrusted native error', async () => {
    const fixture = transport(new AbortController(), (message, child) => {
      if (message.method === 'thread/inject_items') {
        child.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32000, message: 'private-untrusted-native-diagnostic' } })}\n`)
      } else acknowledge(message, child)
    })
    try {
      await fixture.client.initialize()
      await fixture.client.createSession()
      await expect(fixture.client.importHistory(nativeId)).rejects.toThrow('Codex app-server rejected the native import request')
    } finally { await fixture.client.close() }
  })

  it('cancels initialization before creating a native thread or starting a model turn', async () => {
    const controller = new AbortController()
    const fixture = transport(controller, () => {})
    const initializing = fixture.client.initialize()
    controller.abort()
    await expect(initializing).rejects.toThrow(/cancelled/)
    await fixture.client.close()
    expect(fixture.commands.map((command) => command.method)).toEqual(['initialize'])
    expect(fixture.counts()).toEqual({ releases: 1, terminations: 1, cleanups: 1 })
  })
})
