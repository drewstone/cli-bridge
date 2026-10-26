import { localHarnesses, type Config } from './config.js';
export interface LocalSeat {
    harness: typeof localHarnesses[number][1];
    status: 'authenticated' | 'configured' | 'signed_out' | 'missing' | 'unknown';
    authMode: 'subscription' | 'api_key' | 'unknown';
    source: 'native_status' | 'native_store';
    fix?: string;
}
export interface LocalSeatOptions {
    config?: Config;
    timeoutMs?: number;
    signal?: AbortSignal;
}
/** Query local login state without an inference, refresh, or credential in the returned value. */
export declare function detectLocalSeats(options?: LocalSeatOptions): Promise<LocalSeat[]>;
