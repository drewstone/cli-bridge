import { describe, expect, it } from 'vitest'
import { AdmissionGate, AdmissionRejectedError, type AdmissionLease } from '../src/admission.js'

function gate(over: Partial<ConstructorParameters<typeof AdmissionGate>[0]> = {}) {
  return new AdmissionGate({
    maxActive: 4,
    maxQueue: 8,
    queueTimeoutMs: 50,
    reservedActive: 1,
    bulkQueueTimeoutMs: 50,
    ...over,
  })
}

/** Fill every slot a bulk caller is allowed to take. */
async function saturateBulk(g: AdmissionGate, n: number): Promise<AdmissionLease[]> {
  const leases: AdmissionLease[] = []
  for (let i = 0; i < n; i++) leases.push(await g.acquire(undefined, 'bulk'))
  return leases
}

describe('admission lanes', () => {
  it('reproduces the starvation: with no reserved lane a full pool rejects the reviewer', async () => {
    const g = gate({ reservedActive: 0, maxQueue: 8 })
    await saturateBulk(g, 4)
    expect(g.snapshot()).toMatchObject({ active: 4, maxActive: 4 })

    // The queue is nowhere near full (0/8) — the caller still fails, because a
    // 50ms admission timeout expires long before any slot frees. This is the
    // measured incident shape: active 20/20, queued 7/48, reason queue_timeout.
    const err = await g.acquire(undefined, 'bulk').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AdmissionRejectedError)
    expect((err as AdmissionRejectedError).reason).toBe('queue_timeout')
    expect((err as AdmissionRejectedError).snapshot.queued).toBe(0)
  })

  it('admits a reserved caller instantly while bulk holds every slot it can', async () => {
    const g = gate({ reservedActive: 1 })
    // Bulk saturates its ceiling (maxActive - reservedActive = 3).
    const held = await saturateBulk(g, 3)
    expect(g.snapshot()).toMatchObject({ active: 3, bulkMaxActive: 3 })

    // A 4th bulk caller cannot take the reserved slot.
    const blocked = await g.acquire(undefined, 'bulk').catch((e: unknown) => e)
    expect((blocked as AdmissionRejectedError).reason).toBe('queue_timeout')

    // The reviewer is admitted with zero wait, with the pool otherwise full.
    const lease = await g.acquire(undefined, 'reserved')
    expect(g.snapshot()).toMatchObject({ active: 4, activeByClass: { reserved: 1, bulk: 3 } })

    lease.release()
    for (const l of held) l.release()
    expect(g.snapshot()).toMatchObject({ active: 0, queued: 0 })
  })

  it('serves queued reserved callers before queued bulk callers', async () => {
    const g = gate({ reservedActive: 1, queueTimeoutMs: 5_000, bulkQueueTimeoutMs: 5_000 })
    const held = await saturateBulk(g, 3)
    const reservedHeld = await g.acquire(undefined, 'reserved')

    const order: string[] = []
    const queuedBulk = g.acquire(undefined, 'bulk').then((l) => { order.push('bulk'); return l })
    await new Promise((r) => setTimeout(r, 10))
    const queuedReserved = g.acquire(undefined, 'reserved').then((l) => { order.push('reserved'); return l })
    await new Promise((r) => setTimeout(r, 10))
    expect(g.snapshot().queuedByClass).toEqual({ reserved: 1, bulk: 1 })

    // One slot frees. The reserved waiter queued LAST must still win it.
    reservedHeld.release()
    const l1 = await queuedReserved
    expect(order).toEqual(['reserved'])

    // Releasing that reserved slot does NOT serve the bulk waiter: bulk is at
    // its ceiling, so it waits for a bulk slot, not for the reserved lane.
    l1.release()
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual(['reserved'])

    held[0]!.release()
    const l2 = await queuedBulk
    expect(order).toEqual(['reserved', 'bulk'])
    l2.release()
    for (const l of held.slice(1)) l.release()
  })

  it('gives bulk a longer wait than reserved instead of failing it fast', async () => {
    const g = gate({ reservedActive: 1, queueTimeoutMs: 20, bulkQueueTimeoutMs: 400 })
    const held = await saturateBulk(g, 3)
    const reservedHeld = await g.acquire(undefined, 'reserved')

    const started = Date.now()
    const bulkWait = g.acquire(undefined, 'bulk')
    // A slot frees well after the reserved lane's 20ms timeout would have
    // expired; the bulk caller waits it out and is served rather than rejected.
    setTimeout(() => held[0]!.release(), 120)
    const lease = await bulkWait
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)

    lease.release()
    reservedHeld.release()
    for (const l of held.slice(1)) l.release()
  })

  it('keeps per-class queue caps so bulk cannot fill the queue a reviewer needs', async () => {
    const g = gate({ reservedActive: 1, maxQueue: 1, queueTimeoutMs: 5_000, bulkQueueTimeoutMs: 5_000 })
    const held = await saturateBulk(g, 3)
    const reservedHeld = await g.acquire(undefined, 'reserved')

    const queuedBulk = g.acquire(undefined, 'bulk')
    await new Promise((r) => setTimeout(r, 10))
    // Bulk's queue is now full; that must not consume the reserved queue slot.
    const overflow = await g.acquire(undefined, 'bulk').catch((e: unknown) => e)
    expect((overflow as AdmissionRejectedError).reason).toBe('queue_full')
    expect((overflow as AdmissionRejectedError).admissionClass).toBe('bulk')

    const queuedReserved = g.acquire(undefined, 'reserved')
    await new Promise((r) => setTimeout(r, 10))
    expect(g.snapshot().queuedByClass).toEqual({ reserved: 1, bulk: 1 })

    reservedHeld.release()
    ;(await queuedReserved).release()
    held[0]!.release()
    ;(await queuedBulk).release()
    for (const l of held.slice(1)) l.release()
  })

  it('holds the reserved slot empty rather than lending it to bulk', async () => {
    // The invariant that makes reviewer admission wait-free: with the reserved
    // lane idle and bulk queued, the slot stays free. Lending it would put the
    // next reviewer call behind a median host call instead of admitting it now.
    const g = gate({ reservedActive: 1, queueTimeoutMs: 5_000, bulkQueueTimeoutMs: 100 })
    const held = await saturateBulk(g, 3)
    expect(g.snapshot()).toMatchObject({ active: 3, maxActive: 4, activeByClass: { reserved: 0, bulk: 3 } })

    const overflow = await g.acquire(undefined, 'bulk').catch((e: unknown) => e)
    expect((overflow as AdmissionRejectedError).reason).toBe('queue_timeout')
    expect(g.snapshot().activeByClass).toEqual({ reserved: 0, bulk: 3 })

    // The slot the fleet could not take is still there for the reviewer.
    const lease = await g.acquire(undefined, 'reserved')
    lease.release()
    for (const l of held) l.release()
  })

  it('rejects a reserved lane that would leave bulk with no slots', () => {
    expect(() => gate({ maxActive: 2, reservedActive: 2 })).toThrow(/invalid reservedActive/)
  })

  it('reports the lane on every rejection so a caller can name what starved it', async () => {
    const g = gate({ reservedActive: 1, queueTimeoutMs: 20, bulkQueueTimeoutMs: 20 })
    const held = await saturateBulk(g, 3)
    const reservedHeld = await g.acquire(undefined, 'reserved')

    const err = await g.acquire(undefined, 'reserved').catch((e: unknown) => e) as AdmissionRejectedError
    expect(err.admissionClass).toBe('reserved')
    expect(err.snapshot).toMatchObject({
      active: 4,
      maxActive: 4,
      reservedActive: 1,
      bulkMaxActive: 3,
      activeByClass: { reserved: 1, bulk: 3 },
    })
    expect(err.message).toContain('reserved lane')

    reservedHeld.release()
    for (const l of held) l.release()
  })
})
