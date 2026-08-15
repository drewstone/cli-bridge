/**
 * Resume re-materialization — a session's second turn re-applies the same
 * workspace plan into the cwd the agent has been living in. claude-code
 * stores session memory in CLAUDE.md, so the agent editing that file between
 * turns is normal state. The session's recorded workspacePlanDigest, not the
 * current file bytes, decides whether re-application is a no-op.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { provisionProfileWorkspace } from '../src/backends/profile-support.js'
import type { ChatRequest } from '../src/backends/types.js'
import type { SessionRecord } from '../src/sessions/store.js'

const PROFILE: AgentProfile = {
  name: 'worker',
  prompt: {
    systemPrompt: 'Answer in as few words as possible.',
    instructions: ['STANDING BRIEF'],
  },
}

const request = (profile: AgentProfile = PROFILE): ChatRequest => ({
  model: 'claude-code/anthropic/haiku',
  messages: [{ role: 'user', content: 'work' }],
  agent_profile: structuredClone(profile) as ChatRequest['agent_profile'],
})

const sessionFor = (
  cwd: string,
  planDigest: string,
  profile: AgentProfile = PROFILE,
): SessionRecord => ({
  externalId: 'resume-test',
  backend: 'claude',
  internalId: 'internal-1',
  cwd,
  turns: 1,
  createdAt: Date.now(),
  lastUsedAt: Date.now(),
  metadata: {
    agent_profile: structuredClone(profile),
    profile_materialization: { workspacePlanDigest: planDigest },
  },
})

describe('resume re-materialization', () => {
  const roots: string[] = []
  const root = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-resume-'))
    roots.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('re-applies an agent-edited workspace as a no-op when the session digest matches', () => {
    const cwd = root()
    const first = provisionProfileWorkspace(request(), null, 'claude-code', cwd)
    if (!first.workspacePlanDigest) throw new Error('turn 1 produced no plan digest')
    // The agent stores session memory in its context file between turns.
    appendFileSync(join(cwd, 'CLAUDE.md'), '\n- codeword: heliotrope\n')

    const second = provisionProfileWorkspace(
      request(),
      sessionFor(cwd, first.workspacePlanDigest),
      'claude-code',
      cwd,
    )
    expect(second.workspacePlanDigest).toBe(first.workspacePlanDigest)
    expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8')).toContain('codeword: heliotrope')
  })

  it('materializes fully when the session digest was recorded for a different cwd', () => {
    const cwd = root()
    const first = provisionProfileWorkspace(request(), null, 'claude-code', cwd)
    if (!first.workspacePlanDigest) throw new Error('turn 1 produced no plan digest')

    const otherCwd = root()
    const second = provisionProfileWorkspace(
      request(),
      sessionFor(cwd, first.workspacePlanDigest),
      'claude-code',
      otherCwd,
    )
    expect(second.written).toContain('CLAUDE.md')
    expect(readFileSync(join(otherCwd, 'CLAUDE.md'), 'utf8')).toContain('STANDING BRIEF')
  })

  it('still refuses a mid-session profile swap, naming both content digests', () => {
    const cwd = root()
    const first = provisionProfileWorkspace(request(), null, 'claude-code', cwd)
    if (!first.workspacePlanDigest) throw new Error('turn 1 produced no plan digest')

    const swapped: AgentProfile = {
      ...PROFILE,
      prompt: { ...PROFILE.prompt, instructions: ['A DIFFERENT BRIEF'] },
    }
    let message = ''
    try {
      provisionProfileWorkspace(
        request(swapped),
        sessionFor(cwd, first.workspacePlanDigest, swapped),
        'claude-code',
        cwd,
      )
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('Refusing to replace existing workspace file: CLAUDE.md')
    expect(message).toMatch(/planned sha256:[0-9a-f]{64}/)
    expect(message).toMatch(/existing sha256:[0-9a-f]{64}/)
  })
})
