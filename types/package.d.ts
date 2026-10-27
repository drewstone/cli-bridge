import type { BridgeServer, StartServerOptions } from './server-options.js';
export { loadConfig } from './config.js';
export type { BridgeServer, StartServerOptions } from './server-options.js';
export { detectLocalSeats, type LocalSeat, type LocalSeatOptions } from './local-seats.js';
export { listLocalModels, type LocalModelOptions } from './local-models.js';
export type { ModelEntry } from './model-entry.js';
export declare function startServer(options?: StartServerOptions): Promise<BridgeServer>;
