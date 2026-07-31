/**
 * `provisionProfileWorkspace` is the only thing that puts an `agent_profile`'s
 * skills, context, and subagents on disk before the harness spawns. The
 * profile's own prompt cites the paths they land at, so a run that proceeds
 * un-provisioned answers as an agent with no skills while looking identical to
 * a working run at the wire — and every number measured from it is about an
 * agent nobody ships. These pin that a provisioning failure is loud and that a
 * dimension the harness cannot take is reported rather than dropped in silence.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { provisionProfileWorkspace } from '../src/backends/profile-support.js'
import { BackendError } from '../src/backends/types.js'
import type { ChatRequest } from '../src/backends/types.js'

const SKILL_BODY = '---\nskill: citation-anchoring\ndescription: Anchor every claim.\n---\nCite the controlling authority.'

function profileWithSkill(): AgentProfile {
  return {
    prompt: { systemPrompt: 'You are a legal associate.' },
    resources: { skills: [{ kind: 'inline', name: 'citation-anchoring', content: SKILL_BODY }] },
  }
}

function request(profile: AgentProfile | undefined): ChatRequest {
  return { model: 'opencode/kimi-for-coding/k3', messages: [], ...(profile ? { agent_profile: profile } : {}) } as ChatRequest
}

describe('provisionProfileWorkspace', () => {
  it('writes an inline skill to the harness-native dir and reports what it wrote', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'provision-ok-'))
    const result = provisionProfileWorkspace(request(profileWithSkill()), null, 'opencode', cwd)

    expect(existsSync(join(cwd, '.opencode/skills/citation-anchoring/SKILL.md'))).toBe(true)
    expect(result.written).toContain('.opencode/skills/citation-anchoring/SKILL.md')
    expect(result.unsupported).toEqual([])
  })

  it('places the same skill under the dir each harness actually reads', () => {
    for (const [harness, rel] of [
      ['opencode', '.opencode/skills'],
      ['claude', '.claude/skills'],
      ['codex', '.codex/skills'],
      ['pi', '.pi/skills'],
    ] as const) {
      const cwd = mkdtempSync(join(tmpdir(), `provision-${harness}-`))
      provisionProfileWorkspace(request(profileWithSkill()), null, harness, cwd)
      expect(existsSync(join(cwd, rel, 'citation-anchoring/SKILL.md'))).toBe(true)
    }
  })

  it('reports a dimension the harness cannot take instead of dropping it silently', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'provision-hermes-'))
    const result = provisionProfileWorkspace(request(profileWithSkill()), null, 'hermes', cwd)

    // hermes reads skills from a user/global dir only — there is no cwd path to
    // write. Correct to skip; a caller must be able to SEE that it was skipped.
    expect(result.unsupported.map((u) => u.dimension)).toContain('skills')
    expect(existsSync(join(cwd, 'skills/citation-anchoring/SKILL.md'))).toBe(false)
  })

  it('fails the request when the workspace cannot be written', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'provision-blocked-'))
    // A regular file where the skill directory must go: the write cannot succeed,
    // and a run that continued here would be a skill-less agent reporting 200.
    writeFileSync(join(cwd, '.opencode'), 'not a directory')

    let caught: unknown
    try {
      provisionProfileWorkspace(request(profileWithSkill()), null, 'opencode', cwd)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(BackendError)
    expect((caught as BackendError).code).toBe('not_configured')
    expect((caught as Error).message).toMatch(/agent_profile workspace could not be written/)
  })

  it('is a no-op without a profile', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'provision-none-'))
    expect(provisionProfileWorkspace(request(undefined), null, 'opencode', cwd)).toEqual({
      env: {},
      flags: [],
      written: [],
      unsupported: [],
    })
  })
})
