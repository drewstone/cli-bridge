import type { Backend, ChatDelta, ChatRequest, BackendHealth } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'

export interface UrlTranslateBackendOptions {
  translationApiUrl: string
  translationApiKey: string | null
  timeoutMs: number
}

interface TranslateRequest {
  url: string
  targetLanguage: string
}

function parseTranslateRequest(messages: ChatRequest['messages']): TranslateRequest | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role !== 'user') continue
    const text = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map(p => p.text).join('\n')
        : null
    if (!text) continue
    try {
      const parsed = JSON.parse(text)
      if (parsed.url && parsed.targetLanguage) {
        return { url: parsed.url, targetLanguage: parsed.targetLanguage }
      }
    } catch {
      const urlMatch = text.match(/https?:\/\/\S+/)
      const langMatch = text.match(/(?:to|into|in)\s+(\w+)/i)
        ?? text.match(/translate\s+.*?(\w+)/i)
      if (urlMatch && langMatch) {
        return { url: urlMatch[0], targetLanguage: langMatch[1]! }
      }
    }
  }
  return null
}

async function fetchPage(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; url-translate/1.0)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
  })
  if (!res.ok) {
    throw new BackendError(`fetch failed: ${res.status} ${res.statusText}`, 'upstream')
  }
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('text/html') && !ct.includes('application/xhtml') && !ct.includes('text/plain')) {
    throw new BackendError(`unsupported content type: ${ct}`, 'upstream')
  }
  return res.text()
}

function extractTextSegments(html: string): { segments: string[]; placeholderMap: Map<string, string> } {
  const segments: string[] = []
  const placeholderMap = new Map<string, string>()
  let counter = 0

  const tagRe = /<(script|style|noscript|code|pre|textarea)[^>]*>[\s\S]*?<\/\1>/gi
  const attrRe = /\s+(?:href|src|action|content|property|charset|http-equiv|rel|lang|xmlns|charset|type)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi
  const tokenRe = /@@TZ(\d+)@@/g

  html = html.replace(tagRe, (match) => {
    const id = `@@TZ${counter++}@@`
    placeholderMap.set(id, match)
    return id
  })

  html = html.replace(attrRe, (match) => {
    const id = `@@TZ${counter++}@@`
    placeholderMap.set(id, match)
    return id
  })

  const htmlTagRe = /<[^>]+>/g
  let remaining = html
  let result = ''
  let lastIndex = 0

  const tagPositions: Array<{ start: number; end: number; tag: string }> = []
  let m: RegExpExecArray | null
  const htmlCopy = html
  const re = new RegExp(htmlTagRe.source, htmlTagRe.flags)
  while ((m = re.exec(htmlCopy)) !== null) {
    tagPositions.push({ start: m.index, end: m.index + m[0].length, tag: m[0] })
  }

  let pos = 0
  for (const tp of tagPositions) {
    if (tp.start > pos) {
      const text = html.slice(pos, tp.start)
      if (text.trim()) {
        segments.push(text)
      }
    }
    pos = tp.end
  }
  if (pos < html.length) {
    const text = html.slice(pos)
    if (text.trim()) {
      segments.push(text)
    }
  }

  return { segments, placeholderMap }
}

async function translateSegments(
  segments: string[],
  targetLanguage: string,
  opts: UrlTranslateBackendOptions,
  signal: AbortSignal,
): Promise<string[]> {
  if (segments.length === 0) return []

  const useGoogle = opts.translationApiUrl.includes('googleapis')
  const useDeepL = opts.translationApiUrl.includes('deepl')

  if (useGoogle) {
    return translateViaGoogle(segments, targetLanguage, opts, signal)
  }
  if (useDeepL) {
    return translateViaDeepL(segments, targetLanguage, opts, signal)
  }
  return translateViaLlm(segments, targetLanguage, opts, signal)
}

async function translateViaGoogle(
  segments: string[],
  targetLanguage: string,
  opts: UrlTranslateBackendOptions,
  signal: AbortSignal,
): Promise<string[]> {
  const body = {
    q: segments,
    target: targetLanguage,
    format: 'html',
  }
  const url = opts.translationApiKey
    ? `${opts.translationApiUrl}&key=${opts.translationApiKey}`
    : opts.translationApiUrl

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new BackendError(`Google Translate API ${res.status}: ${text.slice(0, 200)}`, 'upstream')
  }
  const data = await res.json() as {
    data: { translations: Array<{ translatedText: string }> }
  }
  return data.data.translations.map(t => t.translatedText)
}

async function translateViaDeepL(
  segments: string[],
  targetLanguage: string,
  opts: UrlTranslateBackendOptions,
  signal: AbortSignal,
): Promise<string[]> {
  const form = new URLSearchParams()
  for (const seg of segments) {
    form.append('text', seg)
  }
  form.append('target_lang', targetLanguage.toUpperCase())
  if (opts.translationApiKey) {
    form.append('auth_key', opts.translationApiKey)
  }

  const res = await fetch(opts.translationApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new BackendError(`DeepL API ${res.status}: ${text.slice(0, 200)}`, 'upstream')
  }
  const data = await res.json() as {
    translations: Array<{ text: string }>
  }
  return data.translations.map(t => t.text)
}

async function translateViaLlm(
  segments: string[],
  targetLanguage: string,
  opts: UrlTranslateBackendOptions,
  _signal: AbortSignal,
): Promise<string[]> {
  const results: string[] = []
  const batchSize = 10
  for (let i = 0; i < segments.length; i += batchSize) {
    const batch = segments.slice(i, i + batchSize)
    const numbered = batch.map((s, idx) => `[${i + idx}] ${s}`).join('\n\n')
    const prompt =
      `Translate each numbered text segment below into ${targetLanguage}. ` +
      `Preserve HTML entities, placeholders like @@TZ...@@, and any non-text tokens exactly. ` +
      `Return ONLY the numbered translations, one per line, in the same [N] format.\n\n${numbered}`

    const res = await fetch(opts.translationApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.translationApiKey ? { 'Authorization': `Bearer ${opts.translationApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new BackendError(`LLM translate ${res.status}: ${text.slice(0, 200)}`, 'upstream')
    }
    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>
    }
    const content = data.choices[0]?.message?.content ?? ''
    const lines = content.split('\n').filter(l => l.trim())
    for (const line of lines) {
      const match = /^\[\d+\]\s*/.exec(line)
      if (match) {
        results.push(line.slice(match[0].length))
      }
    }
  }
  return results
}

function reassembleHtml(html: string, translatedSegments: string[], placeholderMap: Map<string, string>): string {
  const tagRe = /<[^>]+>/g
  const tagPositions: Array<{ start: number; end: number }> = []
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html)) !== null) {
    tagPositions.push({ start: m.index, end: m.index + m[0].length })
  }

  const parts: string[] = []
  let pos = 0
  let segIdx = 0

  for (const tp of tagPositions) {
    if (tp.start > pos) {
      const text = html.slice(pos, tp.start)
      if (text.trim() && segIdx < translatedSegments.length) {
        parts.push(translatedSegments[segIdx]!)
        segIdx++
      } else {
        parts.push(text)
      }
    }
    parts.push(html.slice(tp.start, tp.end))
    pos = tp.end
  }
  if (pos < html.length) {
    const text = html.slice(pos)
    if (text.trim() && segIdx < translatedSegments.length) {
      parts.push(translatedSegments[segIdx]!)
      segIdx++
    } else {
      parts.push(text)
    }
  }

  let result = parts.join('')

  for (const [placeholder, original] of placeholderMap) {
    result = result.replaceAll(placeholder, original)
  }

  const langRe = /<html[^>]*\slang\s*=\s*["']([a-zA-Z-]+)["']/i
  result = result.replace(langRe, (match, _lang: string) => {
    return match.replace(/lang\s*=\s*["'][a-zA-Z-]+["']/i, `lang="${_lang}"`)
  })

  return result
}

export class UrlTranslateBackend implements Backend {
  readonly name = 'url-translate'
  private readonly opts: UrlTranslateBackendOptions

  constructor(opts: UrlTranslateBackendOptions) {
    this.opts = opts
  }

  matches(model: string): boolean {
    const m = model.toLowerCase()
    return m === 'url-translate' || m.startsWith('url-translate/')
  }

  async health(): Promise<BackendHealth> {
    return {
      name: this.name,
      state: 'ready',
      detail: `translation api: ${this.opts.translationApiUrl}`,
    }
  }

  async *chat(
    req: ChatRequest,
    _session: SessionRecord | null,
    signal: AbortSignal,
  ): AsyncIterable<ChatDelta> {
    const translateReq = parseTranslateRequest(req.messages)
    if (!translateReq) {
      throw new BackendError(
        'Provide a JSON message with { "url": "...", "targetLanguage": "..." }',
        'not_configured',
      )
    }

    const html = await fetchPage(translateReq.url, signal)
    const { segments, placeholderMap } = extractTextSegments(html)

    let translatedHtml: string
    if (segments.length === 0) {
      translatedHtml = html
    } else {
      const translated = await translateSegments(segments, translateReq.targetLanguage, this.opts, signal)
      translatedHtml = reassembleHtml(html, translated, placeholderMap)
    }

    yield { content: translatedHtml }
    yield { finish_reason: 'stop' }
  }
}
