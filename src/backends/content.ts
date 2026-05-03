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

export function collectSystemText(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => contentToText(m.content))
    .filter(Boolean)
    .join('\n\n')
}

export function contentToText(content: ChatMessageContent): string {
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
