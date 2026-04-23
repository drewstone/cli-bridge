/**
 * Passthrough backend — direct vendor-API call, no CLI harness.
 *
 * Model id scheme: `<provider>/<model>` where `<provider>` is one of
 * openai, anthropic, moonshot, zai. This is NOT subscription-backed —
 * it uses API keys you've configured in env and bills per token.
 *
 * Examples:
 *   openai/gpt-4o
 *   anthropic/claude-3-5-sonnet
 *   moonshot/kimi-k2-0905-preview
 *   zai/glm-4.6
 *
 * Kept here so cli-bridge is a single endpoint for BOTH subscription-
 * backed CLI harnesses AND metered API calls — pick by model id shape.
 * Use sparingly; if you want per-provider config + fallback chains +
 * cost tracking, send traffic through a router (tangle-router,
 * openrouter, litellm) instead.
 */

import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

interface ProviderBinding {
  name: string
  prefix: string
  baseUrl: string
  apiKey: string | null
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
      { name: 'openai', prefix: 'openai/', baseUrl: 'https://api.openai.com/v1', apiKey: opts.openaiApiKey },
      { name: 'anthropic', prefix: 'anthropic/', baseUrl: 'https://api.anthropic.com/v1', apiKey: opts.anthropicApiKey },
      { name: 'moonshot', prefix: 'moonshot/', baseUrl: 'https://api.moonshot.ai/v1', apiKey: opts.moonshotApiKey },
      { name: 'zai', prefix: 'zai/', baseUrl: 'https://api.z.ai/api/paas/v4', apiKey: opts.zaiApiKey },
    ]
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return this.providers.some(p => p.apiKey !== null && m.startsWith(p.prefix))
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

    // Strip the "<provider>/" prefix before forwarding — upstreams expect
    // their own bare model ids ("gpt-4o", not "openai/gpt-4o").
    const bareModel = req.model.slice(provider.prefix.length)

    const body: Record<string, unknown> = {
      model: bareModel,
      messages: req.messages,
      stream: true,
      temperature: req.temperature,
      max_tokens: req.max_tokens,
    }
    if (req.responseFormat) {
      body.response_format = req.responseFormat
    }

    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(body),
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
          if (choice?.delta?.content) yield { content: choice.delta.content }
          if (choice?.finish_reason) {
            yield {
              finish_reason: choice.finish_reason as ChatDelta['finish_reason'],
              usage: parsed.usage
                ? { input_tokens: parsed.usage.prompt_tokens, output_tokens: parsed.usage.completion_tokens }
                : undefined,
            }
          }
        } catch { /* skip malformed delta line */ }
      }
    }

    yield { finish_reason: 'stop' }
  }

  private pick(model: string): ProviderBinding | null {
    const m = model.toLowerCase()
    for (const p of this.providers) {
      if (p.apiKey !== null && m.startsWith(p.prefix)) return p
    }
    return null
  }
}
