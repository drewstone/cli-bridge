#!/usr/bin/env node
// The test files the commits GATE_BASE..HEAD reach, this BEELINK_GATE_SHARD's share of them, and with --run their run.
// tangle-tools deploy/deploy-check runs `GATE_BASE=<proven base> pnpm run test:affected` in three Beelink gate shards
// before a cli-bridge deploy rolls; a pass with nothing selected rolls.
//
// Each changed file reaches the test files that vitest's own module graph (the walk `vitest related` does) finds
// importing it, directly or through other modules. A module that names a reached file in a relative tsImport() or
// new URL() is reached too, until nothing new is: a test that runs a fixture by path (uncapped-host) reaches what the
// fixture imports, and src/jail/landlock-exec.py reaches its tests through src/jail/linux-landlock.ts. Every named
// module and node --test *.integration.mjs joins the walk, so the graph also holds what they import.
// A changed file outside the docs (*.md, docs/) that reaches no test file selects every test file: a file read through
// a joined path (profiles/*.json, tests/fixtures/durable-run-server.ts), index.mjs, types/*.d.ts, a lockfile, a
// tsconfig, this file, a deleted file. vitest itself answers every test file for a package.json or vitest.config.ts.
// The walk runs without vitest's fsModuleCache, whose entries can carry an import graph from another tree.
// A test that says `deploy-check: full run only` (deploy-check's own marker) needs a host that a Beelink gate is not.
//
// Usage: GATE_BASE=<ref> [BEELINK_GATE_SHARD=<i>/<n>] node tools/affected-tests.mjs [--run], from the repository root
//   prints this shard's test files, largest first to each shard in turn; `pnpm run test:affected` (--run) then
//   typechecks in shard 1 when the range selects any and runs the share's vitest files and node --test files. A killed step keeps its signal's
//   exit code, which deploy-check holds on; any other failure exits 1.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { constants } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { createVitest } from 'vitest/node'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean)
const names = new Map(git('ls-files', '--', '*.ts', '*.mjs', '*.js').map((file) => [file, [...readFileSync(file, 'utf8')
  .matchAll(/(?:tsImport|new URL)\(['"](\.\.?\/[^'"]+)/gu)].map((match) => join(dirname(file), match[1]))]))
const tests = [...names.keys()].filter((file) => /\.test\.ts$|\.integration\.mjs$/u.test(file))
const vitest = await createVitest('test', { watch: false, fsModuleCache: false,
  include: [...tests, ...[...names.values()].flat().filter((path) => names.has(path))] })
const reaching = new Set()
let all = false
for (const path of git('diff', '--name-only', '--no-renames', `${process.env.GATE_BASE || 'origin/main'}...HEAD`)) {
  const reached = new Set([path])
  for (let size; size !== reached.size;) {
    size = reached.size
    vitest.config.related = [...reached].map((file) => resolve(file))
    for (const spec of await vitest.getRelevantTestSpecifications()) reached.add(relative('.', spec.moduleId))
    for (const [file, paths] of names) if (paths.some((named) => reached.has(named))) reached.add(file)
  }
  const found = tests.filter((test) => reached.has(test))
  found.forEach((test) => reaching.add(test))
  if ((all = !found.length && !/\.md$|^docs\//u.test(path))) break
}
await vitest.close()
const selected = (all ? tests : [...reaching].sort()).filter((file) => !readFileSync(file, 'utf8').includes('deploy-check: full run only'))
const [index, count] = (process.env.BEELINK_GATE_SHARD || '1/1').split('/').map(Number)
const share = selected.map((file) => [statSync(file).size, file]).sort(([a], [b]) => b - a)
  .filter((_, at) => at % count === index - 1).map(([, file]) => file).sort()
console.error(`affected-tests: selected ${all ? 'every test file' : selected.length}; shard ${index}/${count} runs:`)
console.log(share.join('\n'))
if (process.argv.includes('--run')) {
  const node = share.filter((test) => test.endsWith('.mjs')), unit = share.filter((test) => !node.includes(test))
  let exit = 0
  for (const [command, ...args] of [index === 1 && selected.length && ['tsc', '--noEmit'], unit.length && ['vitest', 'run', ...unit],
    node.length && ['node', '--test', ...node]].filter(Boolean)) {
    const { status, signal } = spawnSync(command, args, { stdio: 'inherit' })
    if (status !== 0) exit ||= signal ? 128 + constants.signals[signal] : 1
  }
  process.exit(exit)
}
