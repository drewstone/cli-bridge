import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { ContainerPool } from '../src/executors/container-pool.js'
import { createDockerSpawner } from '../src/executors/docker.js'

const execFileAsync = promisify(execFile)
const runRealDocker = process.env.CLI_BRIDGE_REAL_DOCKER_TESTS === '1'
const containers = new Set<string>()

describe.skipIf(!runRealDocker)('Docker cancellation with a real container', () => {
  afterEach(async () => {
    await Promise.all([...containers].map(async (name) => {
      await execFileAsync('docker', ['rm', '-f', name]).catch(() => {})
      containers.delete(name)
    }))
  })

  it('kills the in-container CLI tree before returning the pool slot', async () => {
    const image = process.env.CLI_BRIDGE_REAL_DOCKER_IMAGE ?? 'cli-bridge-cli-runtime:latest'
    const name = `cli-bridge-cancel-test-${randomUUID()}`
    const marker = `cli-bridge-orphan-${randomUUID()}`
    containers.add(name)
    await execFileAsync('docker', [
      'run', '-d', '--rm', '--name', name,
      '--entrypoint', 'tail', image, '-f', '/dev/null',
    ])

    let slotReleases = 0
    const pool = {
      acquire: async () => ({
        containerId: name,
        slotIndex: 0,
        release: () => { slotReleases += 1 },
      }),
    } as unknown as ContainerPool
    const spawner = createDockerSpawner({ pool })
    const script = [
      'const { spawn } = require("node:child_process");',
      `const marker = ${JSON.stringify(marker)};`,
      'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 100)", marker], { stdio: "ignore" });',
      'process.stdout.write(JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }) + "\\n");',
      'setInterval(() => {}, 100);',
    ].join('')
    const spawned = await spawner('node', ['-e', script, marker], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const pids = await readJsonLine(spawned.child.stdout)
    expect(pids).toMatchObject({
      parent: expect.any(Number),
      grandchild: expect.any(Number),
    })

    const before = await containerCommandLines(name)
    expect(before.filter((line) => line.includes(marker))).toHaveLength(2)
    expect(slotReleases).toBe(0)

    await spawned.terminate?.()
    spawned.release()

    const after = await containerCommandLines(name)
    expect(after.some((line) => line.includes(marker))).toBe(false)
    expect(slotReleases).toBe(1)
  }, 30_000)
})

async function readJsonLine(
  stdout: NodeJS.ReadableStream | null,
): Promise<{ parent: number; grandchild: number }> {
  if (!stdout) throw new Error('docker exec had no stdout')
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('timed out waiting for in-container pids')), 5_000)
    stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timer)
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as { parent: number; grandchild: number })
      } catch (error) {
        reject(error)
      }
    })
    stdout.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function containerCommandLines(container: string): Promise<string[]> {
  const script = 'for f in /proc/[0-9]*/cmdline; do tr "\\000" " " < "$f" 2>/dev/null || true; printf "\\n"; done'
  const result = await execFileAsync('docker', ['exec', container, 'sh', '-c', script], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  })
  return result.stdout.split('\n').filter(Boolean)
}
