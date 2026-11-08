import { describe, expect, it } from 'vitest'
import { genericCliBridgeCapabilities } from '../src/sessions/retained/capabilities.js'

describe('generic backend capability advertisement', () => {
  it('claims permissions and subagents for backends with a verified mapping', () => {
    for (const backend of ['opencode', 'claude-code', undefined]) {
      const capabilities = genericCliBridgeCapabilities(backend)
      expect(capabilities.profile.permissions).toBe(true)
      expect(capabilities.profile.subagents).toBe(true)
    }
  })

  it('does not claim codex permission or subagent mapping', () => {
    const codex = genericCliBridgeCapabilities('codex')
    expect(codex.profile.permissions).toBe(false)
    expect(codex.profile.subagents).toBe(false)
    // everything the codex backend does verify stays claimed
    expect(codex.profile.systemPrompt).toEqual({ replace: true, append: true })
    expect(codex.profile.tools).toBe(true)
    expect(codex.profile.mcp).toBe(true)
    expect(codex.profile.resources.files).toBe(true)
  })
})
