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
export declare const localHarnesses: readonly [readonly ['claude', 'claude-code', 'claude auth login', readonly ['auth', 'status', '--json'], 'anthropic'], readonly ['codex', 'codex', 'codex login', readonly ['login', 'status'], 'openai'], readonly ['opencode', 'opencode', 'opencode auth login', readonly ['auth', 'list', '--pure'], null], readonly ['kimi', 'kimi-code', 'kimi login', readonly ['--version'], 'moonshot'], readonly ['gemini', 'gemini', 'gemini', readonly ['--version'], 'google'], readonly ['cursor', 'cursor', 'cursor-agent login', readonly ['status', '--format', 'json'], 'cursor'], readonly ['pi', 'pi', 'pi', readonly ['auth', 'check', '--provider', 'openai-codex', '--json', '--no-refresh'], null]];
/**
 * Agents driven over ACP (AcpBackend): backend name (the model id and the `<NAME>_BIN` variable), harness
 * id, default binary. How each one starts and steers is in backends/acp-agents.ts.
 */
export declare const acpHarnesses: readonly [readonly ['hermes', 'hermes', 'hermes'], readonly ['copilot', 'github-copilot', 'copilot'], readonly ['qwen', 'qwen-code', 'qwen'], readonly ['grok', 'grok', 'grok'], readonly ['dsh', 'deepseek-harness', 'dsh']];
export type AcpHarnessName = typeof acpHarnesses[number][0];
/**
 * Agents run one process per turn (OneShotBackend): backend key (the `<KEY>_BIN` variable), harness id,
 * default binary. How each one starts and is read is in backends/one-shot-agents.ts.
 */
export declare const oneShotHarnesses: readonly [readonly ['nanocode', 'nanocode', 'nc']];
export type OneShotHarnessName = typeof oneShotHarnesses[number][0];
/**
 * Local drivers registered by the server. This is routing metadata, not proof
 * of installation, authentication, model availability or profile capabilities.
 * Consumers must still use the selected driver's admission contract.
 */
export declare const localBackends: readonly [...({
    name: "claude" | "codex" | "cursor" | "gemini" | "kimi" | "opencode" | "pi";
    harness: "claude-code" | "codex" | "cursor" | "gemini" | "kimi-code" | "opencode" | "pi";
    kind: 'native';
} | {
    name: "copilot" | "dsh" | "grok" | "hermes" | "qwen";
    harness: "deepseek-harness" | "github-copilot" | "grok" | "hermes" | "qwen-code";
    kind: 'acp';
} | {
    name: "nanocode";
    harness: "nanocode";
    kind: 'one-shot';
})[], {
    readonly name: 'droid';
    readonly harness: 'factory-droids';
    readonly kind: 'droid';
}, {
    readonly name: 'exo';
    readonly harness: 'exo';
    readonly kind: 'exo';
}, {
    readonly name: 'openclaw';
    readonly harness: 'openclaw';
    readonly kind: 'openclaw';
}, {
    readonly name: 'prime';
    readonly harness: 'prime';
    readonly kind: 'prime';
}];
type NativeHarnessConfig = {
    [Key in typeof localHarnesses[number][0] as `${Key}Bin`]: string;
} & {
    [Key in typeof localHarnesses[number][0] as `${Key}TimeoutMs`]: number;
};
type AcpHarnessConfig = {
    [Key in AcpHarnessName | OneShotHarnessName as `${Key}Bin`]: string;
};
/** Operator assertion only; never accepted from a request or exposed as a capability key. */
export declare const JAIL_HOST_EGRESS_ENV = "BRIDGE_JAIL_HOST_EGRESS_ENFORCED";
export declare const JAIL_OUTER_PROXY_ENV = "BRIDGE_JAIL_OUTER_PROXY_ENFORCED";
export declare function hostEnforcesJailEgress(env: NodeJS.ProcessEnv): boolean;
export declare function outerProxyEnforcesJailEgress(env: NodeJS.ProcessEnv): boolean;
/** Linux backend selection is operator-owned; bubblewrap remains the default. */
export declare const JAIL_BACKEND_ENV = "BRIDGE_JAIL_BACKEND";
export type LinuxJailBackend = 'bwrap' | 'landlock';
/** Public operator network policy; execution code re-exports this single definition. */
export type JailNetwork = 'none' | 'router' | 'relay';
export declare function configuredJailBackend(env?: NodeJS.ProcessEnv): LinuxJailBackend;
export interface Config extends NativeHarnessConfig, AcpHarnessConfig {
    host: string;
    port: number;
    bearer: string | null;
    dataDir: string;
    /** Trusted server-owned capture root; null disables native/process capture. */
    rawCaptureDir?: string | null;
    /** Opt-in worker isolation for durable streamed writes; FULL WAL semantics stay unchanged. */
    asyncDurableWrites: boolean;
    backends: Set<string>;
    /** Dedicated subscription consumers refuse API and unverified native routes. */
    subscriptionsOnly: boolean;
    /** Factory Droid, driven on its streamed JSON-RPC mode (DroidBackend). */
    droidBin: string;
    /** Exo, driven on its HTTP service (ExoBackend). */
    exoBin: string;
    /** openclaw, driven via `openclaw agent --local` (OpenclawBackend). */
    openclawBin: string;
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
    /** Tangle sandbox-api base URL (e.g. https://sandbox.tangle.tools). When set + key present, the `sandbox` backend registers. */
    sandboxApiUrl: string | null;
    /** Bearer for sandbox-api. Required for the sandbox backend. */
    sandboxApiKey: string | null;
    /** Filesystem dir holding cataloged AgentProfile JSON files (one per profile, filename is the id). */
    sandboxProfilesDir: string;
    /** Operator timeout fallback sent to sandbox-api when the caller omits one. Zero means none. */
    sandboxTimeoutMs: number;
    /** `BRIDGE_JAIL_MODE`. A request may raise this floor, never lower it. */
    jailMode: 'off' | 'write-jail' | 'fs-jail';
    /** Explicit policy when the configured OS jail is unavailable. */
    jailFallback: 'deny' | 'warn';
    /** Trusted assertion that host policy supplies the Landlock transport’s missing egress isolation. */
    jailHostEgressEnforced?: boolean;
    /** Trusted assertion that the host `HTTPS_PROXY` refuses private destinations for Landlock relays. */
    jailOuterProxyEnforced?: boolean;
    /** Captured operator Linux backend; never accepted from request JSON. */
    jailBackend?: LinuxJailBackend;
    /** `BRIDGE_JAIL_NETWORK`: default and ceiling for a spawn's egress (none < router < relay). Unset: default none, ceiling router. */
    jailNetwork?: JailNetwork;
    /** `BRIDGE_IRON_PROXY_BIN`: agent-container's pinned iron-proxy, for `relay` spawns with proxySecrets. */
    ironProxyBin?: string;
    /** `BRIDGE_PROXY_SECRET_COMMAND`: mints and revokes a proxySecrets credential per spawn (see jail/egress.ts). */
    proxySecretCommand?: string;
    /** Hostnames from `BRIDGE_JAIL_RELAY_ALLOW`, spliced on relay only. Empty omits the field. */
    jailRelayAllow?: string[];
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
    /**
     * The change ledger Bridge writes for each turn (`src/change-ledger/recorder.ts`): the directory holding
     * `changes.jsonl`. `BRIDGE_CHANGE_LEDGER=off` omits it; `CHANGE_LEDGER_DIR` names the directory, as it does for the hooks.
     */
    changeLedger?: {
        dir: string;
    };
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
/** Shared listener safety for environment and embedded callers; only embedding permits port 0. */
export declare function assertListenerConfig({ host, port, bearer }: Pick<Config, 'host' | 'port' | 'bearer'>, ephemeral?: boolean): void;
export declare function anyBackendSpawnsOnHost(backends: Iterable<string>): boolean;
export declare function loadConfig(env?: NodeJS.ProcessEnv): Config;
export {};
