/**
 * Write-jail + AgentProfile instructions must compose (#145).
 *
 * Reported 2026-09-10: under BRIDGE_JAIL_MODE=write-jail an opencode turn with
 * prompt.instructions exited 1 before any model usage — opencode's startup
 * write of `<workspace>/.opencode/.gitignore` hit the read-only project bind.
 * PR #216 moved profile config into a per-turn bridge-owned config dir with
 * the project layer disabled; this test proves the composed behavior on the
 * real binary under the real jail, which no other test covers.
 *
 * Skipped when the opencode binary, the jail (bwrap), or the free live model
 * route is unavailable; the model route is the free tier, so no paid run.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { OpencodeBackend } from '../src/backends/opencode.js'
import { jailFloor } from '../src/jail/resolve-spec.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'

const BIN = process.env.OPENCODE_BIN ?? join(homedir(), '.opencode/bin/opencode')
const BWRAP = '/usr/bin/bwrap'
const MODEL = process.env.CLI_BRIDGE_LIVE_MODEL ?? 'opencode/opencode/glm-5.3-flash-free'
const ENABLED = existsSync(BIN)
  && existsSync(BWRAP)
  && process.env.CLI_BRIDGE_SKIP_REAL_OPENCODE !== '1'

const workspaces: string[] = []
afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true })
})

describe('opencode profile instructions under the write jail', () => {
  it.skipIf(!ENABLED)('completes a turn without touching the read-only project tree', async () => {
    // Prove the jail is actually armed for this run; an unjailed pass would
    // prove nothing about #145.
    const saved = process.env.BRIDGE_JAIL_MODE
    process.env.BRIDGE_JAIL_MODE = 'write-jail'
    try {
      expect(jailFloor()).toBe('write-jail')

      const cwd = mkdtempSync(join(tmpdir(), 'opencode-write-jail-'))
      workspaces.push(cwd)
      const backend = new OpencodeBackend({ bin: BIN, timeoutMs: 120_000 })

      const request: ChatRequest = {
        cwd,
        session_id: 'write-jail-instructions',
        mode: 'byob',
        model: MODEL,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        agent_profile: {
          name: 'narrow',
          harness: 'opencode',
          prompt: { instructions: ['You are narrow. Reply with exactly one word.'] },
        },
      }

      const deltas: ChatDelta[] = []
      for await (const delta of backend.chat(request, null, new AbortController().signal)) {
        deltas.push(delta)
      }

      const failure = deltas.find((delta) => delta.finish_reason === 'error')
      expect(failure, `turn failed: ${JSON.stringify(failure ?? {})}`).toBeUndefined()
      expect(deltas.some((delta) => typeof delta.content === 'string' && delta.content.length > 0)).toBe(true)
      expect(deltas.at(-1)).toMatchObject({ finish_reason: 'stop' })
    } finally {
      if (saved === undefined) delete process.env.BRIDGE_JAIL_MODE
      else process.env.BRIDGE_JAIL_MODE = saved
    }
  }, 180_000)
})

