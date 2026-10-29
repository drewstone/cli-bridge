/**
 * Config — env-driven, validated at startup.
 *
 * One principle: the server refuses to start in an unsafe configuration.
 * Specifically, a non-loopback bind without a bearer check is a hard fail,
 * not a warning — an accidental open proxy to your personal subscription
 * keys is the failure mode we refuse to allow.
 */
export declare const maxCodexSubscriptionTurnMs: number;
/** Native harness identities only; model selection and seat syntax belong to agent-interface. */
export declare const localHarnesses: readonly [readonly ['claude', 'claude-code', 'claude auth login', readonly ['auth', 'status', '--json'], 'anthropic'], readonly ['codex', 'codex', 'codex login', readonly ['login', 'status'], 'openai'], readonly ['opencode', 'opencode', 'opencode auth login', readonly ['auth', 'list', '--pure'], null], readonly ['kimi', 'kimi-code', 'kimi login', readonly ['--version'], null], readonly ['gemini', 'gemini', 'gemini', readonly ['--version'], 'google'], readonly ['cursor', 'cursor', 'cursor-agent login', readonly ['status', '--format', 'json'], 'cursor'], readonly ['pi', 'pi', 'pi', readonly ['auth', 'check', '--provider', 'openai-codex', '--json', '--no-refresh'], null]];
type NativeHarnessConfig = {
    [Key in typeof localHarnesses[number][0] as `${Key}Bin`]: string;
} & {
    [Key in typeof localHarnesses[number][0] as `${Key}TimeoutMs`]: number;
};
export interface Config extends NativeHarnessConfig {
    host: string;
    port: number;
    bearer: string | null;
    dataDir: string;
    /** Opt-in worker isolation for durable streamed writes; FULL WAL semantics stay unchanged. */
    asyncDurableWrites: boolean;
    backends: Set<string>;
    /** Dedicated subscription consumers refuse API and unverified native routes. */
    subscriptionsOnly: boolean;
    factoryBin: string;
    ampBin: string;
    forgeBin: string;
    /** ACP-protocol agents driven via `<bin> acp` (AcpBackend). */
    hermesBin: string;
    openclawBin: string;
    /** NanoClaw daemon CLI-channel Unix socket (NanoclawBackend connects as a client). */
    nanoclawSocket: string;
    primeBin: string;
    primeTimeoutMs: number;
    /** Operator models.json materialized into every isolated prime agent dir. Null = none configured. */
    primeModelsJson: string | null;
    /**
     * Operator-owned prime agent dir shared across runs — the explicit opt-in to
     * prime-agent's persistent self-modification state (harness_state.json rides
     * every future system prompt). Null = every run gets a fresh agent dir.
     */
    primePersistentAgentDir: string | null;
    cliTimeoutMsDefault: number;
    admission: {
        maxActive: number;
        maxQueue: number;
        queueTimeoutMs: number;
        reservedActive: number;
        bulkQueueTimeoutMs: number;
    };
    /**
     * `x-tangle-client` prefixes admitted through the reserved lane. Matched on
     * the segment before `/`, so `pr-reviewer` covers `pr-reviewer/1`.
     */
    admissionReservedClients: string[];
    /**
     * When set, the `claudish` harness is registered and Claude Code is
     * spawned with ANTHROPIC_BASE_URL=<this> for `claudish/*` model ids.
     */
    claudishUrl: string | null;
    openaiApiKey: string | null;
    anthropicApiKey: string | null;
    moonshotApiKey: string | null;
    zaiApiKey: string | null;
    /** Tangle sandbox-api base URL (e.g. https://sandbox.tangle.tools). When set + key present, the `sandbox` backend registers. */
    sandboxApiUrl: string | null;
    /** Bearer for sandbox-api. Required for the sandbox backend. */
    sandboxApiKey: string | null;
    /** Filesystem dir holding cataloged AgentProfile JSON files (one per profile, filename is the id). */
    sandboxProfilesDir: string;
    /** Operator timeout fallback sent to sandbox-api when the caller omits one. Zero means none. */
    sandboxTimeoutMs: number;
    /**
     * Default jail mode for host-executed CLIs, from `BRIDGE_JAIL_MODE`
     * (off|write-jail|fs-jail, default off; `WORKER_FS_JAIL=1` is a shorthand
     * for fs-jail). A per-request `execution.jail.mode` may raise (never lower)
     * this floor. In `write-jail` the host filesystem is read-only and the CLI's
     * writes are confined to the jail root; `fs-jail` additionally confines
     * READS to a minimal system+toolchain allowlist so the CLI cannot read the
     * host repo or sibling run scratch dirs (bwrap Linux only; write-jail on
     * macOS via sandbox-exec; no-op elsewhere).
     */
    jailMode: 'off' | 'write-jail' | 'fs-jail';
    /** Explicit policy when the configured OS jail is unavailable. */
    jailFallback: 'deny' | 'warn';
    /**
     * Default writable jail root from `BRIDGE_JAIL_ROOT`. Relative paths
     * resolve under the request cwd; absolute paths must stay inside it.
     * Null falls back to `<cwd>/.agent-home`. A per-request
     * `execution.jail.root` overrides this.
     */
    jailRoot: string | null;
    /** Operator extra read-only binds for fs-jailed workers (`BRIDGE_JAIL_RO_PATHS`), validated at boot. */
    jailReadablePaths: string[];
    /** Operator extra writable binds for jailed workers (`BRIDGE_JAIL_RW_PATHS`), validated at boot. */
    jailWritablePaths: string[];
    /** OTLP span emission for chat requests. See {@link TraceConfig}. */
    trace: TraceConfig;
}
/**
 * Trace emission settings.
 *
 * On by default: the bridge is the only place every harness passes through, so a
 * bridge that has to be switched on to be observable is a bridge nobody has
 * traces for when they need them. The cost is bounded by `maxBytes * maxFiles`
 * on disk — 32 MiB unless configured — and one append per request.
 */
export interface TraceConfig {
    /** `BRIDGE_TRACE=off` disables emission entirely (the sink becomes a no-op). */
    enabled: boolean;
    /** Active JSONL file. Rotated generations get `.1`, `.2`, … */
    file: string;
    /** Rotate once the active file would exceed this. */
    maxBytes: number;
    /** Generations retained, including the active file. */
    maxFiles: number;
    /** Cap on TOOL spans per request; the observed count is still reported in full. */
    maxToolSpans: number;
}
export declare function assertListenerConfig({ host, port, bearer }: Pick<Config, 'host' | 'port' | 'bearer'>, ephemeral?: boolean): void;
export declare function loadConfig(env?: NodeJS.ProcessEnv): Config;
export {};

export declare function anyBackendSpawnsOnHost(backends: Iterable<string>): boolean;
