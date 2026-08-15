import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { Spawner } from '../src/executors/types.js'
import { BackendRegistry } from '../src/backends/registry.js'
import { PiBackend } from '../src/backends/pi.js'
import { RunRegistry } from '../src/runs/registry.js'
import { SessionStore } from '../src/sessions/store.js'
import { RetainedSessionService, mountRetainedSessions } from '../src/sessions/retained.js'
import { testPiInferenceTransport } from './pi-inference-fixture.js'
import {
  agentRunCancellationRequestDigest,
  interactionResponseCommandDigest,
  type InteractionRequest,
  type InteractionResponse,
  type InteractionResponseCommand,
} from '@tangle-network/agent-interface'

/** A real child speaking Pi's documented JSONL RPC framing, including state responses. */
const rpcChild = String.raw`
import json
import sys

turns = 0
session_id = "child-pi-session"

def send(value):
    print(json.dumps(value), flush=True)

for line in sys.stdin:
    message = json.loads(line)
    kind = message.get("type")
    if kind == "prompt":
        turns += 1
        send({"id": message.get("id"), "type": "response", "command": "prompt", "success": True})
        send({"type": "session", "id": session_id})
        send({"type": "agent_start"})
        send({"type": "turn_start"})
        send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "child-reply-" + str(turns)}})
        send({"type": "turn_end", "message": {"usage": {"input": 4, "output": 2}}})
        send({"type": "agent_end"})
        send({"type": "agent_settled"})
    elif kind == "get_state":
        send({"id": message.get("id"), "type": "response", "command": "get_state", "success": True, "data": {"sessionId": session_id, "messageCount": turns * 2}})
    elif kind in ("steer", "abort"):
        send({"id": message.get("id"), "type": "response", "command": kind, "success": True})
`

const hungPromptChild = String.raw`
import sys

for line in sys.stdin:
    # Deliberately consume every command without acknowledging prompt or abort.
    # The bridge must bound both waits and terminate this real child.
    pass
`

const abortingChild = String.raw`
import json
import sys

for line in sys.stdin:
    message = json.loads(line)
    if message.get("type") == "prompt":
        print(json.dumps({"id": message.get("id"), "type": "response", "success": True}), flush=True)
        print(json.dumps({"type": "session", "id": "cancel-session"}), flush=True)
    elif message.get("type") == "abort":
        print(json.dumps({"id": message.get("id"), "type": "response", "success": True}), flush=True)
        break
`

const interactionChild = String.raw`
import json
import os
import re
import sys

session_id = "interaction-pi-session"
args = json.loads(os.environ["CLI_BRIDGE_TEST_ARGS"])
extension_path = args[args.index("--extension") + 1]
extension = open(extension_path, encoding="utf-8").read()
nonce = re.search(r"const bridgeNonce = [\"']([^\"']+)[\"']", extension).group(1)
permission_token = nonce + "-1"
permission_title = "Permission: bash [cli-bridge-marker:" + permission_token + "]"

def send(value):
    print(json.dumps(value), flush=True)

for line in sys.stdin:
    message = json.loads(line)
    kind = message.get("type")
    if kind == "prompt":
        send({"id": message.get("id"), "type": "response", "command": "prompt", "success": True})
        send({"type": "session", "id": session_id})
        send({"type": "extension_ui_request", "id": "native-permission", "method": "select", "title": permission_title, "options": ["allow_once", "deny"]})
    elif kind == "extension_ui_response" and message.get("id") == "native-permission":
        send({"type": "extension_ui_request", "id": "marker-notification", "method": "notify", "message": "cli-bridge.permission-applied.v1:" + permission_token + ":" + str(message.get("value"))})
        send({"type": "tool_execution_start", "toolCallId": "tool-after-permission", "toolName": "read_file", "args": {"path": "README.md"}})
        send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "permission-resumed"}})
        send({"type": "turn_end"})
        send({"type": "agent_end"})
        send({"type": "agent_settled"})
    elif kind == "get_state":
        send({"id": message.get("id"), "type": "response", "command": "get_state", "success": True, "data": {"sessionId": session_id, "messageCount": 2}})
    elif kind == "abort":
        send({"id": message.get("id"), "type": "response", "command": "abort", "success": True})
`

const interactionWithoutProgressChild = interactionChild
  .replace(
    '        send({"type": "extension_ui_request", "id": "marker-notification", "method": "notify", "message": "cli-bridge.permission-applied.v1:" + permission_token + ":" + str(message.get("value"))})',
    '        send({"type": "extension_ui_request", "id": "unrelated-notification", "method": "notify", "message": "not-the-marker"})',
  )
  .replace(
    '        send({"type": "turn_end"})\n        send({"type": "agent_end"})\n        send({"type": "agent_settled"})',
    '        send({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "contentIndex": 0, "delta": "unrelated-traffic"}})',
  )

function makeChildSpawner(
  calls: Array<{ bin: string; args: string[] }>,
  lifecycle?: { children: ReturnType<typeof spawn>[]; releases: number; terminations: number },
  childSource = rpcChild,
): Spawner {
  const spawner: Spawner = Object.assign(async (bin: string, args: string[], options: Parameters<Spawner>[2]) => {
    const isRpc = args.includes('--mode') && args.includes('rpc')
    if (isRpc) calls.push({ bin, args: [...args] })
    const source = isRpc ? childSource : 'print("pi 0.83.0-test", flush=True)'
    const child = spawn('python3', ['-u', '-c', source], {
      cwd: options.cwd,
      env: { ...options.env, CLI_BRIDGE_TEST_ARGS: JSON.stringify(args) },
      stdio: options.stdio,
    })
    if (isRpc) lifecycle?.children.push(child)
    let released = false
    let terminated = false
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    return {
      child,
      release: () => {
        if (released) return
        released = true
        if (isRpc && lifecycle) lifecycle.releases += 1
      },
      terminate: async () => {
        if (terminated) return
        terminated = true
        if (isRpc && lifecycle) lifecycle.terminations += 1
        if (!child.killed) child.kill('SIGTERM')
        await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, 1_000))])
      },
    }
  }, { executionEnvironment: 'test-double' as const })
  return spawner
}

function interactionCommand(
  operationId: string,
  request: InteractionRequest,
  response: InteractionResponse,
): InteractionResponseCommand {
  const binding = { ...request.binding, requestDigest: request.requestDigest }
  return {
    operationId,
    binding,
    response,
    commandDigest: interactionResponseCommandDigest({ binding, response }),
  }
}

async function readJson(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for native child turn')
}

function privateRootCount(dir: string): number {
  return readdirSync(dir).filter(name => name.startsWith('.cli-bridge-pi-')).length
}

describe('Pi native RPC adapter', () => {
  let dir: string | null = null
  let store: SessionStore | null = null
  let runs: RunRegistry | null = null

  afterEach(async () => {
    await runs?.shutdown(2_000)
    store?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
    store = null
    runs = null
  })

  it('uses a real JSONL child for two HTTP turns, state proof, and canonical replay', async () => {
    dir = mkdtempSync(`${tmpdir()}/cli-bridge-pi-native-`)
    store = new SessionStore(dir)
    runs = new RunRegistry({ replayRetentionMs: 60_000, identityRetentionMs: 60_000 })
    const calls: Array<{ bin: string; args: string[] }> = []
    const lifecycle = { children: [] as ReturnType<typeof spawn>[], releases: 0, terminations: 0 }
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 10_000,
      spawner: makeChildSpawner(calls, lifecycle),
      transportResolver: testPiInferenceTransport(),
    })
    const registry = new BackendRegistry().register(backend)
    const service = new RetainedSessionService({ store, registry, runs })
    const app = new Hono()
    mountRetainedSessions(app, service)

    const created = await app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: 'child-session',
        model: 'pi/test/model',
        cwd: dir,
        agent_profile: { name: 'native-exact', prompt: { systemPrompt: 'native system' } },
      }),
    })
    expect(created.status).toBe(201)
    const first = await app.request('/v1/sessions/child-session/turns', {
      method: 'POST',
      body: JSON.stringify({ message: 'first', run_id: 'child-first', execution_id: 'child-first-execution' }),
    })
    expect(first.status).toBe(202)
    await waitFor(() => store!.getRetained('child-session')?.turns === 1)

    const second = await app.request('/v1/sessions/child-session/turns', {
      method: 'POST',
      body: JSON.stringify({ message: 'second', run_id: 'child-second', execution_id: 'child-second-execution' }),
    })
    expect(second.status).toBe(202)
    await waitFor(() => store!.getRetained('child-session')?.turns === 2)

    const transcript = await app.request('/v1/sessions/child-session/transcript')
    const body = await readJson(transcript)
    expect(body.messages.flatMap((message: any) => message.parts.map((part: any) => part.text))).toEqual([
      'child-reply-1',
      'child-reply-2',
    ])
    expect(body.usage).toHaveLength(2)
    expect(body.last_event_id).toBe('18')

    const events = await app.request('/v1/sessions/child-session/events')
    const eventText = await events.text()
    const envelopes = [...eventText.matchAll(/data: (\{.*\})\r?\n/gu)].map(match => JSON.parse(match[1]!))
    expect(envelopes.map(item => item.eventId)).toHaveLength(18)
    expect(new Set(envelopes.map(item => item.eventId)).size).toBe(18)
    expect(envelopes.some(item => item.event.type === 'raw' && item.event.event.type === 'usage')).toBe(true)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.args.slice(0, 2)).toEqual(['--mode', 'rpc'])
    expect(calls[0]!.args).toContain('--session-id')
    expect(calls[0]!.args).toContain('--extension')
    expect(calls[0]!.args).toContain('--system-prompt')
    const session = await app.request('/v1/sessions/child-session')
    const sessionBody = await readJson(session)
    expect(sessionBody.profile_materialization_receipt).toMatchObject({
      schema: 'cli-bridge.profile-materialization.v2',
      harness: 'pi',
    })

    // A successful run keeps the child for the next retained turn; bridge
    // shutdown is the terminal owner boundary that must close and release it.
    await runs.shutdown(1_000)
    expect(lifecycle.releases).toBe(1)
    expect(lifecycle.terminations).toBe(1)
    await runs.shutdown(1_000)
    expect(lifecycle.releases).toBe(1)
    expect(lifecycle.terminations).toBe(1)
  })

  it('closes the real retained child and removes private files at identity eviction', async () => {
    dir = mkdtempSync(`${tmpdir()}/cli-bridge-pi-native-eviction-`)
    store = new SessionStore(dir)
    runs = new RunRegistry({ replayRetentionMs: 20, identityRetentionMs: 40 })
    const lifecycle = { children: [] as ReturnType<typeof spawn>[], releases: 0, terminations: 0 }
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 10_000,
      spawner: makeChildSpawner([], lifecycle),
      transportResolver: testPiInferenceTransport(),
    })
    const service = new RetainedSessionService({
      store,
      registry: new BackendRegistry().register(backend),
      runs,
    })
    const app = new Hono()
    mountRetainedSessions(app, service)

    expect((await app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: 'evicted-child',
        model: 'pi/test/model',
        cwd: dir,
        agent_profile: { prompt: { systemPrompt: 'eviction profile' } },
      }),
    })).status).toBe(201)
    expect((await app.request('/v1/sessions/evicted-child/turns', {
      method: 'POST',
      body: JSON.stringify({
        message: 'finish',
        run_id: 'evicted-child-run',
        execution_id: 'evicted-child-execution',
      }),
    })).status).toBe(202)
    await waitFor(() => store!.getRetained('evicted-child')?.turns === 1)
    expect(lifecycle.children).toHaveLength(1)
    expect(privateRootCount(dir)).toBeGreaterThan(0)

    await waitFor(() => runs!.get('evicted-child-run') === undefined && lifecycle.releases === 1)
    expect(lifecycle.terminations).toBe(1)
    expect(lifecycle.releases).toBe(1)
    expect(privateRootCount(dir)).toBe(0)
    expect(lifecycle.children[0]!.exitCode !== null || lifecycle.children[0]!.signalCode !== null).toBe(true)
  })

  it('releases the native child lease when the RPC process exits unexpectedly', async () => {
    dir = mkdtempSync(`${tmpdir()}/cli-bridge-pi-native-crash-`)
    store = new SessionStore(dir)
    runs = new RunRegistry({ replayRetentionMs: 60_000, identityRetentionMs: 60_000 })
    const lifecycle = { children: [] as ReturnType<typeof spawn>[], releases: 0, terminations: 0 }
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 10_000,
      spawner: makeChildSpawner([], lifecycle),
      transportResolver: testPiInferenceTransport(),
    })
    const registry = new BackendRegistry().register(backend)
    const service = new RetainedSessionService({ store, registry, runs })
    const app = new Hono()
    mountRetainedSessions(app, service)

    const created = await app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'crash-session', model: 'pi/test/model', cwd: dir }),
    })
    expect(created.status).toBe(201)
    const turn = await app.request('/v1/sessions/crash-session/turns', {
      method: 'POST',
      body: JSON.stringify({ message: 'first', run_id: 'crash-first', execution_id: 'crash-first-execution' }),
    })
    expect(turn.status).toBe(202)
    await waitFor(() => store!.getRetained('crash-session')?.turns === 1)
    expect(lifecycle.children).toHaveLength(1)

    lifecycle.children[0]!.kill('SIGKILL')
    await waitFor(() => lifecycle.releases === 1)
    expect(lifecycle.releases).toBe(1)
  })

  it('retains the native lease and private files until termination is proven', async () => {
    dir = mkdtempSync(`${tmpdir()}/cli-bridge-pi-native-proof-`)
    let releases = 0
    let terminationAttempts = 0
    let child: ReturnType<typeof spawn> | null = null
    const spawner: Spawner = Object.assign(async (_bin: string, args: string[], options: Parameters<Spawner>[2]) => {
      child = spawn('python3', ['-u', '-c', rpcChild], {
        cwd: options.cwd,
        env: options.env,
        stdio: options.stdio,
      })
      const running = child
      const closed = new Promise<void>(resolve => running!.once('close', () => resolve()))
      return {
        child: running,
        release: () => { releases += 1 },
        terminate: async () => {
          terminationAttempts += 1
          if (terminationAttempts === 1) throw new Error('termination not proven')
          running!.kill('SIGKILL')
          await closed
        },
      }
    }, { executionEnvironment: 'test-double' as const })
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1_000,
      spawner,
      transportResolver: testPiInferenceTransport(),
    })
    const native = await backend.startNativeSession({
      model: 'pi/test/model',
      messages: [{ role: 'user', content: 'start' }],
      cwd: dir,
      mode: 'byob',
      interaction_policy: 'interactive',
    }, null)

    await expect(native.close()).rejects.toThrow(/termination not proven/)
    expect(releases).toBe(0)
    expect(privateRootCount(dir)).toBeGreaterThan(0)

    await expect(native.close()).resolves.toBeUndefined()
    expect(releases).toBe(1)
    expect(privateRootCount(dir)).toBe(0)
    const observedChild = child as ReturnType<typeof spawn> | null
    expect(observedChild).not.toBeNull()
    expect(observedChild!.exitCode !== null || observedChild!.signalCode !== null).toBe(true)
  })

  it('returns the native executor allocation when private-file cleanup must retry', async () => {
    dir = mkdtempSync(`${tmpdir()}/cli-bridge-pi-native-cleanup-retry-`)
    const lifecycle = { children: [] as ReturnType<typeof spawn>[], releases: 0, terminations: 0 }
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 1_000,
      spawner: makeChildSpawner([], lifecycle),
      transportResolver: testPiInferenceTransport(),
    })
    const native = await backend.startNativeSession({
      model: 'pi/test/model',
      messages: [{ role: 'user', content: 'start' }],
      cwd: dir,
      mode: 'byob',
      interaction_policy: 'interactive',
    }, null)
    const rootName = readdirSync(dir).find(name => name.startsWith('.cli-bridge-pi-rpc-'))
    expect(rootName).toBeDefined()
    const root = `${dir}/${rootName!}`
    const original = `${root}.original`
    renameSync(root, original)
    mkdirSync(root, { mode: 0o700 })

    await expect(native.close()).rejects.toThrow(/replaced temporary root/u)
    expect(lifecycle).toMatchObject({ releases: 1, terminations: 1 })

    rmSync(root, { recursive: true, force: true })
    renameSync(original, root)
    await expect(native.close()).resolves.toBeUndefined()
    expect(lifecycle).toMatchObject({ releases: 1, terminations: 1 })
  })

  it('aborts and closes a real retained child exactly once on cancellation', async () => {
    dir = mkdtempSync(`${tmpdir()}/cli-bridge-pi-native-cancel-`)
    store = new SessionStore(dir)
    runs = new RunRegistry({ replayRetentionMs: 60_000, identityRetentionMs: 60_000 })
    const lifecycle = { children: [] as ReturnType<typeof spawn>[], releases: 0, terminations: 0 }
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 500,
      spawner: makeChildSpawner([], lifecycle, abortingChild),
      transportResolver: testPiInferenceTransport(),
    })
    const registry = new BackendRegistry().register(backend)
    const service = new RetainedSessionService({ store, registry, runs })
    const app = new Hono()
    mountRetainedSessions(app, service)

    expect((await app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'cancel-real', model: 'pi/test/model', cwd: dir }),
    })).status).toBe(201)
    const turn = await app.request('/v1/sessions/cancel-real/turns', {
      method: 'POST',
      body: JSON.stringify({ message: 'hang until cancelled', run_id: 'cancel-real-run', execution_id: 'cancel-real-execution' }),
    })
    expect(turn.status).toBe(202)
    const runId = (await readJson(turn)).run.id as string
    await waitFor(() => store!.getRetained('cancel-real')?.status === 'running')

    const admission = store.getRetainedRun(runId)
    if (!admission) throw new Error('cancel-real run admission missing')
    const material = {
      operationId: 'cancel-real',
      run: {
        runId,
        provider: 'cli-bridge',
        environmentId: 'cli-bridge',
        sessionId: 'cancel-real',
        executionId: admission.executionId,
        requestDigest: admission.requestDigest as `sha256:${string}`,
      },
    }
    const cancelled = await app.request('/v1/sessions/cancel-real/cancel?wait_ms=2000', {
      method: 'POST',
      body: JSON.stringify({
        ...material,
        requestDigest: agentRunCancellationRequestDigest(material),
      }),
    })
    expect(cancelled.status).toBe(200)
    expect(await readJson(cancelled)).toMatchObject({ status: 'accepted', effect: 'cancelled' })
    await waitFor(() => lifecycle.releases === 1)
    expect(lifecycle.releases).toBe(1)
    expect(lifecycle.terminations).toBe(1)
    expect(runs!.nativeSession('cancel-real')).toBeNull()

    // A second terminal cleanup request must not call the provider or release
    // the executor slot again.
    await runs!.shutdown(1_000)
    expect(lifecycle.releases).toBe(1)
    expect(lifecycle.terminations).toBe(1)
  })

  it('bounds an unacknowledged initial prompt RPC and then closes the real child', async () => {
    dir = mkdtempSync(`${tmpdir()}/cli-bridge-pi-native-timeout-`)
    store = new SessionStore(dir)
    runs = new RunRegistry({ replayRetentionMs: 60_000, identityRetentionMs: 60_000 })
    const lifecycle = { children: [] as ReturnType<typeof spawn>[], releases: 0, terminations: 0 }
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 80,
      spawner: makeChildSpawner([], lifecycle, hungPromptChild),
      transportResolver: testPiInferenceTransport(),
    })
    const registry = new BackendRegistry().register(backend)
    const service = new RetainedSessionService({ store, registry, runs })
    const app = new Hono()
    mountRetainedSessions(app, service)
    expect((await app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'timeout-real', model: 'pi/test/model', cwd: dir }),
    })).status).toBe(201)

    const startedAt = Date.now()
    const turn = await app.request('/v1/sessions/timeout-real/turns', {
      method: 'POST',
      body: JSON.stringify({ message: 'never acknowledge prompt', run_id: 'timeout-real-run', execution_id: 'timeout-real-execution' }),
    })
    expect(turn.status).toBe(202)
    await waitFor(() => store!.getRetained('timeout-real')?.status === 'unknown', 2_000)
    expect(Date.now() - startedAt).toBeLessThan(1_500)
    await waitFor(() => lifecycle.releases === 1)
    expect(lifecycle.releases).toBe(1)
    expect(lifecycle.terminations).toBe(1)
  })

  it('acknowledges a Pi interaction only after the native turn visibly resumes', async () => {
    dir = mkdtempSync(`${tmpdir()}/cli-bridge-pi-native-interaction-`)
    store = new SessionStore(dir)
    runs = new RunRegistry({ replayRetentionMs: 60_000, identityRetentionMs: 60_000 })
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 500,
      spawner: makeChildSpawner([], undefined, interactionChild),
      transportResolver: testPiInferenceTransport(),
    })
    const service = new RetainedSessionService({
      store,
      registry: new BackendRegistry().register(backend),
      runs,
    })
    const app = new Hono()
    mountRetainedSessions(app, service)
    expect((await app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'native-interaction', model: 'pi/test/model', cwd: dir }),
    })).status).toBe(201)
    const turn = await app.request('/v1/sessions/native-interaction/turns', {
      method: 'POST',
      body: JSON.stringify({
        message: 'ask permission',
        run_id: 'native-interaction-run',
        execution_id: 'native-interaction-execution',
      }),
    })
    expect(turn.status).toBe(202)
    await waitFor(() => store!.retainedEventsAfter('native-interaction').some(item => item.envelope.event.type === 'interaction'))
    const event = store.retainedEventsAfter('native-interaction').find(item => item.envelope.event.type === 'interaction')?.envelope.event
    if (event?.type !== 'interaction') throw new Error('native interaction event missing')
    const command = interactionCommand('native-interaction-response', event.request, {
      id: event.request.id,
      outcome: 'accepted',
      data: { grant: ['allow_once'] },
    })
    const response = await app.request(
      `/v1/runs/native-interaction-run/interactions/${event.request.id}/respond`,
      { method: 'POST', body: JSON.stringify(command) },
    )
    expect(response.status).toBe(200)
    expect(await readJson(response)).toMatchObject({ status: 'accepted' })
    await waitFor(() => store!.getRetained('native-interaction')?.turns === 1)
    expect(store.retainedEventsAfter('native-interaction').some(item =>
      item.envelope.event.type === 'message.part.updated' &&
      item.envelope.event.part.type === 'text' &&
      item.envelope.event.part.text === 'permission-resumed')).toBe(true)
  })

  it('returns transport failure when Pi consumes a response but exposes no resumed native effect', async () => {
    dir = mkdtempSync(`${tmpdir()}/cli-bridge-pi-native-interaction-timeout-`)
    store = new SessionStore(dir)
    runs = new RunRegistry({ replayRetentionMs: 60_000, identityRetentionMs: 60_000 })
    const backend = new PiBackend({
      bin: 'pi',
      timeoutMs: 80,
      spawner: makeChildSpawner([], undefined, interactionWithoutProgressChild),
      transportResolver: testPiInferenceTransport(),
    })
    const service = new RetainedSessionService({
      store,
      registry: new BackendRegistry().register(backend),
      runs,
    })
    const app = new Hono()
    mountRetainedSessions(app, service)
    await app.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: 'silent-interaction', model: 'pi/test/model', cwd: dir }),
    })
    await app.request('/v1/sessions/silent-interaction/turns', {
      method: 'POST',
      body: JSON.stringify({
        message: 'ask permission',
        run_id: 'silent-interaction-run',
        execution_id: 'silent-interaction-execution',
      }),
    })
    await waitFor(() => store!.retainedEventsAfter('silent-interaction').some(item => item.envelope.event.type === 'interaction'))
    const event = store.retainedEventsAfter('silent-interaction').find(item => item.envelope.event.type === 'interaction')?.envelope.event
    if (event?.type !== 'interaction') throw new Error('silent native interaction event missing')
    const response = await app.request(
      `/v1/runs/silent-interaction-run/interactions/${event.request.id}/respond`,
      {
        method: 'POST',
        body: JSON.stringify(interactionCommand('silent-interaction-response', event.request, {
          id: event.request.id,
          outcome: 'accepted',
          data: { grant: ['allow_once'] },
        })),
      },
    )
    const responseBody = await readJson(response)
    expect(response.status).toBe(502)
    expect(responseBody).toMatchObject({ status: 'transport_failure', retryable: false })
    expect(store.getInteractionOperation('silent-interaction-response')?.acknowledgement.status).toBe('transport_failure')
  })
})
