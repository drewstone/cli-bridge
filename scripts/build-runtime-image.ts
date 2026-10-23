#!/usr/bin/env tsx
/** Existing image build command: retain its lease across exec into Docker. */
import { execFileSync } from 'node:child_process'
import { acquireRuntimeImageLock, runtimeDockerHost, runtimeImageReference } from '../src/executors/runtime-image.js'

if (typeof process.execve !== 'function') throw new Error('runtime image publication requires Node with process.execve support')
const reference = runtimeImageReference()
const host = runtimeDockerHost()
const args = process.argv.slice(2)
if (args.some((arg) => arg.startsWith('-t') || arg === '--tag' || arg.startsWith('--tag=') ||
    arg.startsWith('-o') || arg === '--output' || arg.startsWith('--output=') || arg === '--push')) {
  throw new Error('the runtime builder publishes only BRIDGE_DEFAULT_DOCKER_IMAGE; alternate tag/output/push flags are unsupported')
}
const docker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim()
const lock = acquireRuntimeImageLock(reference)
try {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.DOCKER_CONTEXT
  // execve preserves PID/start identity. The lease stays live until Docker
  // exits; its next owner reclaims it through the existing lock protocol.
  process.execve(docker, ['docker', '--host', host, 'build', '-f', 'docker/Dockerfile.cli-runtime',
    '-t', reference, '.', ...args], env)
} catch (error) {
  lock.release()
  throw error
}
