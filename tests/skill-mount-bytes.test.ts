/**
 * A mounted skill carries the exact bytes the profile declared.
 *
 * Measured motive: agent-profile-materialize 0.17.1 re-quoted a SKILL.md whose
 * frontmatter already carried a quoted description. On a scratch 0.17.1 install
 * (materializeProfile, 2026-09-06), the Lab's skills/profile-authoring/SKILL.md
 * (3,862 bytes) mounted as 3,866 bytes, and mounting that output again, as a
 * child that copies the mount would, gave 3,874. No live run recorded those
 * counts. That skill instructs every spawn-capable profile to carry a
 * byte-identical copy, which no agent can do while the mount itself changes the
 * bytes. 0.19.2 returns a normalized SKILL.md unchanged; this test pins that on
 * the bridge's own claude-code path.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { provisionProfileWorkspace } from '../src/backends/profile-support.js'
import type { ChatRequest } from '../src/backends/types.js'

const FIXTURE = new URL('./fixtures/profile-authoring-SKILL.md', import.meta.url)
const FIXTURE_BYTES = 3862
const FIXTURE_SHA256 = '7c505520ad7cc77e78c79d0488f19302ee7738270ca378bb3b253ce092b34131'
const MOUNT_PATH = '.claude/skills/profile-authoring/SKILL.md'

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

function mountSkill(content: string): Buffer {
  const root = mkdtempSync(join(tmpdir(), 'skill-mount-bytes-'))
  try {
    const req: ChatRequest = {
      model: 'claude-code/opus',
      messages: [{ role: 'user', content: 'work' }],
      agent_profile: {
        resources: { skills: [{ kind: 'inline', name: 'profile-authoring', content }] },
      },
    }
    const result = provisionProfileWorkspace(req, null, 'claude-code', root)
    expect(result.written).toEqual([MOUNT_PATH])
    expect(result.receipt?.files).toEqual([{ path: MOUNT_PATH, mode: 0o644 }])
    return readFileSync(join(root, MOUNT_PATH))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('skill mount bytes', () => {
  it('mounts the Lab profile-authoring skill byte-identical on the claude-code path', () => {
    const source = readFileSync(FIXTURE)
    expect(source.length).toBe(FIXTURE_BYTES)
    expect(sha256(source)).toBe(FIXTURE_SHA256)

    const mounted = mountSkill(source.toString('utf8'))

    expect(mounted.length).toBe(FIXTURE_BYTES)
    expect(sha256(mounted)).toBe(FIXTURE_SHA256)
    expect(mounted.equals(source)).toBe(true)
  })

  it('mounts a copy of the mounted skill byte-identical, as a child copying the mount would', () => {
    const source = readFileSync(FIXTURE)

    const first = mountSkill(source.toString('utf8'))
    const second = mountSkill(first.toString('utf8'))

    expect(second.length).toBe(FIXTURE_BYTES)
    expect(sha256(second)).toBe(FIXTURE_SHA256)
  })
})
