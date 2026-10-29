/** Stop journal-owned legacy pool slots; retain every container, image and mount. */
import { request } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tsImport } from 'tsx/esm/api'
import { z } from 'zod'

const execute = promisify(execFile)
const identity = z.string().regex(/^[a-f0-9]{64}$/u)
const image = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const roll = z.object({ oldId: identity, candidateId: identity, imageId: image,
  name: z.string(), nonce: z.string().regex(/^[a-f0-9]{32}$/u), phase: z.literal('promoted') })
const journalSchema = z.object({ schema: z.literal(1), pools: z.array(z.object({
  prefix: z.string().regex(/^cli-bridge-[a-zA-Z0-9_-]{1,64}$/u), legacyDataDir: z.string().startsWith('/'),
  image, legacyPorts: z.array(z.number().int().min(1).max(65535)).min(1).max(4),
  slots: z.array(z.object({ index: z.number().int().min(0).max(31), id: identity })).min(1).max(32),
  rolls: z.record(z.string(), roll),
})).min(1).max(32) })
const receiptSchema = z.object({ schema: z.literal(1), journalDigest: z.string(), slots: z.record(identity,
  z.object({ name: z.string(), imageId: image, phase: z.enum(['intent', 'stopped']), at: z.string() }).strict()) }).strict()

function readPrivate(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 1_048_576) {
      throw new Error('pool retirement requires a private owned regular journal')
    }
    return readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
}

function save(path, value) {
  const temporary = `${path}.${randomUUID()}.next`
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
  const directory = openSync(join(path, '..'), constants.O_RDONLY | constants.O_DIRECTORY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

function engine(method, path, body) {
  const host = process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock'
  if (!host.startsWith('unix://')) throw new Error('pool retirement requires a local Docker socket')
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: host.slice(7), method, path, headers: { 'content-type': 'application/json' }, timeout: 30_000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (part) => { body += part; if (body.length > 2_097_152) req.destroy() })
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 300) return reject(new Error(`pool retirement Docker request refused (${res.statusCode})`))
        try { resolve(body ? JSON.parse(body) : null) } catch { reject(new Error('invalid Docker retirement response')) }
      })
      res.on('error', () => reject(new Error('Docker retirement response failed')))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => reject(new Error('Docker retirement transport failed')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

async function inspect(slot, allowStopped) {
  const info = await engine('GET', `/containers/${slot.id}/json`)
  if (!info.Mounts?.some((mount) => mount.Type === 'bind' && mount.Source.startsWith(slot.legacyRoot)) ||
    info.Id !== slot.id || info.Name !== `/${slot.name}` || info.Image !== slot.imageId ||
    info.Config.Labels?.['cli-bridge.maintenance.nonce'] !== slot.nonce ||
    info.Config.Labels?.['cli-bridge.maintenance.old-id'] !== slot.oldId ||
    info.State.Paused || info.State.Restarting || info.ExecIDs?.length ||
    JSON.stringify(info.Config.Cmd) !== JSON.stringify(['tail', '-f', '/dev/null']) ||
    JSON.stringify(info.Config.Entrypoint) !== JSON.stringify(['dumb-init', '--'])) {
    throw new Error('pool retirement identity or idle configuration differs from its journal')
  }
  if (!info.State.Running) {
    if (!allowStopped || info.State.Status !== 'exited') throw new Error('slot was stopped outside this retirement receipt')
    if (info.HostConfig.RestartPolicy.Name !== 'no') throw new Error('retired slot restart policy changed')
    return false
  }
  const top = await engine('GET', `/containers/${slot.id}/top?ps_args=${encodeURIComponent('-eo pid,ppid,comm')}`)
  const rows = top.Processes
  const init = rows?.find((row) => row[2] === 'dumb-init')
  const tail = rows?.find((row) => row[2] === 'tail')
  if (!Array.isArray(rows) || rows.length !== 2 || !init || !tail ||
    Number(init[0]) !== info.State.Pid || tail[1] !== init[0]) throw new Error('pool slot contains active work; retirement refused')
  return true
}

export async function retirePools(inputDir = process.env.BRIDGE_DATA_DIR ?? './data') {
  if (process.platform !== 'linux') throw new Error('pool retirement requires Linux listener inventory')
  const dataDir = realpathSync(inputDir)
  const stat = lstatSync(dataDir)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error('pool retirement data directory must be private and owned')
  const { acquireDataDirectoryLock } = await tsImport('../src/runtime/single-instance.ts', import.meta.url)
  const locks = [acquireDataDirectoryLock(join(dataDir, '.pool-retirement'))]
  try {
    const original = readPrivate(join(dataDir, 'pool-maintenance.json'))
    const journal = journalSchema.parse(JSON.parse(original))
    for (const dir of new Set(journal.pools.map((pool) => realpathSync(pool.legacyDataDir)))) {
      if (dir === dataDir) throw new Error('legacy pool directory cannot be the live maintenance directory')
      locks.push(acquireDataDirectoryLock(dir))
    }
    for (const port of new Set(journal.pools.flatMap((pool) => pool.legacyPorts))) {
      const result = await execute('ss', ['-H', '-ltn', `sport = :${port}`], { timeout: 2000, maxBuffer: 65536 })
      if (result.stdout.trim() || result.stderr.trim()) throw new Error('legacy pool listener still exists; retirement refused')
    }
    const slots = journal.pools.flatMap((pool) => pool.slots.map((slot, index) => {
      const current = pool.rolls[String(index)]
      if (slot.index !== index || !current || current.oldId !== slot.id || current.imageId !== pool.image || current.name !== `${pool.prefix}-${index}`) throw new Error('pool retirement requires contiguous, fully promoted slots')
      return { legacyRoot: `${dirname(realpathSync(pool.legacyDataDir))}${sep}`, id: current.candidateId, name: current.name, imageId: current.imageId, nonce: current.nonce, oldId: current.oldId }
    }))
    if (new Set(slots.map((slot) => slot.id)).size !== slots.length) throw new Error('duplicate retirement identities')
    const path = join(dataDir, 'pool-retirement.json')
    const journalDigest = createHash('sha256').update(original).digest('hex')
    let receipt = { schema: 1, journalDigest, slots: {} }
    try { receipt = receiptSchema.parse(JSON.parse(readPrivate(path))) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (receipt.journalDigest !== journalDigest) throw new Error('pool journal changed since retirement began')
    for (const [id, previous] of Object.entries(receipt.slots)) {
      if (!slots.some((slot) => slot.id === id && slot.name === previous.name && slot.imageId === previous.imageId)) {
        throw new Error('retirement receipt contains a conflicting slot identity')
      }
    }
    for (const slot of slots) await inspect(slot, Boolean(receipt.slots[slot.id]))
    for (const slot of slots) {
      if (await inspect(slot, Boolean(receipt.slots[slot.id]))) {
        receipt.slots[slot.id] = { name: slot.name, imageId: slot.imageId, phase: 'intent', at: new Date().toISOString() }
        save(path, receipt)
        await inspect(slot, false)
        await engine('POST', `/containers/${slot.id}/update`, { RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } })
        const configured = await engine('GET', `/containers/${slot.id}/json`)
        if (configured.HostConfig.RestartPolicy.Name !== 'no') throw new Error('retired slot restart policy remains enabled')
        await inspect(slot, false)
        await engine('POST', `/containers/${slot.id}/stop?t=10`)
        if (await inspect(slot, true)) throw new Error('pool slot is still running after retirement')
      }
      receipt.slots[slot.id] = { name: slot.name, imageId: slot.imageId, phase: 'stopped', at: new Date().toISOString() }
      save(path, receipt)
    }
    return receipt
  } finally { for (const lock of locks.reverse()) lock.release() }
}
