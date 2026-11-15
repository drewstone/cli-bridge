/**
 * Real-CLI proof of a retained Claude Code session through the HTTP surface a
 * Fleet lane uses: fresh directory, retained start, working status, a
 * mid-turn steer that changes the agent's actions, idle status, an idle
 * message that starts exactly one turn, repeated message ids with one effect,
 * and a close that leaves the native transcript in place.
 *
 * Opt-in with CLI_BRIDGE_REAL_CLAUDE_TESTS=1: it runs the installed `claude`
 * (or CLAUDE_BIN) on the logged-in subscription seat with Haiku.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import {
  interactionResponseCommandDigest,
  type InteractionRequest,
  type StreamEvent,
} from '@tangle-network/agent-interface'
import { ClaudeNativeBackend } from '../src/backends/claude.js'
import { BackendRegistry } from '../src/backends/registry.js'
import { hostSpawner } from '../src/executors/host.js'
import { mountRuns } from '../src/routes/runs.js'
import { RunRegistry } from '../src/runs/registry.js'
import { RetainedSessionService, mountRetainedSessions } from '../src/sessions/retained.js'
import { SessionStore } from '../src/sessions/store.js'

const describeReal = process.env.CLI_BRIDGE_REAL_CLAUDE_TESTS === '1' ? describe : describe.skip
const MODEL = 'claude-code/claude-haiku-5-5'
const SESSION = 'real-claude'

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describeReal('retained Claude Code session (real CLI)', () => {
  const dirs: string[] = []
  let store: SessionStore | null = null
  let runs: RunRegistry | null = null

  afterEach(async () => {
    await runs?.shutdown(5_000)
    store?.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    store = null
    runs = null
  })

  it('steers a running turn, starts one idle turn per message id, and keeps the transcript on close', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cli-bridge-claude-state-'))
    const workspace = mkdtempSync(join(tmpdir(), 'cli-bridge-claude-ws-'))
    dirs.push(stateDir, workspace)
    store = new SessionStore(stateDir)
    runs = new RunRegistry({ replayRetentionMs: 300_000, identityRetentionMs: 300_000 })
    const backend = new ClaudeNativeBackend({
      bin: process.env.CLAUDE_BIN ?? 'claude',
      harness: 'claude-code',
      timeoutMs: 180_000,
      spawner: hostSpawner,
    })
    const service = new RetainedSessionService({ store, registry: new BackendRegistry().register(backend), runs })
    const app = new Hono()
    mountRetainedSessions(app, service)
    mountRuns(app, { runs, retainedRuns: service, retainedStore: store })
    const post = (path: string, body: unknown): Promise<Response> =>
      Promise.resolve(app.request(path, { method: 'POST', body: JSON.stringify(body) }))
    const events = (runId?: string): StreamEvent[] => store!.retainedEventsAfter(SESSION)
      .filter((item) => runId === undefined || item.envelope.runId === runId)
      .map((item) => item.envelope.event)
    const rawOf = (runId: string, type: string): Array<Record<string, unknown>> => events(runId)
      .flatMap((event) => event.type === 'raw' ? [event.event as Record<string, unknown>] : [])
      .filter((event) => event.type === type)
    const text = (runId: string): string => events(runId)
      .flatMap((event) => event.type === 'message.part.updated' && event.part.type === 'text' ? [event.part.text] : [])
      .join('')
    const terminal = (runId: string): StreamEvent | undefined => events(runId)
      .findLast((event) => event.type === 'status' && (event.status === 'completed' || event.status === 'failed'))
    const status = async (): Promise<string> => ((await (await app.request(`/v1/sessions/${SESSION}`)).json()) as { status: string }).status
    const answered = new Set<string>()
    const allowPending = async (runId: string): Promise<number> => {
      let count = 0
      for (const event of events(runId)) {
        if (event.type !== 'interaction' || answered.has(event.request.id)) continue
        answered.add(event.request.id)
        const request: InteractionRequest = event.request
        const binding = { ...request.binding, requestDigest: request.requestDigest }
        const response = { id: request.id, outcome: 'accepted' as const, data: { grant: ['allow_once'] } }
        const reply = await post(`/v1/runs/${runId}/interactions/${request.id}/respond`, {
          operationId: `allow-${request.id}`,
          binding,
          response,
          commandDigest: interactionResponseCommandDigest({ binding, response }),
        })
        expect(reply.status).toBe(200)
        expect(await reply.json()).toMatchObject({ status: 'accepted' })
        count += 1
      }
      return count
    }

    // Fresh directory, retained start.
    const created = await post('/v1/sessions', { id: SESSION, model: MODEL, cwd: workspace })
    expect(created.status, await created.clone().text()).toBe(201)
    expect(await status()).toBe('created')

    // A turn that sits in a tool call long enough to be steered.
    const steerRun = 'real-claude-steer'
    const first = await post(`/v1/sessions/${SESSION}/turns`, {
      message: 'Use the Bash tool to run exactly `sleep 20`, then reply with only the word DONE1.',
      run_id: steerRun,
      execution_id: `${steerRun}-execution`,
    })
    expect(first.status, await first.clone().text()).toBe(202)
    await waitFor(() => events(steerRun).some((event) => event.type === 'interaction'), 120_000, 'the sleep permission')
    expect(await status()).toBe('running')
    expect(await allowPending(steerRun)).toBe(1)

    const admission = store.getRetainedRun(steerRun)
    if (!admission) throw new Error('steer run admission missing')
    const steer = {
      operationId: 'real-claude-steer-1',
      message: 'Change of plan: after the sleep finishes, also use the Bash tool to run exactly `echo STEERED > steer.txt`, and reply with only the word PINEAPPLE instead of DONE1.',
      run: {
        runId: steerRun,
        provider: admission.provider,
        environmentId: admission.environmentId,
        sessionId: SESSION,
        executionId: admission.executionId,
        requestDigest: admission.requestDigest,
      },
    }
    const steered = await post(`/v1/sessions/${SESSION}/steer`, steer)
    expect(steered.status).toBe(200)
    const acknowledgement = await steered.json()
    expect(acknowledgement).toMatchObject({ operationId: steer.operationId, status: 'accepted' })
    // The same Fleet message id replays the first acknowledgement and writes nothing.
    const repeated = await post(`/v1/sessions/${SESSION}/steer`, steer)
    expect(repeated.status).toBe(200)
    expect(await repeated.json()).toEqual(acknowledgement)

    // The steered command asks for its own permission inside the same turn.
    const deadline = Date.now() + 180_000
    while (terminal(steerRun) === undefined) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the steered turn')
      await allowPending(steerRun)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    expect(terminal(steerRun)).toMatchObject({ status: 'completed' })
    const receipts = rawOf(steerRun, 'steer')
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ operationId: steer.operationId, state: 'applied' })
    expect(readFileSync(join(workspace, 'steer.txt'), 'utf8').trim()).toBe('STEERED')
    expect(text(steerRun)).toContain('PINEAPPLE')
    expect(rawOf(steerRun, 'result')).toHaveLength(1)

    // Idle, then one message starts exactly one turn; its repeat starts none.
    await waitFor(() => store!.getRetained(SESSION)?.status === 'idle', 30_000, 'idle status')
    expect(await status()).toBe('idle')
    const idleRun = 'real-claude-idle'
    const idleTurn = { message: 'Reply with only the word MANGO.', run_id: idleRun, execution_id: `${idleRun}-execution` }
    expect((await post(`/v1/sessions/${SESSION}/turns`, idleTurn)).status).toBe(202)
    await waitFor(() => terminal(idleRun) !== undefined, 120_000, 'the idle turn')
    expect(terminal(idleRun)).toMatchObject({ status: 'completed' })
    expect(text(idleRun)).toContain('MANGO')
    const replay = await post(`/v1/sessions/${SESSION}/turns`, idleTurn)
    expect(replay.status).toBe(202)
    expect(await replay.json()).toMatchObject({ run: { id: idleRun } })
    expect(store.getRetained(SESSION)?.turns).toBe(2)
    expect(rawOf(idleRun, 'result')).toHaveLength(1)
    expect(rawOf(idleRun, 'user').filter((event) => event.isReplay === true)).toHaveLength(1)

    // Close stops the process and leaves Claude's own transcript.
    const providerSessionId = store.getRetained(SESSION)?.internalId
    if (!providerSessionId) throw new Error('native session id missing')
    const closed = await post(`/v1/sessions/${SESSION}/close`, {})
    expect(closed.status).toBe(200)
    const transcript = join(
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
      'projects',
      realpathSync(workspace).replace(/[^A-Za-z0-9]/gu, '-'),
      `${providerSessionId}.jsonl`,
    )
    expect(existsSync(transcript)).toBe(true)
    const native = readFileSync(transcript, 'utf8')
    expect(native).toContain('PINEAPPLE')
    expect(native).toContain('MANGO')
  }, 600_000)
})
