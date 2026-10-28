import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  AgentProfileConfigValue,
  AgentProfileMcpServer,
} from '@tangle-network/agent-interface'
import type { ChatRequest, McpServerSpec } from './types.js'
import { BackendError } from './types.js'
import type { SessionRecord } from '../sessions/store.js'
import { resolveAgentProfile, requireMaterializationCwd } from './profile-support.js'

export function resolveMcpServers(
  req: ChatRequest,
  session: SessionRecord | null,
): Record<string, McpServerSpec> | null {
  const merged: Record<string, McpServerSpec> = {}

  const profile = resolveAgentProfile(req, session)
  const requestMcp = req.mcp?.mcpServers
  if (profile && Object.keys(requestMcp ?? {}).length > 0) {
    throw new BackendError(
      'request mcp cannot accompany agent_profile; declare the exact MCP servers in agent_profile.mcp',
      'parse_error',
    )
  }
  if (profile && typeof profile === 'object') {
    const profileMcp = (profile as { mcp?: Record<string, AgentProfileMcpServer> }).mcp
    if (profileMcp && typeof profileMcp === 'object') {
      for (const [name, raw] of Object.entries(profileMcp)) {
        if (!name || !raw || typeof raw !== 'object') continue
        if ((raw as { enabled?: unknown }).enabled === false) continue
        merged[name] = normalizeMcpServerSpec({ ...raw, type: raw.transport }, name, `mcp[${JSON.stringify(name)}]`)
      }
    }
  }

  if (requestMcp && typeof requestMcp === 'object') {
    for (const [name, raw] of Object.entries(requestMcp)) {
      if (!name || !raw || typeof raw !== 'object') continue
      merged[name] = normalizeMcpServerSpec(raw, name)
    }
  }

  // Runtime attachments mount platform endpoints beside the authored
  // sources without entering any identity digest. A collision would let an
  // attachment shadow an authored server (or the reverse) invisibly to the
  // session binding, so it is refused instead of resolved by precedence.
  const attachments = req.runtime_attachments?.mcp
  if (attachments && typeof attachments === 'object') {
    for (const [name, raw] of Object.entries(attachments)) {
      if (!name || !raw || typeof raw !== 'object') {
        throw new BackendError(
          `runtime_attachments.mcp[${JSON.stringify(name)}] is not an MCP server object`,
          'parse_error',
        )
      }
      if (merged[name] !== undefined) {
        throw new BackendError(
          `runtime attachment ${JSON.stringify(name)} collides with an MCP server declared by the ` +
            `${profile ? 'agent_profile' : 'request mcp channel'}; attachments must use a reserved alias`,
          'parse_error',
        )
      }
      if ((raw as { enabled?: unknown }).enabled === false) {
        throw new BackendError(
          `runtime attachment ${JSON.stringify(name)} is disabled; an attachment mounts by presence — omit the entry instead`,
          'parse_error',
        )
      }
      merged[name] = normalizeMcpServerSpec({ ...raw, type: raw.transport }, name, `runtime_attachments.mcp[${JSON.stringify(name)}]`)
    }
  }

  return Object.keys(merged).length > 0 ? merged : null
}

/**
 * Read one `AgentProfileMcpServer` configuration value as the plain string an MCP config file or a
 * server spawn needs.
 *
 * Interface 0.40 retyped `args`/`env`/`headers` from `string` to `AgentProfileConfigValue` — public
 * bytes (`{kind:'public', value}`) or an opaque `{kind:'secret-ref', key}` a private executor
 * resolves. cli-bridge is not that executor: every one of these values ends up in an on-disk MCP
 * config the harness reads (`writeMcpConfigFile`, `materializeMcpServersForPi`,
 * `materializeMcpServersForOpencode`, …), and cli-bridge has no `AgentProfileSecretProvider` to
 * resolve a reference with. So a reference is REFUSED here rather than resolved or rendered:
 * writing the reference object is nonsense to the harness, and writing a placeholder turns an auth
 * failure into what looks like a broken tool. The refusal names the reference KEY, never a value.
 *
 * `args` is refused for a second, stronger reason: those strings become the MCP server's argv,
 * which is readable by every process on the host (`/proc/<pid>/cmdline`) and lies outside every
 * redaction channel. agent-runtime's `resolveMcpServerLaunch` refuses a secret-ref in argv even
 * when it DOES hold a provider; a secret belongs in `env`, never in a command line.
 *
 * Plain `string`/`number`/`boolean` are accepted, matching agent-runtime's `publicConfigString`
 * (`src/runtime/supervise/pi-mcp.ts`): hand-written JSON profiles authored before 0.40 commonly
 * carry those where the type now says `{kind:'public'}`, and rejecting them would break every
 * caller mid-migration for no safety gain.
 */
function publicMcpConfigString(value: unknown, where: string): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value && typeof value === 'object') {
    const config = value as AgentProfileConfigValue
    if (config.kind === 'public' && typeof config.value === 'string') return config.value
    if (config.kind === 'secret-ref') {
      throw new BackendError(
        `AgentProfile ${where} is a secret-ref (${JSON.stringify(config.key)}) and cli-bridge has ` +
          'no secret provider — resolve it before the request, or declare a public value',
        'parse_error',
      )
    }
  }
  throw new BackendError(
    `AgentProfile ${where} is not a public configuration value`,
    'parse_error',
  )
}

/** Every entry of an MCP `env`/`headers` map as public strings. */
function publicMcpConfigRecord(
  record: Record<string, AgentProfileConfigValue> | undefined,
  where: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!record || typeof record !== 'object') return out
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue
    out[key] = publicMcpConfigString(value, `${where}[${JSON.stringify(key)}]`)
  }
  return out
}

function normalizeMcpServerSpec(
  raw: McpServerSpec | Record<string, unknown>,
  name: string,
  where = `mcp.mcpServers[${JSON.stringify(name)}]`,
): McpServerSpec {
  // Defensive copy — drop any unknown fields, coerce types loosely.
  const r = raw as Record<string, unknown>
  const out: McpServerSpec = {}
  if (r.type === 'stdio' || r.type === 'http' || r.type === 'sse') out.type = r.type
  if (typeof r.command === 'string') out.command = r.command
  // A profile-less request owns these bytes all the way to argv/on-disk MCP config. This path used
  // to drop every non-string silently,
  // which turned a secret-ref in `args` into a SHORTER command line and a server that spawned
  // wrong for a reason nothing reported. Same refusal as the profile path, same reason.
  if (Array.isArray(r.args)) {
    out.args = (r.args as unknown[]).map((a, i) => publicMcpConfigString(a, `${where}.args[${i}]`))
  }
  if (r.env && typeof r.env === 'object') {
    out.env = publicMcpConfigRecord(r.env as Record<string, AgentProfileConfigValue>, `${where}.env`)
  }
  if (typeof r.url === 'string') out.url = r.url
  if (r.headers && typeof r.headers === 'object') {
    out.headers = publicMcpConfigRecord(
      r.headers as Record<string, AgentProfileConfigValue>,
      `${where}.headers`,
    )
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

export interface MaterializedMcpConfig {
  configPath: string
  serverNames: string[]
  cleanup(): void
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
): Record<string, McpServerSpec> {
  const mcpServers: Record<string, McpServerSpec> = {}
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

/** True when a process id still names a live process. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = alive but owned by another user — still very much alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Write a cwd-native config without following a planted final-component symlink. */
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
  cwd: string | undefined,
): MaterializedMcpConfig | null {
  if (!specs) return null
  // `directTools` is pi-adapter-specific, so it is added HERE rather than in the shared canonical
  // builder that Claude and Kimi also read. It registers each server's tools as NATIVE pi tools
  // instead of leaving them behind the generic `mcp` tool, where an agent must connect to the
  // server and describe each verb before it can call one. A measured supervisor run spent turns
  // and hundreds of thousands of input tokens on that discovery before it could delegate once.
  const mcpServers = Object.fromEntries(
    Object.entries(buildCanonicalMcpServers(specs)).map(([name, server]) => [
      name,
      { ...server, directTools: true },
    ]),
  )
  const serverNames = Object.keys(mcpServers)
  if (process.env.CLI_BRIDGE_DEBUG_MCP) {
    console.error(`[cli-bridge mcp pi] materialized servers: ${serverNames.join(', ') || '(none)'} from specs: ${Object.keys(specs).join(', ') || '(empty)'}`)
  }
  if (serverNames.length === 0) return null
  const workspaceCwd = requireMaterializationCwd(cwd, 'pi MCP passthrough')
  let dir: string | null = null
  try {
    // pi-mcp-adapter has exposed the per-process `--mcp-config` flag since its first public
    // release. Keep the config under the mounted workspace so host and Docker Pi see the same
    // absolute path, but never mutate the project's own `.pi/mcp.json`.
    dir = mkdtempSync(join(workspaceCwd, '.cli-bridge-pi-mcp-'))
    chmodSync(dir, 0o755)
    const configPath = join(dir, 'mcp.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2), { flag: 'wx', mode: 0o644 })
    let cleaned = false
    return {
      configPath,
      serverNames,
      cleanup: () => {
        if (cleaned) return
        cleaned = true
        rmSync(dir!, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (dir) rmSync(dir, { recursive: true, force: true })
    const message = error instanceof Error ? error.message : String(error)
    throw new BackendError(`backend pi failed to prepare MCP config: ${message}`, 'not_configured', error)
  }
}

/**
 * Mount a `{mcpServers}` object into a CWD-NATIVE config file
 * (`<cwd>/<subdir>/<filename>`) that a CLI discovers by working directory
 * rather than a per-invocation flag. Shared by the additive cwd-native MCP
 * backends — gemini (`.gemini/settings.json`) and droid/factory
 * (`.factory/mcp.json`). Only the schema of the `mcpServers` values differs,
 * and the caller has already transformed those.
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
 * Materialize MCP servers for Kimi Code's project-local loader.
 *
 * Kimi Code 0.36 reads `<cwd>/.kimi-code/mcp.json` and has no
 * per-invocation `--mcp-config-file` option. Reuse the locked mount
 * so request servers never leak into the next run or overwrite the
 * user's project config after cleanup.
 */
export function materializeMcpServersForKimi(
  specs: Record<string, McpServerSpec> | null,
  cwd: string | undefined,
): MaterializedMcpConfig | null {
  if (!specs) return null
  const target = requireMaterializationCwd(cwd, 'kimi MCP passthrough')
  return mountCwdNativeMcp(target, {
    subdir: '.kimi-code',
    filename: 'mcp.json',
    backendName: 'kimi-code',
    mcpServers: buildCanonicalMcpServers(specs),
  })
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
  return Object.fromEntries(Object.entries(buildCanonicalMcpServers(specs)).map(([name, spec]) => {
    const { type, url, ...server } = spec
    return [name, type
      ? { ...server, [type === 'http' ? 'httpUrl' : 'url']: url, trust: true }
      : { ...server, trust: true }]
  }))
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
  cwd: string | undefined,
): MaterializedMcpConfig | null {
  if (!specs) return null
  const target = requireMaterializationCwd(cwd, 'gemini MCP passthrough')
  const mcpServers = buildGeminiMcpServers(specs)
  if (process.env.CLI_BRIDGE_DEBUG_MCP) {
    console.error(`[cli-bridge mcp gemini] materialized servers: ${Object.keys(mcpServers).join(', ') || '(none)'} from specs: ${Object.keys(specs).join(', ') || '(empty)'}`)
  }
  return mountCwdNativeMcp(target, { subdir: '.gemini', filename: 'settings.json', backendName: 'gemini', mcpServers })
}

/**
 * Build the droid (Factory) `mcpServers` object. droid's `mcp.json` is
 * nearly canonical — stdio entries carry an explicit `type:'stdio'` and
 * every entry an explicit `disabled:false`, both of which the canonical
 * shape omits. Remote entries are `{type:'http'|'sse', url, headers}`.
 */
function buildFactoryMcpServers(specs: Record<string, McpServerSpec>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(buildCanonicalMcpServers(specs)).map(([name, spec]) => {
    const { timeout: _timeout, ...server } = spec
    return [name, {
      ...server,
      ...(server.command ? { type: 'stdio', args: server.args ?? [] } : {}),
      disabled: false,
    }]
  }))
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
  for (const [name, spec] of Object.entries(buildCanonicalMcpServers(specs ?? {}))) {
    if (spec.command) {
      opencodeMcp[name] = {
        type: 'local',
        command: [spec.command, ...(spec.args ?? [])],
        ...(spec.env ? { environment: spec.env } : {}),
        enabled: true,
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
      }
    } else if (spec.url) {
      opencodeMcp[name] = {
        type: 'remote',
        url: spec.url,
        ...(spec.headers ? { headers: spec.headers } : {}),
        enabled: true,
      }
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
