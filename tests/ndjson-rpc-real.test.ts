/**
 * ndjson-rpc transport boundary tests — REAL child processes over real pipes,
 * mirroring the independent pipe-level review that found three framing bugs:
 *
 *   1. same-id overlap: a server request carrying the same numeric id as an
 *      outstanding client call must reach onMessage, and the later response
 *      must still settle that call
 *   2. a pipe write that splits a 4-byte UTF-8 character across chunks must
 *      decode as one stream (東京🙂 café, no U+FFFD)
 *   3. a peer that closes stdout must reject (not strand) the outstanding
 *      call
 *
 * No model calls: the children are plain node scripts.
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { attachNdjsonRpc } from '../src/backends/ndjson-rpc.js'

const CHILD_SOURCE = String.raw`
const read = require('node:readline').createInterface({ input: process.stdin })
const mode = process.argv[1]
const line = (m) => process.stdout.write(JSON.stringify(m) + '\n')
read.on('line', (raw) => {
  const m = JSON.parse(raw)
  if (!m.method) return
  if (mode === 'overlap') {
    line({ jsonrpc: '2.0', id: m.id, method: 'session/request_permission', params: {} })
    setTimeout(() => line({ jsonrpc: '2.0', id: m.id, result: { witness: 'completed' } }), 30)
  } else if (mode === 'utf8') {
    const b = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { witness: '東京🙂 café' } }) + '\n')
    const n = b.indexOf(Buffer.from('🙂')) + 2
    process.stdout.write(b.subarray(0, n), () => setTimeout(() => process.stdout.write(b.subarray(n)), 40))
  } else if (mode === 'eof') {
    process.stdout.end(); read.close(); process.stdin.destroy()
  }
})
`

async function withPeer(mode: string, run: (rpc: ReturnType<typeof attachNdjsonRpc>, sawPermission: () => number) => Promise<void>): Promise<void> {
  const child = spawn(process.execPath, ['-e', CHILD_SOURCE, mode], { stdio: ['pipe', 'pipe', 'pipe'] })
  let permissionRequests = 0
  const rpc = attachNdjsonRpc({
    child,
    label: 'test rpc',
    stdin: child.stdin!,
    stdout: child.stdout!,
    onMessage: (m) => {
      if (m.method === 'session/request_permission') {
        permissionRequests++
        rpc.respondError(m.id!, -32601, 'No permission grant available')
      }
    },
  })
  try {
    await run(rpc, () => permissionRequests)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'close').catch(() => {})
      child.kill()
      await exited
    }
  }
}

describe('attachNdjsonRpc boundary (real child, real pipes)', () => {
  it('dispatches a same-id server request and still settles the call with the later response', async () => {
    await withPeer('overlap', async (rpc, sawPermission) => {
      const result = (await rpc.request('session/prompt', {})) as { witness?: string }
      expect(result.witness).toBe('completed')
      expect(sawPermission()).toBe(1)
    })
  })

  it('decodes a UTF-8 character split across pipe chunks as one stream', async () => {
    await withPeer('utf8', async (rpc) => {
      const result = (await rpc.request('session/prompt', {})) as { witness?: string }
      expect(result.witness).toBe('東京🙂 café')
    })
  })

  it('rejects the outstanding call when the peer closes stdout', async () => {
    await withPeer('eof', async (rpc) => {
      await expect(rpc.request('session/prompt', {})).rejects.toThrow(/closed before a response arrived|stdin write failed/)
    })
  })
})
