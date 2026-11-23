/**
 * A Claude Code runner that dies of SIGABRT inside the bwrap jail. bwrap's PID 1 reaps it and
 * exits 134, so the Bridge must read that status as the signal: a killed runner continues once in
 * its own native session, and a second kill fails naming the signal. Real bwrap, real processes,
 * the maintained host spawner; no model is called.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ClaudeBackend } from '../src/backends/claude.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import { hostSpawner } from '../src/executors/host.js'
import type { Spawner } from '../src/executors/types.js'
import { hostRequestJail } from '../src/jail/host-request.js'
import { LinuxBwrapJail } from '../src/jail/linux-bwrap.js'

const NATIVE_SESSION = '00000000-0000-4000-8000-000000000134'
const MARKER = 'continued-after-abort-394'

// Each spawn records its PID and resume id; the first `aborts` spawns die mid-tool by process.abort().
const runner = (workspace: string, aborts: number) => `#!${process.execPath}
const fs = require('node:fs')
if (process.argv.includes('--version')) { console.log('2.1.330 (Claude Code)'); process.exit(0) }
const log = ${JSON.stringify(join(workspace, 'spawns.json'))}
const spawns = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : []
const at = process.argv.indexOf('--resume')
spawns.push({ pid: process.pid, resume: at < 0 ? null : process.argv[at + 1] })
fs.writeFileSync(log, JSON.stringify(spawns))
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
emit({ type: 'system', subtype: 'init', session_id: ${JSON.stringify(NATIVE_SESSION)} })
if (spawns.length <= ${aborts}) {
  emit({ type: 'assistant', message: { id: 'msg-' + spawns.length, content: [{ type: 'tool_use', id: 'toolu_' + spawns.length, name: 'Bash', input: { command: 'pnpm test' } }] } })
  process.abort()
}
emit({ type: 'assistant', message: { id: 'msg-answer', content: [{ type: 'text', text: ${JSON.stringify(MARKER)} }] } })
emit({ type: 'result', subtype: 'success', session_id: ${JSON.stringify(NATIVE_SESSION)}, result: ${JSON.stringify(MARKER)}, is_error: false,
  usage: { input_tokens: 3, output_tokens: 5 } })
`

// The gate hosts have no systemd user manager, so this spawner names the scope that
// scoped-host's cgroup.kill proves drained in production. The process, jail and exit are real.
const spawner: Spawner = async (bin, args, opts) => ({ ...(await hostSpawner(bin, args, opts)), scope: 'jailed-abort-proof.scope' })

describe.skipIf(!new LinuxBwrapJail().isAvailable())('a Claude runner killed by SIGABRT inside the bwrap jail', () => {
  let root: string
  beforeAll(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'jailed-harness-abort-'))) })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  const turn = async (name: string, aborts: number) => {
    const workspace = join(root, name)
    await mkdir(workspace)
    const bin = join(workspace, 'claude.cjs')
    await writeFile(bin, runner(workspace, aborts), { mode: 0o700 })
    const request: ChatRequest = {
      cwd: workspace,
      session_id: `jailed-abort-${name}`,
      mode: 'byob',
      model: 'claude-code/anthropic/sonnet',
      messages: [{ role: 'user', content: 'run the tests' }],
      agent_profile: { name: 'jailed-abort-proof' },
    }
    request.jailSpec = hostRequestJail(request, 'claude-code', { ...process.env, BRIDGE_JAIL_MODE: 'fs-jail', BRIDGE_JAIL_NETWORK: 'none' })
    expect(request.jailSpec, 'BRIDGE_JAIL_MODE=fs-jail resolves a host jail').toBeTruthy()
    const backend = new ClaudeBackend({ bin, harness: 'claude-code', timeoutMs: 0, spawner })
    const deltas: ChatDelta[] = []
    let failure: Error | undefined
    try {
      for await (const delta of backend.chat(request, null, new AbortController().signal)) deltas.push(delta)
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }
    const spawns = JSON.parse(await readFile(join(workspace, 'spawns.json'), 'utf8')) as Array<{ pid: number; resume: string | null }>
    return { deltas, failure, spawns }
  }

  it('continues the turn once in the same native session', async () => {
    const { deltas, failure, spawns } = await turn('once', 1)
    expect(failure?.message).toBeUndefined()
    // PID 2 is the command under bwrap's own PID 1: the abort reached the Bridge only as bwrap's status.
    expect(spawns).toEqual([{ pid: 2, resume: null }, { pid: 2, resume: NATIVE_SESSION }])
    expect(deltas.find((delta) => delta.continuation)?.continuation).toMatchObject({
      reason: 'runner_exit',
      previous_exit: 'SIGABRT',
      native_session_id: NATIVE_SESSION,
      interrupted_tool_calls: [{ id: 'toolu_1', name: 'Bash' }],
    })
    expect(deltas.map((delta) => delta.content ?? '').join('')).toContain(MARKER)
    expect(deltas.at(-1)).toMatchObject({ finish_reason: 'stop' })
  }, 60_000)

  it('fails naming the signal when the continuation is killed too', async () => {
    const { failure, spawns } = await turn('twice', 2)
    expect(spawns).toHaveLength(2)
    expect(failure?.message).toMatch(/claude was killed by SIGABRT/)
    expect(failure?.message).not.toMatch(/exited 134/)
  }, 60_000)
})
