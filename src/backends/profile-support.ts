import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProfile, AgentProfileMcpServer } from '@tangle-network/agent-interface'
import type { ChatMessage, ChatRequest, McpServerSpec } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import { applyWorkspacePlan, type HarnessId, materializeProfile } from '@tangle-network/agent-profile-materialize'

/**
 * Provision an AgentProfile's CWD-NATIVE dimensions (skills, context, hooks, subagents,
 * commands) into the run workspace before the harness spawns — the shared Phase-2 host
 * wiring. MCP is SKIPPED here so cli-bridge's existing per-harness MCP path (config-dir +
 * env) stays the source of truth (additive, can't regress MCP). Purely writes files into
 * `cwd`; returns env/flags (empty for the non-MCP dimensions, which are all cwd-native)
 * for the caller to apply if present. No-op when there's no profile or nothing to mount.
 */
export function provisionProfileWorkspace(
  req: ChatRequest,
  session: SessionRecord | null,
  harness: HarnessId,
  cwd: string,
): { env: Record<string, string>; flags: string[]; written: string[] } {
  try {
    const profile = resolveAgentProfile(req, session)
    if (!profile) return { env: {}, flags: [], written: [] }
    const plan = materializeProfile(profile, harness, { skip: ['mcp'] })
    if (!plan.files.length && !plan.flags.length) return { env: {}, flags: [], written: [] }
    const applied = applyWorkspacePlan(plan, cwd)
    return { env: applied.env, flags: applied.flags, written: applied.written }
  } catch {
    // FAIL-SAFE: a profile-materialization error must never break a live request.
    // Worst case the run is un-provisioned (same as today), never crashed.
    return { env: {}, flags: [], written: [] }
  }
}

export function resolveAgentProfile(req: ChatRequest, session: SessionRecord | null): AgentProfile | null {
  if (req.agent_profile && typeof req.agent_profile === 'object') return req.agent_profile
  const stored = session?.metadata?.agent_profile
  return stored && typeof stored === 'object' ? stored as AgentProfile : null
}

/**
 * Merge request-body `mcp.mcpServers` and `agent_profile.mcp` into a
 * single normalized map keyed by server name. Request-body wins on
 * name collisions — caller's per-turn intent overrides profile
 * defaults.
 *
 * Returns `null` when neither source supplies any entries. Callers
 * that need a non-null result (e.g. opencode, which always writes a
 * config file) should default to `{}` after this returns null.
 *
 * The returned spec is the canonical `McpServerSpec` shape; backends
 * pick the fields they support and ignore the rest.
 */
export function resolveMcpServers(
  req: ChatRequest,
  session: SessionRecord | null,
): Record<string, McpServerSpec> | null {
  const merged: Record<string, McpServerSpec> = {}

  const profile = resolveAgentProfile(req, session)
  if (profile && typeof profile === 'object') {
    const profileMcp = (profile as { mcp?: Record<string, AgentProfileMcpServer> }).mcp
    if (profileMcp && typeof profileMcp === 'object') {
      for (const [name, raw] of Object.entries(profileMcp)) {
        if (!name || !raw || typeof raw !== 'object') continue
        merged[name] = profileMcpToSpec(raw)
      }
    }
  }

  const requestMcp = req.mcp?.mcpServers
  if (requestMcp && typeof requestMcp === 'object') {
    for (const [name, raw] of Object.entries(requestMcp)) {
      if (!name || !raw || typeof raw !== 'object') continue
      merged[name] = normalizeMcpServerSpec(raw)
    }
  }

  return Object.keys(merged).length > 0 ? merged : null
}

function profileMcpToSpec(raw: AgentProfileMcpServer): McpServerSpec {
  // AgentProfileMcpServer uses `transport`; McpServerSpec uses `type`.
  // Rename and forward only the fields we model.
  const out: McpServerSpec = {}
  if (raw.transport) out.type = raw.transport
  if (typeof raw.command === 'string') out.command = raw.command
  if (Array.isArray(raw.args)) out.args = raw.args.filter((a): a is string => typeof a === 'string')
  if (raw.env && typeof raw.env === 'object') {
    out.env = Object.fromEntries(
      Object.entries(raw.env).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>
  }
  if (typeof raw.url === 'string') out.url = raw.url
  if (raw.headers && typeof raw.headers === 'object') {
    out.headers = Object.fromEntries(
      Object.entries(raw.headers).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>
  }
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  const timeoutRaw = (raw as { timeout?: unknown }).timeout
  if (typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw > 0) {
    out.timeout = timeoutRaw
  }
  return out
}

function normalizeMcpServerSpec(raw: McpServerSpec | Record<string, unknown>): McpServerSpec {
  // Defensive copy — drop any unknown fields, coerce types loosely.
  const r = raw as Record<string, unknown>
  const out: McpServerSpec = {}
  if (r.type === 'stdio' || r.type === 'http' || r.type === 'sse') out.type = r.type
  if (typeof r.command === 'string') out.command = r.command
  if (Array.isArray(r.args)) out.args = (r.args as unknown[]).filter((a): a is string => typeof a === 'string')
  if (r.env && typeof r.env === 'object') {
    out.env = Object.fromEntries(
      Object.entries(r.env as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>
  }
  if (typeof r.url === 'string') out.url = r.url
  if (r.headers && typeof r.headers === 'object') {
    out.headers = Object.fromEntries(
      Object.entries(r.headers as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>
  }
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  if (typeof r.timeout === 'number' && Number.isFinite(r.timeout) && r.timeout > 0) {
    out.timeout = r.timeout
  }
  return out
}

/**
 * True when this spec describes a local stdio MCP server. cli-bridge's
 * MCP-enabled CLI backends load stdio MCP via their config-file
 * loaders; remote http/sse MCP needs a per-backend registration path
 * that we don't model in the unified materializers.
 */
export function isStdioMcpSpec(spec: McpServerSpec): boolean {
  if (spec.enabled === false) return false
  if (spec.type === 'stdio') return Boolean(spec.command)
  if (spec.type === 'http' || spec.type === 'sse') return false
  return Boolean(spec.command)
}

/**
 * Materialize an `AgentProfile.mcp` map into a temp JSON file in the
 * standard mcp-config.json shape (any CLI taking --mcp-config-file):
 *
 *   { "mcpServers": { name: {command, args, env}, ... } }
 *
 * Returns `null` when the profile has no enabled MCP servers — backends
 * should skip the `--mcp-config` flag in that case rather than passing
 * an empty config.
 *
 * Caller MUST invoke `cleanup()` after the subprocess exits (typically
 * in a `finally` block) so the temp dir doesn't leak.
 *
 * Honours `AgentProfileMcpServer.enabled` — entries explicitly disabled
 * are dropped. Entries without a `command` (e.g., remote http/sse
 * transports) are also dropped here because the local CLIs only support
 * stdio MCP servers via `--mcp-config`. Remote MCP servers would need a
 * separate registration path (claude has `claude mcp add --transport
 * http`) which we don't model in this materializer.
 */
export interface MaterializedMcpConfig {
  configPath: string
  serverNames: string[]
  cleanup(): void
}

export function materializeMcpConfig(profile: AgentProfile | null): MaterializedMcpConfig | null {
  if (!profile || typeof profile !== 'object') return null
  const mcp = (profile as { mcp?: Record<string, AgentProfileMcpServer> }).mcp
  if (!mcp || typeof mcp !== 'object') return null
  const specs: Record<string, McpServerSpec> = {}
  for (const [name, raw] of Object.entries(mcp)) {
    if (!name || !raw || typeof raw !== 'object') continue
    specs[name] = profileMcpToSpec(raw)
  }
  return writeMcpConfigFile(specs)
}

/**
 * Write the canonical claude/kimi `mcp-config.json` shape from a
 * normalized `McpServerSpec` map. Filters out disabled entries.
 *
 * Both stdio and remote (http/sse) transports are emitted: Claude Code's
 * `--mcp-config` JSON natively accepts `{type:'http'|'sse', url, headers}`
 * entries alongside stdio `{command, args, env}` ones (mcp-config.json
 * schema), so a remote MCP server (e.g. an HTTP tool host the caller runs)
 * is forwarded as-is rather than silently dropped. (Earlier this path was
 * stdio-only on the mistaken assumption that claude couldn't load remote
 * servers from the config file — it can.)
 *
 * `timeout` (ms) is the per-MCP-server tool-call timeout. Claude Code
 * honors this in mcp-config.json — its default is 300_000ms which
 * kills long-running tool calls (e.g. coordinators that block while a
 * subagent audit runs). Forward when supplied so callers don't need
 * to set MCP_TIMEOUT globally (which has known-silently-ignored bugs
 * upstream).
 *
 * Returns null when no usable entries remain — backends should skip
 * the `--mcp-config` flag in that case rather than passing an empty
 * config.
 */
/**
 * Build the canonical `mcpServers` object from a normalized spec map:
 * stdio entries as `{command, args, env, timeout}`, remote http/sse
 * entries as `{type, url, headers, timeout}`. Disabled and malformed
 * entries are dropped. Shared by the claude/kimi temp-file materializer
 * and the pi workspace materializer (pi-mcp-adapter reads the same
 * `{mcpServers}` shape from `.mcp.json` / `.pi/mcp.json`).
 */
export function buildCanonicalMcpServers(
  specs: Record<string, McpServerSpec>,
): Record<string, Record<string, unknown>> {
  const mcpServers: Record<string, Record<string, unknown>> = {}
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.enabled === false) continue
    if (isStdioMcpSpec(spec) && spec.command) {
      mcpServers[name] = {
        command: spec.command,
        ...(spec.args && spec.args.length ? { args: spec.args } : {}),
        ...(spec.env && Object.keys(spec.env).length ? { env: spec.env } : {}),
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
      }
    } else if ((spec.type === 'http' || spec.type === 'sse') && spec.url) {
      // Remote MCP server — Claude Code loads these from --mcp-config
      // natively. Forward type/url/headers/timeout verbatim.
      mcpServers[name] = {
        type: spec.type,
        url: spec.url,
        ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}),
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
      }
    }
    // unknown transport / missing required fields → drop silently
  }
  return mcpServers
}

export function writeMcpConfigFile(
  specs: Record<string, McpServerSpec> | null,
): MaterializedMcpConfig | null {
  if (!specs) return null
  const mcpServers = buildCanonicalMcpServers(specs)
  const serverNames = Object.keys(mcpServers)
  if (process.env.CLI_BRIDGE_DEBUG_MCP) {
    console.error(`[cli-bridge mcp] materialized servers: ${serverNames.length ? serverNames.join(", ") : "(none)"} from specs: ${Object.keys(specs).join(", ") || "(empty)"}`)
  }
  if (serverNames.length === 0) return null

  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-mcp-'))
  const configPath = join(dir, 'mcp-config.json')
  writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2))
  return {
    configPath,
    serverNames,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    },
  }
}

/**
 * Materialize MCP servers for the pi backend by writing the canonical
 * `{mcpServers}` JSON to `<cwd>/.pi/mcp.json` — pi's project-level MCP
 * override file, read by the `pi-mcp-adapter` extension (pi's CLI has
 * no `--mcp-config` flag; the adapter's config discovery is the only
 * per-invocation MCP path).
 *
 * The file lives in the run workspace, not a temp dir, because the
 * adapter discovers config by cwd. If `.pi/mcp.json` already exists
 * (caller-provisioned workspace), the requested servers are merged in
 * (request wins on name collisions) and the LAST active mount's
 * `cleanup()` restores the original bytes; otherwise it removes the
 * file and, when the first mount created it, the `.pi` directory.
 *
 * Concurrency: pi discovers config strictly by cwd, so two overlapping
 * runs in one workspace would either share request-scoped server
 * definitions (leaking one run's tools/secrets into the other) or race
 * on restore. Neither is acceptable — a `.pi/mcp.json.lock` file
 * (O_EXCL, holds `{pid}`) enforces ONE active MCP mount per cwd across
 * processes. A second overlapping mount fails loud with instructions to
 * use distinct cwds; a lock whose pid is dead is stolen (crashed run).
 *
 * Returns null when no usable servers remain. Callers must verify the
 * adapter is installed BEFORE mounting (see `piMcpAdapterAvailable` in
 * backends/pi.ts) — writing config a runner never reads would recreate
 * the silent-drop bug this materializer exists to fix.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = alive but owned by another user — still very much alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Host-side write into a workspace-controlled path. `.pi/mcp.json` lives
 * inside the request's cwd, which a sandboxed agent can mutate — if it
 * swaps the file for a symlink, a plain `writeFileSync` from the HOST
 * process would write through the link to any host path the bridge user
 * can touch. `O_NOFOLLOW` makes open fail (ELOOP) on a symlink instead;
 * callers treat that as fail-closed. (`O_NOFOLLOW` is 0 on Windows —
 * symlink creation there needs elevated rights, and the jail concern is
 * the POSIX sandbox path.)
 */
function writeFileNoFollow(path: string, bytes: string): void {
  const fd = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0),
  )
  try {
    writeFileSync(fd, bytes)
  } finally {
    closeSync(fd)
  }
}

export function materializeMcpServersForPi(
  specs: Record<string, McpServerSpec> | null,
  cwd: string,
): MaterializedMcpConfig | null {
  if (!specs) return null
  const mcpServers = buildCanonicalMcpServers(specs)
  const serverNames = Object.keys(mcpServers)
  if (process.env.CLI_BRIDGE_DEBUG_MCP) {
    console.error(`[cli-bridge mcp pi] materialized servers: ${serverNames.join(', ') || '(none)'} from specs: ${Object.keys(specs).join(', ') || '(empty)'}`)
  }
  if (serverNames.length === 0) return null

  const piDir = join(cwd, '.pi')
  const configPath = join(piDir, 'mcp.json')
  const lockPath = `${configPath}.lock`

  const fail = (detail: string): never => {
    throw new BackendError(
      `backend pi failed to prepare MCP config at ${configPath}: ${detail}`,
      'not_configured',
    )
  }

  let createdDir = false
  try {
    createdDir = !existsSync(piDir)
    mkdirSync(piDir, { recursive: true })
    // `writeFileNoFollow` only guards the FINAL path component; a
    // workspace that pre-created `.pi` as a symlink to a host directory
    // would still redirect every write under it. lstat does not follow —
    // require a real directory, not a link to one.
    if (!lstatSync(piDir).isDirectory()) {
      fail(`${piDir} exists but is not a real directory (symlink or file planted by the workspace)`)
    }
  } catch (err) {
    if (err instanceof BackendError) throw err
    fail(err instanceof Error ? err.message : String(err))
  }

  // Exclusive per-cwd lock (cross-process): `wx` refuses to overwrite.
  // The lock is written ONCE, atomically, with its full metadata — the
  // TRUE pre-mount state (`originalBytes`) — so a crashed run's
  // request-scoped config never outlives it: whoever steals a stale lock
  // rolls the workspace back to that recorded state instead of adopting
  // the dead run's mounted config as "original". There is deliberately
  // no in-place rewrite of a held lock (a truncate/write window would
  // let a concurrent EEXIST reader misparse a LIVE lock as stale); the
  // one post-acquire correction path goes through temp-file + rename,
  // which readers see atomically. An unreadable lock is FAIL-CLOSED
  // (contention error), never stolen.
  const writeLockAtomic = (payload: { pid: number; originalBytes: string | null }): void => {
    const tmpPath = `${lockPath}.${process.pid}.tmp`
    // `wx` refuses a pre-planted symlink at the tmp path; rename replaces
    // the lock atomically without following links.
    rmSync(tmpPath, { force: true })
    writeFileSync(tmpPath, JSON.stringify(payload), { flag: 'wx' })
    renameSync(tmpPath, lockPath)
  }

  // Guarded read of a workspace-controlled path. A plain `readFileSync`
  // would follow symlinks and BLOCK FOREVER on a planted FIFO (host-side
  // DoS before any timeout starts). Open no-follow + non-blocking, fstat
  // the fd (no swap race), reject non-regular files and oversized bytes.
  const MAX_WORKSPACE_READ = 1024 * 1024
  const readWorkspaceFileMaybe = (path: string): string | null => {
    let fd: number
    try {
      fd = openSync(
        path,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
      )
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      return fail(`${path} is not readable as a regular file (${code ?? 'unknown error'})`)
    }
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) fail(`${path} is not a regular file (workspace planted a special file)`)
      if (st.size > MAX_WORKSPACE_READ) fail(`${path} exceeds the ${MAX_WORKSPACE_READ}-byte cap`)
      return readFileSync(fd, 'utf-8')
    } finally {
      closeSync(fd)
    }
  }

  const tryAcquire = (): boolean => {
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, originalBytes: readWorkspaceFileMaybe(configPath) }),
        { flag: 'wx' },
      )
      return true
    } catch (err) {
      if (err instanceof BackendError) throw err
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        fail(err instanceof Error ? err.message : String(err))
      }
      return false
    }
  }

  if (!tryAcquire()) {
    let stale: { pid?: number; originalBytes?: string | null } | null = null
    try {
      stale = JSON.parse(readWorkspaceFileMaybe(lockPath) ?? '') as { pid?: number; originalBytes?: string | null }
    } catch {
      // Unreadable/corrupt lock: FAIL-CLOSED. Stealing here could kill a
      // live mount mid-run; a human (or a dead-pid check on a later
      // retry) resolves genuine corruption.
      throw new BackendError(
        `backend pi cannot mount MCP servers at ${configPath}: lock file ${lockPath} exists but is `
        + `unreadable; if no pi run is active in this cwd, remove it manually`,
        'not_configured',
      )
    }
    const holderPid = stale?.pid ?? null
    if (holderPid === null || pidAlive(holderPid)) {
      throw new BackendError(
        `backend pi cannot mount MCP servers at ${configPath}: another run${holderPid !== null ? ` (pid ${holderPid})` : ''} holds the `
        + `mount for this cwd; pi supports one MCP-mounted run per workspace — use distinct cwds`,
        'not_configured',
      )
    }
    // Stale lock from a dead/crashed run: roll the config back to the
    // dead run's recorded pre-mount state (or remove it when unknown —
    // leaked request-scoped servers must not persist), then steal.
    try {
      if (stale && typeof stale.originalBytes === 'string') {
        writeFileNoFollow(configPath, stale.originalBytes)
      } else {
        // unlink removes a symlink itself, never its target — safe.
        rmSync(configPath, { force: true })
      }
      rmSync(lockPath, { force: true })
      if (!tryAcquire()) {
        fail('lost race stealing stale lock: another run acquired it first')
      }
    } catch (retryErr) {
      if (retryErr instanceof BackendError) throw retryErr
      fail(`lost race stealing stale lock: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`)
    }
  }

  const releaseLock = (): void => {
    try {
      rmSync(lockPath, { force: true })
    } catch {
      // best-effort
    }
  }

  // We hold the lock; re-read the config in case it changed between the
  // pre-acquire snapshot and acquisition, and correct the recorded
  // pre-mount state atomically if so.
  const originalBytes = readWorkspaceFileMaybe(configPath)
  try {
    let recorded: string | null | undefined
    try {
      recorded = (JSON.parse(readWorkspaceFileMaybe(lockPath) ?? '') as { originalBytes?: string | null }).originalBytes
    } catch {
      recorded = undefined
    }
    if (recorded !== originalBytes) {
      writeLockAtomic({ pid: process.pid, originalBytes })
    }
  } catch (err) {
    releaseLock()
    fail(err instanceof Error ? err.message : String(err))
  }
  let merged: Record<string, unknown> = { mcpServers }
  if (originalBytes !== null) {
    try {
      const original = JSON.parse(originalBytes) as Record<string, unknown>
      const originalServers = (original.mcpServers ?? {}) as Record<string, unknown>
      merged = { ...original, mcpServers: { ...originalServers, ...mcpServers } }
    } catch {
      // Unparseable existing file — overwrite for the run; cleanup
      // restores the original bytes verbatim either way.
    }
  }
  try {
    writeFileNoFollow(configPath, JSON.stringify(merged, null, 2))
  } catch (err) {
    releaseLock()
    fail(err instanceof Error ? err.message : String(err))
  }

  let cleaned = false
  return {
    configPath,
    serverNames,
    cleanup: () => {
      if (cleaned) return
      cleaned = true
      try {
        if (originalBytes !== null) {
          // No-follow: the workspace may have swapped the config for a
          // symlink mid-run; never restore THROUGH it from the host.
          writeFileNoFollow(configPath, originalBytes)
        } else {
          rmSync(configPath, { force: true })
        }
      } catch (err) {
        // FAIL-CLOSED: restore failed (e.g. symlink planted mid-run).
        // Keep the lock — its recorded originalBytes let a later mount's
        // stale-lock recovery retry the rollback once this pid exits;
        // releasing it now would let the tampered config masquerade as
        // workspace-original state.
        if (process.env.CLI_BRIDGE_DEBUG_MCP) {
          console.error(`[cli-bridge mcp pi] cleanup restore failed for ${configPath}; keeping lock: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      releaseLock()
      try {
        // Only remove `.pi` when this run created it AND nothing else
        // landed in it meanwhile (rmdirSync refuses non-empty dirs).
        if (originalBytes === null && createdDir) rmdirSync(piDir)
      } catch {
        // best-effort cleanup
      }
    },
  }
}

/**
 * Mount a `{mcpServers}` object into a CWD-NATIVE config file
 * (`<cwd>/<subdir>/<filename>`) that a CLI discovers by working directory
 * rather than a per-invocation flag. Shared by the additive cwd-native MCP
 * backends — gemini (`.gemini/settings.json`) and droid/factory
 * (`.factory/mcp.json`) — because the FS discipline is identical to pi's;
 * only the schema of the `mcpServers` values differs, and the caller has
 * already transformed those.
 *
 * The file lives in the run workspace, not a temp dir, because the CLI
 * discovers config by cwd. When the file already exists (caller-
 * provisioned workspace, or the user's own project settings), the
 * requested servers are merged into its `mcpServers` map (request wins on
 * name collisions) and every other top-level key is preserved; the
 * mount's `cleanup()` restores the original bytes verbatim, otherwise it
 * removes the file and, when this mount created it, the `<subdir>`
 * directory. This is why the user's own `~/.factory/mcp.json` or
 * `~/.gemini/settings.json` is never touched — we only write the
 * project-scoped file the CLI layers on top.
 *
 * Concurrency: the CLI discovers config strictly by cwd, so two
 * overlapping runs in one workspace would either share request-scoped
 * server definitions (leaking one run's tools/secrets into the other) or
 * race on restore. Neither is acceptable — a `<filename>.lock` file
 * (O_EXCL, holds `{pid, originalBytes}`) enforces ONE active MCP mount
 * per cwd across processes. A second overlapping mount fails loud with
 * instructions to use distinct cwds; a lock whose pid is dead is stolen
 * (crashed run) after rolling the workspace back to its recorded
 * pre-mount state.
 *
 * Returns null when `mcpServers` is empty.
 */
function mountCwdNativeMcp(
  cwd: string,
  opts: { subdir: string; filename: string; backendName: string; mcpServers: Record<string, unknown> },
): MaterializedMcpConfig | null {
  const { subdir, filename, backendName, mcpServers } = opts
  const serverNames = Object.keys(mcpServers)
  if (serverNames.length === 0) return null

  const piDir = join(cwd, subdir)
  const configPath = join(piDir, filename)
  const lockPath = `${configPath}.lock`

  const fail = (detail: string): never => {
    throw new BackendError(
      `backend ${backendName} failed to prepare MCP config at ${configPath}: ${detail}`,
      'not_configured',
    )
  }

  let createdDir = false
  try {
    createdDir = !existsSync(piDir)
    mkdirSync(piDir, { recursive: true })
    // `writeFileNoFollow` only guards the FINAL path component; a
    // workspace that pre-created `.pi` as a symlink to a host directory
    // would still redirect every write under it. lstat does not follow —
    // require a real directory, not a link to one.
    if (!lstatSync(piDir).isDirectory()) {
      fail(`${piDir} exists but is not a real directory (symlink or file planted by the workspace)`)
    }
  } catch (err) {
    if (err instanceof BackendError) throw err
    fail(err instanceof Error ? err.message : String(err))
  }

  // Exclusive per-cwd lock (cross-process): `wx` refuses to overwrite.
  // The lock is written ONCE, atomically, with its full metadata — the
  // TRUE pre-mount state (`originalBytes`) — so a crashed run's
  // request-scoped config never outlives it: whoever steals a stale lock
  // rolls the workspace back to that recorded state instead of adopting
  // the dead run's mounted config as "original". There is deliberately
  // no in-place rewrite of a held lock (a truncate/write window would
  // let a concurrent EEXIST reader misparse a LIVE lock as stale); the
  // one post-acquire correction path goes through temp-file + rename,
  // which readers see atomically. An unreadable lock is FAIL-CLOSED
  // (contention error), never stolen.
  const writeLockAtomic = (payload: { pid: number; originalBytes: string | null }): void => {
    const tmpPath = `${lockPath}.${process.pid}.tmp`
    // `wx` refuses a pre-planted symlink at the tmp path; rename replaces
    // the lock atomically without following links.
    rmSync(tmpPath, { force: true })
    writeFileSync(tmpPath, JSON.stringify(payload), { flag: 'wx' })
    renameSync(tmpPath, lockPath)
  }

  // Guarded read of a workspace-controlled path. A plain `readFileSync`
  // would follow symlinks and BLOCK FOREVER on a planted FIFO (host-side
  // DoS before any timeout starts). Open no-follow + non-blocking, fstat
  // the fd (no swap race), reject non-regular files and oversized bytes.
  const MAX_WORKSPACE_READ = 1024 * 1024
  const readWorkspaceFileMaybe = (path: string): string | null => {
    let fd: number
    try {
      fd = openSync(
        path,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
      )
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      return fail(`${path} is not readable as a regular file (${code ?? 'unknown error'})`)
    }
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) fail(`${path} is not a regular file (workspace planted a special file)`)
      if (st.size > MAX_WORKSPACE_READ) fail(`${path} exceeds the ${MAX_WORKSPACE_READ}-byte cap`)
      return readFileSync(fd, 'utf-8')
    } finally {
      closeSync(fd)
    }
  }

  const tryAcquire = (): boolean => {
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, originalBytes: readWorkspaceFileMaybe(configPath) }),
        { flag: 'wx' },
      )
      return true
    } catch (err) {
      if (err instanceof BackendError) throw err
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        fail(err instanceof Error ? err.message : String(err))
      }
      return false
    }
  }

  if (!tryAcquire()) {
    let stale: { pid?: number; originalBytes?: string | null } | null = null
    try {
      stale = JSON.parse(readWorkspaceFileMaybe(lockPath) ?? '') as { pid?: number; originalBytes?: string | null }
    } catch {
      // Unreadable/corrupt lock: FAIL-CLOSED. Stealing here could kill a
      // live mount mid-run; a human (or a dead-pid check on a later
      // retry) resolves genuine corruption.
      throw new BackendError(
        `backend ${backendName} cannot mount MCP servers at ${configPath}: lock file ${lockPath} exists but is `
        + `unreadable; if no ${backendName} run is active in this cwd, remove it manually`,
        'not_configured',
      )
    }
    const holderPid = stale?.pid ?? null
    if (holderPid === null || pidAlive(holderPid)) {
      throw new BackendError(
        `backend ${backendName} cannot mount MCP servers at ${configPath}: another run${holderPid !== null ? ` (pid ${holderPid})` : ''} holds the `
        + `mount for this cwd; ${backendName} supports one MCP-mounted run per workspace — use distinct cwds`,
        'not_configured',
      )
    }
    // Stale lock from a dead/crashed run: roll the config back to the
    // dead run's recorded pre-mount state (or remove it when unknown —
    // leaked request-scoped servers must not persist), then steal.
    try {
      if (stale && typeof stale.originalBytes === 'string') {
        writeFileNoFollow(configPath, stale.originalBytes)
      } else {
        // unlink removes a symlink itself, never its target — safe.
        rmSync(configPath, { force: true })
      }
      rmSync(lockPath, { force: true })
      if (!tryAcquire()) {
        fail('lost race stealing stale lock: another run acquired it first')
      }
    } catch (retryErr) {
      if (retryErr instanceof BackendError) throw retryErr
      fail(`lost race stealing stale lock: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`)
    }
  }

  const releaseLock = (): void => {
    try {
      rmSync(lockPath, { force: true })
    } catch {
      // best-effort
    }
  }

  // We hold the lock; re-read the config in case it changed between the
  // pre-acquire snapshot and acquisition, and correct the recorded
  // pre-mount state atomically if so.
  const originalBytes = readWorkspaceFileMaybe(configPath)
  try {
    let recorded: string | null | undefined
    try {
      recorded = (JSON.parse(readWorkspaceFileMaybe(lockPath) ?? '') as { originalBytes?: string | null }).originalBytes
    } catch {
      recorded = undefined
    }
    if (recorded !== originalBytes) {
      writeLockAtomic({ pid: process.pid, originalBytes })
    }
  } catch (err) {
    releaseLock()
    fail(err instanceof Error ? err.message : String(err))
  }
  let merged: Record<string, unknown> = { mcpServers }
  if (originalBytes !== null) {
    try {
      const original = JSON.parse(originalBytes) as Record<string, unknown>
      const originalServers = (original.mcpServers ?? {}) as Record<string, unknown>
      merged = { ...original, mcpServers: { ...originalServers, ...mcpServers } }
    } catch {
      // Unparseable existing file — overwrite for the run; cleanup
      // restores the original bytes verbatim either way.
    }
  }
  try {
    writeFileNoFollow(configPath, JSON.stringify(merged, null, 2))
  } catch (err) {
    releaseLock()
    fail(err instanceof Error ? err.message : String(err))
  }

  let cleaned = false
  return {
    configPath,
    serverNames,
    cleanup: () => {
      if (cleaned) return
      cleaned = true
      try {
        if (originalBytes !== null) {
          // No-follow: the workspace may have swapped the config for a
          // symlink mid-run; never restore THROUGH it from the host.
          writeFileNoFollow(configPath, originalBytes)
        } else {
          rmSync(configPath, { force: true })
        }
      } catch (err) {
        // FAIL-CLOSED: restore failed (e.g. symlink planted mid-run).
        // Keep the lock — its recorded originalBytes let a later mount's
        // stale-lock recovery retry the rollback once this pid exits;
        // releasing it now would let the tampered config masquerade as
        // workspace-original state.
        if (process.env.CLI_BRIDGE_DEBUG_MCP) {
          console.error(`[cli-bridge mcp ${backendName}] cleanup restore failed for ${configPath}; keeping lock: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      releaseLock()
      try {
        // Only remove `<subdir>` when this run created it AND nothing
        // else landed in it meanwhile (rmdirSync refuses non-empty dirs).
        if (originalBytes === null && createdDir) rmdirSync(piDir)
      } catch {
        // best-effort cleanup
      }
    },
  }
}

/**
 * Build the Gemini CLI `mcpServers` object from a normalized spec map.
 * Gemini's settings.json uses a DIFFERENT remote key than the canonical
 * shape: HTTP endpoints go under `httpUrl` (not `url`), SSE endpoints
 * under `url`; both take a `headers` object. `trust: true` is set so the
 * CLI does not block a headless run on a per-tool confirmation prompt.
 * stdio servers use `{command, args, env}`. Disabled/malformed entries
 * are dropped.
 */
function buildGeminiMcpServers(specs: Record<string, McpServerSpec>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.enabled === false) continue
    if (isStdioMcpSpec(spec) && spec.command) {
      out[name] = {
        command: spec.command,
        ...(spec.args && spec.args.length ? { args: spec.args } : {}),
        ...(spec.env && Object.keys(spec.env).length ? { env: spec.env } : {}),
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
        trust: true,
      }
    } else if (spec.type === 'http' && spec.url) {
      out[name] = {
        httpUrl: spec.url,
        ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}),
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
        trust: true,
      }
    } else if (spec.type === 'sse' && spec.url) {
      out[name] = {
        url: spec.url,
        ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}),
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
        trust: true,
      }
    }
  }
  return out
}

/**
 * Materialize MCP servers for the gemini backend by merging them into the
 * project-scope `<cwd>/.gemini/settings.json`, which Gemini CLI layers on
 * top of the user's global `~/.gemini/settings.json`. cwd-native (no
 * per-invocation MCP flag), so it shares pi's lock + no-follow discipline
 * via `mountCwdNativeMcp`; every non-`mcpServers` settings key already in
 * the file is preserved. Returns null when no usable servers remain.
 */
export function materializeMcpServersForGemini(
  specs: Record<string, McpServerSpec> | null,
  cwd: string,
): MaterializedMcpConfig | null {
  if (!specs) return null
  const mcpServers = buildGeminiMcpServers(specs)
  if (process.env.CLI_BRIDGE_DEBUG_MCP) {
    console.error(`[cli-bridge mcp gemini] materialized servers: ${Object.keys(mcpServers).join(', ') || '(none)'} from specs: ${Object.keys(specs).join(', ') || '(empty)'}`)
  }
  return mountCwdNativeMcp(cwd, { subdir: '.gemini', filename: 'settings.json', backendName: 'gemini', mcpServers })
}

/**
 * Build the droid (Factory) `mcpServers` object. droid's `mcp.json` is
 * nearly canonical — stdio entries carry an explicit `type:'stdio'` and
 * every entry an explicit `disabled:false`, both of which the canonical
 * shape omits. Remote entries are `{type:'http'|'sse', url, headers}`.
 */
function buildFactoryMcpServers(specs: Record<string, McpServerSpec>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.enabled === false) continue
    if (isStdioMcpSpec(spec) && spec.command) {
      out[name] = {
        type: 'stdio',
        command: spec.command,
        args: spec.args ?? [],
        ...(spec.env && Object.keys(spec.env).length ? { env: spec.env } : {}),
        disabled: false,
      }
    } else if ((spec.type === 'http' || spec.type === 'sse') && spec.url) {
      out[name] = {
        type: spec.type,
        url: spec.url,
        ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}),
        disabled: false,
      }
    }
  }
  return out
}

/**
 * Materialize MCP servers for the droid/Factory backend by merging them
 * into the project-scope `<cwd>/.factory/mcp.json`, which `droid exec`
 * discovers by cwd (verified against the CLI: config candidates include
 * `join(cwd, '.factory', 'mcp.json')`). This never touches the user's
 * `~/.factory/mcp.json`. cwd-native, so it shares pi's lock + no-follow
 * discipline via `mountCwdNativeMcp`. Returns null when no usable servers
 * remain.
 */
export function materializeMcpServersForFactory(
  specs: Record<string, McpServerSpec> | null,
  cwd: string,
): MaterializedMcpConfig | null {
  if (!specs) return null
  const mcpServers = buildFactoryMcpServers(specs)
  if (process.env.CLI_BRIDGE_DEBUG_MCP) {
    console.error(`[cli-bridge mcp factory] materialized servers: ${Object.keys(mcpServers).join(', ') || '(none)'} from specs: ${Object.keys(specs).join(', ') || '(empty)'}`)
  }
  return mountCwdNativeMcp(cwd, { subdir: '.factory', filename: 'mcp.json', backendName: 'factory', mcpServers })
}

/**
 * Build the ACP `session/new` `mcpServers` param array from a normalized
 * spec map. ACP takes MCP servers INLINE as a JSON-RPC param (no temp
 * file). The schema (verified live against `hermes acp`, protocol v1)
 * differs from the config-file shapes:
 *   - remote:  `{type:'http'|'sse', name, url, headers:[{name,value}]}`
 *   - stdio:   `{name, command, args, env:[{name,value}]}`
 * Note `headers`/`env` are LISTS of `{name,value}` pairs, not objects.
 * Disabled/malformed entries are dropped.
 */
export function buildAcpMcpServers(specs: Record<string, McpServerSpec> | null): Array<Record<string, unknown>> {
  if (!specs) return []
  const pairs = (map: Record<string, string> | undefined): Array<{ name: string; value: string }> =>
    Object.entries(map ?? {}).map(([name, value]) => ({ name, value }))
  const out: Array<Record<string, unknown>> = []
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.enabled === false) continue
    if (isStdioMcpSpec(spec) && spec.command) {
      out.push({ name, command: spec.command, args: spec.args ?? [], env: pairs(spec.env) })
    } else if ((spec.type === 'http' || spec.type === 'sse') && spec.url) {
      out.push({ type: spec.type, name, url: spec.url, headers: pairs(spec.headers) })
    }
  }
  return out
}

/**
 * Same as `materializeMcpConfig` but writes opencode's schema —
 * `{mcp: {<name>: {type:'local', command:[...], environment:{...}, enabled, timeout}}}`
 * instead of claude/kimi's `{mcpServers: {<name>: {command, args, env}}}`.
 *
 * opencode-cli loads the file via the `OPENCODE_CONFIG` env var (which
 * cli-bridge's opencode backend sets when it spawns the CLI). The file
 * is layered on top of the user's global ~/.config/opencode/opencode.json,
 * so we only need to declare the MCP servers we want to add.
 *
 * Schema source: https://opencode.ai/config.json (`properties.mcp.additionalProperties`).
 */
export function materializeOpencodeMcpConfig(profile: AgentProfile | null): MaterializedMcpConfig {
  const specs: Record<string, McpServerSpec> = {}
  if (profile && typeof profile === 'object') {
    const mcp = (profile as { mcp?: Record<string, AgentProfileMcpServer> }).mcp
    if (mcp && typeof mcp === 'object') {
      for (const [name, raw] of Object.entries(mcp)) {
        if (!name || !raw || typeof raw !== 'object') continue
        specs[name] = profileMcpToSpec(raw)
      }
    }
  }
  const permissions = profile && typeof profile === 'object'
    ? (profile as { permissions?: Record<string, unknown> }).permissions
    : undefined
  return materializeMcpServersForOpencode(specs, permissions)
}

/**
 * Write opencode's schema —
 * `{mcp: {<name>: {type:'local', command:[...], environment:{...}, enabled, timeout}}}`
 * from a normalized `McpServerSpec` map. Layered on top of the user's
 * global `~/.config/opencode/opencode.json` via `OPENCODE_CONFIG`.
 *
 * Always returns a non-null result — opencode needs a config file
 * even when no MCP servers are declared (so the headless permission
 * map below can disable interactive prompts).
 *
 * Schema source: https://opencode.ai/config.json
 *   (`properties.mcp.additionalProperties`).
 */
export function materializeMcpServersForOpencode(
  specs: Record<string, McpServerSpec> | null,
  callerPermissions?: Record<string, unknown> | null,
): MaterializedMcpConfig {
  const opencodeMcp: Record<string,
    | { type: 'local'; command: string[]; environment?: Record<string, string>; enabled?: boolean; timeout?: number }
    | { type: 'remote'; url: string; headers?: Record<string, string>; enabled?: boolean }
  > = {}
  if (specs) {
    for (const [name, spec] of Object.entries(specs)) {
      if (spec.enabled === false) continue
      if (isStdioMcpSpec(spec) && spec.command) {
        opencodeMcp[name] = {
          type: 'local',
          command: [spec.command, ...(spec.args ?? [])],
          ...(spec.env && Object.keys(spec.env).length ? { environment: spec.env } : {}),
          enabled: true,
          ...(spec.timeout ? { timeout: spec.timeout } : {}),
        }
      } else if ((spec.type === 'http' || spec.type === 'sse') && spec.url) {
        // opencode loads remote MCP via `{type:'remote', url, headers}`
        // (opencode.ai/config.json). Forward verbatim so an HTTP tool host
        // is reachable, mirroring the claude/kimi remote fix (cli-bridge#48).
        opencodeMcp[name] = {
          type: 'remote',
          url: spec.url,
          ...(spec.headers && Object.keys(spec.headers).length ? { headers: spec.headers } : {}),
          enabled: true,
        }
      }
      // unknown transport / missing required fields → drop
    }
  }
  if (process.env.CLI_BRIDGE_DEBUG_MCP) {
    console.error(`[cli-bridge mcp opencode] materialized: ${Object.keys(opencodeMcp).join(', ') || '(none)'}`)
  }
  const serverNames = Object.keys(opencodeMcp)

  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-opencode-'))
  const configPath = join(dir, 'opencode.json')
  // Headless benchmark and automation runs must never block on an
  // interactive permission prompt, so every tool defaults to `allow`.
  const headlessPermission: Record<string, 'allow' | 'ask' | 'deny'> = {
    external_directory: 'allow',
    bash: 'allow',
    edit: 'allow',
    read: 'allow',
    write: 'allow',
    webfetch: 'allow',
    task: 'allow',
    plan_enter: 'allow',
    plan_exit: 'allow',
    question: 'allow',
  }
  // The caller's agent_profile.permissions override the headless defaults —
  // an explicit `deny` is load-bearing (the search benchmark's no-web arm
  // sets webfetch:'deny' to remove native web). Without this, the hardcoded
  // `allow` above silently kept webfetch on and the "offline" arm still
  // fetched. Only known permission verbs are honored, per-key.
  if (callerPermissions && typeof callerPermissions === 'object') {
    for (const [key, value] of Object.entries(callerPermissions)) {
      if (value === 'allow' || value === 'ask' || value === 'deny') {
        headlessPermission[key] = value
      }
    }
  }
  writeFileSync(configPath, JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    permission: headlessPermission,
    mcp: opencodeMcp,
  }, null, 2))
  return {
    configPath,
    serverNames,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    },
  }
}

export function materializeEmptyMcpConfig(): MaterializedMcpConfig {
  const dir = mkdtempSync(join(tmpdir(), 'cli-bridge-mcp-'))
  const configPath = join(dir, 'mcp-config.json')
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2))
  return {
    configPath,
    serverNames: [],
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    },
  }
}

/**
 * Materialize a `McpServerSpec` map into a temp `CODEX_HOME` directory
 * containing a synthetic `config.toml`. Codex CLI accepts MCP servers
 * via the `[mcp_servers.<name>]` TOML stanza in `$CODEX_HOME/config.toml`
 * — there is no `--mcp-config` flag. We point codex at a temp HOME so
 * the passthrough is per-invocation and never mutates the user's real
 * `~/.codex/config.toml`.
 *
 * `authSourcePath` is the path to the user's persistent `auth.json`
 * (default `~/.codex/auth.json`). Codex looks up the session's bearer
 * token here. We copy it into the temp dir so the spawned codex still
 * authenticates as the operator. The copy is deleted at cleanup.
 *
 * stdio servers — written as `command = "..."` + optional `args`/`env`.
 * http servers (spec.type === 'http' with `url`) — written as
 * `url = "..."` + optional `headers`/`bearer_token_env_var`.
 *
 * Returns null when no usable servers remain.
 */
export interface MaterializedCodexHome {
  /** Directory to pass via `CODEX_HOME` env. */
  homePath: string
  /** Names actually written. */
  serverNames: string[]
  cleanup(): void
}

export function materializeMcpServersForCodex(
  specs: Record<string, McpServerSpec> | null,
  authSourcePath?: string,
): MaterializedCodexHome | null {
  if (!specs) return null

  const lines: string[] = []
  const serverNames: string[] = []
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.enabled === false) continue
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      // Codex's TOML table key parser is strict; skip names that would
      // require quoting and could collide with other config keys.
      continue
    }
    const block: string[] = [`[mcp_servers.${name}]`]
    if (spec.type === 'http' || (spec.url && spec.type !== 'sse' && !spec.command)) {
      if (!spec.url) continue
      block.push(`url = ${tomlString(spec.url)}`)
      if (spec.headers && Object.keys(spec.headers).length) {
        block.push(`http_headers = ${tomlInlineTable(spec.headers)}`)
      }
      // codex tool-call timeout key — verified against `codex mcp get`
      // round-trip. Other names (`tool_timeout_ms`, `request_timeout_ms`)
      // are silently dropped by the parser.
      if (spec.timeout) block.push(`tool_timeout_sec = ${Math.max(1, Math.round(spec.timeout / 1000))}`)
    } else {
      if (!spec.command) continue
      block.push(`command = ${tomlString(spec.command)}`)
      if (spec.args && spec.args.length) {
        block.push(`args = ${tomlStringArray(spec.args)}`)
      }
      if (spec.env && Object.keys(spec.env).length) {
        block.push(`env = ${tomlInlineTable(spec.env)}`)
      }
      // codex stdio servers use `tool_timeout_sec` for per-call and
      // `startup_timeout_sec` for the launch handshake. We map a
      // single caller-provided `timeout` to BOTH so generous values
      // unblock long-running tools without separately requiring the
      // caller to fiddle with handshake timing.
      if (spec.timeout) {
        const secs = Math.max(1, Math.round(spec.timeout / 1000))
        block.push(`tool_timeout_sec = ${secs}`)
        block.push(`startup_timeout_sec = ${secs}`)
      }
    }
    lines.push(block.join('\n'))
    serverNames.push(name)
  }
  if (serverNames.length === 0) return null

  // Codex aborts if CODEX_HOME is under the system tmpdir on some
  // platforms — use the user's HOME/.cache as a stable parent.
  const baseDir = mkdtempSync(join(stableTmpRoot(), 'cli-bridge-codex-'))
  writeFileSync(join(baseDir, 'config.toml'), lines.join('\n\n') + '\n')

  if (authSourcePath) {
    try {
      const auth = readFileMaybe(authSourcePath)
      if (auth !== null) writeFileSync(join(baseDir, 'auth.json'), auth)
    } catch {
      // Best-effort: codex without auth.json will fail to call the
      // model. Surface that as an upstream error from the backend
      // rather than silently swallowing it here.
    }
  }

  return {
    homePath: baseDir,
    serverNames,
    cleanup: () => {
      try {
        rmSync(baseDir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    },
  }
}

function stableTmpRoot(): string {
  // Prefer ~/.cache so codex's "not in /tmp" guard doesn't trip.
  // `tmpdir()` (typically /tmp) is the documented fallback. The
  // function is sync because the call sites are sync; HOME is always
  // set on supported platforms.
  const home = process.env.HOME
  if (home) {
    try {
      const cache = join(home, '.cache')
      // Don't mkdir — cli-bridge runs on hosts that always have
      // ~/.cache (we don't ship a polyfill for first-boot Linux).
      return cache
    } catch {
      // fallthrough
    }
  }
  return tmpdir()
}

function readFileMaybe(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

function tomlString(s: string): string {
  // Use TOML's basic string with conservative escaping. Codex's TOML
  // parser handles `\"`, `\\`, `\n`, `\t` — escape the dangerous set
  // and trust UTF-8 for the rest.
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

function tomlStringArray(items: string[]): string {
  return `[${items.map(tomlString).join(', ')}]`
}

function tomlInlineTable(map: Record<string, string>): string {
  const entries = Object.entries(map).map(([k, v]) => {
    const key = /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)
    return `${key} = ${tomlString(v)}`
  })
  return `{ ${entries.join(', ')} }`
}

/**
 * Build the `--allowedTools` CSV that auto-allows every tool exposed by
 * the named MCP servers. Without this, claude's permission system will
 * prompt on first use of each MCP tool, which hangs in non-interactive
 * mode (`-p` print mode). Caller decides whether to actually pass the
 * resulting flag — hosted-safe mode usually wants to keep MCP tools
 * gated rather than auto-allow them.
 *
 * Format follows claude's tool spec: `mcp__<server>` allows ALL tools
 * exposed by that server. Per-tool grants would be `mcp__<server>__<tool>`.
 */
export function buildMcpAllowList(serverNames: string[]): string {
  return serverNames.map((n) => `mcp__${n}`).join(',')
}

export function resolvePromptMessages(req: ChatRequest, session: SessionRecord | null): ChatMessage[] {
  const preamble = renderLocalHarnessProfilePreamble(resolveAgentProfile(req, session))
  if (!preamble) return req.messages
  return [{ role: 'system', content: preamble }, ...req.messages]
}

export function renderLocalHarnessProfilePreamble(profile: AgentProfile | null): string | null {
  if (!profile || typeof profile !== 'object') return null
  const sections: string[] = []

  const systemPrompt = pickString(
    (profile as Record<string, unknown>).systemPrompt,
    ((profile as Record<string, unknown>).prompt as Record<string, unknown> | undefined)?.systemPrompt,
  )
  if (systemPrompt) sections.push(systemPrompt)

  const skills = pickStringArray((profile as Record<string, unknown>).skills)
  if (skills.length) {
    sections.push(`Caller-declared skills for this session: ${skills.join(', ')}`)
  }

  const mcpServers = pickNamedEntries((profile as Record<string, unknown>).mcpServers)
  if (mcpServers.length) {
    sections.push(`Caller-declared MCP servers for this session: ${mcpServers.join(', ')}`)
  }

  const resources = pickNamedEntries((profile as Record<string, unknown>).resources)
  if (resources.length) {
    sections.push(`Caller-declared resources for this session: ${resources.join(', ')}`)
  }

  const permissionSummary = renderPermissions((profile as Record<string, unknown>).permissions)
  if (permissionSummary) {
    sections.push(`Requested permission posture: ${permissionSummary}`)
  }

  return sections.length ? sections.join('\n\n') : null
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function pickStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function pickNamedEntries(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === 'string' && item.trim()) return [item]
      if (item && typeof item === 'object') {
        const name = (item as Record<string, unknown>).name
        if (typeof name === 'string' && name.trim()) return [name]
      }
      return []
    })
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).filter(Boolean)
  }
  return []
}

function renderPermissions(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string' && v)
    .map(([k, v]) => `${k}=${v}`)
  return entries.length ? entries.join(', ') : null
}
