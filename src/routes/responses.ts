/**
 * POST /v1/responses and /profiles/:id/v1/responses — the text subset of the OpenAI Responses API, for callers that only
 * call `responses.create`, such as PRBench's runner. The request runs as one non-streaming chat completion through this
 * Bridge's own route (/v1/chat/completions, or /profiles/:id/v1/chat/completions with that profile), so admission, jail and
 * receipts are the chat route's, and the reply comes back as a Responses object whose `output_text` is the answer.
 *
 * Carried: `model`, `input` (a string, or role/content messages with text parts), `instructions` (a system message),
 * `max_output_tokens` and `reasoning.effort`. Refused with 400: anything that would change what runs without this
 * subset running it (tools, background, streaming, stored conversation state, structured output).
 */

import type { Context, Hono } from 'hono'

const REFUSED = ['tools', 'tool_choice', 'background', 'stream', 'previous_response_id', 'conversation', 'text', 'prompt'] as const
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])

export function mountResponses(app: Hono): void {
  app.post('/v1/responses', (c) => respond(app, c, '/v1'))
  app.post('/profiles/:id/v1/responses', (c) => respond(app, c, `/profiles/${encodeURIComponent(c.req.param('id'))}/v1`))
}

async function respond(app: Hono, c: Context, base: string): Promise<Response> {
  const refuse = (message: string) => c.json({ error: { message, type: 'invalid_request_error' } }, 400)
  const body = await c.req.json().catch(() => undefined) as Record<string, unknown> | undefined
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('invalid JSON body')
  if (typeof body.model !== 'string' || !body.model) return refuse('model is required')
  const refused = REFUSED.filter((field) => {
    const value = body[field]
    if (value === undefined || value === null || value === false || (Array.isArray(value) && value.length === 0)) return false
    return !(field === 'text' && (value as { format?: { type?: unknown } }).format?.type === 'text')
  })
  if (refused.length) return refuse(`this Bridge serves the Responses API's text subset; it does not run ${refused.join(', ')}`)
  const messages = inputMessages(body.input)
  if (typeof messages === 'string') return refuse(messages)
  if (typeof body.instructions === 'string' && body.instructions) messages.unshift({ role: 'system', content: body.instructions })
  const effort = (body.reasoning as { effort?: unknown } | undefined)?.effort
  const chat = {
    model: body.model, messages,
    ...(typeof body.max_output_tokens === 'number' ? { max_tokens: body.max_output_tokens } : {}),
    ...(typeof effort === 'string' && EFFORTS.has(effort) ? { effort } : {}),
  }
  const url = new URL(c.req.url)
  url.pathname = `${base}/chat/completions`
  const headers = new Headers(c.req.raw.headers)
  headers.delete('content-length')
  const answered = await app.fetch(new Request(url, { method: 'POST', headers, body: JSON.stringify(chat), signal: c.req.raw.signal }), c.env)
  if (!answered.ok) return answered
  const completion = await answered.json() as {
    id?: string; created?: number; choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const text = typeof completion.choices?.[0]?.message?.content === 'string' ? completion.choices[0].message.content : ''
  const input = completion.usage?.prompt_tokens ?? 0, output = completion.usage?.completion_tokens ?? 0
  return c.json({
    id: `resp_${completion.id ?? crypto.randomUUID()}`, object: 'response', created_at: completion.created ?? Math.floor(Date.now() / 1000),
    model: body.model, status: 'completed',
    output: [{ type: 'message', id: `msg_${completion.id ?? crypto.randomUUID()}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
  })
}

/** Responses `input` as chat messages: a string is one user message; text parts join; any other part is refused. */
function inputMessages(input: unknown): Array<{ role: string; content: string }> | string {
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  if (!Array.isArray(input) || input.length === 0) return 'input must be a string or a non-empty list of messages'
  const messages: Array<{ role: string; content: string }> = []
  for (const item of input as Array<{ type?: unknown; role?: unknown; content?: unknown }>) {
    if ((item.type !== undefined && item.type !== 'message') || !['user', 'assistant', 'system', 'developer'].includes(String(item.role))) {
      return 'input items must be messages with role user, assistant, system or developer'
    }
    const content = typeof item.content === 'string' ? item.content : Array.isArray(item.content)
      && item.content.every((part: { type?: unknown; text?: unknown }) => ['input_text', 'output_text', 'text'].includes(String(part?.type)) && typeof part.text === 'string')
      ? item.content.map((part: { text: string }) => part.text).join('') : null
    if (content === null) return 'message content must be text'
    messages.push({ role: item.role === 'developer' ? 'system' : String(item.role), content })
  }
  return messages
}
