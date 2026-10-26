import type { LocalSeat } from './local-seats.js';
/** Configured route facts, never the model identity served by a turn. */
export interface ModelEntry {
    id: string;
    object: 'model';
    backend: string;
    provider: string | null;
    authentication: Pick<LocalSeat, 'status' | 'authMode' | 'source' | 'fix'>;
    note?: string;
    default?: true;
    recommended?: true;
}
