import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { McpServerSpec } from './types.js'
import { BackendError } from './types.js'
import { processMatchesOwner, processStartIdentity } from '../runtime/private-temporary.js'
import { type MaterializedMcpConfig, writeFileNoFollow } from './profile-core.js'

export function mountCwdNativeMcp(
  cwd: string,
  opts: { subdir: string; filename: string; backendName: string; mcpServers: Record<string, unknown> },
): MaterializedMcpConfig | null {
  const { subdir, filename, backendName, mcpServers } = opts
  const serverNames = Object.keys(mcpServers)
  if (serverNames.length === 0) return null

  const piDir = join(cwd, subdir)
  const configPath = join(piDir, filename)
  const lockPath = `${configPath}.lock`
  const recoveryPath = `${lockPath}.recovery`

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
  interface LockPayload {
    pid: number
    processStart: string | null
    originalBytes: string | null
    originalMode: number | null
    mountedDigest: string | null
    mountedDevice: string | null
    mountedInode: string | null
    mountedChangeTime: string | null
  }
  const writeLockAtomic = (payload: LockPayload): void => {
    const tmpPath = `${lockPath}.${process.pid}.tmp`
    // `wx` refuses a pre-planted symlink at the tmp path; rename replaces
    // the lock atomically without following links.
    rmSync(tmpPath, { force: true })
    writeFileSync(tmpPath, JSON.stringify(payload), { flag: 'wx', mode: 0o600 })
    renameSync(tmpPath, lockPath)
  }

  // Guarded read of a workspace-controlled path. A plain `readFileSync`
  // would follow symlinks and BLOCK FOREVER on a planted FIFO (host-side
  // DoS before any timeout starts). Open no-follow + non-blocking, fstat
  // the fd (no swap race), reject non-regular files and oversized bytes.
  const MAX_WORKSPACE_READ = 1024 * 1024
  const readWorkspaceFileState = (
    path: string,
    enforcePrivateMode = false,
  ): {
    bytes: string | null
    mode: number | null
    device: string | null
    inode: string | null
    changeTime: string | null
  } => {
    let fd: number
    try {
      fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return { bytes: null, mode: null, device: null, inode: null, changeTime: null }
      return fail(`${path} is not readable as a regular file (${code ?? 'unknown error'})`)
    }
    try {
      const st = fstatSync(fd, { bigint: true })
      if (!st.isFile()) fail(`${path} is not a regular file (workspace planted a special file)`)
      if (st.size > BigInt(MAX_WORKSPACE_READ)) fail(`${path} exceeds the ${MAX_WORKSPACE_READ}-byte cap`)
      if (enforcePrivateMode) fchmodSync(fd, 0o600)
      return {
        bytes: readFileSync(fd, 'utf-8'),
        mode: Number(st.mode & 0o777n),
        device: st.dev.toString(),
        inode: st.ino.toString(),
        changeTime: st.ctimeNs.toString(),
      }
    } finally {
      closeSync(fd)
    }
  }
  const readWorkspaceFileMaybe = (path: string, enforcePrivateMode = false): string | null =>
    readWorkspaceFileState(path, enforcePrivateMode).bytes
  const contentDigest = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')
  const matchesMountedFile = (
    state: ReturnType<typeof readWorkspaceFileState>,
    payload: Partial<LockPayload>,
  ): boolean =>
    Boolean(
      state.bytes !== null &&
        payload.mountedDigest &&
        payload.mountedDevice &&
        payload.mountedInode &&
        payload.mountedChangeTime &&
        state.device === payload.mountedDevice &&
        state.inode === payload.mountedInode &&
        state.changeTime === payload.mountedChangeTime &&
        contentDigest(state.bytes) === payload.mountedDigest,
    )
  const matchesOriginalFile = (
    state: ReturnType<typeof readWorkspaceFileState>,
    payload: Partial<LockPayload>,
  ): boolean => {
    if (payload.originalBytes === null) return state.bytes === null
    return (
      typeof payload.originalBytes === 'string' &&
      state.bytes === payload.originalBytes &&
      state.mode === payload.originalMode
    )
  }

  const tryAcquire = (): boolean => {
    try {
      const original = readWorkspaceFileState(configPath)
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          processStart: processStartIdentity(process.pid),
          originalBytes: original.bytes,
          originalMode: original.mode,
          mountedDigest: null,
          mountedDevice: null,
          mountedInode: null,
          mountedChangeTime: null,
        } satisfies LockPayload),
        { flag: 'wx', mode: 0o600 },
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

  if (existsSync(recoveryPath)) {
    fail(`stale-lock recovery is already in progress at ${recoveryPath}`)
  }
  if (!tryAcquire()) {
    let stale: Partial<LockPayload> | null = null
    let staleLockBytes: string | null = null
    try {
      staleLockBytes = readWorkspaceFileMaybe(lockPath, true)
      stale = JSON.parse(staleLockBytes ?? '') as Partial<LockPayload>
    } catch {
      // Unreadable/corrupt lock: FAIL-CLOSED. Stealing here could kill a
      // live mount mid-run; a human (or a dead-pid check on a later
      // retry) resolves genuine corruption.
      throw new BackendError(
        `backend ${backendName} cannot mount MCP servers at ${configPath}: lock file ${lockPath} exists but is ` +
          `unreadable; if no ${backendName} run is active in this cwd, remove it manually`,
        'not_configured',
      )
    }
    const holderPid = stale?.pid ?? null
    if (holderPid === null || processMatchesOwner(holderPid, stale?.processStart ?? null)) {
      throw new BackendError(
        `backend ${backendName} cannot mount MCP servers at ${configPath}: another run${holderPid !== null ? ` (pid ${holderPid})` : ''} holds the ` +
          `mount for this cwd; ${backendName} supports one MCP-mounted run per workspace — use distinct cwds`,
        'not_configured',
      )
    }
    // Stale lock from a dead/crashed run: roll back only the exact inode and
    // content that the dead run wrote. A user may have replaced or edited the
    // file after the crash; preserving that file is safer than guessing.
    try {
      writeFileSync(
        recoveryPath,
        JSON.stringify({ pid: process.pid, processStart: processStartIdentity(process.pid) }),
        {
          flag: 'wx',
          mode: 0o600,
        },
      )
    } catch (recoveryError) {
      fail(
        `another run is recovering a stale lock (${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)})`,
      )
    }
    try {
      const currentLockBytes = readWorkspaceFileMaybe(lockPath, true)
      if (currentLockBytes !== staleLockBytes) {
        fail('lock changed while stale-lock recovery was being claimed')
      }
      try {
        const current = readWorkspaceFileState(configPath)
        if (matchesMountedFile(current, stale ?? {})) {
          if (stale && typeof stale.originalBytes === 'string') {
            writeFileNoFollow(
              configPath,
              stale.originalBytes,
              typeof stale.originalMode === 'number' ? stale.originalMode : 0o600,
            )
          } else if (stale?.originalBytes === null) {
            // unlink removes a symlink itself, never its target — safe.
            rmSync(configPath, { force: true })
          } else {
            fail('stale lock has no valid original config state')
          }
        } else if (!matchesOriginalFile(current, stale ?? {})) {
          fail(`stale mounted config changed after its owner exited; preserving ${configPath} and keeping the lock`)
        }
        rmSync(lockPath, { force: true })
        if (!tryAcquire()) {
          fail('lost race stealing stale lock: another run acquired it first')
        }
      } catch (retryErr) {
        if (retryErr instanceof BackendError) throw retryErr
        fail(`lost race stealing stale lock: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`)
      }
    } finally {
      rmSync(recoveryPath, { force: true })
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
  const original = readWorkspaceFileState(configPath)
  const originalBytes = original.bytes
  const originalMode = original.mode
  try {
    let recorded: string | null | undefined
    let recordedMode: number | null | undefined
    try {
      const payload = JSON.parse(readWorkspaceFileMaybe(lockPath, true) ?? '') as Partial<LockPayload>
      recorded = payload.originalBytes
      recordedMode = payload.originalMode
    } catch {
      recorded = undefined
      recordedMode = undefined
    }
    if (recorded !== originalBytes || recordedMode !== originalMode) {
      writeLockAtomic({
        pid: process.pid,
        processStart: processStartIdentity(process.pid),
        originalBytes,
        originalMode,
        mountedDigest: null,
        mountedDevice: null,
        mountedInode: null,
        mountedChangeTime: null,
      })
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
  const restoreOriginal = (): void => {
    if (originalBytes !== null) writeFileNoFollow(configPath, originalBytes, originalMode ?? 0o600)
    else rmSync(configPath, { force: true })
  }
  const mountedBytes = JSON.stringify(merged, null, 2)
  let mountedState: ReturnType<typeof readWorkspaceFileState> | null = null
  try {
    writeFileNoFollow(configPath, mountedBytes, 0o600)
    mountedState = readWorkspaceFileState(configPath)
    if (mountedState.bytes !== mountedBytes || !mountedState.device || !mountedState.inode) {
      fail(`could not prove the identity of the mounted config at ${configPath}`)
    }
    writeLockAtomic({
      pid: process.pid,
      processStart: processStartIdentity(process.pid),
      originalBytes,
      originalMode,
      mountedDigest: contentDigest(mountedBytes),
      mountedDevice: mountedState.device,
      mountedInode: mountedState.inode,
      mountedChangeTime: mountedState.changeTime,
    })
  } catch (err) {
    try {
      const current = readWorkspaceFileState(configPath)
      if (
        mountedState &&
        !matchesMountedFile(current, {
          mountedDigest: contentDigest(mountedBytes),
          mountedDevice: mountedState.device,
          mountedInode: mountedState.inode,
          mountedChangeTime: mountedState.changeTime,
        })
      )
        throw new Error('mounted config identity changed before setup rollback')
      restoreOriginal()
      releaseLock()
    } catch {
      // Keep the lock and its original bytes for crash recovery.
    }
    fail(err instanceof Error ? err.message : String(err))
  }

  let cleaned = false
  return {
    configPath,
    serverNames,
    cleanup: () => {
      if (cleaned) return
      try {
        const current = readWorkspaceFileState(configPath)
        const mountedStillOwned = matchesMountedFile(current, {
          mountedDigest: contentDigest(mountedBytes),
          mountedDevice: mountedState?.device ?? null,
          mountedInode: mountedState?.inode ?? null,
          mountedChangeTime: mountedState?.changeTime ?? null,
        })
        if (!mountedStillOwned && !matchesOriginalFile(current, { originalBytes, originalMode })) {
          throw new Error(`mounted config changed during the run; preserving ${configPath}`)
        }
        if (mountedStillOwned && originalBytes !== null) {
          // No-follow: the workspace may have swapped the config for a
          // symlink mid-run; never restore THROUGH it from the host.
          writeFileNoFollow(configPath, originalBytes, originalMode ?? 0o600)
        } else if (mountedStillOwned) {
          rmSync(configPath, { force: true })
        }
      } catch (err) {
        // FAIL-CLOSED: restore failed (e.g. symlink planted mid-run).
        // Keep the lock — its recorded originalBytes let a later mount's
        // stale-lock recovery retry the rollback once this pid exits;
        // releasing it now would let the tampered config masquerade as
        // workspace-original state.
        throw new BackendError(
          `backend ${backendName} could not restore MCP config at ${configPath}; keeping lock: ${err instanceof Error ? err.message : String(err)}`,
          'upstream',
          err,
        )
      }
      try {
        rmSync(lockPath, { force: true })
      } catch (err) {
        throw new BackendError(
          `backend ${backendName} restored MCP config but could not remove lock ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
          'upstream',
          err,
        )
      }
      cleaned = true
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
