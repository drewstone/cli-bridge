/**
 * materializeProfile golden-file tests — assert the EXACT native file tree + flags +
 * fail-closed records each harness produces for a full profile, per the verified
 * capability matrix. A wrong path here = the live sandbox loads nothing, so these
 * lock the matrix down.
 */
import { describe, it, expect } from 'vitest'
import {
  materializeProfile,
  normalizeSkillMd,
  type MaterializableProfile,
  type HarnessId,
} from '../src/backends/materialize-profile.js'

const FULL: MaterializableProfile = {
  prompt: { systemPrompt: 'You are a build agent.', instructions: ['Prefer real artifacts.'] },
  skills: { 'fhenix-core': '---\nskill: fhenix-core\ndescription: >\n  Build real CoFHE.\n---\nUse euint.' },
  mcp: { echo: { command: 'echo-mcp', args: ['--stdio'], env: { K: 'v' } }, web: { url: 'https://mcp.example/sse' } },
  hooks: { PreToolUse: [{ command: 'touch .sentinel', matcher: '*' }] },
  subagents: { reviewer: { description: 'reviews diffs', model: 'deepseek', prompt: 'Review.' } },
  commands: { ship: 'Ship the build.' },
}

const paths = (h: HarnessId) => materializeProfile(FULL, h).files.map((f) => f.relPath).sort()
const has = (h: HarnessId, p: string) => paths(h).includes(p)
const unsupportedDims = (h: HarnessId) => materializeProfile(FULL, h).unsupported.map((u) => u.dimension)

describe('materializeProfile — verified per-harness routing', () => {
  it('normalizeSkillMd → name+description frontmatter, body preserved, VB fm stripped', () => {
    const md = normalizeSkillMd('fhenix-core', FULL.skills!['fhenix-core']!)
    expect(md).toMatch(/^---\nname: fhenix-core\ndescription: ".+"\n---\n/)
    expect(md).toContain('Use euint.')
    expect(md).not.toContain('skill: fhenix-core')
  })

  it('claude-code: full cwd provisioning across all dimensions', () => {
    const p = paths('claude-code')
    expect(p).toContain('CLAUDE.md')
    expect(p).toContain('.claude/skills/fhenix-core/SKILL.md')
    expect(p).toContain('.mcp.json')
    expect(p).toContain('.claude/settings.json') // merged: enabledMcpjsonServers + hooks
    expect(p).toContain('.claude/agents/reviewer.md')
    expect(p).toContain('.claude/commands/ship.md')
    // settings.json must carry BOTH mcp-enable AND hooks (merge, not clobber)
    const settings = JSON.parse(materializeProfile(FULL, 'claude-code').files.find((f) => f.relPath === '.claude/settings.json')!.content)
    expect(settings.enabledMcpjsonServers).toContain('echo')
    expect(settings.hooks.PreToolUse).toBeTruthy()
  })

  it('codex: skills (.codex/skills) + config.toml mcp + hooks.json + agents.toml', () => {
    expect(has('codex', '.codex/skills/fhenix-core/SKILL.md')).toBe(true)
    expect(has('codex', '.codex/config.toml')).toBe(true)
    expect(has('codex', '.codex/hooks.json')).toBe(true)
    expect(has('codex', '.codex/agents/reviewer.toml')).toBe(true)
    expect(materializeProfile(FULL, 'codex').files.find((f) => f.relPath === '.codex/config.toml')!.content).toContain('trust_level = "trusted"')
    expect(unsupportedDims('codex')).toContain('commands') // project commands unsupported
  })

  it('gemini: GEMINI.md (NOT AGENTS.md) + .gemini/settings.json + .gemini/commands/*.toml', () => {
    expect(has('gemini', 'GEMINI.md')).toBe(true)
    expect(has('gemini', 'AGENTS.md')).toBe(false)
    expect(has('gemini', '.gemini/skills/fhenix-core/SKILL.md')).toBe(true)
    expect(has('gemini', '.gemini/settings.json')).toBe(true)
    expect(has('gemini', '.gemini/commands/ship.toml')).toBe(true)
    const settings = JSON.parse(materializeProfile(FULL, 'gemini').files.find((f) => f.relPath === '.gemini/settings.json')!.content)
    expect(settings.mcpServers.echo).toBeTruthy()
    expect(settings.hooks.PreToolUse).toBeTruthy()
  })

  it('opencode: AGENTS.md + .opencode/skills + opencode.json mcp + plugin hook + agent', () => {
    expect(has('opencode', 'AGENTS.md')).toBe(true)
    expect(has('opencode', '.opencode/skills/fhenix-core/SKILL.md')).toBe(true)
    expect(has('opencode', 'opencode.json')).toBe(true)
    expect(has('opencode', '.opencode/agent/reviewer.md')).toBe(true)
    expect(has('opencode', '.opencode/command/ship.md')).toBe(true)
    expect(paths('opencode').some((p) => p.startsWith('.opencode/plugin/'))).toBe(true)
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
    expect(plan.env.HERMES_ENABLE_PROJECT_PLUGINS).toBe('1')
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
})
