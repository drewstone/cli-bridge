/**
 * The generated output-budget plugin, replayed as a black box.
 *
 * installOutputCapPlugin writes outputCapPluginSource(cap) into the turn's
 * config directory; opencode executes exactly that file. So the artifact
 * itself is the unit under test: import the generated source and drive its
 * hooks with the notification shapes opencode's bus produces, including the
 * ambiguous ones a real run can deliver — replayed receipts, an overlapping
 * ask while a lease is outstanding, a receipt from another session, and a
 * lost stream whose automatic retry must be refused before the wire.
 *
 * The invariant under every sequence: the sum of granted asks never exceeds
 * the cap (plus receipt-backed refunds of unspent differences), and capacity
 * is returned only by a receipt attributed to the outstanding lease.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { outputCapPluginSource } from '../src/backends/opencode.js'

interface Hooks {
  'chat.params': (input: { sessionID?: string; message?: { sessionID?: string; id?: string; role: 'user' } }, params: { maxOutputTokens?: number }) => Promise<void>
  event: (wrapper: { event: unknown }) => Promise<void>
}

const temps: string[] = []
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

async function makePlugin(cap: number): Promise<Hooks> {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-cap-plugin-'))
  temps.push(dir)
  const file = join(dir, 'cli-bridge-output-cap.mjs')
  writeFileSync(file, outputCapPluginSource(cap))
  const mod = await import(pathToFileURL(file).href) as { CliBridgeOutputCap: () => Promise<Hooks> }
  return await mod.CliBridgeOutputCap()
}

const activeAssistant = new WeakMap<Hooks, Map<string, string>>()
let sequence = 0
async function partEvent(hooks: Hooks, part: Record<string, unknown>): Promise<void> {
  await hooks.event({ event: { type: 'message.part.updated', properties: { part } } })
}

/** Replay the native writer's assistant → chat.params(user) → step-start ordering. */
async function ask(hooks: Hooks, sessionID = 'ses_run', base = 1_000_000): Promise<number> {
  const user = { sessionID, id: 'user1', role: 'user' as const }
  const info = { id: `assistant${++sequence}`, sessionID, parentID: user.id, role: 'assistant' }
  const notify = (value: object) => hooks.event({ event: { type: 'message.updated', properties: { info: value } } })
  await notify(info)
  const params = { maxOutputTokens: base }
  try {
    await hooks['chat.params']({ sessionID, message: user }, params)
  } catch (error) {
    await notify({ ...info, error: { name: 'UnknownError' } })
    throw error
  }
  const active = activeAssistant.get(hooks) ?? new Map<string, string>()
  active.set(sessionID, info.id)
  activeAssistant.set(hooks, active)
  await partEvent(hooks, { type: 'step-start', id: `start-${info.id}`, sessionID, messageID: info.id })
  return params.maxOutputTokens
}

async function receipt(hooks: Hooks, part: {
  id?: string; sessionID?: string; messageID?: string; output?: number; reasoning?: number; override?: Record<string, unknown>
}): Promise<void> {
  const sessionID = part.sessionID ?? 'ses_run'
  await partEvent(hooks, {
    type: 'step-finish', id: part.id, sessionID,
    messageID: part.messageID ?? activeAssistant.get(hooks)?.get(sessionID) ?? 'foreign',
    tokens: { output: part.output ?? 0, reasoning: part.reasoning ?? 0 }, ...part.override,
  })
}

describe('the generated output-budget plugin', () => {
  it('grants the cap, then only the unspent remainder across sequential steps', async () => {
    const hooks = await makePlugin(60)
    expect(await ask(hooks)).toBe(60)
    await receipt(hooks, { id: 'p1', output: 48 })
    expect(await ask(hooks)).toBe(12)
    await receipt(hooks, { id: 'p2', output: 10, reasoning: 0 })
    // 2 tokens remain.
    expect(await ask(hooks)).toBe(2)
  })

  it('refunds only the receipt-backed difference of its exact attempt', async () => {
    const hooks = await makePlugin(100)
    expect(await ask(hooks)).toBe(100)
    await receipt(hooks, { id: 'p1', output: 40 })
    // The attempt was allowed 100 and billed 40: 60 return to the budget.
    expect(await ask(hooks)).toBe(60)
    await receipt(hooks, { id: 'p2', output: 50 })
    // Allowed 60, billed 50: 10 remain.
    expect(await ask(hooks)).toBe(10)
    // A receipt reporting more than its ask refunds nothing.
    await receipt(hooks, { id: 'p3', output: 50 })
    await expect(ask(hooks)).rejects.toThrow(/budget is spent/)
  })

  it('settles a replayed receipt exactly once', async () => {
    const hooks = await makePlugin(60)
    expect(await ask(hooks)).toBe(60)
    await receipt(hooks, { id: 'p1', output: 10 })
    // The duplicate notification must not refund again: 50 remain, not 100.
    await receipt(hooks, { id: 'p1', output: 10 })
    expect(await ask(hooks)).toBe(50)
  })

  it('refuses an overlapping ask while a lease is outstanding, including a retry after a lost stream', async () => {
    const hooks = await makePlugin(60)
    expect(await ask(hooks)).toBe(60)
    // The stream is lost: no receipt ever arrives, then the runner retries.
    await expect(ask(hooks)).rejects.toThrow(/overlapping model call/)
    // Still outstanding: every later attempt is refused the same way.
    await expect(ask(hooks)).rejects.toThrow(/overlapping model call/)
  })

  it('charges, never refunds, a receipt it cannot attribute to the outstanding lease', async () => {
    const hooks = await makePlugin(60)
    expect(await ask(hooks, 'ses_run')).toBe(60)
    // A subagent session's receipt while the run's lease is outstanding.
    await receipt(hooks, { id: 'sub1', sessionID: 'ses_sub', output: 20 })
    // The lease is still unsettled: nothing was refunded to it.
    await expect(ask(hooks, 'ses_run')).rejects.toThrow(/overlapping model call/)
    // The run's own receipt settles the lease: 60 - 5 refunded, minus the
    // subagent's charged 20.
    await receipt(hooks, { id: 'p1', sessionID: 'ses_run', output: 5 })
    expect(await ask(hooks, 'ses_run')).toBe(35)
  })

  it('settles a lease only on the same session', async () => {
    const hooks = await makePlugin(60)
    expect(await ask(hooks, 'ses_run')).toBe(60)
    await receipt(hooks, { id: 'p1', sessionID: 'ses_other', output: 0 })
    await expect(ask(hooks, 'ses_run')).rejects.toThrow(/overlapping model call/)
  })

  it('withholds the full grant when a native counter is absent, invalid or normalized to zero', async () => {
    for (const tokens of [undefined, {}, { output: 4 }, { reasoning: 2 }, { output: 0, reasoning: 0 },
      { output: 0, reasoning: 5 }, { output: -1, reasoning: 5 }, { output: 4, reasoning: -1 }, { output: 1.5, reasoning: 0 },
      { output: Infinity, reasoning: 0 }, { output: 4, reasoning: NaN }, { output: '4', reasoning: 0 },
      { output: Number.MAX_SAFE_INTEGER, reasoning: 1 }]) {
      const hooks = await makePlugin(30)
      expect(await ask(hooks, 'ses_run', 20)).toBe(20)
      await receipt(hooks, { id: 'finish', override: { tokens } })
      // The other ten tokens were never granted to the uncertain call.
      expect(await ask(hooks)).toBe(10)
    }
  })

  it('reconciles a pure reasoning receipt before returning capacity', async () => {
    const tokens = { output: 0, reasoning: 7, input: 10, cache: { read: 2, write: 1 }, total: 20 }
    for (const [reason, total, remaining] of [['stop', 20, 13], ['stop', 19, 0], ['tool-calls', 20, 0]] as const) {
      const hooks = await makePlugin(20)
      await ask(hooks)
      await receipt(hooks, { id: 'r', override: { reason, tokens: { ...tokens, total } } })
      if (remaining > 0) expect(await ask(hooks)).toBe(remaining)
      else await expect(ask(hooks)).rejects.toThrow(/usage is unknown/)
    }
  })

  it('requires an identified finish from the assistant whose model step started', async () => {
    for (const override of [{ id: undefined }, { id: '' }, { sessionID: undefined }, { messageID: undefined },
      { messageID: 'different-assistant-in-same-session' }]) {
      const hooks = await makePlugin(30)
      await ask(hooks)
      await receipt(hooks, { id: 'finish', output: 2, override })
      await expect(ask(hooks)).rejects.toThrow(/overlapping model call/)
    }
    const hooks = await makePlugin(30)
    await ask(hooks)
    const first = activeAssistant.get(hooks)!.get('ses_run')!
    await receipt(hooks, { id: 'first', output: 5 })
    expect(await ask(hooks)).toBe(25)
    await receipt(hooks, { id: 'first', messageID: first, output: 5 })
    await receipt(hooks, { id: 'late', messageID: first, output: 2 })
    await expect(ask(hooks)).rejects.toThrow(/overlapping model call/)
    await receipt(hooks, { id: 'second', output: 5 })
    expect(await ask(hooks)).toBe(18)
  })

  it('withholds the lease when the grant or native start cannot identify an attempt', async () => {
    for (const mode of ['absent-user', 'ambiguous-assistant', 'absent-start', 'ambiguous-start']) {
      const hooks = await makePlugin(30)
      const sessionID = 'ses_run'
      for (const id of mode === 'ambiguous-assistant' ? ['a', 'b'] : ['a']) {
        await hooks.event({ event: { type: 'message.updated', properties: { info: { id, sessionID, parentID: 'user1', role: 'assistant' } } } })
      }
      const message = { id: mode === 'absent-user' ? undefined : 'user1', role: 'user' as const, sessionID }
      await hooks['chat.params']({ sessionID, message }, {})
      if (mode !== 'absent-start') await partEvent(hooks, { id: 'start', type: 'step-start', sessionID, messageID: 'a' })
      if (mode === 'ambiguous-start') await partEvent(hooks, { id: 'other', type: 'step-start', sessionID, messageID: 'a' })
      await receipt(hooks, { id: 'finish', messageID: 'a', output: 3 })
      await expect(ask(hooks)).rejects.toThrow(/overlapping model call/)
    }
  })

  it('refuses once the budget is spent, and keeps refusing', async () => {
    const hooks = await makePlugin(30)
    expect(await ask(hooks)).toBe(30)
    await receipt(hooks, { id: 'p1', output: 30 })
    await expect(ask(hooks)).rejects.toThrow(/budget is spent/)
    await expect(ask(hooks)).rejects.toThrow(/budget is spent/)
  })

  it('tracks a long ambiguous sequence exactly: no capacity leaks', async () => {
    const hooks = await makePlugin(50)
    let expected = 50
    // Sequential steps whose receipts replay, foreign receipts interleaved:
    // each settled step bills 3, each foreign receipt charges 2, so the
    // budget must read exactly 50 - 5*i after iteration i.
    for (let i = 1; i <= 8; i += 1) {
      expect(await ask(hooks)).toBe(expected)
      await receipt(hooks, { id: `p${i}`, output: 3 })
      await receipt(hooks, { id: `p${i}`, output: 3 })
      await receipt(hooks, { id: `foreign${i}`, sessionID: 'ses_sub', output: 2 })
      expected -= 5
    }
    expect(await ask(hooks)).toBe(10)
    // The bound is the cap: total eventual billing cannot pass 50, and once
    // the receipts spend it, further calls are refused.
    await receipt(hooks, { id: 'p9', output: 10 })
    await expect(ask(hooks)).rejects.toThrow(/budget is spent/)
  })
})
