import { BackendReportedFailureError } from './error-shape.js'
import type { ChatDelta } from '../backends/types.js'

/** Native adapters identify assistant text; JSON is decoded once, after successful source drain. */
export class FinalOutput {
  private text = ''
  private native: string | undefined

  observe(delta: ChatDelta): void {
    if (delta.tool_calls?.length) { this.text = ''; this.native = undefined }
    if (delta.content) this.text += delta.content
    if (delta.final_text !== undefined) this.native = delta.final_text
  }

  result(required: boolean): { final_output: unknown } | undefined {
    const text = (this.native ?? this.text).trim()
    const whole = text.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')
    // Agents often explain themselves before the settle fence; the last json fence is the answer.
    const fenced = [...text.matchAll(/```json[ \t]*\n([\s\S]*?)\n```/gi)].at(-1)?.[1]
    for (const candidate of fenced !== undefined ? [whole, fenced] : required ? [whole, ...trailingObjects(text)] : [whole]) {
      let value: unknown
      try { value = JSON.parse(candidate) } catch { continue }
      if (!required || (value && typeof value === 'object' && !Array.isArray(value))) return { final_output: value }
      break
    }
    if (required)
      throw new BackendReportedFailureError('Harness completed without a final JSON object', 'HARNESS_OUTPUT_INVALID')
    return undefined
  }
}

/**
 * With no fence, a settle object written bare after prose ends the text (factory-episodes-v4,
 * agent-container 18475 and 18871): try each line-start `{`, last first, whose rest is the whole object.
 * Only a run that requires JSON looks here; a chat answer ending in an example object is not a result.
 */
function* trailingObjects(text: string): Generator<string> {
  for (let i = text.lastIndexOf('\n{'); i >= 0; i = text.lastIndexOf('\n{', i - 1)) yield text.slice(i + 1)
}
