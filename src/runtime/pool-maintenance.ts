/** Durable adoption and one-slot runtime rolls, owned by the bridge's admin API. */
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fsyncSync, fstatSync, openSync, readFileSync, renameSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { ContainerPool } from '../executors/container-pool.js'
import { dockerEngine, inspectIdle, replaceRuntime, type RollReceipt } from '../executors/docker-runtime-roll.js'
import { registeredPools } from '../routes/metrics.js'
import { acquireDataDirectoryLock, type DataDirectoryLock } from './single-instance.js'

const identity = z.string().regex(/^[a-f0-9]{64}$/u)
const prefix = z.string().regex(/^cli-bridge-[a-zA-Z0-9_-]{1,64}$/u)
export const adoptionRequest = z.object({ prefix, legacyDataDir: z.string().startsWith('/'),
  expectedImage: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  legacyPorts: z.array(z.number().int().min(1).max(65535)).min(1).max(4),
  slots: z.array(z.object({ index: z.number().int().min(0).max(31), id: identity }).strict()).min(1).max(32),
}).strict()
const rollSchema = z.object({ oldId: identity, imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u), name: z.string(),
  nonce: z.string().regex(/^[a-f0-9]{32}$/u), candidateId: identity.optional(), retainedName: z.string().optional(),
  phase: z.enum(['intent', 'candidate', 'verified', 'stopped', 'retained', 'promoted']), node: z.string().optional(),
}).strict()
const recordSchema = adoptionRequest.extend({ rolls: z.record(z.string(), rollSchema), image: z.string(),
  history: z.record(z.string(), z.array(rollSchema)).default({}), }).strict()
type Record = z.infer<typeof recordSchema>

/** Linux's kernel socket inventory covers IPv4, IPv6 and non-loopback binds. */
async function requireNoListener(port: number): Promise<void> {
  if (process.platform !== 'linux') throw new Error('pool adoption requires Linux listener inventory')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid legacy port')
  // Missing ss, timeout, nonzero exit, or excessive output all reject adoption.
  const { stdout, stderr } = await promisify(execFile)('ss', ['-H', '-ltn', `sport = :${port}`],
    { timeout: 2000, maxBuffer: 65536, killSignal: 'SIGKILL' })
  if (stderr.trim()) throw new Error('legacy listener inventory is ambiguous')
  if (stdout.trim()) throw new Error('legacy controller still listens on a declared port')
}

export class PoolMaintenance {
  private records: Record[] = []
  private locks = new Map<string, DataDirectoryLock>()
  private pools = new Map<string, ContainerPool>()
  private operating = new Set<string>()
  private closing = false
  private path: string

  constructor(dataDir: string) {
    this.path = join(dataDir, 'pool-maintenance.json')
    try {
      const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = fstatSync(fd)
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('unsafe maintenance journal')
        this.records = z.object({ schema: z.literal(1), pools: z.array(recordSchema).max(32) }).strict()
          .parse(JSON.parse(readFileSync(fd, 'utf8'))).pools
      } finally { closeSync(fd) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('maintenance journal needs operator reconciliation')
    }
    try {
      for (const record of this.records) {
        this.lock(record.legacyDataDir)
        this.restore(record)
      }
    } catch (error) {
      for (const [name, pool] of this.pools) if (registeredPools.get(name) === pool) registeredPools.delete(name)
      for (const lock of this.locks.values()) lock.release()
      throw error
    }
  }

  private lock(dir: string): void {
    const canonical = realpathSync(dir)
    if (!this.locks.has(canonical)) this.locks.set(canonical, acquireDataDirectoryLock(canonical))
  }

  private restore(record: Record): ContainerPool {
    if (this.pools.has(record.prefix)) return this.pools.get(record.prefix)!
    const ids = record.slots.map((slot) => {
      const roll = record.rolls[String(slot.index)]
      return roll ? (roll.phase === 'promoted' ? roll.candidateId! : roll.oldId) : slot.id
    })
    const pool = ContainerPool.adopt({ size: ids.length, image: record.image,
      namePrefix: record.prefix, oauthMode: 'share', slotMaxHoldMs: 0 }, ids)
    this.pools.set(record.prefix, pool)
    registeredPools.set(record.prefix, pool)
    return pool
  }

  private save(): void {
    const temp = `${this.path}.${randomBytes(8).toString('hex')}.next`
    const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try { writeFileSync(fd, JSON.stringify({ schema: 1, pools: this.records })); fsyncSync(fd) }
    finally { closeSync(fd) }
    renameSync(temp, this.path)
    const dir = openSync(dirname(this.path), constants.O_RDONLY | constants.O_DIRECTORY)
    try { fsyncSync(dir) } finally { closeSync(dir) }
  }

  snapshot() {
    return [...this.pools].map(([name, pool]) => {
      const record = this.records.find((r) => r.prefix === name)!
      const slots = pool.slotSnapshot().map((slot) => {
        const transactions = [...(record.history[String(slot.index)] ?? []), record.rolls[String(slot.index)]]
        const receipt = transactions.find((roll) => roll?.candidateId === slot.containerId)
        const imageId = receipt?.imageId ?? (record.slots[slot.index]?.id === slot.containerId ? record.expectedImage : null)
        return { ...slot, imageId }
      })
      return { prefix: name, slots, rolls: Object.values(record.rolls), history: record.history }
    })
  }

  async adopt(input: z.infer<typeof adoptionRequest>) {
    if (this.closing || this.operating.size) throw new Error('another maintenance operation is active')
    this.operating.add(input.prefix)
    try {
      if (this.records.some((r) => r.prefix === input.prefix)) throw new Error('pool already adopted; inspect its durable receipt')
      if (input.slots.some((slot, index) => slot.index !== index) || new Set(input.slots.map((s) => s.id)).size !== input.slots.length) {
        throw new Error('slots must be ordered contiguous distinct identities')
      }
      for (const pool of registeredPools.values()) {
        if (input.slots.some((s) => pool.liveContainerIds().includes(s.id))) throw new Error('slot is already owned by a live pool')
      }
      this.lock(input.legacyDataDir)
      for (const port of input.legacyPorts) await requireNoListener(port)
      const root = `${dirname(realpathSync(input.legacyDataDir))}/`
      let image = ''
      for (const slot of input.slots) {
        const info = await inspectIdle(slot.id, `${input.prefix}-${slot.index}`)
        if (!info.Mounts.some((mount: any) => mount.Type === 'bind' && mount.Source.startsWith(root))) {
          throw new Error('slot has no bind association with the locked legacy data directory')
        }
        if (info.Image !== input.expectedImage) throw new Error('adoption image identity differs from explicit manifest')
        if (image && image !== info.Image) throw new Error('adoption requires one known runtime image')
        image = info.Image
      }
      const record = { ...input, legacyDataDir: realpathSync(input.legacyDataDir), image, rolls: {}, history: {} }
      this.records.push(record)
      this.save()
      this.restore(record)
      return this.snapshot()
    } finally {
      this.operating.delete(input.prefix)
      const canonical = realpathSync(input.legacyDataDir)
      if (!this.records.some((record) => record.legacyDataDir === canonical)) {
        this.locks.get(canonical)?.release()
        this.locks.delete(canonical)
      }
    }
  }

  drain(name: string, index: number, expectedId: string) {
    const pool = this.pools.get(name)
    if (this.closing || !pool || this.operating.has(name)) throw new Error('pool unavailable or maintenance is active')
    pool.drainSlot(index, expectedId)
    return pool.slotSnapshot()
  }

  async roll(name: string, index: number, expectedId: string, imageId: string) {
    const pool = this.pools.get(name)
    const record = this.records.find((r) => r.prefix === name)
    if (this.closing || !pool || !record || this.operating.size) throw new Error('pool unavailable or maintenance is active')
    const slot = record.slots[index]
    if (!slot || slot.index !== index) throw new Error('unknown slot')
    const previous = record.rolls[String(index)]
    const retry = previous?.oldId === expectedId && previous.imageId === imageId
    if (previous && !retry && (previous.phase !== 'promoted' || previous.candidateId !== expectedId || previous.imageId === imageId)) {
      throw new Error('new roll requires the completed transaction current identity and a different image')
    }
    const receipt: RollReceipt = retry ? previous! : { oldId: expectedId, imageId,
      name: `${name}-${index}`, nonce: randomBytes(16).toString('hex'), phase: 'intent' }
    this.operating.add(name)
    try {
      if (retry && previous?.phase === 'promoted') {
        const current = pool.slotSnapshot()[index]!
        pool.drainSlot(index, current.containerId)
        await pool.rollSlot(index, current.containerId, imageId, async (_id, arm) =>
          await replaceRuntime(previous, () => this.save(), arm))
        return previous
      }
      if (!retry) {
        const current = pool.slotSnapshot()[index]!
        if (current.containerId !== expectedId || !current.draining || current.busy || current.maintenance) {
          throw new Error('new roll requires the drained idle current slot')
        }
        // Missing local artifacts never replace a completed durable receipt.
        const image = await dockerEngine('GET', `/images/${imageId}/json`)
        if (image.Id !== imageId) throw new Error('runtime image identity differs')
        if (previous) (record.history[String(index)] ??= []).push(structuredClone(previous))
      }
      // Persist the identity before the first Docker write; failures stay drained.
      record.rolls[String(index)] = receipt
      this.save()
      await pool.rollSlot(index, expectedId, imageId, async (_id, arm) =>
        await replaceRuntime(receipt, () => this.save(), arm))
      record.image = imageId
      this.save()
      return receipt
    } finally { this.operating.delete(name) }
  }

  async close(): Promise<void> {
    this.closing = true
    while (this.operating.size) await new Promise((resolve) => setTimeout(resolve, 50))
    for (const lock of this.locks.values()) lock.release()
    this.locks.clear()
  }
}
