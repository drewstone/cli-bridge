import { type Config } from './config.js';
import type { ModelEntry } from './model-entry.js';
export interface LocalModelOptions {
    config?: Config;
    cwd?: string;
    signal?: AbortSignal;
}
/** Read host-native models and authentication without a listener, execution state or inference. */
export declare function listLocalModels({ config, cwd, signal }?: LocalModelOptions): Promise<ModelEntry[]>;
