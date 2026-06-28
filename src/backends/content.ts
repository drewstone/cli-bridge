import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, ChatMessageContent, ChatContentPart } from './types.js'

export interface ImageAttachment {
  data: Buffer
  mediaType: string
}

export interface MaterializedImages {
  paths: string[]
  cleanup: () => Promise<void>
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

export function collectSystemText(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => contentToText(m.content))
    .filter(Boolean)
    .join('\n\n')
}

export function contentToText(content: ChatMessageContent): string {
  if (content === null) return ''
  if (typeof content === 'string') return content
  return content.map((part) => {
    if (part.type === 'text') return part.text
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

export async function materializeImages(images: ImageAttachment[]): Promise<MaterializedImages> {
  if (images.length === 0) {
    return { paths: [], cleanup: async () => {} }
  }

  const dir = await mkdtemp(join(tmpdir(), 'cli-bridge-images-'))
  const paths: string[] = []
  await Promise.all(images.map(async (image, i) => {
    const ext = extensionForMediaType(image.mediaType)
    const file = join(dir, `image-${i + 1}.${ext}`)
    await writeFile(file, image.data)
    paths.push(file)
  }))

  return {
    paths,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function imagePartValue(part: ChatContentPart): string | undefined {
  if (part.type === 'image_url' || part.type === 'input_image') {
    return typeof part.image_url === 'string' ? part.image_url : part.image_url.url
  }
  if (part.type === 'image') return part.image
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

function extensionForMediaType(mediaType: string): string {
  if (mediaType.includes('png')) return 'png'
  if (mediaType.includes('webp')) return 'webp'
  if (mediaType.includes('gif')) return 'gif'
  return 'jpg'
}
