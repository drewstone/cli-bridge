/**
 * opencode installs itself under $HOME (`~/.opencode/bin/opencode`), and an fs-jail deliberately
 * hides /home. A jailed run therefore exits 127 on a binary that exists:
 *
 *   opencode exited 127: timeout: failed to run command
 *   '/home/<user>/.opencode/bin/opencode': No such file or directory
 *
 * The generic derivation in `toolchainReadPaths` reaches the install root only when the on-PATH
 * entry realpaths INTO it. An operator whose `opencode` is a wrapper script somewhere else
 * realpaths to the wrapper's own directory, so the install root stays hidden and the 127 reads as
 * a missing binary rather than a jail gap. Measured on this host: 12 consecutive opencode runs
 * failed this way and the seat was recorded as an unusable harness.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OpencodeBackend } from '../src/backends/opencode.js'
import type { ChatRequest } from '../src/backends/types.js'
import type { JailSpec } from '../src/jail/types.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), 'opencode-jail-'))
  dirs.push(d)
  return d
}

/** Drive one chat turn far enough to reach jail registration, with a spawner that never runs. */
async function registerPaths(req: ChatRequest, spec: JailSpec): Promise<string[]> {
  req.jailSpec = spec
  const backend = new OpencodeBackend({
    bin: 'opencode',
    timeoutMs: 1_000,
    spawner: () => {
      throw new Error('spawn refused: this test only exercises pre-spawn registration')
    },
  })
  try {
    for await (const _ of backend.chat(req, null, new AbortController().signal)) {
      /* the spawner throws before any delta arrives */
    }
  } catch {
    /* expected: registration happens before the refused spawn */
  }
  return spec.extraReadablePaths ?? []
}

describe('opencode fs-jail binary visibility', () => {
  it('exposes the opencode install root so a jailed run can exec its own binary', async () => {
    const cwd = workspace()
    const spec: JailSpec = { root: cwd, projectDir: cwd, readConfine: true }
    const paths = await registerPaths(
      { model: 'opencode', cwd, messages: [{ role: 'user', content: 'hi' }] } as ChatRequest,
      spec,
    )
    expect(paths).toContain(join(homedir(), '.opencode'))
  })

  it('honours OPENCODE_INSTALL_DIR when the operator moved the install', async () => {
    const cwd = workspace()
    const installed = workspace()
    const spec: JailSpec = { root: cwd, projectDir: cwd, readConfine: true }
    const previous = process.env.OPENCODE_INSTALL_DIR
    process.env.OPENCODE_INSTALL_DIR = installed
    try {
      const paths = await registerPaths(
        { model: 'opencode', cwd, messages: [{ role: 'user', content: 'hi' }] } as ChatRequest,
        spec,
      )
      expect(paths).toContain(installed)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_INSTALL_DIR
      else process.env.OPENCODE_INSTALL_DIR = previous
    }
  })

  it('registers nothing when reads are not confined', async () => {
    const cwd = workspace()
    // A write-jail leaves the host filesystem readable, so there is no path to re-open and
    // `registerJailReadable` must stay a no-op rather than widening a spec that needs nothing.
    const spec: JailSpec = { root: cwd, projectDir: cwd }
    const paths = await registerPaths(
      { model: 'opencode', cwd, messages: [{ role: 'user', content: 'hi' }] } as ChatRequest,
      spec,
    )
    expect(paths).toEqual([])
  })
})
