import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpencodeBackend } from '../src/backends/opencode.js'
import { hostSpawner } from '../src/executors/host.js'

const transportKeys = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'] as const
const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('OpenCode operator transport environment at the real child boundary', () => {
  async function capture() {
    const cwd = mkdtempSync(join(tmpdir(), 'opencode-proxy-env-'))
    roots.push(cwd)
    const bin = join(cwd, 'synthetic-opencode')
    const keys = [...transportKeys, 'UNRELATED_PRIVATE_SECRET', 'NODE_TLS_REJECT_UNAUTHORIZED']
    // Synthetic CLI protocol fixture, but a real Node child through the production
    // hostSpawner. It reads no files and makes no network calls.
    writeFileSync(bin, `#!${process.execPath}\n` + `
process.stdin.resume();
process.stdin.on('end', () => {
  const selected = Object.fromEntries(${JSON.stringify(keys)}.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
  process.stdout.write(JSON.stringify({ type: 'text', part: { text: JSON.stringify(selected) } }) + '\\n');
});
`, { mode: 0o700 })
    const backend = new OpencodeBackend({ bin, timeoutMs: 5_000, spawner: hostSpawner })
    let content = ''
    for await (const delta of backend.chat({
      cwd,
      model: 'opencode/opencode/glm-5.3-flash-free',
      messages: [{ role: 'user', content: 'synthetic' }],
    }, null, new AbortController().signal)) content += delta.content ?? ''
    return JSON.parse(content) as Record<string, string>
  }

  it('delivers the named proxy and trust settings, excluding unrelated secrets and TLS-disable flags', async () => {
    for (const key of transportKeys) vi.stubEnv(key, `synthetic-${key}`)
    vi.stubEnv('UNRELATED_PRIVATE_SECRET', 'must-not-reach-child')
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
    const received = await capture()
    expect(received).toEqual(Object.fromEntries(transportKeys.map(key => [key, `synthetic-${key}`])))
    expect(received.UNRELATED_PRIVATE_SECRET).toBeUndefined()
    expect(received.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
  })

  it('does not invent proxy or trust settings when the operator has none', async () => {
    for (const key of transportKeys) vi.stubEnv(key, undefined)
    vi.stubEnv('UNRELATED_PRIVATE_SECRET', undefined)
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', undefined)
    expect(await capture()).toEqual({})
  })
})
