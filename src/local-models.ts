import { loadConfig, localHarnesses, type Config } from './config.js'
import { BackendRegistry } from './backends/registry.js'
import { createLocalBackend } from './backends/local.js'
import { CodexBackend } from './backends/codex.js'
import { hostSpawner } from './executors/host.js'
import { createNativeCatalog } from './native-catalog.js'
import { collectModels } from './routes/models.js'
import type { ModelEntry } from './model-entry.js'

export interface LocalModelOptions {
  config?: Config
  cwd?: string
  signal?: AbortSignal
}

/** Read host-native models and authentication without a listener, execution state or inference. */
export async function listLocalModels({ config = loadConfig(), cwd = process.cwd(), signal }: LocalModelOptions = {}): Promise<ModelEntry[]> {
  signal?.throwIfAborted()
  const registry = new BackendRegistry()
  for (const [name] of localHarnesses) if (config.backends.has(name))
    registry.register(createLocalBackend(config, name, { spawner: hostSpawner }))
  const codex = registry.byName('codex')
  return collectModels({ registry, cwd, opencodeBin: config.opencodeBin, piBin: config.piBin,
    describe: createNativeCatalog(config, codex instanceof CodexBackend ? codex.readCatalog : undefined, cwd).describe }, signal)
}
