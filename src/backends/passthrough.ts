/**
 * Passthrough backend — when a request doesn't match any CLI backend,
 * forward it to the vendor's real HTTP API using a configured key.
 *
 * Kept minimal on purpose. If you want full routing across many
 * providers (cost optimization, fallback chains, compliance filters),
 * point cli-bridge at an OpenAI-compatible router (tangle-router,
 * openrouter, litellm) instead of wiring that logic here.
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

interface ProviderBinding {
  name: string
  baseUrl: string
  apiKey: string | null
  matchPrefixes: string[]
}

export class PassthroughBackend implements Backend {
  readonly name = 'passthrough'
  private readonly providers: ProviderBinding[]

  constructor(opts: {
    openaiApiKey: string | null
    anthropicApiKey: string | null
    moonshotApiKey: string | null
    zaiApiKey: string | null
  }) {
    this.providers = [
      {
        name: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: opts.openaiApiKey,
        matchPrefixes: ['gpt-', 'o1-', 'o3-', 'openai/'],
      },
      {
        name: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: opts.anthropicApiKey,
        matchPrefixes: ['claude-3', 'anthropic/'],
      },
      {
        name: 'moonshot',
        baseUrl: 'https://api.moonshot.ai/v1',
        apiKey: opts.moonshotApiKey,
        matchPrefixes: ['moonshot-', 'kimi-', 'moonshot/'],
      },
      {
        name: 'zai',
        baseUrl: 'https://api.z.ai/api/paas/v4',
        apiKey: opts.zaiApiKey,
        matchPrefixes: ['glm-', 'zai/', 'glm/'],
      },
    ]
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return this.providers.some(p =>
      p.apiKey !== null && p.matchPrefixes.some(pfx => m.startsWith(pfx)),
    )
  }

  async health(): Promise<BackendHealth> {
    const configured = this.providers.filter(p => p.apiKey !== null).map(p => p.name)
    if (configured.length === 0) {
      return { name: this.name, state: 'unavailable', detail: 'no provider keys configured' }
    }
    return { name: this.name, state: 'ready', detail: `providers: ${configured.join(', ')}` }
  }

  async *chat(
    req: ChatRequest,
    _session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    const provider = this.pick(req.model)
    if (!provider) {
      throw new BackendError(`no passthrough provider matches model "${req.model}"`, 'not_configured')
    }

    // For now, only support OpenAI-shaped Chat Completions. Anthropic's
    // /v1/messages needs a separate request shape — wired in the route
    // layer, not here, to keep this backend small.
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: true,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
      }),
      signal,
    })

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '')
      throw new BackendError(
        `${provider.name} returned ${res.status}: ${body.slice(0, 300)}`,
        'upstream',
      )
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      if (signal.aborted) {
        reader.cancel().catch(() => {})
        return
      }
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line || !line.startsWith('data:')) continue
        const payload = line.slice('data:'.length).trim()
        if (payload === '[DONE]') {
          yield { finish_reason: 'stop' }
          return
        }
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>
            usage?: { prompt_tokens?: number; completion_tokens?: number }
          }
          const choice = parsed.choices?.[0]
          if (choice?.delta?.content) {
            yield { content: choice.delta.content }
          }
          if (choice?.finish_reason) {
            yield {
              finish_reason: choice.finish_reason as ChatDelta['finish_reason'],
              usage: parsed.usage
                ? { input_tokens: parsed.usage.prompt_tokens, output_tokens: parsed.usage.completion_tokens }
                : undefined,
            }
          }
        } catch {
          // skip malformed delta line
        }
      }
    }

    yield { finish_reason: 'stop' }
  }

  private pick(model: string): ProviderBinding | null {
    const m = model.toLowerCase()
    for (const p of this.providers) {
      if (p.apiKey !== null && p.matchPrefixes.some(pfx => m.startsWith(pfx))) return p
    }
    return null
  }
}
