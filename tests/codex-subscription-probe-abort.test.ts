/** Real CodexBackend probe, real app-server child and real abort signals at the subscription admission boundary. No inference. */
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CodexBackend } from '../src/backends/codex.js'
import type { ChatRequest } from '../src/backends/types.js'
import { loadConfig } from '../src/config.js'
import { createNativeCatalog } from '../src/native-catalog.js'
import { describeRunFailure } from '../src/runs/error-shape.js'

describe('a codex subscription probe abort names its cause in the admission refusal', () => {
  let root: string, bin: string, started: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-probe-abort-'))
    bin = join(root, 'codex.cjs')
    started = join(root, 'app-server-started')
    // An app-server that starts and never acknowledges `initialize`; any other command would be an inference attempt.
    await writeFile(bin, `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]!=='app-server')process.exit(125);`
      + `fs.writeFileSync(${JSON.stringify(started)},'started');process.stdin.resume();setInterval(()=>{},1000)\n`, { mode: 0o700 })
  })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  const admit = async (signal: AbortSignal): Promise<unknown> => {
    await rm(started, { force: true })
    const config = loadConfig({ BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'codex', CODEX_BIN: bin, BRIDGE_TRACE: 'off', BRIDGE_SUBSCRIPTIONS_ONLY: '1' })
    const request = { model: 'codex/openai/probe-canary', messages: [{ role: 'user', content: 'must never run' }] } as unknown as ChatRequest
    await createNativeCatalog(config, new CodexBackend({ bin, timeoutMs: 60_000 }).readCatalog, root).admit(request, 'codex', signal)
    return request.subscriptionAdmission!.check({ model: request.model, cwd: root, env: { ...process.env, HOME: root }, flags: [], executor: 'host' })
      .then(() => { throw new Error('the hung probe admitted a subscription') }, (error: unknown) => error)
  }

  it('the probe\'s own timeout stays provider_unresolved and names the timeout and its abort chain', async () => {
    const failure = describeRunFailure(await admit(new AbortController().signal))
    expect(failure).toMatchObject({ type: 'subscription_required', cause: 'provider_unresolved', status: 403, provider_dispatch: 'not_started',
      message: expect.stringContaining('Its native probe failed: Error: Codex subscription probe exceeded its own 10 s timeout <- Error: Codex ') })
    expect(failure.message).toMatch(/(AbortError|TimeoutError): The operation was aborted/)
  }, 30_000)

  it('the caller request signal is a cancellation, distinguishable from the probe timeout', async () => {
    const controller = new AbortController()
    const pending = admit(controller.signal)
    for (const deadline = Date.now() + 8_000; !await access(started).then(() => true, () => false);) {
      expect(Date.now()).toBeLessThan(deadline)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    controller.abort()
    const failure = describeRunFailure(await pending)
    expect(failure).toMatchObject({ type: 'aborted', provider_dispatch: 'not_started',
      message: "Subscription admission for the selected codex route was cancelled by the caller's request signal (AbortError: This operation was aborted)." })
    expect(failure.message).not.toContain('timeout')
  }, 30_000)
})
