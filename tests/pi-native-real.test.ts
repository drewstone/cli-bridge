import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { agentRunCancellationRequestDigest } from '@tangle-network/agent-interface'
import { BackendRegistry } from '../src/backends/registry.js'
import { PiBackend } from '../src/backends/pi.js'
import { RunRegistry } from '../src/runs/registry.js'
import { SessionStore } from '../src/sessions/store.js'
import { RetainedSessionService, mountRetainedSessions } from '../src/sessions/retained.js'

const enabled = process.env.CLI_BRIDGE_REAL_PI === '1'

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('timed out waiting for real Pi turn')
}

async function waitForTurn(store: SessionStore, id: string, runId: string, turn: number, timeoutMs: number): Promise<void> {
  await waitFor(() => {
    const record = store.getRetained(id)
    if (record?.status === 'unknown') {
      const event = store.retainedEventsAfter(id).reverse().find(item => item.envelope.runId === runId)?.envelope.event
      const detail = event?.type === 'status' ? event.detail : undefined
      throw new Error(`real Pi retained turn failed before turn ${turn}; provider state is unknown${detail ? `: ${detail}` : ''}`)
    }
    const terminal = store.retainedEventsAfter(id)
      .filter(item => item.envelope.runId === runId)
      .map(item => item.envelope.event)
      .findLast(event => event.type === 'status' && (event.status === 'completed' || event.status === 'failed'))
    if (terminal?.type === 'status' && terminal.status === 'failed') {
      throw new Error(`real Pi retained turn ${runId} failed: ${terminal.detail ?? 'provider failure'}`)
    }
    return record?.turns === turn && terminal?.type === 'status' && terminal.status === 'completed'
  }, timeoutMs)
}

function exactTextForRun(store: SessionStore, sessionId: string, runId: string): string {
  const parts = new Map<string, string>()
  for (const item of store.retainedEventsAfter(sessionId)) {
    if (item.envelope.runId !== runId) continue
    const event = item.envelope.event
    if (event.type !== 'message.part.updated' || event.part.type !== 'text') continue
    parts.set(event.part.id, event.part.text)
  }
  return [...parts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) => text)
    .join('')
}

describe.skipIf(!enabled)('gated real Pi native RPC', () => {
  let dir: string | null = null
  let store: SessionStore | null = null
  let runs: RunRegistry | null = null

  afterEach(async () => {
    await runs?.shutdown(5_000)
    store?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
    store = null
    runs = null
  })

  it('uses the installed Pi subscription for two retained turns and a native boundary proof', async () => {
    dir = mkdtempSync(`${tmpdir()}/cli-bridge-real-pi-`)
    store = new SessionStore(dir)
    runs = new RunRegistry({ replayRetentionMs: 300_000, identityRetentionMs: 300_000 })
    const backend = new PiBackend({
      bin: process.env.CLI_BRIDGE_PI_BIN ?? 'pi',
      timeoutMs: 180_000,
    })
    const registry = new BackendRegistry().register(backend)
    const service = new RetainedSessionService({ store, registry, runs })
    const app = new Hono()
    mountRetainedSessions(app, service)
    const model = process.env.CLI_BRIDGE_REAL_PI_MODEL ?? 'pi/deepseek/deepseek-v4-pro'

    const created = await app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: 'real-pi',
        model,
        cwd: dir,
        agent_profile: {
          name: 'real-pi-exact',
          prompt: { systemPrompt: 'Follow the user request exactly and keep the answer concise.' },
        },
      }),
    })
    expect(created.status).toBe(201)

    const first = await app.request('/v1/sessions/real-pi/turns', {
      method: 'POST',
      body: JSON.stringify({ message: 'Reply with exactly: first native turn.', run_id: 'real-pi-first', execution_id: 'real-pi-first-execution' }),
    })
    expect(first.status).toBe(202)
    const firstBody = await first.json() as { run: { id: string } }
    await waitForTurn(store!, 'real-pi', firstBody.run.id, 1, 180_000)

    const second = await app.request('/v1/sessions/real-pi/turns', {
      method: 'POST',
      body: JSON.stringify({ message: 'Reply with exactly: second native turn.', run_id: 'real-pi-second', execution_id: 'real-pi-second-execution' }),
    })
    expect(second.status).toBe(202)
    const secondBody = await second.json() as { run: { id: string } }
    await waitForTurn(store!, 'real-pi', secondBody.run.id, 2, 180_000)

    const view = await app.request('/v1/sessions/real-pi')
    const viewBody = await view.json() as {
      context_boundary?: { status?: string; boundary?: { kind?: string } }
      profile_materialization_receipt?: { schema?: string; harness?: string }
    }
    expect(viewBody.context_boundary?.boundary?.kind).toBe('revision')
    expect(viewBody.profile_materialization_receipt).toMatchObject({
      schema: 'cli-bridge.profile-materialization.v1',
      harness: 'pi',
    })

    // Partition the durable event log by the exact run ids returned by each
    // turn. Each part event carries cumulative text, so retain the final text
    // per part before comparing; flattening the whole transcript would let a
    // response from one turn satisfy the assertion for the other.
    expect(exactTextForRun(store!, 'real-pi', firstBody.run.id)).toBe('first native turn.')
    expect(exactTextForRun(store!, 'real-pi', secondBody.run.id)).toBe('second native turn.')
    const allEvents = store!.retainedEventsAfter('real-pi')
    expect(allEvents.some(item =>
      item.envelope.event.type === 'raw'
      && typeof item.envelope.event.event === 'object'
      && item.envelope.event.event !== null
      && (item.envelope.event.event as { type?: unknown }).type === 'usage',
    )).toBe(true)
    expect(new Set(allEvents.map(item => item.envelope.eventId)).size).toBe(allEvents.length)
  }, 400_000)

  it('pauses a real Pi tool call, applies one exact permission response, resumes, and rejects a stale change', async () => {
    dir = mkdtempSync(`${tmpdir()}/cli-bridge-real-pi-permission-`)
    writeFileSync(`${dir}/approval-target.txt`, 'permission target read successfully\n', 'utf8')
    store = new SessionStore(dir)
    runs = new RunRegistry({ replayRetentionMs: 300_000, identityRetentionMs: 300_000 })
    const backend = new PiBackend({
      bin: process.env.CLI_BRIDGE_PI_BIN ?? 'pi',
      timeoutMs: 180_000,
    })
    const registry = new BackendRegistry().register(backend)
    const service = new RetainedSessionService({ store, registry, runs })
    const app = new Hono()
    mountRetainedSessions(app, service)
    const model = process.env.CLI_BRIDGE_REAL_PI_MODEL ?? 'pi/deepseek/deepseek-v4-pro'

    expect((await app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'real-pi-permission', model, cwd: dir }),
    })).status).toBe(201)
    const started = await app.request('/v1/sessions/real-pi-permission/turns', {
      method: 'POST',
      body: JSON.stringify({
        message: 'You must use the read tool to read approval-target.txt before answering. Then reply with exactly: live permission resumed.',
        run_id: 'real-pi-permission-run',
        execution_id: 'real-pi-permission-execution',
      }),
    })
    expect(started.status).toBe(202)

    await waitFor(() => store!.retainedEventsAfter('real-pi-permission').some(item => item.envelope.event.type === 'interaction'), 180_000)
    const interactionEvent = store!.retainedEventsAfter('real-pi-permission')
      .find(item => item.envelope.event.type === 'interaction')?.envelope.event
    if (interactionEvent?.type !== 'interaction') throw new Error('real Pi permission interaction missing')
    expect(interactionEvent.request.kind).toBe('permission')
    const command = {
      operationId: 'real-pi-permission-response',
      binding: {
        runId: 'real-pi-permission-run',
        environmentId: 'cli-bridge',
        sessionId: 'real-pi-permission',
        interactionId: interactionEvent.request.id,
      },
      response: {
        id: interactionEvent.request.id,
        outcome: 'accepted',
        data: { grant: ['allow_once'] },
      },
    }
    const response = await app.request(
      `/v1/runs/real-pi-permission-run/interactions/${interactionEvent.request.id}/respond`,
      { method: 'POST', body: JSON.stringify(command) },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'accepted' })

    await waitForTurn(store!, 'real-pi-permission', 'real-pi-permission-run', 1, 180_000)
    expect(exactTextForRun(store!, 'real-pi-permission', 'real-pi-permission-run')).toBe('live permission resumed.')
    const events = store!.retainedEventsAfter('real-pi-permission')
    expect(events.some(item => item.envelope.event.type === 'message.part.updated' && item.envelope.event.part.type === 'tool')).toBe(true)

    const replay = await app.request(
      `/v1/runs/real-pi-permission-run/interactions/${interactionEvent.request.id}/respond`,
      { method: 'POST', body: JSON.stringify(command) },
    )
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ status: 'accepted' })

    const changed = await app.request(
      `/v1/runs/real-pi-permission-run/interactions/${interactionEvent.request.id}/respond`,
      {
        method: 'POST',
        body: JSON.stringify({
          ...command,
          operationId: 'real-pi-permission-stale-change',
          response: {
            id: interactionEvent.request.id,
            outcome: 'declined',
          },
        }),
      },
    )
    expect(changed.status).toBe(409)
    expect(await changed.json()).toMatchObject({ status: 'already_resolved_different' })
  }, 400_000)

  it('cancels a real active Pi process once and replays the exact cancellation result', async () => {
    dir = mkdtempSync(`${tmpdir()}/cli-bridge-real-pi-cancel-`)
    writeFileSync(`${dir}/cancel-target.txt`, 'cancel target\n', 'utf8')
    store = new SessionStore(dir)
    runs = new RunRegistry({ replayRetentionMs: 300_000, identityRetentionMs: 300_000 })
    const backend = new PiBackend({
      bin: process.env.CLI_BRIDGE_PI_BIN ?? 'pi',
      timeoutMs: 180_000,
    })
    const registry = new BackendRegistry().register(backend)
    const service = new RetainedSessionService({ store, registry, runs })
    const app = new Hono()
    mountRetainedSessions(app, service)
    const model = process.env.CLI_BRIDGE_REAL_PI_MODEL ?? 'pi/deepseek/deepseek-v4-pro'
    const sessionId = 'real-pi-cancel'
    const runId = 'real-pi-cancel-run'

    expect((await app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: sessionId, model, cwd: dir }),
    })).status).toBe(201)
    expect((await app.request(`/v1/sessions/${sessionId}/turns`, {
      method: 'POST',
      body: JSON.stringify({
        message: 'You must use the read tool to read cancel-target.txt before answering.',
        run_id: runId,
        execution_id: 'real-pi-cancel-execution',
      }),
    })).status).toBe(202)
    await waitFor(
      () => store!.retainedEventsAfter(sessionId).some(item => item.envelope.event.type === 'interaction'),
      180_000,
    )

    const admission = store.getRetainedRun(runId)
    if (!admission) throw new Error('real Pi cancellation admission missing')
    const material = {
      operationId: 'real-pi-cancel-operation',
      reason: 'live cancellation proof',
      run: {
        runId,
        provider: 'cli-bridge',
        environmentId: 'cli-bridge',
        sessionId,
        executionId: admission.executionId,
        requestDigest: admission.requestDigest as `sha256:${string}`,
      },
    }
    const command = {
      ...material,
      requestDigest: agentRunCancellationRequestDigest(material),
    }
    const cancelled = await app.request(`/v1/sessions/${sessionId}/cancel?wait_ms=5000`, {
      method: 'POST',
      body: JSON.stringify(command),
    })
    expect(cancelled.status).toBe(200)
    const acknowledgement = await cancelled.json()
    expect(acknowledgement).toMatchObject({
      operationId: material.operationId,
      status: 'accepted',
      effect: 'cancelled',
    })
    expect(store.getRetained(sessionId)).toMatchObject({ status: 'cancelled' })
    expect(store.getRetainedRun(runId)).toMatchObject({
      snapshot: { status: 'cancelled', terminal: true },
    })
    expect(runs.nativeSession(sessionId)).toBeNull()
    expect(
      store
        .retainedEventsAfter(sessionId)
        .some(item => item.envelope.runId === runId && item.envelope.event.type === 'interaction.cancel'),
    ).toBe(true)

    const replay = await app.request(`/v1/sessions/${sessionId}/cancel?wait_ms=5000`, {
      method: 'POST',
      body: JSON.stringify(command),
    })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(acknowledgement)

    const changedMaterial = { ...material, reason: 'changed cancellation reason' }
    const changed = await app.request(`/v1/sessions/${sessionId}/cancel?wait_ms=5000`, {
      method: 'POST',
      body: JSON.stringify({
        ...changedMaterial,
        requestDigest: agentRunCancellationRequestDigest(changedMaterial),
      }),
    })
    expect(changed.status).toBe(409)
    expect(await changed.json()).toMatchObject({ status: 'conflict' })
  }, 400_000)

  it('reports a real active Pi run as unknown after service restart and never submits it again', async () => {
    dir = mkdtempSync(`${tmpdir()}/cli-bridge-real-pi-restart-`)
    writeFileSync(`${dir}/restart-target.txt`, 'restart proof target\n', 'utf8')
    store = new SessionStore(dir)
    runs = new RunRegistry({ replayRetentionMs: 300_000, identityRetentionMs: 300_000 })
    const backend = new PiBackend({
      bin: process.env.CLI_BRIDGE_PI_BIN ?? 'pi',
      timeoutMs: 180_000,
    })
    const registry = new BackendRegistry().register(backend)
    const service = new RetainedSessionService({ store, registry, runs })
    const app = new Hono()
    mountRetainedSessions(app, service)
    const model = process.env.CLI_BRIDGE_REAL_PI_MODEL ?? 'pi/deepseek/deepseek-v4-pro'
    const request = {
      message: 'You must use the read tool to read restart-target.txt before answering. Then reply with exactly: this response must not be resubmitted.',
      run_id: 'real-pi-restart-run',
      execution_id: 'real-pi-restart-execution',
    }

    expect((await app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'real-pi-restart', model, cwd: dir }),
    })).status).toBe(201)
    expect((await app.request('/v1/sessions/real-pi-restart/turns', {
      method: 'POST',
      body: JSON.stringify(request),
    })).status).toBe(202)
    await waitFor(() => store!.retainedEventsAfter('real-pi-restart').some(item => item.envelope.event.type === 'interaction'), 180_000)

    const restartedStore = new SessionStore(dir)
    const restartedRuns = new RunRegistry({ replayRetentionMs: 300_000, identityRetentionMs: 300_000 })
    const forbiddenDispatchBackend = new PiBackend({
      bin: '/cli-bridge-live-proof-must-not-dispatch-pi',
      timeoutMs: 1_000,
    })
    const restartedRegistry = new BackendRegistry().register(forbiddenDispatchBackend)
    const restartedService = new RetainedSessionService({
      store: restartedStore,
      registry: restartedRegistry,
      runs: restartedRuns,
    })
    const restartedApp = new Hono()
    mountRetainedSessions(restartedApp, restartedService)
    try {
      expect(restartedService.get('real-pi-restart')).toMatchObject({
        status: 'unknown',
        run: {
          id: 'real-pi-restart-run',
          executionId: 'real-pi-restart-execution',
          status: 'unknown',
          terminal: false,
        },
      })
      const exactReplay = await restartedApp.request('/v1/sessions/real-pi-restart/turns', {
        method: 'POST',
        body: JSON.stringify(request),
      })
      expect(exactReplay.status).toBe(202)
      expect(await exactReplay.json()).toMatchObject({
        session: { status: 'unknown' },
        run: {
          id: 'real-pi-restart-run',
          executionId: 'real-pi-restart-execution',
          status: 'unknown',
          terminal: false,
        },
      })

      const changedReplay = await restartedApp.request('/v1/sessions/real-pi-restart/turns', {
        method: 'POST',
        body: JSON.stringify({ ...request, message: 'changed input must conflict' }),
      })
      expect(changedReplay.status).toBe(409)
      expect(await changedReplay.json()).toMatchObject({ error: { type: 'run_identity_conflict' } })

      const unsafeNewTurn = await restartedApp.request('/v1/sessions/real-pi-restart/turns', {
        method: 'POST',
        body: JSON.stringify({
          message: 'do not submit a new turn',
          run_id: 'real-pi-restart-new-run',
          execution_id: 'real-pi-restart-new-execution',
        }),
      })
      expect(unsafeNewTurn.status).toBe(404)
      expect(await unsafeNewTurn.json()).toMatchObject({ error: { type: 'unknown_session' } })
      expect(restartedRuns.get('real-pi-restart-run')).toBeUndefined()
      expect(restartedRuns.get('real-pi-restart-new-run')).toBeUndefined()
    } finally {
      await restartedRuns.shutdown(1_000)
      restartedStore.close()
    }
  }, 400_000)
})
