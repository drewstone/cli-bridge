/** Immutable runtime replacement. Docker configuration stays in memory, never in logs. */
import { request } from 'node:http'
import { readFileSync } from 'node:fs'
import { dockerCli } from './docker-cli.js'
import { preflightDockerSlot } from './docker-preflight.js'

type Json = Record<string, any>
export async function dockerEngine(method: string, path: string, body?: unknown): Promise<any> {
  const host = process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock'
  if (!host.startsWith('unix://')) throw new Error('maintenance requires a local Docker socket')
  return await new Promise((resolve, reject) => {
    const req = request({ socketPath: host.slice(7), path, method,
      headers: { 'content-type': 'application/json' }, timeout: 120_000 }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (part: string) => { data += part; if (data.length > 8 * 1024 * 1024) req.destroy() })
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 300) reject(new Error(`Docker maintenance request refused (${res.statusCode})`))
        else { try { resolve(data ? JSON.parse(data) : null) } catch { reject(new Error('invalid Docker response')) } }
      })
    })
    req.on('timeout', () => req.destroy(new Error('Docker maintenance timeout')))
    req.on('error', () => reject(new Error('Docker maintenance transport failed')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

export async function inspectIdle(id: string, expectedName?: string): Promise<Json> {
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('full container identity required')
  const info = await dockerEngine('GET', `/containers/${id}/json`)
  if (info.Id !== id || !info.State.Running || info.State.Paused || info.State.Restarting ||
      info.ExecIDs?.length || (expectedName && info.Name !== `/${expectedName}`) ||
      JSON.stringify(info.Config.Cmd) !== JSON.stringify(['tail', '-f', '/dev/null']) ||
      JSON.stringify(info.Config.Entrypoint) !== JSON.stringify(['dumb-init', '--'])) {
    throw new Error('container is not the expected idle CLI slot')
  }
  const top = await dockerCli(['top', id, '-eo', 'comm'])
  const commands = top.stdout.trim().split('\n').slice(1).map((line) => line.trim())
  if (top.code !== 0 || commands.length !== 2 || commands.sort().join(',') !== 'dumb-init,tail') {
    const observed = commands.map((name) => /^[a-zA-Z0-9._-]{1,64}$/u.test(name) ? name : '<unsupported>')
    throw new Error(`slot contains unexpected processes (${JSON.stringify(observed)}, init=${String(info.HostConfig.Init)}); leave it drained until its work finishes`)
  }
  return info
}

function envMap(values: string[]): Map<string, string> {
  return new Map(values.map((value) => [value.slice(0, value.indexOf('=')), value]))
}

/** Keep operator overrides; image-owned environment follows the patched image. */
function replacementEnvironment(old: Json, oldImage: Json, image: Json): string[] {
  const baseline = envMap(oldImage.Config.Env ?? [])
  const values = envMap(image.Config.Env ?? [])
  for (const [key, value] of envMap(old.Config.Env ?? [])) {
    if (baseline.get(key) !== value) values.set(key, value)
  }
  return [...values.values()]
}

function cloneConfiguration(old: Json, oldImage: Json, image: Json): Json {
  const host = structuredClone(old.HostConfig)
  // Sharing another container's namespaces or devices is outside pool ownership.
  if (!['default', 'bridge'].includes(host.NetworkMode) || host.Privileged || host.AutoRemove ||
      host.ContainerIDFile || host.VolumesFrom?.length || host.Links?.length ||
      Object.keys(old.NetworkSettings.Networks ?? {}).some((name) => name !== 'bridge') ||
      old.Config.Domainname || host.PidMode || host.IpcMode === 'host' || host.Devices?.length ||
      Object.keys(host.PortBindings ?? {}).length || old.Mounts.some((m: Json) => !['bind', 'volume'].includes(m.Type))) {
    throw new Error('unsupported slot namespace, device, port or mount topology')
  }
  host.Binds = null
  host.VolumesFrom = null
  host.Mounts = old.Mounts.map((m: Json) => ({ Type: m.Type,
    Source: m.Type === 'volume' ? m.Name : m.Source, Target: m.Destination, ReadOnly: !m.RW,
    ...(m.Type === 'bind' ? { BindOptions: { Propagation: m.Propagation || 'rprivate' } } :
      { VolumeOptions: { NoCopy: true } }) }))
  return { ...old.Config, Hostname: '', Domainname: '', Image: image.Id,
    Env: replacementEnvironment(old, oldImage, image), Volumes: {}, HostConfig: host }
}

/** Execute the maintained runtime pin policy, then the normal Docker preflight. */
export async function verifyRuntime(id: string, imageId: string, original: Json): Promise<string> {
  const dockerfile = readFileSync(new URL('../../docker/Dockerfile.cli-runtime', import.meta.url), 'utf8')
  const required = /^FROM node:(\d+\.\d+\.\d+)-/mu.exec(dockerfile)?.[1]
  if (!required) throw new Error('runtime Node policy is unavailable')
  const result = await dockerCli(['exec', id, 'node', '--version'])
  if (result.code !== 0 || result.stdout.trim() !== `v${required}`) throw new Error('candidate fails maintained Node security policy')
  const candidate = await dockerEngine('GET', `/containers/${id}/json`)
  for (const mount of original.Mounts) {
    if (!candidate.Mounts.some((m: Json) => m.Type === mount.Type && m.Destination === mount.Destination &&
        m.RW === mount.RW && (m.Type === 'volume' ? m.Name === mount.Name :
          m.Source === mount.Source && m.Propagation === mount.Propagation))) {
      throw new Error('candidate changed an existing mount')
    }
  }
  for (const key of ['User', 'WorkingDir', 'Entrypoint', 'Cmd']) {
    if (JSON.stringify(candidate.Config[key]) !== JSON.stringify(original.Config[key])) throw new Error('candidate changed process configuration')
  }
  const home = (original.Config.Env ?? []).find((v: string) => v.startsWith('HOME='))?.slice(5) ?? '/root'
  const workspace = original.Mounts.find((m: Json) => m.Type === 'bind' && m.Source === m.Destination)?.Destination
  const findings = await preflightDockerSlot({ backend: 'runtime', envPrefix: 'BRIDGE', image: imageId,
    workspaceRoot: workspace, bin: 'node', containerHome: home, containerUser: original.Config.User || undefined,
    mounts: original.Mounts.filter((m: Json) => m.Destination.startsWith(`${home}/`)).map((m: Json) => ({ source: m.Type === 'volume' ? m.Name : m.Source,
      target: m.Destination, kind: m.Type })), buildCommand: 'pnpm run docker:build:runtime' }, id, dockerCli)
  if (findings.length) throw new Error('candidate fails maintained Docker preflight')
  await inspectIdle(id)
  return result.stdout.trim()
}

export interface RollReceipt {
  oldId: string
  imageId: string
  name: string
  candidateId?: string
  retainedName?: string
  phase: 'intent' | 'candidate' | 'verified' | 'stopped' | 'retained' | 'promoted'
  node?: string
  nonce: string
}

/** Each irreversible boundary is journaled; retries use exact recorded IDs. */
export async function replaceRuntime(receipt: RollReceipt, save: () => void, arm: (id: string) => Promise<void>): Promise<string> {
  if (!/^sha256:[a-f0-9]{64}$/u.test(receipt.imageId)) throw new Error('immutable local image identity required')
  const image = await dockerEngine('GET', `/images/${receipt.imageId}/json`)
  if (image.Id !== receipt.imageId) throw new Error('candidate image identity changed')
  const old = await dockerEngine('GET', `/containers/${receipt.oldId}/json`)
  if (receipt.phase === 'intent') {
    await inspectIdle(receipt.oldId, receipt.name)
    const oldImage = await dockerEngine('GET', `/images/${old.Image}/json`)
    // Name is deterministic, so a response lost after creation can be read back.
    const candidateName = `${receipt.name}-candidate-${receipt.nonce}`
    let candidate: Json
    try { candidate = await dockerEngine('GET', `/containers/${candidateName}/json`) }
    catch {
      const config = cloneConfiguration(old, oldImage, image)
      config.Labels = { ...config.Labels, 'cli-bridge.maintenance.nonce': receipt.nonce, 'cli-bridge.maintenance.old-id': receipt.oldId }
      candidate = await dockerEngine('POST', `/containers/create?name=${candidateName}`, config)
    }
    receipt.candidateId = candidate.Id
    receipt.phase = 'candidate'; save()
  }
  const id = receipt.candidateId!
  const candidate = await dockerEngine('GET', `/containers/${id}/json`)
  if (candidate.Config.Labels?.['cli-bridge.maintenance.nonce'] !== receipt.nonce ||
      candidate.Config.Labels?.['cli-bridge.maintenance.old-id'] !== receipt.oldId || candidate.Image !== image.Id) throw new Error('candidate image mismatch')
  if (receipt.phase === 'candidate') {
    if (!candidate.State.Running) await dockerEngine('POST', `/containers/${id}/start`)
    await arm(id)
    receipt.node = await verifyRuntime(id, image.Id, old)
    receipt.phase = 'verified'; save()
  }
  if (receipt.phase === 'verified') {
    await arm(id)
    await verifyRuntime(id, image.Id, old)
    if (old.State.Running) {
      await inspectIdle(receipt.oldId, receipt.name)
      await dockerEngine('POST', `/containers/${receipt.oldId}/stop?t=10`)
    }
    receipt.phase = 'stopped'; save()
  }
  receipt.retainedName ??= `${receipt.name}-retained-${receipt.oldId.slice(0, 12)}`
  if (receipt.phase === 'stopped') {
    const current = await dockerEngine('GET', `/containers/${receipt.oldId}/json`)
    if (current.State.Running) throw new Error('old slot restarted during promotion')
    if (current.Name !== `/${receipt.retainedName}`) await dockerEngine('POST', `/containers/${receipt.oldId}/rename?name=${receipt.retainedName}`)
    receipt.phase = 'retained'; save()
  }
  if (receipt.phase === 'retained') {
    await arm(id)
    await verifyRuntime(id, image.Id, old)
    const current = await dockerEngine('GET', `/containers/${id}/json`)
    if (current.Name !== `/${receipt.name}`) await dockerEngine('POST', `/containers/${id}/rename?name=${receipt.name}`)
    receipt.phase = 'promoted'; save()
  }
  await arm(id)
  await verifyRuntime(id, image.Id, old)
  await inspectIdle(id, receipt.name)
  const retained = await dockerEngine('GET', `/containers/${receipt.oldId}/json`)
  if (retained.State.Running) throw new Error('retained old container unexpectedly running')
  return id
}
