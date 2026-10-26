import type { BridgeServer, StartServerOptions } from './server-options.js';
export { loadConfig } from './config.js';
export type { BridgeServer, StartServerOptions } from './server-options.js';
export declare function startServer(options?: StartServerOptions): Promise<BridgeServer>;
