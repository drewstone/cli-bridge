import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { resolveSpawnerCwd } from '../src/executors/types.js'
import { mountHealth } from '../src/routes/health.js'
import { mountChatCompletions } from '../src/routes/chat-completions.js'
import { BackendRegistry } from '../src/backends/registry.js'
import { OpencodeBackend } from '../src/backends/opencode.js'
import { BackendError, type Backend, type BackendHealth, type ChatDelta } from '../src/backends/types.js'
import { SessionStore } from '../src/sessions/store.js'
import { RunRegistry } from '../src/runs/registry.js'

/**
 * Second pass over the same defect class: NO FAILURE MAY PRESENT AS A
 * DIFFERENT FAILURE. Each test below encodes a case that survived the first
 * pass and was reproduced live on the fixed build.
 *
 *   1. A backend that fails AFTER its first delta returned HTTP 200,
 *      `finish_reason: "error"`, `content: ""` and no message at all — the only
 *      copy of the reason went to the bridge's stdout
 *      (`BackendError: opencode: opencode error { code: 'upstream' }`).
 *      `Run.pump` recorded the error only `if (this.seq === 0)`, so every
 *      post-output failure — which is what a credential/auth failure actually
 *      produces — lost its reason. An empty completion reads as a model
 *      problem, which is the exact misattribution this class is about.
 *
 *   2. `preflight ok` + /health `ready` with ZERO credentials in the pool. The
 *      empty-credential warning skipped `kind !== 'bind'`, so per-slot volumes
 *      were never looked at, and the check was "is the directory non-empty"
 *      rather than "does it hold credentials". Measured on this host:
 *        /home/drew/.config/opencode      -> 6 entries, NO auth.json
 *        /home/drew/.local/share/opencode -> auth.json (432 B)
 *      i.e. the DEFAULT opencode docker mount (.config/opencode) carries no
 *      credentials at all, which is why the operator had to hand-pin
 *      OPENCODE_DOCKER_HOST_CONFIG_DIR to the data dir to get a working bridge.
 *
 *   3. A request that sent NO cwd was refused with
 *      "this request asks to run in /home/drew/code/cli-bridge-preflight" —
 *      the BRIDGE'S own working directory, injected by the backend
 *      (`req.cwd ?? session?.cwd ?? process.cwd()`). The remedy it offered
 *      ("send requests without a cwd") was the thing the caller had already
 *      done and is unreachable through the HTTP API.
 *
 *   4. Slot self-healing was checked in `handOut` only, which is the free-slot
 *      path. A QUEUED waiter went through `releaseSlot -> waiter.resolve ->
 *      markAcquired` and was handed the removed container id at any TTL, so
 *      the pool healed only when idle — never when saturated, which is the
 *      condition it exists for.
 *
 *   5. The top-level `status` and HTTP code were computed from possibly-cached
 *      backend verdicts with no staleness marker while `ts` was always fresh,
 *      so a bridge with zero containers answered `status: "ok"` + 200 for the
 *      full cache TTL. Per-backend `probed_at`/`cached` were honest; the two
 *      fields a watchdog reads were not.
 */


// ─── helpers ─────────────────────────────────────────────────────────────

const tempDirs: string[] = []
const stores: SessionStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

function childExiting(code: number, stdoutText: string, stderrText = ''): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  const stderr = new PassThrough()
  ;(child as unknown as { stdout: Readable }).stdout = Readable.from(stdoutText ? [stdoutText] : [])
  ;(child as unknown as { stderr: PassThrough }).stderr = stderr
  ;(child as unknown as { stdin: PassThrough }).stdin = new PassThrough()
  ;(child as unknown as { pid: number }).pid = 4242
  ;(child as unknown as { kill: () => boolean }).kill = () => true
  // `null` while running, like a real ChildProcess: `waitForProcessClose`
  // short-circuits on any non-null value, so `undefined` here would be read as
  // "exited undefined" and every fake run would look like a CLI failure.
  ;(child as unknown as { exitCode: number | null }).exitCode = null
  setImmediate(() => {
    if (stderrText) stderr.write(stderrText)
    stderr.end()
    ;(child as unknown as { exitCode: number | null }).exitCode = code
    child.emit('close', code)
  })
  return child
}

/** A backend that emits `deltas`, then throws — the post-output failure shape. */
function throwingBackend(deltas: ChatDelta[], error: unknown): Backend {
  return {
    name: 'opencode',
    matches: (model: string) => model === 'opencode' || model.startsWith('opencode/'),
    health: async (): Promise<BackendHealth> => ({ name: 'opencode', state: 'ready' }),
    chat: async function* (): AsyncIterable<ChatDelta> {
      for (const d of deltas) yield d
      throw error
    },
  } as unknown as Backend
}

function chatApp(backend: Backend): Hono {
  const app = new Hono()
  const registry = new BackendRegistry().register(backend)
  const sessions = new SessionStore(tempDir('cli-bridge-attribution-store-'))
  stores.push(sessions)
  mountChatCompletions(app, { registry, sessions, runs: new RunRegistry({}) })
  return app
}

async function postChat(app: Hono, body: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

async function streamChat(app: Hono, body: unknown): Promise<string> {
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(body as object), stream: true }),
  })
  return await res.text()
}

describe('a post-output failure answers with its reason, not an empty 200', () => {
  it('returns the backend status and message when the run produced no content', async () => {
    // The measured shape: opencode emits its session id, then fails against
    // credentials that are not there. Pre-fix this was 200 + content:'' and the
    // reason existed only in the bridge's stdout.
    const app = chatApp(throwingBackend(
      [{ internal_session_id: 'ses_abc' }],
      new BackendError('opencode: no credentials in /root/.local/share/opencode', 'upstream'),
    ))

    const { status, json } = await postChat(app, {
      model: 'opencode/zai-coding-plan/glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(json.error?.message).toContain('no credentials in /root/.local/share/opencode')
    expect(json.error?.type).toBe('upstream')
    // Same status a pre-output BackendError('upstream') gets: the caller cannot
    // tell where in the stream the failure happened, and must not have to.
    expect(status).toBe(502)
  })

  it('keeps partial content AND names the failure when output had already started', async () => {
    const app = chatApp(throwingBackend(
      [{ content: 'partial answer' }],
      new BackendError('opencode: upstream closed the stream', 'upstream'),
    ))

    const { status, json } = await postChat(app, {
      model: 'opencode/zai-coding-plan/glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    })

    // Real work is not discarded, but the body says outright that it failed.
    expect(status).toBe(200)
    expect(json.choices[0].message.content).toBe('partial answer')
    expect(json.choices[0].finish_reason).toBe('error')
    expect(json.error?.message).toContain('upstream closed the stream')
    expect(json.error?.type).toBe('upstream')
  })

  it('streams the reason as an error frame instead of a bare terminal delta', async () => {
    const app = chatApp(throwingBackend(
      [{ content: 'partial answer' }],
      new BackendError('opencode: no credentials in /root/.local/share/opencode', 'upstream'),
    ))

    const body = await streamChat(app, {
      model: 'opencode/zai-coding-plan/glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(body).toContain('no credentials in /root/.local/share/opencode')
    expect(body).toContain('"type":"upstream"')
  })

  it('preserves Router’s typed pre-provider proof on both response shapes', async () => {
    const error = new BackendError('candidate grant limit exceeded', 'upstream', undefined, {
      providerDispatch: 'not_started',
    })
    const app = chatApp(throwingBackend([{ internal_session_id: 'ses_abc' }], error))

    const response = await postChat(app, {
      model: 'opencode/zai-coding-plan/glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(response.status).toBe(502)
    expect(response.json.error?.provider_dispatch).toBe('not_started')

    const body = await streamChat(app, {
      model: 'opencode/zai-coding-plan/glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(body).toContain('"provider_dispatch":"not_started"')
  })

  it('leaves a successful run untouched — no error field, no status change', async () => {
    const app = chatApp({
      name: 'opencode',
      matches: (m: string) => m.startsWith('opencode'),
      health: async () => ({ name: 'opencode', state: 'ready' as const }),
      chat: async function* () {
        yield { content: 'all good' }
        yield { finish_reason: 'stop' as const }
      },
    } as unknown as Backend)

    const { status, json } = await postChat(app, {
      model: 'opencode/zai-coding-plan/glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(status).toBe(200)
    expect(json.error).toBeUndefined()
    expect(json.choices[0].message.content).toBe('all good')
    expect(json.choices[0].finish_reason).toBe('stop')
  })
})

// ─── 2. credentials are proven, not assumed ──────────────────────────────

describe('/health cannot present a remembered verdict as a fresh one', () => {
  function healthApp(probe: () => Promise<BackendHealth>, now: () => number): Hono {
    const app = new Hono()
    const registry = new BackendRegistry().register({
      name: 'opencode',
      matches: () => true,
      health: probe,
      chat: async function* () { /* unused */ },
    } as unknown as Backend)
    mountHealth(app, { registry }, { cacheMs: 30_000, now, probe: (b) => b.health() })
    return app
  }

  it('marks the response when the verdict behind status:ok was not measured now', async () => {
    let clock = 1_000
    let probes = 0
    const app = healthApp(async () => {
      probes += 1
      return { name: 'opencode', state: 'ready', version: '1.18.9' }
    }, () => clock)

    const first = await (await app.request('/health')).json() as any
    expect(first.cached_verdicts).toBe(false)

    clock += 11_000
    const second = await (await app.request('/health')).json() as any
    expect(probes).toBe(1)
    expect(second.cached_verdicts).toBe(true)
    // The response is fresh; the verdict behind it is 11 s old and says so.
    expect(second.oldest_probed_at).toBe(new Date(1_000).toISOString())
    expect(second.ts).toBe(new Date(12_000).toISOString())
  })

  it('says the verdicts are fresh when they are', async () => {
    let clock = 1_000
    const app = healthApp(async () => ({ name: 'opencode', state: 'error', detail: 'container gone' }), () => clock)

    const first = await (await app.request('/health')).json() as any
    expect(first.cached_verdicts).toBe(false)
    clock += 11_000
    const second = await (await app.request('/health')).json() as any
    // A failing verdict is never cached, so the second answer is measured.
    expect(second.cached_verdicts).toBe(false)
    expect(second.oldest_probed_at).toBe(new Date(12_000).toISOString())
  })
})
