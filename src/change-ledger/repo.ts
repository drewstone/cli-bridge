/**
 * What a turn can read about the repository its session works in, and what changed between two readings.
 *
 * Every read is a plain `git` or `gh` child process in the session's working directory. A read that fails
 * returns null: the caller records nothing for the turn rather than a guess.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 5_000
const GH_TIMEOUT_MS = 20_000
/** A turn with more commits than this is reported as truncated, never as a complete list. */
export const MAX_TURN_COMMITS = 500

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name]
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', LC_ALL: 'C' }
}

async function run(bin: string, args: string[], cwd: string, timeout: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, args, { cwd, timeout, env: cleanEnv(), maxBuffer: 16 * 1024 * 1024 })
    return stdout.trim()
  } catch {
    return null
  }
}

const git = (cwd: string, ...args: string[]) => run('git', args, cwd, GIT_TIMEOUT_MS)

/** One reading of a working repository. */
export interface RepoReading {
  /** The checkout's top directory; two sessions with the same `top` share one working tree. */
  top: string
  head: string
  /** The checked-out branch; null when HEAD is detached. */
  branch: string | null
  /** `origin` as `owner/repo` for github.com, else `host/path`; null when there is none. */
  remote: string | null
  /** Remote-tracking refs of `origin`, as branch name to commit. */
  originRefs: ReadonlyMap<string, string>
}

/** `owner/repo` for github.com, else `host/path`; credentials, scheme and the .git suffix removed. */
export function normalizeRemote(url: string | null): string | null {
  if (!url) return null
  const text = url.trim()
  let host: string
  let path: string
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(text)
  if (scp) {
    host = scp[1]!
    path = scp[2]!
  } else {
    const parsed = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(text)
    if (!parsed) return null
    host = parsed[1]!
    path = parsed[2]!
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
  return host === 'github.com' ? path : `${host}/${path}`
}

/** True for a repository `gh` can address as `owner/repo`. */
export const isGithubRepo = (remote: string | null): remote is string =>
  remote !== null && /^[\w.-]+\/[\w.-]+$/.test(remote)

export async function readRepo(cwd: string): Promise<RepoReading | null> {
  const ids = await git(cwd, 'rev-parse', '--show-toplevel', 'HEAD')
  const [top, head] = ids?.split('\n') ?? []
  if (!top || !head || !/^[0-9a-f]{40,64}$/.test(head)) return null
  const [branch, origin, refs] = await Promise.all([
    git(cwd, 'symbolic-ref', '--short', '-q', 'HEAD'),
    git(cwd, 'remote', 'get-url', 'origin'),
    git(cwd, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/origin'),
  ])
  // A failed ref listing is not an empty one: the pushes of the turn could not be told.
  if (refs === null) return null
  const originRefs = new Map<string, string>()
  for (const line of refs.split('\n')) {
    const [name, sha] = line.split(' ')
    const branchName = name?.startsWith('refs/remotes/origin/') ? name.slice('refs/remotes/origin/'.length) : null
    if (branchName && branchName !== 'HEAD' && sha) originRefs.set(branchName, sha)
  }
  return { top, head, branch: branch || null, remote: normalizeRemote(origin), originRefs }
}

export interface TurnCommits {
  /** Oldest first. */
  shas: string[]
  /** More commits than `MAX_TURN_COMMITS`: the list is a prefix. */
  truncated: boolean
}

/**
 * The commits the turn made: reachable from the end HEAD, not from the start HEAD, and committed after the turn began.
 * The date bound keeps old commits a branch switch or a pull brought in out of the turn. Null when git could not say.
 */
export async function commitsBetween(cwd: string, before: string, after: string, sinceMs: number): Promise<TurnCommits | null> {
  if (before === after) return { shas: [], truncated: false }
  const since = Math.floor(sinceMs / 1000) - 2
  const out = await git(cwd, 'rev-list', '--reverse', `--max-count=${MAX_TURN_COMMITS + 1}`, `--since=${since}`, after, '--not', before)
  if (out === null) return null
  const shas = out === '' ? [] : out.split('\n')
  return { shas: shas.slice(0, MAX_TURN_COMMITS), truncated: shas.length > MAX_TURN_COMMITS }
}

/**
 * Branches of `origin` this turn pushed: a remote-tracking ref that moved and whose newest reflog entry is a push,
 * not a fetch. Null when a reflog could not be read.
 */
export async function pushedBranches(cwd: string, before: RepoReading, after: RepoReading): Promise<Array<{ branch: string; sha: string }> | null> {
  const pushed: Array<{ branch: string; sha: string }> = []
  for (const [branch, sha] of after.originRefs) {
    if (before.originRefs.get(branch) === sha) continue
    const subject = await git(cwd, 'reflog', 'show', '--format=%gs', '-n', '1', `refs/remotes/origin/${branch}`)
    if (subject === null) return null
    if (subject === 'update by push') pushed.push({ branch, sha })
  }
  return pushed
}

export interface PullRequestAction {
  action: 'pr-create' | 'pr-merge'
  pr: number
}

/**
 * Pull requests of `branches` created or merged inside the turn's window, from one `gh pr list` per branch.
 * Null when a read failed: the turn's pull request actions are unknown.
 */
export async function pullRequestActions(
  cwd: string,
  repo: string,
  branches: readonly string[],
  startMs: number,
  endMs: number,
  ghBin = process.env.CLI_BRIDGE_GH_BIN || 'gh',
): Promise<PullRequestAction[] | null> {
  const actions = new Map<string, PullRequestAction>()
  const inside = (stamp: unknown): boolean => {
    if (typeof stamp !== 'string') return false
    const at = Date.parse(stamp)
    return Number.isFinite(at) && at >= startMs - 1_000 && at <= endMs + 5_000
  }
  for (const branch of branches) {
    const listing = ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--limit', '30', '--json', 'number,createdAt,mergedAt']
    const out = await run(ghBin, listing, cwd, GH_TIMEOUT_MS)
    if (out === null) return null
    let rows: unknown
    try {
      rows = JSON.parse(out)
    } catch {
      return null
    }
    if (!Array.isArray(rows)) return null
    for (const row of rows as Array<Record<string, unknown>>) {
      const pr = row.number
      if (typeof pr !== 'number' || !Number.isInteger(pr) || pr <= 0) continue
      if (inside(row.createdAt)) actions.set(`create#${pr}`, { action: 'pr-create', pr })
      if (inside(row.mergedAt)) actions.set(`merge#${pr}`, { action: 'pr-merge', pr })
    }
  }
  return [...actions.values()]
}
