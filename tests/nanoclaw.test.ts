/**
 * NanoclawBackend tests — drive the backend against a REAL Unix-socket server that
 * speaks NanoClaw's CLI-channel protocol ({"text":...} in, {"text":...} out, then
 * silence). Real socket I/O, the exact protocol — verifies the client end-to-end
 * without the NanoClaw daemon (which needs a wired agent group).
 */
import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NanoclawBackend } from '../src/backends/nanoclaw.js'
import type { ChatRequest } from '../src/backends/types.js'

let server: net.Server | null = null
let dir: string | null = null

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  server = null
  if (dir) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } dir = null }
})

/** A mock NanoClaw daemon: on a client message, stream back the given reply chunks. */
function startMockDaemon(replies: string[], opts: { closeAfter?: boolean } = {}): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), 'nano-'))
  const sock = join(dir, 'cli.sock')
  server = net.createServer((c) => {
    c.on('data', () => {
      for (const r of replies) c.write(JSON.stringify({ text: r }) + '\n')
      if (opts.closeAfter) c.end()
    })
  })
  return new Promise((resolve) => server!.listen(sock, () => resolve(sock)))
}

const drain = async (be: NanoclawBackend, req: ChatRequest) => {
  const out = { text: '', finish: '' as string, deltas: 0 }
  for await (const d of be.chat(req, null, new AbortController().signal)) {
    out.deltas++
    if (d.content) out.text += d.content
    if (d.finish_reason) out.finish = d.finish_reason
  }
  return out
}

describe('NanoclawBackend', () => {
  const req: ChatRequest = { model: 'nanoclaw', messages: [{ role: 'user', content: 'hi' }] } as ChatRequest

  it('matches its model ids', () => {
    const be = new NanoclawBackend({ socketPath: '/x', timeoutMs: 1000 })
    expect(be.matches('nanoclaw')).toBe(true)
    expect(be.matches('nanoclaw/claude')).toBe(true)
    expect(be.matches('hermes')).toBe(false)
  })

  it('streams {text} replies as content, finishes on SILENCE', async () => {
    const sock = await startMockDaemon(['Hello ', 'world'])
    const be = new NanoclawBackend({ socketPath: sock, timeoutMs: 5000, silenceMs: 150 })
    const r = await drain(be, req)
    expect(r.text).toBe('Hello world')
    expect(r.finish).toBe('stop')
  })

  it('finishes when the daemon closes the connection', async () => {
    const sock = await startMockDaemon(['done'], { closeAfter: true })
    const be = new NanoclawBackend({ socketPath: sock, timeoutMs: 5000, silenceMs: 9999 })
    const r = await drain(be, req)
    expect(r.text).toBe('done')
    expect(r.finish).toBe('stop')
  })

  it('health: ready when the daemon socket is up', async () => {
    const sock = await startMockDaemon([])
    const be = new NanoclawBackend({ socketPath: sock, timeoutMs: 5000 })
    expect((await be.health()).state).toBe('ready')
  })

  it('health: unavailable when the daemon is not running / no socket', async () => {
    expect((await new NanoclawBackend({ socketPath: '/no/such/cli.sock', timeoutMs: 1000 }).health()).state).toBe('unavailable')
    expect((await new NanoclawBackend({ socketPath: '', timeoutMs: 1000 }).health()).state).toBe('unavailable')
  })
})
