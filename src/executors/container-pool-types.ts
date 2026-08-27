import type { DockerCli } from './docker-cli.js'

export interface ContainerPoolOptions {
  size: number
  image: string
  namePrefix: string
  resourceOwner: string
  oauthMode: 'share' | 'per-slot'
  shareMounts?: string[]
  perSlotVolumes?: Array<{ volumePrefix: string; target: string }>
  workspaceRoot?: string
  network?: string
  containerUser?: string
  containerHome?: string
  memory?: string
  cpus?: string
  maxQueueDepth?: number
  acquireDeadlineMs?: number
  slotMaxHoldMs?: number
  maxConsecutiveFailures?: number
  reprovisionBackoffMs?: number
  livenessTtlMs?: number
  cli?: DockerCli
  afterCreate?: (containerId: string, index: number) => Promise<void>
  onProgress?: (msg: string) => void
}

export interface AcquiredSlot { containerId: string; slotIndex: number; release(): void }

export interface SlotState {
  containerId: string
  index: number
  busy: boolean
  dead: boolean
  recovering: boolean
  recoveryTimer: NodeJS.Timeout | null
  lastSession: string | null
  holdTimer: NodeJS.Timeout | null
  generation: number
  consecutiveFailures: number
  lastVerifiedAt: number
  armedStart: string
}

export interface PoolWaiter {
  sessionId: string | undefined
  signal: AbortSignal | undefined
  resolve: (slot: AcquiredSlot) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  state: 'queued' | 'checking' | 'settled'
  onAbort?: () => void
}

export const DEFAULTS = {
  ACQUIRE_DEADLINE_MS: 60_000,
  SLOT_MAX_HOLD_MS: 600_000,
  MAX_CONSECUTIVE_FAILURES: 3,
  REPROVISION_BACKOFF_MS: 250,
  LIVENESS_TTL_MS: 30_000,
} as const

export interface PoolCounters {
  acquires: number
  queue_full_rejects: number
  acquire_timeouts: number
  slot_force_releases: number
  slot_reprovisions: number
  slots_marked_dead: number
  slot_liveness_recoveries: number
  slot_rearms: number
  slot_rearm_failures: number
}
