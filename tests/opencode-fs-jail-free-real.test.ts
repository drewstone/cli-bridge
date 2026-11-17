/**
 * A fresh OpenCode user's free model under subscriptions-only admission and the filesystem jail.
 *
 * Reported 2026-11-17 from a public `tangle graph run` on a credential-free host: admission refused
 * `opencode/opencode/glm-5.3-flash-free` as provider_unresolved, and with admission off the jailed
 * turn exited 1 on `FileSystem.writeFile(.agent-home/.config/opencode/.gitignore)` because the
 * user's config directory was bound read-only. This test runs the real binary, real catalog and
 * real jail from a home that has a config directory and no credential.
 *
 * Skipped when the opencode binary or bwrap is unavailable; the model is OpenCode's free tier.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { OpencodeBackend } from '../src/backends/opencode.js'
import type { ChatDelta, ChatRequest } from '../src/backends/types.js'
import { loadConfig } from '../src/config.js'
import { hostRequestJail } from '../src/jail/host-request.js'
import { createNativeCatalog } from '../src/native-catalog.js'

const BIN = process.env.OPENCODE_BIN ?? join(homedir(), '.opencode/bin/opencode')
const MODEL = process.env.CLI_BRIDGE_LIVE_MODEL ?? 'opencode/opencode/glm-5.3-flash-free'
const ENABLED = existsSync(BIN) && existsSync('/usr/bin/bwrap') && process.env.CLI_BRIDGE_SKIP_REAL_OPENCODE !== '1'
const cleanups: string[] = []
afterAll(async () => { for (const dir of cleanups) await rm(dir, { recursive: true, force: true }) })

it.skipIf(!ENABLED)('admits and completes a credential-free free-model turn in the filesystem jail', async () => {
  const home = await mkdtemp(join(tmpdir(), 'opencode-free-home-'))
  const cwd = await mkdtemp(join(tmpdir(), 'opencode-free-work-'))
  cleanups.push(home, cwd)
  // Every OpenCode user has this directory; its presence is what the jail used to bind read-only.
  await mkdir(join(home, '.config', 'opencode'), { recursive: true })
  await writeFile(join(home, '.config', 'opencode', 'opencode.json'), '{"$schema":"https://opencode.ai/config.json"}\n')
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    BRIDGE_JAIL_MODE: process.env.BRIDGE_JAIL_MODE, BRIDGE_JAIL_NETWORK: process.env.BRIDGE_JAIL_NETWORK }
  Object.assign(process.env, { HOME: home, BRIDGE_JAIL_MODE: 'fs-jail', BRIDGE_JAIL_NETWORK: 'relay' })
  delete process.env.XDG_CONFIG_HOME
  delete process.env.XDG_DATA_HOME
  try {
    const config = loadConfig({ ...process.env, OPENCODE_BIN: BIN, BRIDGE_SUBSCRIPTIONS_ONLY: '1' })
    const request: ChatRequest = {
      cwd,
      session_id: 'fs-jail-free',
      mode: 'byob',
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      agent_profile: { name: 'free', harness: 'opencode', prompt: { appendSystemPrompt: 'Reply with exactly one word.' } },
    }
    // The chat route resolves the host jail before admission; the backend confines the turn only when it is set.
    request.jailSpec = hostRequestJail(request, 'opencode', process.env)
    expect(request.jailSpec, 'BRIDGE_JAIL_MODE=fs-jail resolves a host jail').toBeTruthy()
    const signal = new AbortController().signal
    await createNativeCatalog(config, undefined, cwd).admit(request, 'opencode', signal)
    // Admission's host-side `opencode models` initializes the user's config directory. The reported
    // failure had admission off, so the jailed turn found it uninitialized and had to write it.
    const hostIgnore = join(home, '.config', 'opencode', '.gitignore')
    await rm(hostIgnore, { force: true })
    const deltas: ChatDelta[] = []
    for await (const delta of new OpencodeBackend({ bin: BIN, timeoutMs: 120_000 }).chat(request, null, signal)) deltas.push(delta)
    const failure = deltas.find((delta) => delta.finish_reason === 'error')
    expect(failure, `turn failed: ${JSON.stringify(failure ?? {})}`).toBeUndefined()
    expect(deltas.some((delta) => typeof delta.content === 'string' && delta.content.length > 0)).toBe(true)
    expect(deltas.at(-1)).toMatchObject({ finish_reason: 'stop' })
    // The turn ran confined: OpenCode's startup write landed in the jail HOME's seeded config directory.
    const jailedConfig = join(cwd, '.agent-home', '.config', 'opencode')
    expect(existsSync(join(jailedConfig, 'opencode.json')), 'the user config was seeded into the jail').toBe(true)
    expect(existsSync(join(jailedConfig, '.gitignore')), 'OpenCode wrote its config directory inside the jail').toBe(true)
    expect(existsSync(hostIgnore), 'the jailed turn never wrote the host config directory').toBe(false)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 180_000)
