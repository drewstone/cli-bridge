/**
 * End-to-end proof of the worker filesystem jail (fs-jail / WORKER_FS_JAIL).
 *
 * Unlike tests/jail.test.ts (which only inspects the rewritten argv), this
 * ACTUALLY spawns a jailed `bash` through the real bwrap wrapper and asserts,
 * against a live sandbox:
 *
 *   BLOCKED  — a jailed shell cannot read a host "secret" file outside its
 *              workspace (stand-in for the benchmark repo's task defs / grader
 *              answer keys) nor list the host repo tree.
 *   ALLOWED  — a jailed shell can still write in its workspace and run
 *              node / python3 / curl-to-localhost (the model + twin path).
 *
 * Run:  pnpm tsx scripts/verify-fs-jail.ts
 * Exit: 0 = all checks passed (or SKIP when bwrap can't run here), 1 = a check
 *       failed (a leak, or a legitimate capability broke).
 *
 * SKIPs (exit 0, loud) when unprivileged bwrap is unavailable on this host, so
 * CI on a locked-down runner does not go red for an environment reason.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LinuxBwrapJail } from '../src/jail/linux-bwrap.js'
import { resolveJailSpec } from '../src/jail/resolve-spec.js'
import type { JailSpec } from '../src/jail/types.js'

const jail = new LinuxBwrapJail()

interface Check {
  name: string
  /** Shell command run inside the jail. */
  cmd: string
  /** 'block' expects a NON-zero exit (access denied); 'allow' expects zero. */
  expect: 'block' | 'allow'
  /** Optional substring the stdout must contain (allow checks only). */
  wants?: string
}

async function runInJail(spec: JailSpec, cmd: string): Promise<{ status: number; out: string; err: string }> {
  const wrap = await jail.wrap('bash', ['-c', cmd], spec)
  // Async spawn (not spawnSync): the localhost twin is served by THIS process's
  // event loop, which spawnSync would block — leaving the jailed curl to hang.
  return await new Promise((resolve) => {
    const child = spawn(wrap.bin, wrap.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status: status ?? -1, out: out.trim(), err: err.trim() })
    })
  })
}

async function main(): Promise<void> {
  if (!jail.isAvailable()) {
    console.log('SKIP: unprivileged bwrap is unavailable on this host — cannot prove the fs-jail here.')
    console.log('      Enable with `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`')
    console.log('      or `sudo chmod u+s /usr/bin/bwrap`, then re-run.')
    process.exit(0)
  }

  // A clean workspace (as VB hands the coder) + a host "secret" OUTSIDE it that
  // the jail must hide — the stand-in for the benchmark task defs + grader keys.
  const workspace = mkdtempSync(join(tmpdir(), 'fsjail-verify-ws-'))
  const secretDir = mkdtempSync(join(tmpdir(), 'fsjail-verify-secret-'))
  const secretFile = join(secretDir, 'grader-answer-key.ts')
  writeFileSync(secretFile, 'export const ANSWER = "42-cheating"\n')

  // A localhost "twin" the jailed worker must still reach over the network.
  const twin = createServer((_q, s) => s.end('twin-ok')).listen(0)
  await new Promise((r) => twin.once('listening', r))
  const twinPort = (twin.address() as { port: number }).port

  // The real production path: an operator sets WORKER_FS_JAIL=1; the spec is
  // resolved exactly as the chat route resolves it.
  const spec = resolveJailSpec({ cwd: workspace, env: { WORKER_FS_JAIL: '1' } })
  if (!spec?.readConfine) {
    console.error('FAIL: resolveJailSpec(WORKER_FS_JAIL=1) did not produce a read-confined spec')
    process.exit(1)
  }

  // Real host repo tree, if present, gets an extra explicit block check.
  const hostRepo = '/home/drew/code'
  const ghostAdmin = '/home/drew/code/blueprint-agent/scripts/experiments/scenarios/verticals/infra/api-ghost-admin.ts'

  const checks: Check[] = [
    { name: 'BLOCK read host secret file (grader key stand-in)', cmd: `cat ${secretFile}`, expect: 'block' },
    { name: 'BLOCK list the secret dir', cmd: `ls ${secretDir}`, expect: 'block' },
    ...(existsSync(hostRepo) ? [{ name: `BLOCK list host repo ${hostRepo}`, cmd: `ls ${hostRepo}`, expect: 'block' as const }] : []),
    ...(existsSync(ghostAdmin) ? [{ name: 'BLOCK cat the real ghost-admin task/grader file', cmd: `cat ${ghostAdmin}`, expect: 'block' as const }] : []),
    { name: 'ALLOW write a file in the workspace', cmd: 'echo built > solution.txt && cat solution.txt', expect: 'allow', wants: 'built' },
    { name: 'ALLOW run node', cmd: 'node -e "console.log(2+2)"', expect: 'allow', wants: '4' },
    { name: 'ALLOW run python3', cmd: 'python3 -c "print(6*7)"', expect: 'allow', wants: '42' },
    { name: 'ALLOW curl the localhost twin', cmd: `curl -s http://127.0.0.1:${twinPort}`, expect: 'allow', wants: 'twin-ok' },
  ]

  let failed = 0
  for (const c of checks) {
    const { status, out, err } = await runInJail(spec, c.cmd)
    let ok: boolean
    if (c.expect === 'block') ok = status !== 0
    else ok = status === 0 && (c.wants ? out.includes(c.wants) : true)
    if (!ok) failed++
    const tag = ok ? 'PASS' : 'FAIL'
    const detail = c.expect === 'block'
      ? `exit=${status} (want non-zero)`
      : `exit=${status} out=${JSON.stringify(out)}${c.wants ? ` want~=${JSON.stringify(c.wants)}` : ''}`
    console.log(`[${tag}] ${c.name} — ${detail}${!ok && err ? ` err=${JSON.stringify(err.slice(0, 200))}` : ''}`)
  }

  twin.close()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(secretDir, { recursive: true, force: true })

  if (failed) {
    console.error(`\n${failed} check(s) FAILED — the fs-jail is NOT holding.`)
    process.exit(1)
  }
  console.log('\nAll fs-jail checks PASSED: reads outside the workspace are blocked; build + node + python + curl-localhost work.')
}

main().catch((err) => {
  console.error('verify-fs-jail crashed:', err)
  process.exit(1)
})
