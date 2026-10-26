import type { Config } from './config.js';
export interface StartServerOptions {
    /** Omit to use environment configuration. Port 0 selects an ephemeral listener. */
    config?: Config;
    cwd?: string;
    /** Embedded callers retain ownership of signals and process-wide error handlers. */
    handleSignals?: boolean;
    quiet?: boolean;
}
export interface BridgeServer {
    url: string;
    /** Stop only this listener and its owned work, then release its durable writer lock. */
    close(): Promise<void>;
}
