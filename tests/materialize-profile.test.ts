/**
 * materializeProfile golden-file tests — assert the EXACT native file tree + flags +
 * fail-closed records each harness produces for a full profile, per the verified
 * capability matrix. A wrong path here = the live sandbox loads nothing, so these
 * lock the matrix down.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  applyWorkspacePlan,
  type HarnessId,
  materializeProfile,
  normalizeSkillMd,
} from '@tangle-network/agent-profile-materialize'
import { provisionProfileWorkspace } from '../src/backends/profile-support.js'

const SKILL_BODY = '---\nskill: fhenix-core\ndescription: >\n  Build real CoFHE.\n---\nUse euint.'
const FULL: AgentProfile = {
  prompt: { systemPrompt: 'You are a build agent.', instructions: ['Prefer real artifacts.'] },
  // canonical shape — skills/commands under `resources` as refs (matches the box's providers)
  resources: {
    skills: [{ kind: 'inline', name: 'fhenix-core', content: SKILL_BODY }],
    commands: [{ kind: 'inline', name: 'ship', content: 'Ship the build.' }],
  },
  mcp: { echo: { command: 'echo-mcp', args: ['--stdio'], env: { K: 'v' } }, web: { url: 'https://mcp.example/sse' } },
  hooks: { PreToolUse: [{ command: 'touch .sentinel', matcher: '*' }] },
  subagents: { reviewer: { description: 'reviews diffs', model: 'deepseek', prompt: 'Review.' } },
}

const paths = (h: HarnessId) => materializeProfile(FULL, h).files.map((f) => f.relPath).sort()
const has = (h: HarnessId, p: string) => paths(h).includes(p)
const unsupportedDims = (h: HarnessId) => materializeProfile(FULL, h).unsupported.map((u) => u.dimension)

describe('materializeProfile — verified per-harness routing', () => {
  it('normalizeSkillMd → name+description frontmatter, body preserved, VB fm stripped', () => {
    const md = normalizeSkillMd('fhenix-core', SKILL_BODY)
    expect(md).toMatch(/^---\nname: fhenix-core\ndescription: ".+"\n---\n/)
    expect(md).toContain('Use euint.')
    expect(md).not.toContain('skill: fhenix-core')
  })

  it('claude-code: full cwd provisioning across all dimensions', () => {
    const p = paths('claude-code')
    expect(p).toContain('CLAUDE.md')
    expect(p).toContain('.claude/skills/fhenix-core/SKILL.md')
    expect(p).toContain('.tangle/claude-mcp.json')
    expect(p).toContain('.tangle/claude-settings.json')
    expect(p).toContain('.claude/agents/reviewer.md')
    expect(p).toContain('.claude/commands/ship.md')
    const plan = materializeProfile(FULL, 'claude-code')
    const mcp = JSON.parse(plan.files.find((f) => f.relPath === '.tangle/claude-mcp.json')!.content)
    const settings = JSON.parse(plan.files.find((f) => f.relPath === '.tangle/claude-settings.json')!.content)
    expect(mcp.mcpServers.echo.command).toBe('echo-mcp')
    expect(settings.hooks.PreToolUse).toBeTruthy()
    expect(plan.flags).toEqual(expect.arrayContaining([
      '--mcp-config',
      '.tangle/claude-mcp.json',
      '--settings',
      '.tangle/claude-settings.json',
    ]))
  })

  it('codex: skills + agent file with typed MCP, hook, and agent flags', () => {
    expect(has('codex', '.codex/skills/fhenix-core/SKILL.md')).toBe(true)
    expect(has('codex', '.codex/agents/reviewer.toml')).toBe(true)
    const plan = materializeProfile(FULL, 'codex')
    expect(plan.flags.join('\n')).toContain('mcp_servers=')
    expect(plan.flags.join('\n')).toContain('hooks.PreToolUse=')
    expect(plan.flags.join('\n')).toContain('agents.reviewer.config_file=')
    expect(unsupportedDims('codex')).toContain('commands')
  })

  it('gemini: GEMINI.md (NOT AGENTS.md) + .gemini/settings.json + .gemini/commands/*.toml', () => {
    expect(has('gemini', 'GEMINI.md')).toBe(true)
    expect(has('gemini', 'AGENTS.md')).toBe(false)
    expect(has('gemini', '.gemini/skills/fhenix-core/SKILL.md')).toBe(true)
    expect(has('gemini', '.gemini/settings.json')).toBe(true)
    expect(has('gemini', '.gemini/commands/ship.toml')).toBe(true)
    const settings = JSON.parse(materializeProfile(FULL, 'gemini').files.find((f) => f.relPath === '.gemini/settings.json')!.content)
    expect(settings.mcpServers.echo).toBeTruthy()
    expect(unsupportedDims('gemini')).toContain('hooks')
  })

  it('opencode: AGENTS.md + .opencode/skills + opencode.json mcp + plugin hook + agent', () => {
    expect(has('opencode', '.opencode/profile-instructions.md')).toBe(true)
    expect(has('opencode', '.opencode/skills/fhenix-core/SKILL.md')).toBe(true)
    expect(has('opencode', 'opencode.json')).toBe(true)
    expect(has('opencode', '.opencode/agents/reviewer.md')).toBe(true)
    expect(has('opencode', '.opencode/commands/ship.md')).toBe(true)
    expect(unsupportedDims('opencode')).toContain('hooks')
  })

  it('kimi-code: skills cwd-native, but MCP needs the --mcp-config-file FLAG (no cwd discovery)', () => {
    const plan = materializeProfile(FULL, 'kimi-code')
    expect(plan.files.map((f) => f.relPath)).toContain('.kimi/skills/fhenix-core/SKILL.md')
    expect(plan.flags).toEqual(expect.arrayContaining(['--mcp-config-file', '.kimi/mcp.json']))
    expect(unsupportedDims('kimi-code')).toEqual(expect.arrayContaining(['hooks', 'subagents', 'commands']))
  })

  it('hermes: HERMES.md context, NO cwd skill dir (fail-closed), hooks via opt-in env', () => {
    const plan = materializeProfile(FULL, 'hermes')
    expect(plan.files.map((f) => f.relPath)).toContain('HERMES.md')
    expect(plan.unsupported.map((u) => u.dimension)).toContain('skills') // ~/.hermes/skills only
    expect(plan.unsupported.map((u) => u.dimension)).toContain('hooks')
  })

  it('openclaw: AGENTS.md + skills/ (workspace) but mcp/hooks/subagents are central-config (fail-closed)', () => {
    expect(has('openclaw', 'AGENTS.md')).toBe(true)
    expect(has('openclaw', 'skills/fhenix-core/SKILL.md')).toBe(true)
    expect(unsupportedDims('openclaw')).toEqual(expect.arrayContaining(['mcp', 'hooks', 'subagents']))
  })

  it('nanoclaw === claude-code surface, but flags MCP as SDK-injected', () => {
    expect(has('nanoclaw', 'CLAUDE.md')).toBe(true)
    expect(has('nanoclaw', '.claude/skills/fhenix-core/SKILL.md')).toBe(true)
    expect(unsupportedDims('nanoclaw')).toContain('mcp')
  })

  it('aliases resolve: claude→claude-code, kimi→kimi-code', () => {
    expect(paths('claude')).toEqual(paths('claude-code'))
    expect(paths('kimi')).toEqual(paths('kimi-code'))
  })

  it('empty profile → empty plan (bare control, no files)', () => {
    const plan = materializeProfile({}, 'claude-code')
    expect(plan.files).toEqual([])
    expect(plan.unsupported).toEqual([])
  })

  it('applyWorkspacePlan writes every file (with parent dirs) + returns env/flags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apply-'))
    const plan = materializeProfile(FULL, 'kimi-code')
    const r = applyWorkspacePlan(plan, dir)
    expect(existsSync(join(dir, '.kimi/skills/fhenix-core/SKILL.md'))).toBe(true)
    expect(readFileSync(join(dir, '.kimi/skills/fhenix-core/SKILL.md'), 'utf8')).toContain('name: fhenix-core')
    expect(r.flags).toEqual(expect.arrayContaining(['--mcp-config-file', '.kimi/mcp.json']))
    expect(r.written).toContain('.kimi/skills/fhenix-core/SKILL.md')
  })

  it('fails closed on unsafe profile paths when failOnError is set', () => {
    const root = mkdtempSync(join(tmpdir(), 'profile-fail-closed-'))
    const escaped = join(root, '..', 'escaped', 'SKILL.md')
    try {
      expect(() => provisionProfileWorkspace({
        model: 'claude-code/opus',
        messages: [{ role: 'user', content: 'work' }],
        agent_profile: {
          resources: {
            failOnError: true,
            skills: [{ kind: 'inline', name: '../../../escaped', content: 'unsafe' }],
          },
        },
      }, null, 'claude-code', root)).toThrow(/materialization failed/)
      expect(existsSync(escaped)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('marks optional profile materialization as degraded instead of indistinguishable success', () => {
    const root = mkdtempSync(join(tmpdir(), 'profile-degraded-'))
    try {
      const result = provisionProfileWorkspace({
        model: 'claude-code/opus',
        messages: [{ role: 'user', content: 'work' }],
        agent_profile: {
          resources: {
            skills: [{ kind: 'inline', name: '../../../escaped', content: 'unsafe' }],
          },
        },
      }, null, 'claude-code', root)
      expect(result.degraded).toMatch(/canonical|relative/)
      expect(result.written).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
