/** Authenticated, explicit ownership transfer and individually drained runtime roll. */
import type { Hono } from 'hono'
import { z } from 'zod'
import { adoptionRequest, PoolMaintenance } from '../runtime/pool-maintenance.js'

const rollRequest = z.object({ expectedId: z.string().regex(/^[a-f0-9]{64}$/u),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  promoteDefault: z.object({ expectedImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }).strict().optional(), }).strict()
const drainRequest = rollRequest.omit({ imageId: true, promoteDefault: true })

export function mountPoolMaintenance(app: Hono, owner: PoolMaintenance, authenticated: boolean): void {
  app.use('/admin/pools/*', async (c, next) => {
    if (!authenticated) return c.json({ error: 'pool maintenance requires configured bearer authentication' }, 403)
    return next()
  })
  app.get('/admin/pools/status', async (c) => c.json(await owner.status()))
  app.post('/admin/pools/adopt', async (c) => {
    try {
      const text = await c.req.text()
      if (text.length > 32_768) return c.json({ error: 'request too large' }, 413)
      return c.json({ pools: await owner.adopt(adoptionRequest.parse(JSON.parse(text))) })
    } catch { return c.json({ error: 'adoption refused; preserve existing containers and inspect ownership' }, 409) }
  })
  app.post('/admin/pools/:prefix/slots/:index/:operation', async (c) => {
    try {
      const text = await c.req.text()
      if (text.length > 4096) return c.json({ error: 'request too large' }, 413)
      const index = Number(c.req.param('index'))
      if (!Number.isInteger(index) || index < 0 || index > 31) throw new Error('invalid slot')
      const name = c.req.param('prefix')
      if (c.req.param('operation') === 'drain') {
        const input = drainRequest.parse(JSON.parse(text))
        return c.json({ slots: owner.drain(name, index, input.expectedId) })
      }
      if (c.req.param('operation') !== 'roll') return c.json({ error: 'unknown operation' }, 404)
      const input = rollRequest.parse(JSON.parse(text))
      return c.json({ receipt: await owner.roll(name, index, input.expectedId, input.imageId, input.promoteDefault) })
    } catch { return c.json({ error: 'slot maintenance refused; inspect drain, active work and durable receipt' }, 409) }
  })
}
