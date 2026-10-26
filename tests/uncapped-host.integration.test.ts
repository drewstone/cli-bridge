import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

test('explicit uncapped host controls admit 65 real child processes and retain their lifetimes through cleanup', () => {
  const result = execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/uncapped-host.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, BRIDGE_HOST: '127.0.0.1', BRIDGE_BACKENDS: 'codex', BRIDGE_HOST_MAX_CONCURRENCY: '0',
      BRIDGE_HOST_CHAT_MAX_ACTIVE: '0', BRIDGE_HOST_CHAT_MAX_QUEUE: '0', BRIDGE_HOST_CHAT_RESERVED_ACTIVE: '0' },
  })
  expect(JSON.parse(result.trim())).toEqual({ nativeChildren: 65, admissionActive: 0, executorActive: 0, terminated: true })
}, 20_000)
