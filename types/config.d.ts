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
     * Per-backend executor configuration. Every subprocess backend
     * (claude, kimi, codex, opencode, gemini, …) reads its own slot from this
     * map at startup. `host` (default) spawns the CLI on the host;
     * `docker` provisions a pool of pre-warmed containers and dispatches
     * each chat() via `docker exec`.
     *
     * Env keys per backend `<NAME>` (uppercased, e.g. CLAUDE, KIMI):
     *   `<NAME>_EXECUTOR=host|docker`
     *   `<NAME>_DOCKER_IMAGE=<image-tag>`
     *   `<NAME>_DOCKER_POOL_SIZE=<n>`
     *   `<NAME>_DOCKER_OAUTH_MOUNT=share|per-slot`
     *   `<NAME>_DOCKER_NAME_PREFIX=<prefix>`
     *   `<NAME>_DOCKER_HOST_CONFIG_DIR=<host path>`  (share mode only)
     *   `<NAME>_DOCKER_CONTAINER_CONFIG_DIR=<container path>`  (mount target)
     *   `<NAME>_DOCKER_WORKSPACE_ROOT=<absolute host path>`  (read-write, same container path)
     *   `<NAME>_DOCKER_NETWORK=<existing Docker network name>`
     *   `<NAME>_DOCKER_USER=<positive uid>:<positive gid>`  (non-root container identity)
     *   `<NAME>_DOCKER_HOME=<absolute container path>`  (required with Docker user)
     *
     * `BRIDGE_DEFAULT_EXECUTOR` sets the fallback for backends that don't
     * override individually. Default: host.
     */
    executors: Record<string, BackendExecutorConfig>;
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
    /**
     * Default net-jail mode, from `BRIDGE_NET_JAIL_MODE` (off|net-jail, default
     * off; `WORKER_NET_JAIL=1` is a shorthand for net-jail). Sibling of
     * {@link Config.jailMode}: fs-jail confines what a worker can READ, net-jail
     * confines where it can CONNECT. In `net-jail` every worker container runs on
     * an internal Docker network with no route off it, and reaches only an
     * allowlist that always contains its own model endpoint.
     *
     * Docker-only, by construction. A CLI spawned on the host shares the host's
     * network namespace and there is no unprivileged way to give it a partial
     * egress policy, so this setting REFUSES to load alongside a host-executed
     * backend rather than reporting a policy it cannot apply.
     */
    netJailMode: 'off' | 'net-jail';
    /**
     * Extra `host` or `host:port` tokens added to every net-jail allowlist, from
     * `BRIDGE_NET_JAIL_ALLOW`. The model endpoint is derived automatically and
     * does not belong here; this is for the rest (a package registry, an internal
     * service) that a specific workload legitimately needs.
     */
    netJailAllow: string[];
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
export interface BackendExecutorConfig {
    /** Backend name, lowercase: 'claude', 'kimi', 'codex', 'opencode', … */
    name: string;
    kind: 'host' | 'docker';
    /** Docker-only fields. Empty/undefined when kind === 'host'. */
    image?: string;
    poolSize?: number;
    oauthMode?: 'share' | 'per-slot';
    namePrefix?: string;
    /** Host path that gets bind-mounted (share mode). */
    hostConfigDir?: string;
    /** Mount target inside the container, e.g. /root/.claude or /root/.config/opencode. */
    containerConfigDir?: string;
    /** Optional numeric non-root identity used by the pool container and every docker exec. */
    containerUser?: string;
    /** Writable HOME exposed to the configured container identity. */
    containerHome?: string;
    /**
     * Additional credential/state directories this CLI reads, mounted at the same
     * HOME-relative path. opencode is the measured case: config lives in
     * ~/.config/opencode but auth.json lives in ~/.local/share/opencode, so
     * mounting only the config dir gives the container a pool with NO credentials
     * in it — the CLI starts, authenticates against nothing, and the caller reads
     * the empty completion as a model problem.
     */
    extraMounts?: Array<{
        host: string;
        container: string;
    }>;
    /**
     * Path, relative to the container HOME, of the file whose presence proves the
     * CLI can authenticate. Checked by the startup preflight against the mount it
     * belongs to.
     */
    credentialFile?: string;
    /**
     * Canonical host directory exposed read-write to Docker workers at the
     * identical absolute path. Requests with a cwd outside this root fail.
     * Always set for a docker executor: without a mounted directory a request
     * that names no cwd has nowhere to run, and the bridge used to answer it by
     * refusing the request for the bridge's OWN working directory.
     */
    workspaceRoot?: string;
    /** Existing Docker network joined by every pool container. */
    network?: string;
}
/**
 * Whether any ENABLED backend will spawn a CLI on the host (and therefore be
 * subject to the write-jail). True unless every enabled backend is remote/proxy
 * or pinned to a docker executor. Errs toward true: an unrecognized backend is
 * assumed to host-spawn, so the startup jail check fails closed rather than
 * booting "healthy" and failing every request at runtime. Covers backends that
 * are NOT in `executors` (e.g. ACP hermes/openclaw, factory, amp, forge), which
 * default to host spawn.
 */
export declare function anyBackendSpawnsOnHost(backends: Iterable<string>, executors: Record<string, BackendExecutorConfig>): boolean;
/** Shared listener safety for environment and embedded callers; only embedding permits port 0. */
export declare function assertListenerConfig({ host, port, bearer }: Pick<Config, 'host' | 'port' | 'bearer'>, ephemeral?: boolean): void;
export declare function loadConfig(env?: NodeJS.ProcessEnv): Config;
export {};
