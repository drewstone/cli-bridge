import { localHarnesses, type Config } from './config.js';
export interface LocalSeat {
    harness: typeof localHarnesses[number][1];
    provider: string | null;
    /** Native configured default, never a served model identity. */
    defaultModel?: string;
    status: 'authenticated' | 'configured' | 'signed_out' | 'missing' | 'unknown';
    /** `free`: the harness's own catalog prices this exact model at zero and it needs no credential. */
    authMode: 'subscription' | 'free' | 'api_key' | 'unknown';
    /** `plan_key`: the stored key belongs to a flat-rate plan in the Bridge's plan-keyed provider table; `authMode` is `subscription`. */
    credential?: 'plan_key';
    source: 'native_status' | 'native_store' | 'native_catalog';
    fix?: string;
}
export interface LocalSeatOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    model?: string;
    flags?: readonly string[];
    /** Resolve this native provider only; omitted retains aggregate harness inventory. */
    provider?: string;
    harnesses?: readonly LocalSeat['harness'][];
    config?: Config;
    timeoutMs?: number;
    signal?: AbortSignal;
}
/** Query local login state without an inference, refresh, or credential in the returned value. */
export declare function detectLocalSeats(options?: LocalSeatOptions): Promise<LocalSeat[]>;
/** Read Gemini's selected native auth mode without retrieving a key from its keychain. */
export declare function geminiLoginState(home: string, env: NodeJS.ProcessEnv): Promise<Pick<LocalSeat, 'status' | 'authMode'>>;
