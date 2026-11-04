import type { ChatDelta, ChatMessage, ChatMessageContent, ChatContentPart } from './types.js'

export interface ImageAttachment {
  data: Buffer
  mediaType: string
}

export function flattenMessages(messages: ChatMessage[], options: { includeSystem?: boolean } = {}): string {
  const includeSystem = options.includeSystem ?? true
  const visibleMessages = includeSystem ? messages : messages.filter((m) => m.role !== 'system')
  if (visibleMessages.length === 1) return contentToText(visibleMessages[0]?.content ?? '')
  return visibleMessages.map((m) => `[${m.role}] ${contentToText(m.content)}`).join('\n\n')
}

/**
 * Rough token estimate (~4 chars/token) for backends whose CLI emits no usage
 * (kimi-code, opencode). A floor, not exact: the input estimate sees only the
 * request messages, not the backend's injected system prompt or tool schemas.
 * Callers flag the resulting usage `estimated` so cost ledgers price it as
 * approximate, never as measured provider truth.
 */
export function tokensFromChars(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4))
}

/**
 * Total characters the model actually reads for a request — message content PLUS
 * assistant tool-call structures (id + name + arguments), which `flattenMessages`
 * deliberately omits. Used only for usage estimation, where dropping tool calls
 * would systematically undercount tool-heavy turns and make them look cheaper than
 * they were. Counts the semantic payload, not JSON framing.
 */
export function estimateMessagesChars(messages: ChatMessage[]): number {
  let n = 0
  for (const m of messages) {
    n += contentToText(m.content).length
    for (const tc of m.tool_calls ?? []) {
      n += (tc.id?.length ?? 0) + (tc.function?.name?.length ?? 0) + (tc.function?.arguments?.length ?? 0)
    }
  }
  return n
}

/** A tool call the harness ran itself, as `delta.tool_results` reports it; `content` is what the model got back. */
export function toolResult(id: string, name: string, isError: boolean, content: unknown): NonNullable<ChatDelta['tool_results']>[number] {
  const text = typeof content === 'string' || Array.isArray(content) ? contentToText(content as ChatMessageContent) : undefined
  return isError ? { id, name, status: 'error', ...(text ? { error: text } : {}) } : { id, name, status: 'completed', ...(text === undefined ? {} : { output: text }) }
}

export function contentToText(content: ChatMessageContent): string {
  if (content === null) return ''
  if (typeof content === 'string') return content
  return content.map((part) => {
    if (part.type === 'text') return part.text
    if (part.type === 'file') {
      return `[File attachment: ${part.path ?? part.filename ?? part.url ?? 'file attachment'}]`
    }
    if (part.type === 'image' && part.image === undefined) {
      return `[Image attachment: ${part.path ?? part.filename ?? part.url ?? imagePartMediaType(part)}]`
    }
    return `[Image attachment: ${imagePartMediaType(part)}]`
  }).filter(Boolean).join('\n')
}

export function extractImageAttachments(messages: ChatMessage[]): ImageAttachment[] {
  const images: ImageAttachment[] = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      const image = imagePartValue(part)
      if (!image) continue
      const parsed = parseImageValue(image, imagePartMediaType(part))
      if (parsed) images.push(parsed)
    }
  }
  return images
}

function imagePartValue(part: ChatContentPart): string | undefined {
  if (part.type === 'image_url' || part.type === 'input_image') {
    return typeof part.image_url === 'string' ? part.image_url : part.image_url.url
  }
  if (part.type === 'image') return part.image ?? part.url
  return undefined
}

function imagePartMediaType(part: ChatContentPart): string {
  if (part.type === 'image') return part.mediaType ?? part.mimeType ?? 'image/jpeg'
  const value = imagePartValue(part)
  return mediaTypeFromDataUrl(value) ?? 'image/jpeg'
}

function parseImageValue(value: string, fallbackMediaType: string): ImageAttachment | null {
  const dataUrl = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/i.exec(value)
  if (dataUrl) {
    const base64 = dataUrl[2]
    if (!base64) return null
    return {
      mediaType: dataUrl[1] || fallbackMediaType,
      data: Buffer.from(base64, 'base64'),
    }
  }

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length > 64) {
    return {
      mediaType: fallbackMediaType,
      data: Buffer.from(value, 'base64'),
    }
  }

  return null
}

function mediaTypeFromDataUrl(value?: string): string | undefined {
  if (!value) return undefined
  return /^data:([^;,]+)/i.exec(value)?.[1]
}
