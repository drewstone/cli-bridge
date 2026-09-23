import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { hostSpawner } from '../src/executors/host.js'
import { lineageChildEnv, withLineageEnv } from '../src/trace/lineage.js'

const RUN = `run_${'a'.repeat(32)}`
const PARENT = `run_${'b'.repeat(32)}`

function headers(values: Record<string, string>): (name: string) => string | undefined {
  return (name) => values[name]
}

describe('lineageChildEnv', () => {
  it('stamps nothing without a run id', () => {
    expect(lineageChildEnv(headers({ 'x-tangle-project': 'p' }))).toBeNull()
  })

  it('maps x-tangle-* headers to TANGLE_* with this host and a cleared Claude session', () => {
    const env = lineageChildEnv(headers({
      'x-tangle-run-id': RUN,
      'x-tangle-parent-run-id': PARENT,
      'x-tangle-root-run-id': PARENT,
      'x-tangle-edge-kind': 'spawned',
      'x-tangle-operator': 'op-platform',
      'x-tangle-project': 'agent-runtime',
      'x-tangle-account': 'a@b.c',
      'x-tangle-harness': 'claude-code',
    }), { LINEAGE_HOST: 'Box-A.local' })
    expect(env).toEqual({
      TANGLE_RUN_ID: RUN,
      TANGLE_PARENT_RUN_ID: PARENT,
      TANGLE_ROOT_RUN_ID: PARENT,
      TANGLE_EDGE_KIND: 'spawned',
      TANGLE_OPERATOR: 'op-platform',
      TANGLE_PROJECT: 'agent-runtime',
      TANGLE_ACCOUNT: 'a@b.c',
      TANGLE_HARNESS: 'claude-code',
      TANGLE_HOST: 'box-a',
      TANGLE_CLAUDE_SESSION: '',
    })
  })

  it('drops header values that could carry env or shell syntax', () => {
    const env = lineageChildEnv(headers({
      'x-tangle-run-id': RUN,
      'x-tangle-project': 'x; rm -rf /',
      'x-tangle-operator': `a${'b'.repeat(200)}`,
      'x-tangle-account': 'ok\nINJECTED=1',
    }))
    expect(env?.TANGLE_PROJECT).toBeUndefined()
    expect(env?.TANGLE_OPERATOR).toBeUndefined()
    expect(env?.TANGLE_ACCOUNT).toBeUndefined()
    expect(lineageChildEnv(headers({ 'x-tangle-run-id': 'run id with spaces' }))).toBeNull()
  })

  it('merges OTel resource attributes over the child env', () => {
    const merged = withLineageEnv(
      { PATH: '/bin', OTEL_RESOURCE_ATTRIBUTES: 'service.name=x,tangle.run.id=stale' },
      { TANGLE_RUN_ID: RUN, TANGLE_PROJECT: 'a,b' },
    )
    expect(merged?.PATH).toBe('/bin')
    expect(merged?.OTEL_RESOURCE_ATTRIBUTES).toBe(`service.name=x,tangle.run.id=${RUN},tangle.project=a%2Cb`)
    expect(withLineageEnv({ PATH: '/bin' }, null)).toEqual({ PATH: '/bin' })
  })
})

describe('host spawner', () => {
  const saved = process.env.TANGLE_RUN_ID
  beforeEach(() => {
    // The bridge daemon's own lineage must never become a child's.
    process.env.TANGLE_RUN_ID = PARENT
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.TANGLE_RUN_ID
    else process.env.TANGLE_RUN_ID = saved
  })

  async function childSees(lineageEnv?: Record<string, string>): Promise<{ run: string | null; host: string | null }> {
    const { child, release } = await hostSpawner(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify({run: process.env.TANGLE_RUN_ID ?? null, host: process.env.TANGLE_HOST ?? null}))'],
      { env: process.env, ...(lineageEnv ? { lineageEnv } : {}) },
    )
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString() })
    await new Promise((resolve) => child.once('exit', resolve))
    release()
    return JSON.parse(out) as { run: string | null; host: string | null }
  }

  it('gives the child the request lineage over the sanitized env', async () => {
    const env = lineageChildEnv(headers({ 'x-tangle-run-id': RUN }), { LINEAGE_HOST: 'box-a' })
    expect(await childSees(env ?? undefined)).toEqual({ run: RUN, host: 'box-a' })
  })

  it('keeps the daemon ambient run out of an unstamped child', async () => {
    expect(await childSees()).toEqual({ run: null, host: null })
  })
})

describe('every backend forwards lineage beside the jail', () => {
  it('pairs each jail forward with a lineage forward', () => {
    // A backend that forgets the forward silently drops lineage for every request it serves.
    const dir = join(__dirname, '..', 'src', 'backends')
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8')
      const jails = source.split('{ jail: req.jailSpec }').length - 1
      const lineages = source.split('{ lineageEnv: req.childLineage }').length - 1
      expect({ file, lineages }).toEqual({ file, lineages: jails })
    }
  })
})
