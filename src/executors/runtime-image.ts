/** One default runtime reference and one lease for its supported publishers. */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { acquireDataDirectoryLock } from '../runtime/single-instance.js'

const DEFAULT_RUNTIME_IMAGE = 'cli-bridge-cli-runtime:latest'
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/u)

export function runtimeImageReference(env: NodeJS.ProcessEnv = process.env): string {
  const reference = env.BRIDGE_DEFAULT_DOCKER_IMAGE ?? DEFAULT_RUNTIME_IMAGE
  const colon = reference.lastIndexOf(':')
  if (reference.length > 255 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(reference) ||
      colon <= reference.lastIndexOf('/') || colon === reference.length - 1 || reference.startsWith('sha256:')) {
    throw new Error('BRIDGE_DEFAULT_DOCKER_IMAGE requires a named Docker image tag')
  }
  return reference
}

export function runtimeDockerHost(): string {
  const host = process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock'
  if (!host.startsWith('unix://')) throw new Error('runtime default publication requires a local Docker socket')
  return `unix://${realpathSync(host.slice(7))}`
}

/** Both the existing build command and admin publication use the same daemon/tag lease. */
export function acquireRuntimeImageLock(reference: string) {
  const key = createHash('sha256').update(`${runtimeDockerHost()}\0${reference}`).digest('hex')
  return acquireDataDirectoryLock(join(tmpdir(), `cli-bridge-runtime-image-${key}`))
}

export const runtimeDefaultPromotionSchema = z.object({ reference: z.string(),
  expectedImageId: imageId, imageId, phase: z.enum(['intent', 'published']), }).strict()
export type RuntimeDefaultPromotion = z.infer<typeof runtimeDefaultPromotionSchema>
