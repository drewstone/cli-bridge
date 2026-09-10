import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OpencodeBackend } from '../src/backends/opencode.js'
import { provisionProfileWorkspace } from '../src/backends/profile-support.js'
import type { ChatRequest } from '../src/backends/types.js'
import type { Spawner } from '../src/executors/types.js'
import type { SessionRecord } from '../src/sessions/store.js'

const MODEL = 'opencode/zai-coding-plan/glm-5.3'

function request(name: string, marker: string, tools: Record<string, boolean>, cwd?: string): ChatRequest {
  return {
    ...(cwd ? { cwd } : {}),
    session_id: `${name}-session`,
    mode: 'byob',
    model: MODEL,
    messages: [{ role: 'user', content: 'What is your marker?' }],
    agent_profile: {
      name,
      harness: 'opencode',
      prompt: { instructions: [`You are ${name}. Your marker is ${marker}.`] },
      tools,
      resources: {
        files: [{ path: 'inputs/shared.md', resource: { kind: 'inline', name: 'shared', content: 'shared evidence\n' } }],
      },
    },
  }
}

function retained(req: ChatRequest, cwd: string): SessionRecord {
  return {
    externalId: req.session_id!,
    backend: 'opencode',
    internalId: `${req.session_id}-native`,
    cwd,
    turns: 1,
    createdAt: 1,
    lastUsedAt: 1,
    metadata: { agent_profile: req.agent_profile, profile_materialization: req.profile_materialization_receipt },
  }
}

/** Every instruction byte this process would see: the project config opencode loads from cwd, then the process config. */
function visibleInstructions(cwd: string, env: Record<string, string>): string {
  const configs: Array<{ instructions?: string[] }> = []
  if (existsSync(join(cwd, 'opencode.json'))) configs.push(JSON.parse(readFileSync(join(cwd, 'opencode.json'), 'utf8')))
  if (env.OPENCODE_CONFIG_CONTENT) configs.push(JSON.parse(env.OPENCODE_CONFIG_CONTENT))
  return configs.flatMap((config) => config.instructions ?? []).map((path) => readFileSync(join(cwd, path), 'utf8')).join('')
}

describe('opencode profiles in a shared task workspace', () => {
  it('keeps each profile config and instruction file to its own process while sharing task files', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'opencode-profile-isolation-'))
    try {
      const root = request('root', 'ROOT-MARKER', { bash: true, webfetch: true })
      const director = request('director', 'DIRECTOR-MARKER', { bash: true, webfetch: false })
      const first = provisionProfileWorkspace(root, null, 'opencode', cwd)
      const second = provisionProfileWorkspace(director, null, 'opencode', cwd)

      expect(existsSync(join(cwd, 'opencode.json'))).toBe(false)
      expect(existsSync(join(cwd, '.opencode'))).toBe(false)
      expect(readFileSync(join(cwd, 'inputs/shared.md'), 'utf8')).toBe('shared evidence\n')
      expect(visibleInstructions(cwd, first.env)).toContain('ROOT-MARKER')
      expect(visibleInstructions(cwd, first.env)).not.toContain('DIRECTOR-MARKER')
      expect(visibleInstructions(cwd, second.env)).toContain('DIRECTOR-MARKER')
      expect(visibleInstructions(cwd, second.env)).not.toContain('ROOT-MARKER')
      expect(JSON.parse(first.env.OPENCODE_CONFIG_CONTENT!).tools).toEqual({ bash: true, webfetch: true })
      expect(JSON.parse(second.env.OPENCODE_CONFIG_CONTENT!).tools).toEqual({ bash: true, webfetch: false })

      // The config env is part of the plan, so the receipt's plan digest names what ran.
      expect(root.profile_materialization_receipt?.workspacePlanDigest).toBe(first.workspacePlanDigest)
      expect(first.workspacePlanDigest).not.toBe(second.workspacePlanDigest)

      // A resumed session keeps its plan, and its instructions are still its own.
      const resumed = provisionProfileWorkspace({ ...root }, retained(root, cwd), 'opencode', cwd)
      expect(resumed.workspacePlanDigest).toBe(first.workspacePlanDigest)
      expect(resumed.env).toEqual(first.env)
      expect(visibleInstructions(cwd, resumed.env)).toContain('ROOT-MARKER')
      expect(visibleInstructions(cwd, resumed.env)).not.toContain('DIRECTOR-MARKER')

      // An equal profile shares the same bytes at the same path.
      const again = provisionProfileWorkspace(request('root', 'ROOT-MARKER', { bash: true, webfetch: true }), null, 'opencode', cwd)
      expect(again.env).toEqual(first.env)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('removes the fixed-path config an earlier version wrote, and never a user config', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'opencode-profile-legacy-'))
    try {
      mkdirSync(join(cwd, '.opencode'))
      writeFileSync(join(cwd, '.opencode/profile-instructions.md'), 'You are stale. Your marker is STALE-MARKER.\n')
      writeFileSync(join(cwd, 'opencode.json'), JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        instructions: ['.opencode/profile-instructions.md'],
        tools: { bash: true },
      }))
      const provisioned = provisionProfileWorkspace(request('root', 'ROOT-MARKER', { bash: true }), null, 'opencode', cwd)
      expect(existsSync(join(cwd, 'opencode.json'))).toBe(false)
      expect(existsSync(join(cwd, '.opencode/profile-instructions.md'))).toBe(false)
      expect(visibleInstructions(cwd, provisioned.env)).toContain('ROOT-MARKER')
      expect(visibleInstructions(cwd, provisioned.env)).not.toContain('STALE-MARKER')

      const user = JSON.stringify({ $schema: 'https://opencode.ai/config.json', instructions: ['docs/style.md'] })
      writeFileSync(join(cwd, 'opencode.json'), user)
      provisionProfileWorkspace(request('director', 'DIRECTOR-MARKER', { bash: true }), null, 'opencode', cwd)
      expect(readFileSync(join(cwd, 'opencode.json'), 'utf8')).toBe(user)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('launches each profile with its own instructions while another profile materializes mid-turn', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'opencode-profile-spawn-'))
    // Stands in for opencode: it waits for the gate, then reads the project config and the
    // process config the way opencode does on each model request, and replies with the bytes.
    const script = `
      const fs = require('node:fs')
      const path = require('node:path')
      const read = () => {
        const configs = []
        if (fs.existsSync('opencode.json')) configs.push(JSON.parse(fs.readFileSync('opencode.json', 'utf8')))
        if (process.env.OPENCODE_CONFIG_CONTENT) configs.push(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT))
        return configs.flatMap((c) => c.instructions ?? []).map((p) => fs.readFileSync(path.resolve(p), 'utf8')).join('')
      }
      const gate = process.env.TEST_GATE
      const reply = () => {
        console.log(JSON.stringify({ type: 'text', sessionID: 'native-' + process.pid, part: { text: read() } }))
      }
      if (!gate) reply()
      else {
        const timer = setInterval(() => { if (fs.existsSync(gate)) { clearInterval(timer); reply() } }, 10)
      }
    `
    const gates = new Map<string, string>()
    const spawner: Spawner = async (_bin, _args, opts) => {
      const env = { ...opts.env, ...(gates.has(opts.sessionId ?? '') ? { TEST_GATE: gates.get(opts.sessionId ?? '') } : {}) }
      const child = spawn(process.execPath, ['-e', script], { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
      return { child, release() {}, spawnError: () => null }
    }
    const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 0, spawner })
    const turn = async (req: ChatRequest, session: SessionRecord | null = null): Promise<string> => {
      let text = ''
      for await (const delta of backend.chat(req, session, new AbortController().signal)) text += delta.content ?? ''
      return text
    }
    try {
      const gate = join(cwd, '.gate')
      const root = request('root', 'ROOT-MARKER', { bash: true }, cwd)
      gates.set(root.session_id!, gate)
      const rootTurn = turn(root)
      await new Promise((resolve) => setTimeout(resolve, 50))
      const director = request('director', 'DIRECTOR-MARKER', { bash: true }, cwd)
      const directorText = await turn(director)
      writeFileSync(gate, '')
      const rootText = await rootTurn

      expect(rootText).toContain('ROOT-MARKER')
      expect(rootText).not.toContain('DIRECTOR-MARKER')
      expect(directorText).toContain('DIRECTOR-MARKER')
      expect(directorText).not.toContain('ROOT-MARKER')

      gates.clear()
      const resumed = await turn({ ...root, agent_profile: root.agent_profile }, retained(root, cwd))
      expect(resumed).toContain('ROOT-MARKER')
      expect(resumed).not.toContain('DIRECTOR-MARKER')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
