import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { registerJailReadable, registerJailWritable } from '../jail/index.js'
import { terminateSpawned } from '../executors/process-tree.js'
import type { SpawnOpts, Spawner, SpawnResult } from '../executors/types.js'
import { createPrivateTemporaryRoot } from '../runtime/private-temporary.js'
import { kimiNativeHome } from './kimi-turn-failure.js'
import { BackendError } from './types.js'

export function kimiToolChoiceError(reason: string): BackendError {
  return new BackendError('Kimi cannot enforce tool_choice "none" for this request. ' + reason,
    'capability_denied', undefined, { providerDispatch: 'not_started' })
}

/** Kimi gives an explicit print agent file precedence over every discovered agent. */
export function kimiTextOnlyProfile(jail: SpawnOpts['jail']) {
  const root = createPrivateTemporaryRoot(tmpdir(), 'cli-bridge-kimi-')
  try {
    const name = 'bridge-text-' + randomUUID()
    const agents = join(root.path, 'agents')
    mkdirSync(agents, { mode: 0o700 })
    const file = join(agents, name + '.md')
    writeFileSync(file, [
      '---', 'name: ' + name, 'description: Answer the supplied request.',
      'tools: []', 'subagents: []', '---', '${base_prompt}', '',
    ].join('\n'), { flag: 'wx', mode: 0o600 })
    registerJailReadable(jail, file)
    return { root, name, file }
  } catch (error) {
    root.cleanup()
    throw error
  }
}

/** The bootstrap process alone sees the additional profile. ACP uses the operator's original home. */
function bootstrapHome(profile: ReturnType<typeof kimiTextOnlyProfile>, env: NodeJS.ProcessEnv): void {
  const original = kimiNativeHome(env)
  mkdirSync(join(original, 'sessions'), { recursive: true, mode: 0o700 })
  mkdirSync(join(original, 'locks', 'sessions'), { recursive: true, mode: 0o700 })
  const home = realpathSync(original)
  // A first native session must be discoverable by a fresh ACP process even on a new device.
  const names = new Set([...readdirSync(home), 'session_index.jsonl'])
  names.delete('agents')
  for (const name of names) symlinkSync(join(home, name), join(profile.root.path, name))
  const agents = join(home, 'agents')
  if (existsSync(agents)) {
    for (const name of readdirSync(agents)) {
      symlinkSync(join(agents, name), join(profile.root.path, 'agents', name))
    }
  }
}

/** The private loopback origin and bearer that `kimi web --json` prints once ready; null when it names none. */
export async function kapReady(child: ChildProcess): Promise<{ origin: string; token: string } | null> {
  if (!child.stdout) return null
  child.stderr?.resume()
  const lines = createInterface({ input: child.stdout })
  try {
    for await (const line of lines) {
      if (!line.startsWith('{')) continue
      const ready = JSON.parse(line) as { origin?: unknown; token?: unknown }
      if (typeof ready.origin !== 'string' || typeof ready.token !== 'string' || !ready.token) return null
      const url = new URL(ready.origin)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== ready.origin) return null
      return { origin: url.origin, token: ready.token }
    }
  } finally {
    lines.close()
  }
  return null
}

/**
 * Fresh Kimi ACP sessions advertise the ambient catalog before restoring their profile.
 * KAP binds the profile to the real cwd without a prompt. Close it before acquiring the
 * ACP slot and resume its native id. No extra model turn or shared agent registration.
 */
export async function startKimiTextOnlySession(
  bin: string, spawner: Spawner, spawnOpts: SpawnOpts, model: string | null, signal: AbortSignal,
): Promise<string> {
  // The bootstrap's temporary mount is gone before the separate ACP process starts.
  const jail = spawnOpts.jail ? { ...spawnOpts.jail } : undefined
  const profile = kimiTextOnlyProfile(jail)
  let child: SpawnResult | undefined
  const onAbort = (): void => { if (child) void terminateSpawned(child) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    signal.throwIfAborted()
    const env = spawnOpts.env ?? process.env
    bootstrapHome(profile, env)
    registerJailWritable(jail, profile.root.path)
    child = await spawner(bin, ['web', '--json', '--host', '127.0.0.1', '--port', '0'], {
      ...spawnOpts, jail, signal, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, KIMI_CODE_HOME: profile.root.path },
    })
    signal.throwIfAborted()
    if (!child.child.stdout || child.spawnError?.()) throw kimiToolChoiceError('The local session service could not start.')
    const ready = await kapReady(child.child)
    if (!ready) throw kimiToolChoiceError('The local session service did not confirm a private loopback endpoint.')
    const { origin, token } = ready
    const call = async (path: string, body?: object): Promise<unknown> => {
      const response = await fetch(origin + '/api/v1/' + path, {
        method: body ? 'POST' : 'GET', signal, redirect: 'error',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const reply = await response.json() as { code?: number; data?: unknown }
      if (!response.ok || reply.code !== 0) {
        const code = typeof reply.code === 'number' ? String(reply.code) : 'unknown'
        const operation = body ? 'session creation' : 'tool verification'
        throw kimiToolChoiceError(`The native session service refused ${operation} (HTTP ${response.status}, native code ${code}).`)
      }
      return reply.data
    }
    const cwd = spawnOpts.cwd ?? process.cwd()
    const native = await call('sessions', { cwd, environment_id: 'local', environment_cwd: cwd,
      agent_config: { profile: profile.name, ...(model ? { model } : {}) },
    }) as { id?: string } | null
    if (typeof native?.id !== 'string' || !native.id) throw kimiToolChoiceError('The native binding returned no session id.')
    const catalog = await call('tools?session_id=' + encodeURIComponent(native.id)) as { tools?: { active?: boolean }[] } | null
    if (!Array.isArray(catalog?.tools) || !catalog.tools.length || catalog.tools.some(tool => tool?.active !== false)) {
      throw kimiToolChoiceError('The native session did not confirm that every registered tool was disabled.')
    }
    return native.id
  } finally {
    signal.removeEventListener('abort', onAbort)
    try {
      if (child) {
        try { await terminateSpawned(child) } finally { child.release() }
      }
    } finally { profile.root.cleanup() }
  }
}
