import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { Backend, BackendHealth, ChatDelta, ChatRequest } from '../../src/backends/types.js'
import { BackendRegistry } from '../../src/backends/registry.js'
import { mountChatCompletions } from '../../src/routes/chat-completions.js'
import { mountRuns } from '../../src/routes/runs.js'
import { RunRegistry } from '../../src/runs/registry.js'
import { SessionStore, type SessionRecord } from '../../src/sessions/store.js'
import { RetainedSessionService } from '../../src/sessions/retained.js'

const dataDir = process.env.CLI_BRIDGE_TEST_DATA_DIR
const port = Number(process.env.CLI_BRIDGE_TEST_PORT ?? 0)
if (!dataDir || !Number.isSafeInteger(port) || port < 0 || port > 65_535) {
  throw new Error('CLI_BRIDGE_TEST_DATA_DIR and CLI_BRIDGE_TEST_PORT are required')
}

class ReplayBackend implements Backend {
  readonly name = 'durable'

  matches(model: string): boolean {
    return model === 'durable/test'
  }

  async health(): Promise<BackendHealth> {
    return { name: this.name, state: 'ready' }
  }

  async *chat(
    _request: ChatRequest,
    _session: SessionRecord | null,
    _signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    yield { content: 'one' }
    yield { content: 'two' }
    yield { finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 2 } }
  }
}

const sessions = new SessionStore(dataDir)
const runs = new RunRegistry()
const registry = new BackendRegistry().register(new ReplayBackend())
const retained = new RetainedSessionService({ store: sessions, registry, runs })
const app = new Hono()
mountChatCompletions(app, { registry, sessions, retainedRuns: sessions, runs })
mountRuns(app, { runs, retainedRuns: retained, retainedStore: sessions })

const server = serve(
  { fetch: app.fetch, hostname: '127.0.0.1', port },
  (info) => console.log(`READY:${info.port}`),
)

let closing = false
function close(): void {
  if (closing) return
  closing = true
  runs.clear()
  server.close(() => {
    sessions.close()
    process.exit(0)
  })
}

process.once('SIGTERM', close)
process.once('SIGINT', close)
