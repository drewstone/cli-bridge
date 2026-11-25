/**
 * The change ledger Bridge writes for the turns it runs, with no hook in the harness.
 *
 * At a turn's start the recorder reads the session's working repository; when the turn's run ends it reads it
 * again and appends rows to the same `changes.jsonl` the Claude Code and Codex hooks write (row format: agent-eval
 * `src/skill-usage/change-ledger.ts`). Commits the turn made become `commit` rows, remote branches it pushed
 * become `push` rows, and pull requests created or merged on its branches become `pr-create` and `pr-merge`
 * rows. Every turn writes one `turn` row with the HEAD before and after, and a session's first turn also writes
 * `observed`, which is what makes "no change" provable.
 *
 * Unknown stays unknown. A turn whose repository cannot be read writes no row and leaves the session
 * incomplete; a turn whose changes cannot be fully told (a checkout shared with another running turn, more
 * commits than the list holds, a failed pull request read) says so in its `turn` row's `incomplete` field.
 * A row carries no command text, path or attribution.
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Run } from '../runs/registry.js'
import {
  commitsBetween,
  isGithubRepo,
  pullRequestActions,
  pushedBranches,
  readRepo,
  type PullRequestAction,
  type RepoReading,
} from './repo.js'

export type ChangeLedgerAction = 'observed' | 'turn' | 'commit' | 'push' | 'pr-create' | 'pr-merge'

export type IncompleteReason =
  | 'shared-checkout'
  | 'too-many-commits'
  | 'commit-read-failed'
  | 'push-read-failed'
  | 'pr-read-failed'
  | 'earlier-turn-unrecorded'

export interface ChangeLedgerRow {
  v: 1
  at: string
  /** The harness as the session readers name it: Claude Code is `claude-code`, every other backend keeps its name. */
  harness: string
  /** Bridge's session id. */
  sessionId: string
  agentId: null
  /** Bridge sees the turn, not the harness's tool call. */
  toolUseId: null
  action: ChangeLedgerAction
  remote: string | null
  sha: string | null
  pr: number | null
  source: 'cli-bridge'
  /** The harness's own session id when Bridge knows it, which is the id its transcript carries. */
  nativeSessionId: string | null
  turnId: string
  runId: string
  /** ISO time the turn began; a reader places the change on the transcript events inside [turnStartedAt, at]. */
  turnStartedAt: string
  /** `turn` rows: HEAD when the turn began and when it ended. */
  headBefore?: string
  head?: string
  /** `push` rows: the branch of `origin` that moved. */
  branch?: string
  /** `turn` rows: why the turn's change rows may not be the whole story; null when they are. */
  incomplete?: IncompleteReason | null
}

export interface TurnIdentity {
  /** Bridge's session id; for a one-shot run with no session, the run id. */
  sessionId: string
  /** The backend that runs the turn. */
  backend: string
  turnId: string
  runId: string
  /** The working directory the harness runs in; null or a remote path means the repository cannot be read. */
  cwd: string | null
  /** Turns the session ran before this one. */
  priorTurns: number
  /** A run with no session id: it is its own whole session, so Bridge keeps no state for it. */
  oneShot?: boolean
  /** Evaluated when the turn ends, once the harness has named its session. */
  nativeSessionId: () => string | null
}

export function harnessName(backend: string): string {
  return backend === 'claude' ? 'claude-code' : backend
}

export function defaultChangeLedgerDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CHANGE_LEDGER_DIR?.trim() || join(homedir(), '.local', 'state', 'change-ledger')
}

type SessionState = 'observed' | 'incomplete'

interface ActiveTurn {
  top: string
  shared: boolean
}

export class ChangeRecorder {
  private readonly ledger: string
  private readonly sessionsDir: string
  private readonly states = new Map<string, SessionState>()
  private readonly active = new Map<string, Set<ActiveTurn>>()
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {
    this.ledger = join(dir, 'changes.jsonl')
    this.sessionsDir = join(dir, 'bridge-sessions')
  }

  /**
   * Read the repository now, before the harness runs, and write the turn's rows when `run` ends. Resolves once the
   * reading is taken so the caller can start the harness after it. Never rejects: a failure here is a turn with no rows.
   */
  async begin(turn: TurnIdentity, run: Run): Promise<void> {
    try {
      const startedAt = this.now()
      const harness = harnessName(turn.backend)
      const stateKey = createHash('sha256').update(`${harness}\0${turn.sessionId}`).digest('hex')
      const kept = turn.oneShot !== true
      let state = kept ? this.stateOf(stateKey) : undefined
      if (kept && state === undefined && turn.priorTurns > 0) state = this.setState(stateKey, 'incomplete')
      const before = turn.cwd !== null && isAbsolute(turn.cwd) ? await readRepo(turn.cwd) : null
      if (before === null) {
        // An unread turn may have changed anything: a session that had proved "no change" stops proving it.
        if (state === 'observed') this.setState(stateKey, 'incomplete')
        return
      }
      const mine: ActiveTurn = { top: before.top, shared: false }
      const sharing = this.active.get(before.top) ?? new Set<ActiveTurn>()
      for (const other of sharing) {
        other.shared = true
        mine.shared = true
      }
      sharing.add(mine)
      this.active.set(before.top, sharing)
      const finished = run
        .whenTerminal()
        .catch(() => undefined)
        .then(() => this.finish({ turn, harness, stateKey, kept, startedAt, before, mine, cwd: turn.cwd! }))
        .catch((error) => {
          console.error(`[cli-bridge] change ledger: turn ${turn.turnId} wrote no rows: ${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => {
          sharing.delete(mine)
          if (sharing.size === 0 && this.active.get(before.top) === sharing) this.active.delete(before.top)
        })
      this.pending.add(finished)
      void finished.finally(() => this.pending.delete(finished))
    } catch (error) {
      console.error(`[cli-bridge] change ledger: turn ${turn.turnId} not recorded: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Wait for the rows of every turn that has ended; tests and shutdown use it. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  private async finish(input: {
    turn: TurnIdentity
    harness: string
    stateKey: string
    /** False for a one-shot run: no session state is read or written. */
    kept: boolean
    startedAt: number
    before: RepoReading
    mine: ActiveTurn
    cwd: string
  }): Promise<void> {
    const { turn, harness, stateKey, kept, startedAt, before, mine, cwd } = input
    const endedAt = this.now()
    const after = await readRepo(cwd)
    const state = kept ? this.stateOf(stateKey) : undefined
    if (after === null || after.top !== before.top) {
      if (kept) this.setState(stateKey, 'incomplete')
      return
    }
    let incomplete: IncompleteReason | null = state === 'incomplete' ? 'earlier-turn-unrecorded' : null
    let commits: string[] = []
    let pushes: Array<{ branch: string; sha: string }> = []
    let pulls: PullRequestAction[] = []
    if (mine.shared) {
      // Another turn ran in this checkout meanwhile, so its commits and pushes cannot be told apart from ours.
      incomplete ??= 'shared-checkout'
    } else {
      const made = await commitsBetween(cwd, before.head, after.head, startedAt)
      if (made === null) incomplete ??= 'commit-read-failed'
      else {
        commits = made.shas
        if (made.truncated) incomplete ??= 'too-many-commits'
      }
      const pushed = await pushedBranches(cwd, before, after)
      if (pushed === null) incomplete ??= 'push-read-failed'
      else pushes = pushed
      if (isGithubRepo(after.remote)) {
        const branches = [...new Set([...(after.branch ? [after.branch] : []), ...pushes.map((p) => p.branch)])]
        if (branches.length > 0) {
          const read = await pullRequestActions(cwd, after.remote, branches, startedAt, this.now())
          if (read === null) incomplete ??= 'pr-read-failed'
          else pulls = read
        }
      }
    }
    const base = {
      v: 1 as const,
      at: new Date(endedAt).toISOString(),
      harness,
      sessionId: turn.sessionId,
      agentId: null,
      toolUseId: null,
      source: 'cli-bridge' as const,
      nativeSessionId: turn.nativeSessionId() ?? null,
      turnId: turn.turnId,
      runId: turn.runId,
      turnStartedAt: new Date(startedAt).toISOString(),
    }
    const row = (action: ChangeLedgerAction, rest: Partial<ChangeLedgerRow> = {}): ChangeLedgerRow => ({
      ...base,
      action,
      remote: after.remote,
      sha: null,
      pr: null,
      ...rest,
    })
    const rows: ChangeLedgerRow[] = []
    if (state === undefined) rows.push(row('observed'))
    rows.push(row('turn', { headBefore: before.head, head: after.head, incomplete }))
    for (const sha of commits) rows.push(row('commit', { sha }))
    for (const push of pushes) rows.push(row('push', { sha: push.sha, branch: push.branch }))
    for (const pull of pulls) rows.push(row(pull.action, { pr: pull.pr }))
    this.append(rows)
    if (kept && state === undefined) this.setState(stateKey, 'observed')
  }

  private append(rows: readonly ChangeLedgerRow[]): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    // One append of one buffer: rows of concurrent turns, and of the hooks, never interleave.
    appendFileSync(this.ledger, rows.map((r) => `${JSON.stringify(r)}\n`).join(''), { mode: 0o600 })
  }

  private stateOf(key: string): SessionState | undefined {
    const known = this.states.get(key)
    if (known !== undefined) return known
    try {
      const file = join(this.sessionsDir, key)
      if (!existsSync(file)) return undefined
      const text = readFileSync(file, 'utf8').trim()
      if (text !== 'observed' && text !== 'incomplete') return undefined
      this.states.set(key, text)
      return text
    } catch {
      return undefined
    }
  }

  private setState(key: string, state: SessionState): SessionState {
    this.states.set(key, state)
    try {
      mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(this.sessionsDir, key), state, { mode: 0o600 })
    } catch {
      // The in-memory state still holds for this process.
    }
    return state
  }
}
