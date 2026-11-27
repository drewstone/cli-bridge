import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadConfig, startServer } from '../src/server.js'

/**
 * A profile that names its skill and a mounted file by GitHub reference runs on the Bridge's local claude-code
 * path. Before this, materialization refused it ("github refs need async pre-resolution") and no such profile
 * could start. The references are pinned to a public commit of this repository and fetched from GitHub for real.
 */
const COMMIT = '0339d41af94006ceb268448e5710f34c7f4114df'
const SKILL_SHA256 = '7c505520ad7cc77e78c79d0488f19302ee7738270ca378bb3b253ce092b34131'
const LICENSE_SHA256 = '4abfe54224d08e40622887bcccca0ff3a648bed7e2f8879b3184876cfecbf29b'

/** A stand-in `claude`: it records in its cwd that it started, then answers with the sha256 of each mounted file in its cwd. */
const harness = String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const { createHash } = require('node:crypto')
if (process.argv.includes('--version')) { console.log('github-resources-peer 1.0'); process.exit(0) }
fs.writeFileSync('peer-started', 'started')
const digest = (path) => { try { return createHash('sha256').update(fs.readFileSync(path)).digest('hex') } catch { return 'missing' } }
const text = 'skill ' + digest('.claude/skills/profile-authoring/SKILL.md') + ' license ' + digest('.claude/skills/profile-authoring/LICENSE')
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'github-resources-native' }))
console.log(JSON.stringify({ type: 'assistant', message: { id: 'msg_done', content: [{ type: 'text', text }] } }))
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'github-resources-native', usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }))
`

const github = (path: string, name?: string) => ({
  kind: 'github',
  repository: 'drewstone/cli-bridge',
  ref: COMMIT,
  path,
  ...(name === undefined ? {} : { name }),
})

it('a profile with commit-pinned GitHub resources mounts their exact bytes, and an unreadable one fails before the harness starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profile-github-resources-'))
  const binary = join(root, 'claude')
  await writeFile(binary, harness)
  await chmod(binary, 0o755)
  const server = await startServer({ cwd: root, quiet: true, handleSignals: false,
    config: { ...loadConfig({ BRIDGE_HOST: '127.0.0.1', BRIDGE_DATA_DIR: join(root, 'state'), BRIDGE_BACKENDS: 'claude',
      BRIDGE_JAIL_MODE: 'off', CLAUDE_BIN: binary }), port: 0 } })
  try {
    const post = async (cwd: string, profile: unknown) => {
      await mkdir(cwd, { recursive: true })
      const response = await fetch(`${server.url}/v1/chat/completions`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-code/test', cwd, agent_profile: profile,
          messages: [{ role: 'user', content: 'Report the mounted files.' }] }) })
      return { status: response.status, text: await response.text() }
    }
    const profile = { name: 'pinned-resources', resources: {
      skills: [github('tests/fixtures/profile-authoring-SKILL.md', 'profile-authoring')],
      files: [{ path: '.claude/skills/profile-authoring/LICENSE', resource: github('LICENSE') }],
    } }

    // Two turns in fresh workspaces: the second takes the pinned bytes the first fetched.
    for (const workspace of ['first', 'second']) {
      const reply = await post(join(root, workspace), profile)
      expect(reply.status, reply.text).toBe(200)
      const answer = JSON.parse(reply.text) as { choices: Array<{ message: { content: string } }> }
      expect(answer.choices[0]!.message.content).toBe(`skill ${SKILL_SHA256} license ${LICENSE_SHA256}`)
    }

    const missing = await post(join(root, 'missing'), { name: 'missing-resource', resources: {
      files: [{ path: 'notes/absent.md', resource: github('no-such-file.md') }],
    } })
    expect(missing.status).toBeGreaterThanOrEqual(400)
    expect(missing.text).toContain('AgentProfile resources could not be fetched')
    expect(missing.text).toContain('404')
    await expect(access(join(root, 'missing', 'peer-started'))).rejects.toThrow()
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
