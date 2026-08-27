import { JSON_MODE_DIRECTIVE, wantsJsonObject } from './types.js'
import type { ChatRequest } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import { contentToText } from './content.js'
import { renderLocalHarnessProfilePreamble, resolveAgentProfile } from './profile-support.js'

export function composeClaudeStdinInput(
  req: ChatRequest,
  session: SessionRecord | null,
): { messages: Array<{ role: 'user'; content: string }> } {
  const systemMessages = (req.messages ?? [])
    .filter((message) => message.role === 'system')
    .map((message) => contentToText(message.content))
    .filter((text) => text.length > 0)
  const systemBlocks = [
    ...systemMessages,
    renderLocalHarnessProfilePreamble(resolveAgentProfile(req, session)),
    wantsJsonObject(req) ? JSON_MODE_DIRECTIVE : null,
  ].filter((value): value is string => Boolean(value))
  const nonSystemMessages = (req.messages ?? []).filter((message) => message.role !== 'system')
  const userText = flattenPrompt(nonSystemMessages)
  const appendLimit = 120 * 1024
  const systemMerged = systemBlocks.join('\n\n')
  const content = systemBlocks.length === 0 || Buffer.byteLength(systemMerged, 'utf8') <= appendLimit
    ? userText
    : `[SYSTEM INSTRUCTIONS]\n${systemMerged}\n\n[USER]\n${userText}`
  return { messages: [{ role: 'user', content }] }
}

function flattenPrompt(messages: ChatRequest['messages']): string {
  if (messages.length === 1) return contentToText(messages[0]?.content ?? '')
  return messages.map((message) => `[${message.role}] ${contentToText(message.content)}`).join('\n\n')
}
