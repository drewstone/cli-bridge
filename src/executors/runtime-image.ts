/** One default runtime reference and one lease for its supported publishers. */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { acquireDataDirectoryLock } from '../runtime/single-instance.js'

const DEFAULT_RUNTIME_IMAGE = 'cli-bridge-cli-runtime:latest'
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/u)

export function runtimeImageReference(env: NodeJS.ProcessEnv = process.env): string {
  const reference = env.BRIDGE_DEFAULT_DOCKER_IMAGE ?? DEFAULT_RUNTIME_IMAGE
  const colon = reference.lastIndexOf(':')
  const repository = reference.slice(0, colon)
  const tag = reference.slice(colon + 1)
  if (reference.length > 255 || !/^[a-z0-9][a-z0-9._:/-]*$/u.test(repository) ||
      !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/u.test(tag) ||
      colon <= reference.lastIndexOf('/') || reference.startsWith('sha256:')) {
    throw new Error('BRIDGE_DEFAULT_DOCKER_IMAGE requires a named Docker image tag')
  }
  // Docker's familiar and qualified names must acquire the same lease.
  // Domain rules: https://github.com/distribution/reference/blob/main/normalize.go
  const slash = repository.indexOf('/')
  const first = slash < 0 ? '' : repository.slice(0, slash)
  let domain = first === 'localhost' || /[.:]/u.test(first) ? first : 'docker.io'
  let remote = domain === first ? repository.slice(slash + 1) : repository
  if (domain === 'index.docker.io') domain = 'docker.io'
  if (domain === 'docker.io' && !remote.includes('/')) remote = `library/${remote}`
  return `${domain}/${remote}:${tag}`
}

export function runtimeDockerHost(): string {
  const host = process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock'
  if (!host.startsWith('unix://')) throw new Error('runtime default publication requires a local Docker socket')
  return `unix://${realpathSync(host.slice(7))}`
}

/** Both the existing build command and admin publication use the same daemon/tag lease. */
export function acquireRuntimeImageLock(reference: string) {
  const canonical = runtimeImageReference({ BRIDGE_DEFAULT_DOCKER_IMAGE: reference })
  const key = createHash('sha256').update(`${runtimeDockerHost()}\0${canonical}`).digest('hex')
  // Account identity, not HOME/XDG_STATE_HOME/TMPDIR: native service sandboxes
  // and the shell publisher must see the same durable per-user lease owner.
  const home = realpathSync(userInfo().homedir)
  return acquireDataDirectoryLock(join(home, '.local', 'state', 'cli-bridge', 'runtime-images', key))
}

export const runtimeDefaultPromotionSchema = z.object({ reference: z.string(),
  expectedImageId: imageId, imageId, phase: z.enum(['intent', 'published']), }).strict()
export type RuntimeDefaultPromotion = z.infer<typeof runtimeDefaultPromotionSchema>
