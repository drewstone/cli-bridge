import { localHarnesses, type Config } from '../config.js'
import type { Spawner } from '../executors/types.js'
import { ClaudeBackend } from './claude.js'
import { CodexBackend } from './codex.js'
import { OpencodeBackend } from './opencode.js'
import { KimiBackend } from './kimi.js'
import { GeminiBackend } from './gemini.js'
import { PiBackend } from './pi.js'

const backends = { claude: ClaudeBackend, codex: CodexBackend, opencode: OpencodeBackend,
  kimi: KimiBackend, gemini: GeminiBackend, pi: PiBackend }

/** Construct native adapters without provisioning an executor or opening state. */
export function createLocalBackend(config: Config, name: typeof localHarnesses[number][0],
  options: { spawner?: Spawner; stateDir?: string; jailEnv?: NodeJS.ProcessEnv } = {}) {
  const [, harness] = localHarnesses.find(([key]) => key === name)!
  const Backend = backends[name]
  return new Backend({ bin: config[`${name}Bin`], harness, timeoutMs: config[`${name}TimeoutMs`], ...options })
}
