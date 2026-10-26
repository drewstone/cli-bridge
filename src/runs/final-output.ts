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
    const text = (this.native ?? this.text).trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')
    try {
      const value: unknown = JSON.parse(text)
      if (required && (!value || typeof value !== 'object' || Array.isArray(value)))
        throw new Error('JSON object required')
      return { final_output: value }
    } catch {
      if (required)
        throw new BackendReportedFailureError('Harness completed without a final JSON object', 'HARNESS_OUTPUT_INVALID')
      return undefined
    }
  }
}
