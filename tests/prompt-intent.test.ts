/**
 * Prompt-intent routing — one test per harness per intent, asserting what the
 * backend ACTUALLY sends (argv flags, on-disk prompt files, or a loud refusal),
 * not what the plan claims.
 *
 * `agent_profile.prompt.systemPrompt` REPLACES the harness's own system prompt
 * and `agent_profile.prompt.appendSystemPrompt` ADDS to it. They are opposite
 * operations on one channel, and every backend here either has a control for a
 * given intent or has none — substituting the other control is a silent
 * semantic change that no field in the response would reveal, so the
 * substitution must be impossible rather than merely discouraged.
 *
 * The control each assertion pins was measured against the installed CLI, by
 * capturing the request the CLI sends to a local sink:
 *
 *   claude-code 2.1.222  --system-prompt         → built-in prompt (27,673 B) GONE
 *                        --append-system-prompt  → built-in prompt intact + text
 *                        repeated --append-system-prompt → LAST ONE WINS, earlier
 *                        occurrences are silently discarded
 *   pi 0.83.0            --system-prompt <path>  → built-in prompt (2,565 B) GONE,
 *                        file bytes inlined, path itself never sent
 *                        --append-system-prompt  → built-in prompt intact + text
 *   codex 0.146.0        -c model_instructions_file=<relpath> → request
 *                        `instructions` becomes exactly the file (20,751 B → file)
 *                        no additive control exists
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { materializeProfile } from '@tangle-network/agent-profile-materialize'
import { AcpBackend } from '../src/backends/acp.js'
import { ClaudeBackend } from '../src/backends/claude.js'
import { CodexBackend } from '../src/backends/codex.js'
import { FactoryBackend } from '../src/backends/factory.js'
import { KimiBackend } from '../src/backends/kimi.js'
import { NanoclawBackend } from '../src/backends/nanoclaw.js'
import { OpencodeBackend } from '../src/backends/opencode.js'
import { PiBackend } from '../src/backends/pi.js'
import {
  assertProfilePromptIntentsSupported,
  provisionProfileWorkspace,
  renderLocalHarnessProfilePreamble,
  resolvePromptMessages,
} from '../src/backends/profile-support.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import type { SpawnResult, Spawner } from '../src/executors/types.js'
import { testPiInferenceTransport } from './pi-inference-fixture.js'

const REPLACEMENT = 'REPLACEMENT-TEXT-ONLY'
const ADDITION = 'ADDITION-TEXT-ONLY'

const workspaces: string[] = []
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-intent-'))
  workspaces.push(dir)
  return dir
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
}

/** Spawner that records argv and then completes the turn with one text delta. */
function recordingSpawner(
  lines: Array<Record<string, unknown>>,
  onSpawn: (bin: string, args: string[], opts: { cwd?: string }) => void,
): Spawner {
  const spawner: Spawner = async (bin, args, opts): Promise<SpawnResult> => {
    onSpawn(bin, [...args], opts as { cwd?: string })
    const child = new FakeChild()
    queueMicrotask(() => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`)
      child.stdout.end()
      child.stderr.end()
      setTimeout(() => {
        child.exitCode = 0
        child.emit('close', 0)
      }, 5)
    })
    return { child: child as never, release() {}, spawnError: () => null }
  }
  spawner.executionEnvironment = 'test-double'
  return spawner
}

const CLAUDE_STREAM = [
  { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
  { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
]
const PI_STREAM = [
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } },
  { type: 'turn_end', message: { usage: { input: 1, output: 1 } } },
]

async function drain(deltas: AsyncIterable<ChatDelta>): Promise<void> {
  for await (const _delta of deltas) void _delta
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function occurrences(args: string[], flag: string): number {
  return args.filter((value) => value === flag).length
}

function request(profile: AgentProfile, model: string, cwd: string): ChatRequest {
  return {
    model,
    messages: [{ role: 'user', content: 'do the task' }],
    cwd,
    agent_profile: profile,
  }
}

describe('prompt intents reach each harness through its own control', () => {
  afterEachCleanup()

  describe('claude-code', () => {
    it('sends a replacement on --system-prompt and never on the additive flag', async () => {
      let args: string[] = []
      const cwd = workspace()
      const backend = new ClaudeBackend({
        bin: 'claude',
        timeoutMs: 5_000,
        harness: 'claude-code',
        spawner: recordingSpawner(CLAUDE_STREAM, (_bin, spawned) => {
          args = spawned
        }),
      })

      await drain(backend.chat(
        request({ prompt: { systemPrompt: REPLACEMENT } }, 'claude-code/opus', cwd),
        null,
        new AbortController().signal,
      ))

      expect(flagValue(args, '--system-prompt')).toBe(REPLACEMENT)
      // The whole point: an addition carrying the replacement text would leave
      // claude-code's own 27,673-byte prompt running.
      expect(flagValue(args, '--append-system-prompt') ?? '').not.toContain(REPLACEMENT)
    })

    it('sends an addition on --append-system-prompt and never on the replacement flag', async () => {
      let args: string[] = []
      const cwd = workspace()
      const backend = new ClaudeBackend({
        bin: 'claude',
        timeoutMs: 5_000,
        harness: 'claude-code',
        spawner: recordingSpawner(CLAUDE_STREAM, (_bin, spawned) => {
          args = spawned
        }),
      })

      await drain(backend.chat(
        request({ prompt: { appendSystemPrompt: ADDITION } }, 'claude-code/opus', cwd),
        null,
        new AbortController().signal,
      ))

      expect(flagValue(args, '--append-system-prompt')).toContain(ADDITION)
      // A replacement carrying the addition would DELETE the prompt the caller
      // asked to keep — the opposite silent downgrade.
      expect(args).not.toContain('--system-prompt')
    })

    it('keeps the two intents separate when both are set', async () => {
      let args: string[] = []
      const cwd = workspace()
      const backend = new ClaudeBackend({
        bin: 'claude',
        timeoutMs: 5_000,
        harness: 'claude-code',
        spawner: recordingSpawner(CLAUDE_STREAM, (_bin, spawned) => {
          args = spawned
        }),
      })

      await drain(backend.chat(
        request(
          { prompt: { systemPrompt: REPLACEMENT, appendSystemPrompt: ADDITION } },
          'claude-code/opus',
          cwd,
        ),
        null,
        new AbortController().signal,
      ))

      expect(flagValue(args, '--system-prompt')).toBe(REPLACEMENT)
      expect(flagValue(args, '--append-system-prompt')).toContain(ADDITION)
      expect(flagValue(args, '--append-system-prompt')).not.toContain(REPLACEMENT)
    })

    it('emits --append-system-prompt exactly once when several additive sources apply', async () => {
      let args: string[] = []
      const cwd = workspace()
      const backend = new ClaudeBackend({
        bin: 'claude',
        timeoutMs: 5_000,
        harness: 'claude-code',
        spawner: recordingSpawner(CLAUDE_STREAM, (_bin, spawned) => {
          args = spawned
        }),
      })

      await drain(backend.chat(
        {
          model: 'claude-code/opus',
          messages: [{ role: 'user', content: 'do the task' }],
          cwd,
          // Two additive sources at once: the profile's addition and the
          // JSON-mode directive.
          response_format: { type: 'json_object' },
          agent_profile: {
            prompt: { appendSystemPrompt: ADDITION },
            permissions: { edit: 'allow' },
          },
        } as ChatRequest,
        null,
        new AbortController().signal,
      ))

      // claude-code takes the LAST --append-system-prompt and discards earlier
      // ones, so a second occurrence would silently drop one of these sources.
      expect(occurrences(args, '--append-system-prompt')).toBe(1)
      const appended = flagValue(args, '--append-system-prompt') ?? ''
      expect(appended).toContain(ADDITION)
      // The profile's addition leads the block it shares with the rest.
      expect(appended.indexOf(ADDITION)).toBe(0)
      expect(appended.length).toBeGreaterThan(ADDITION.length)
    })
  })

  describe('pi', () => {
    it('writes the replacement to a file on --system-prompt', async () => {
      let args: string[] = []
      // Read at spawn time: Pi's request-scoped profile directory is removed
      // once the turn ends, so the bytes only exist while the CLI could read them.
      let replacementFile: string | undefined
      const cwd = workspace()
      const backend = new PiBackend({
        bin: 'pi',
        timeoutMs: 5_000,
        transportResolver: testPiInferenceTransport(),
        spawner: recordingSpawner(PI_STREAM, (_bin, spawned) => {
          args = spawned
          const path = flagValue(spawned, '--system-prompt')
          if (path) replacementFile = readFileSync(path, 'utf8')
        }),
      })

      await drain(backend.chat(
        request({ prompt: { systemPrompt: REPLACEMENT } }, 'pi/zai-coding-paas/glm-5.2', cwd),
        null,
        new AbortController().signal,
      ))

      expect(flagValue(args, '--system-prompt')).toBeTruthy()
      expect(replacementFile).toBe(REPLACEMENT)
      expect(args).not.toContain('--append-system-prompt')
    })

    it('writes the addition to its own file on --append-system-prompt', async () => {
      let args: string[] = []
      let additionFile: string | undefined
      const cwd = workspace()
      const backend = new PiBackend({
        bin: 'pi',
        timeoutMs: 5_000,
        transportResolver: testPiInferenceTransport(),
        spawner: recordingSpawner(PI_STREAM, (_bin, spawned) => {
          args = spawned
          const path = flagValue(spawned, '--append-system-prompt')
          if (path) additionFile = readFileSync(path, 'utf8')
        }),
      })

      await drain(backend.chat(
        request({ prompt: { appendSystemPrompt: ADDITION } }, 'pi/zai-coding-paas/glm-5.2', cwd),
        null,
        new AbortController().signal,
      ))

      expect(flagValue(args, '--append-system-prompt')).toBeTruthy()
      expect(additionFile).toBe(ADDITION)
      expect(args).not.toContain('--system-prompt')
    })

    it('orders the profile addition ahead of the project-instruction file', async () => {
      let appendContents: string[] = []
      const cwd = workspace()
      const backend = new PiBackend({
        bin: 'pi',
        timeoutMs: 5_000,
        transportResolver: testPiInferenceTransport(),
        spawner: recordingSpawner(PI_STREAM, (_bin, spawned) => {
          appendContents = spawned
            .map((value, index) => (value === '--append-system-prompt' ? spawned[index + 1] : undefined))
            .filter((value): value is string => value !== undefined)
            .map((path) => readFileSync(path, 'utf8'))
        }),
      })

      await drain(backend.chat(
        request(
          { prompt: { appendSystemPrompt: ADDITION, instructions: ['PROJECT-INSTRUCTION'] } },
          'pi/zai-coding-paas/glm-5.2',
          cwd,
        ),
        null,
        new AbortController().signal,
      ))

      // pi reuses --append-system-prompt for AGENTS.md, and composes repeated
      // values in argv order, so the higher-privilege profile addition must lead.
      expect(appendContents.length).toBe(2)
      expect(appendContents[0]).toBe(ADDITION)
      expect(appendContents[1]).toContain('PROJECT-INSTRUCTION')
    })
  })

  describe('codex', () => {
    it('points model_instructions_file at the written replacement file', () => {
      const cwd = workspace()
      const provisioned = provisionProfileWorkspace(
        request({ prompt: { systemPrompt: REPLACEMENT } }, 'codex', cwd),
        null,
        'codex',
        cwd,
      )

      expect(provisioned.flags).toEqual(
        expect.arrayContaining(['-c', 'model_instructions_file=.codex/system-prompt.md']),
      )
      expect(readFileSync(join(cwd, '.codex/system-prompt.md'), 'utf8')).toBe(REPLACEMENT)
      // codex's replacement is a config file, never a launch-argument string.
      expect(provisioned.systemPrompt).toBeUndefined()
    })

    it('refuses an addition instead of flattening it into the user turn', () => {
      const cwd = workspace()
      expect(() =>
        provisionProfileWorkspace(
          request({ prompt: { appendSystemPrompt: ADDITION } }, 'codex', cwd),
          null,
          'codex',
          cwd,
        ),
      ).toThrow(/no verified additive system-prompt control/)
    })

    it('never lets the replacement reach the prompt text', () => {
      const cwd = workspace()
      const messages = resolvePromptMessages(
        request({ prompt: { systemPrompt: REPLACEMENT } }, 'codex', cwd),
        null,
        'codex',
      )
      // codex flattens role:'system' into the user turn, so a replacement that
      // arrived here would be ordinary user text while codex's own instructions
      // kept running.
      expect(JSON.stringify(messages)).not.toContain(REPLACEMENT)
    })
  })

  describe('opencode', () => {
    it('refuses a replacement it cannot bind to the launched agent', () => {
      const cwd = workspace()
      expect(() =>
        provisionProfileWorkspace(
          request({ prompt: { systemPrompt: REPLACEMENT } }, 'opencode', cwd),
          null,
          'opencode',
          cwd,
        ),
      ).toThrow(/only system-prompt replacement is per-agent/)
    })

    it('registers the addition as its own instructions file, ahead of project instructions', () => {
      const cwd = workspace()
      provisionProfileWorkspace(
        request(
          { prompt: { appendSystemPrompt: ADDITION, instructions: ['PROJECT-INSTRUCTION'] } },
          'opencode',
          cwd,
        ),
        null,
        'opencode',
        cwd,
      )

      // opencode joins these files into the same system message as its own
      // built-in prompt, which stays in place — that is the addition contract.
      const config = JSON.parse(readFileSync(join(cwd, 'opencode.json'), 'utf8')) as {
        instructions: string[]
      }
      expect(config.instructions).toEqual([
        '.opencode/agent-system-prompt.md',
        '.opencode/profile-instructions.md',
      ])
      expect(readFileSync(join(cwd, '.opencode/agent-system-prompt.md'), 'utf8')).toBe(
        `${ADDITION}\n`,
      )
    })
  })

  describe('gemini', () => {
    it('installs a replacement as its native system file', () => {
      const cwd = workspace()
      const provisioned = provisionProfileWorkspace(
        request({ prompt: { systemPrompt: REPLACEMENT } }, 'gemini', cwd),
        null,
        'gemini',
        cwd,
      )

      expect(provisioned.env.GEMINI_SYSTEM_MD).toBe('1')
      expect(readFileSync(join(cwd, '.gemini/system.md'), 'utf8')).toBe(REPLACEMENT)
    })

    it('refuses an addition rather than aliasing GEMINI.md memory', () => {
      const cwd = workspace()
      expect(() =>
        provisionProfileWorkspace(
          request({ prompt: { appendSystemPrompt: ADDITION } }, 'gemini', cwd),
          null,
          'gemini',
          cwd,
        ),
      ).toThrow(/only additive system-prompt channel is GEMINI\.md memory/)
    })
  })

  describe('backends with no system-prompt channel at all', () => {
    // These flatten a role:'system' message into the user turn, so neither
    // intent has anywhere real to land. The shared seam refuses both — including
    // for backends (acp, factory, nanoclaw) that never materialize a plan and
    // would otherwise drop the intent without a word.
    for (const backend of ['kimi-code', 'nanoclaw', 'acp', 'factory', 'a-backend-added-tomorrow']) {
      it(`refuses a replacement on ${backend}`, () => {
        expect(() =>
          assertProfilePromptIntentsSupported({ prompt: { systemPrompt: REPLACEMENT } }, backend),
        ).toThrow(/cannot replace its harness's system prompt/)
      })

      it(`refuses an addition on ${backend}`, () => {
        expect(() =>
          assertProfilePromptIntentsSupported({ prompt: { appendSystemPrompt: ADDITION } }, backend),
        ).toThrow(/cannot add to its harness's system prompt/)
      })
    }
  })

  describe('the shared preamble', () => {
    it('no longer carries prompt text of either intent', () => {
      const preamble = renderLocalHarnessProfilePreamble({
        prompt: { systemPrompt: REPLACEMENT, appendSystemPrompt: ADDITION },
        // A surface that DOES belong in the preamble, so the assertion below is
        // about the prompt fields rather than an empty render.
        permissions: { edit: 'allow' },
      } as AgentProfile)

      expect(preamble).toBeTruthy()
      expect(preamble).not.toContain(REPLACEMENT)
      expect(preamble).not.toContain(ADDITION)
    })
  })

  describe('the plan itself', () => {
    it('records the two intents as different plans for the same bytes', () => {
      const replace = materializeProfile({ prompt: { systemPrompt: 'SAME' } }, 'claude-code')
      const append = materializeProfile({ prompt: { appendSystemPrompt: 'SAME' } }, 'claude-code')

      expect(replace.systemPrompt).toBe('SAME')
      expect(replace.appendSystemPrompt).toBeUndefined()
      expect(append.appendSystemPrompt).toBe('SAME')
      expect(append.systemPrompt).toBeUndefined()
    })
  })
})

/**
 * The refusal has to fire on the PATH a request takes, not just when the assertion is called
 * directly. Every case below drives the backend's own `chat`/`buildPrompt` with an intent that
 * backend cannot execute, and asserts the BackendError kind AND that nothing was launched —
 * deleting `assertProfilePromptIntentsSupported` from `resolvePromptMessages` turns each of these
 * into a successful spawn carrying no intent at all, which is the silent downgrade the guard exists
 * to stop. `assertProfilePromptIntentsSupported` tested in isolation cannot see that.
 */
describe('the shared refusal seam fires on the real request path', () => {
  afterEachCleanup()

  const REPLACE_REFUSAL = /cannot replace its harness's system prompt/
  const APPEND_REFUSAL = /cannot add to its harness's system prompt/

  /** A spawner that must never run. Counts attempts so "no process spawned" is measured, not assumed. */
  function countingSpawner(counter: { calls: number }): Spawner {
    const spawner: Spawner = async (): Promise<SpawnResult> => {
      counter.calls += 1
      throw new Error('spawner reached: the unsupported prompt intent was not refused')
    }
    spawner.executionEnvironment = 'test-double'
    return spawner
  }

  interface SeamCase {
    readonly label: string
    readonly intent: 'replace' | 'append'
    readonly refusal: RegExp
    /** Drives the backend's real request path with a spawner that counts launches. */
    readonly run: (profile: AgentProfile, cwd: string, spawner: Spawner) => Promise<void>
  }

  const replacement: AgentProfile = { prompt: { systemPrompt: REPLACEMENT } }
  const addition: AgentProfile = { prompt: { appendSystemPrompt: ADDITION } }
  const signal = (): AbortSignal => new AbortController().signal

  const cases: SeamCase[] = [
    // acp / factory / nanoclaw never materialize a profile plan, so the materializer's fail-closed
    // record never reaches them: this seam is their ONLY guard on either intent.
    ...(['replace', 'append'] as const).flatMap((intent): SeamCase[] => {
      const profileOf = intent === 'replace' ? replacement : addition
      const refusal = intent === 'replace' ? REPLACE_REFUSAL : APPEND_REFUSAL
      void profileOf
      return [
        {
          label: `acp (hermes) · ${intent}`,
          intent,
          refusal,
          run: async (profile, cwd, spawner) => {
            const backend = new AcpBackend({ name: 'hermes', bin: 'hermes', timeoutMs: 5_000, spawner })
            await drain(backend.chat(request(profile, 'hermes', cwd), null, signal()))
          },
        },
        {
          label: `factory · ${intent}`,
          intent,
          refusal,
          run: async (profile, cwd, spawner) => {
            const backend = new FactoryBackend({ bin: 'droid', timeoutMs: 5_000, spawner })
            await drain(backend.chat(request(profile, 'factory', cwd), null, signal()))
          },
        },
        {
          label: `kimi-code · ${intent}`,
          intent,
          refusal,
          run: async (profile, cwd, spawner) => {
            const backend = new KimiBackend({ bin: 'kimi', timeoutMs: 5_000, spawner })
            await drain(backend.chat(request(profile, 'kimi-code', cwd), null, signal()))
          },
        },
      ]
    }),
    // codex and opencode DO materialize, and their materializer refuses the same cells — but a
    // second layer down, after the request path has already accepted the intent. Asserting THIS
    // seam's wording proves the refusal happens here first, before any workspace is touched.
    {
      label: 'codex · append (no additive control)',
      intent: 'append',
      refusal: APPEND_REFUSAL,
      run: async (profile, cwd, spawner) => {
        const backend = new CodexBackend({ bin: 'codex', timeoutMs: 5_000, spawner })
        await drain(backend.chat(request(profile, 'codex', cwd), null, signal()))
      },
    },
    {
      label: 'opencode · replace (its replacement binds to a launch-time agent)',
      intent: 'replace',
      refusal: REPLACE_REFUSAL,
      run: async (profile, cwd, spawner) => {
        const backend = new OpencodeBackend({ bin: 'opencode', timeoutMs: 5_000, spawner })
        await drain(backend.chat(request(profile, 'opencode', cwd), null, signal()))
      },
    },
  ]

  for (const seamCase of cases) {
    it(`refuses ${seamCase.label} without spawning anything`, async () => {
      const cwd = workspace()
      const counter = { calls: 0 }
      const profile = seamCase.intent === 'replace' ? replacement : addition

      await expect(
        seamCase.run(profile, cwd, countingSpawner(counter)),
      ).rejects.toMatchObject({ name: 'BackendError', code: 'not_configured' })
      await expect(seamCase.run(profile, cwd, countingSpawner(counter))).rejects.toThrow(
        seamCase.refusal,
      )

      expect(counter.calls).toBe(0)
      // Nothing was written either: the refusal precedes workspace materialization.
      expect(readdirSync(cwd)).toEqual([])
    })
  }

  it('refuses both intents on nanoclaw without opening its socket', async () => {
    const dir = workspace()
    const socketPath = join(dir, 'cli.sock')
    let connections = 0
    const server = net.createServer((socket) => {
      connections += 1
      socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))

    try {
      const backend = new NanoclawBackend({ socketPath, timeoutMs: 5_000, silenceMs: 50 })
      const cwd = workspace()

      await expect(
        drain(backend.chat(request(replacement, 'nanoclaw', cwd), null, signal())),
      ).rejects.toMatchObject({ name: 'BackendError', code: 'not_configured' })
      await expect(
        drain(backend.chat(request(replacement, 'nanoclaw', cwd), null, signal())),
      ).rejects.toThrow(REPLACE_REFUSAL)
      await expect(
        drain(backend.chat(request(addition, 'nanoclaw', cwd), null, signal())),
      ).rejects.toThrow(APPEND_REFUSAL)

      // nanoclaw launches nothing itself — it hands the turn to a running daemon. Reaching that
      // daemon at all IS the downgrade here, so the socket connection count is the spawn count.
      expect(connections).toBe(0)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('lets a supported intent through the same seam, so the refusal is not blanket', async () => {
    // The guard must refuse only what the backend cannot execute. codex owns replacement and
    // opencode owns addition; both pass this seam and are stopped later (or not at all) by their
    // own materializer, never by this assertion.
    expect(() =>
      resolvePromptMessages(request(replacement, 'codex', workspace()), null, 'codex'),
    ).not.toThrow()
    expect(() =>
      resolvePromptMessages(request(addition, 'opencode', workspace()), null, 'opencode'),
    ).not.toThrow()
    // And the intent text never leaks into the flattened prompt on the way through.
    const messages = resolvePromptMessages(
      request(replacement, 'codex', workspace()),
      null,
      'codex',
    )
    expect(JSON.stringify(messages)).not.toContain(REPLACEMENT)
  })
})

function afterEachCleanup(): void {
  // Workspaces are materialized into real directories so the assertions can read
  // the bytes each backend actually wrote.
  afterAll(() => {
    for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
}
