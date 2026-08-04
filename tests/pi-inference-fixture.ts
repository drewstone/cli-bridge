import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  PiInferenceTransportResolver,
  ResolvedPiInferenceTransport,
} from '../src/backends/pi-inference-transport.js'

export function testPiInferenceTransport(
  overrides: Partial<ResolvedPiInferenceTransport> = {},
): PiInferenceTransportResolver {
  return async ({ provider, model }) => ({
    provider,
    model,
    upstreamBaseUrl: 'http://127.0.0.1:9/v1',
    apiMode: 'openai-completions',
    upstreamApiKey: 'test-upstream-key',
    providerConfig: { api: 'openai-completions' },
    modelConfig: {
      id: model,
      name: model,
      api: 'openai-completions',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    },
    sourceAgentDir: tmpdir(),
    sourceSessionDir: join(tmpdir(), 'cli-bridge-pi-test-sessions'),
    ...overrides,
  })
}
