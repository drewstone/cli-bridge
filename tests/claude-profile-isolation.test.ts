import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { applyWorkspacePlan, materializeProfile } from '@tangle-network/agent-profile-materialize'
import { provisionProfileWorkspace } from '../src/backends/profile-support.js'
import { ClaudeBackend } from '../src/backends/claude.js'
import type { ChatRequest } from '../src/backends/types.js'
import type { Spawner } from '../src/executors/types.js'
import type { SessionRecord } from '../src/sessions/store.js'

function session(req: ChatRequest, cwd: string, receipt: unknown): SessionRecord {
  return { externalId: req.session_id!, backend: 'claude-code', internalId: 'native-session', cwd, turns: 1, createdAt: 1, lastUsedAt: 1, metadata: { agent_profile: req.agent_profile, profile_materialization: receipt } }
}

describe('Claude profiles in a shared task workspace', () => {
  it('keeps distinct native tool settings isolated while sharing exact skills and task files', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'claude-profile-isolation-'))
    const request = (sessionId: string, skill: string, tools: Record<string, boolean>): ChatRequest => ({
      session_id: sessionId,
      model: 'claude-code/anthropic/claude-sonnet-5',
      messages: [{ role: 'user', content: 'Read PAYLOAD.txt' }],
      agent_profile: {
        name: sessionId,
        tools,
        resources: {
          skills: [{ kind: 'inline', name: 'method', content: `---\nname: method\ndescription: Research method\n---\n${skill}\n` }],
          files: [{ path: 'PAYLOAD.txt', resource: { kind: 'inline', name: 'payload', content: 'shared evidence\n' } }],
        },
      },
    })
    try {
      const root = request('root-session', 'ROOT', { Read: true, Write: true })
      const child = request('child-session', 'ROOT', { Read: true })
      const first = provisionProfileWorkspace(root, null, 'claude-code', cwd)
      const second = provisionProfileWorkspace(child, null, 'claude-code', cwd)
      expect(readFileSync(join(cwd, '.claude/skills/method/SKILL.md'), 'utf8')).toContain('ROOT')
      expect(first.flags[first.flags.indexOf('--settings') + 1]).not.toBe(second.flags[second.flags.indexOf('--settings') + 1])
      expect(readFileSync(join(cwd, 'PAYLOAD.txt'), 'utf8')).toBe('shared evidence\n')
      expect(provisionProfileWorkspace(root, null, 'claude-code', cwd).flags).toEqual(first.flags)
      const retained = session(root, cwd, root.profile_materialization_receipt)
      expect(provisionProfileWorkspace({ ...root }, retained, 'claude-code', cwd).workspacePlanDigest).toBe(first.workspacePlanDigest)
      expect(root.profile_materialization_receipt?.effectiveProfileDigest).not.toBe(child.profile_materialization_receipt?.effectiveProfileDigest)
      expect(() => provisionProfileWorkspace(request('conflicting-child', 'CHILD', { Read: true }), null, 'claude-code', cwd)).toThrow(/Refusing to replace/u)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('preserves a retained session plan from before settings isolation', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'claude-retained-settings-'))
    try {
      const req: ChatRequest = { session_id: 'existing', model: 'claude-code/anthropic/sonnet', messages: [], agent_profile: { name: 'existing', tools: { Read: true } } }
      const oldPlan = materializeProfile(req.agent_profile!, 'claude-code', { skip: ['mcp'] })
      const oldReceipt = applyWorkspacePlan(oldPlan, cwd)
      const before = readFileSync(join(cwd, '.tangle/claude-settings.json'), 'utf8')
      const child: ChatRequest = { ...req, session_id: 'new-child', agent_profile: { name: 'new-child', tools: { Read: true, Write: true } } }
      provisionProfileWorkspace(child, null, 'claude-code', cwd)
      const result = provisionProfileWorkspace(req, session(req, cwd, oldReceipt), 'claude-code', cwd)
      expect(result.workspacePlanDigest).toBe(oldReceipt.workspacePlanDigest)
      expect(result.flags).toContain('.tangle/claude-settings.json')
      expect(readFileSync(join(cwd, '.tangle/claude-settings.json'), 'utf8')).toBe(before)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('launches both profiles through ClaudeBackend with their own settings and the same cwd', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'claude-settings-spawn-'))
    const launches: string[][] = []
    const script = `
      const fs = require('node:fs')
      const args = process.argv.slice(1)
      const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'))
      console.log(JSON.stringify({type:'system',subtype:'init',session_id:'native-session'}))
      console.log(JSON.stringify({type:'assistant',message:{id:'msg',content:[{type:'text',text:JSON.stringify({cwd:process.cwd(),allow:settings.permissions.allow})}]}}))
      console.log(JSON.stringify({type:'result',subtype:'success',session_id:'native-session',usage:{input_tokens:1,output_tokens:1},total_cost_usd:0}))
    `
    const spawner: Spawner = async (_bin, args, opts) => {
      launches.push(args)
      const child = spawn(process.execPath, ['-e', script, '--', ...args], { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
      return { child, release() {}, spawnError: () => null }
    }
    const backend = new ClaudeBackend({ bin: 'claude', harness: 'claude-code', timeoutMs: 0, spawner })
    try {
      const profiles: Record<string, boolean>[] = [{ Read: true, Write: true }, { Read: true }]
      for (const tools of profiles) {
        const req: ChatRequest = { cwd, session_id: `session-${launches.length}`, mode: 'byob', model: 'claude-code/anthropic/sonnet', messages: [{ role: 'user', content: 'inspect settings' }], agent_profile: { name: `profile-${launches.length}`, tools } }
        let text = ''
        for await (const delta of backend.chat(req, null, new AbortController().signal)) text += delta.content ?? ''
        const observed = JSON.parse(text)
        expect(observed.cwd).toBe(realpathSync(cwd))
        expect(observed.allow).toEqual(Object.keys(tools))
      }
      expect(launches[0]).not.toContain('--bare')
      expect(launches[1]).not.toContain('--plugin-dir')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
