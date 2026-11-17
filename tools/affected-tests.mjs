#!/usr/bin/env node
// The test files the commits GATE_BASE..HEAD reach, this BEELINK_GATE_SHARD's share of them, and with --run their run.
// tangle-tools deploy/deploy-check runs `GATE_BASE=<proven base> pnpm run test:affected` in three Beelink gate shards
// before a cli-bridge deploy rolls; a pass with nothing selected rolls.
//
// Vitest's own module graph (the one `vitest related` walks) picks each *.test.ts that imports a changed file, directly
// or through other modules. A node --test *.integration.mjs runs when it, or a module it imports or loads by tsImport(),
// reaches a change in that graph. A module that names a changed file in a relative new URL(), import or tsImport()
// counts as changed, so a file no module imports (src/jail/landlock-exec.py, docker/Dockerfile) reaches its tests.
// A change to a package.json, pnpm-lock.yaml, pnpm-workspace.yaml, vitest.config.ts, a tsconfig or this file selects
// every test file.
//
// Usage: GATE_BASE=<ref> [BEELINK_GATE_SHARD=<i>/<n>] node tools/affected-tests.mjs [--run]
//   prints this shard's test files, one per line; --run prints the selection and this shard's share, typechecks in
//   shard 1 when a .ts changed, then runs the share's vitest files and node --test files.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { constants } from 'node:os'
import { basename, dirname, join, normalize, relative } from 'node:path'
import { defaultInclude } from 'vitest/config'
import { createVitest } from 'vitest/node'

const root = join(import.meta.dirname, '..'), base = process.env.GATE_BASE || 'origin/main'
const [index, count] = (process.env.BEELINK_GATE_SHARD || '1/1').split('/').map(Number)
if (!(index >= 1 && index <= count)) throw new Error(`BEELINK_GATE_SHARD=${process.env.BEELINK_GATE_SHARD} is not <i>/<n>`)
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean)
const NODE_TEST = /\.integration\.mjs$/u
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\btsImport\(\s*|\bnew URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/gu

const changed = git('diff', '--name-only', '--no-renames', `${base}...HEAD`)
const EVERYTHING = /(^|\/)package\.json$|^(pnpm-lock\.yaml|pnpm-workspace\.yaml|vitest\.config\.ts|tsconfig.*\.json|tools\/affected-tests\.mjs)$/u
const all = changed.some((path) => EVERYTHING.test(path))
// Each tracked module's relative specifiers, as repository paths; a module naming a changed file counts as changed.
const names = new Map(git('ls-files', '--', '*.ts', '*.mjs', '*.js').map((file) =>
  [file, [...readFileSync(join(root, file), 'utf8').matchAll(SPECIFIER)].map((match) => normalize(join(dirname(file), match[1])))]))
const related = new Set([...changed, ...[...names.keys()].filter((file) => names.get(file).some((path) => changed.includes(path)))])
const nodeTests = [...names.keys()].filter((file) => NODE_TEST.test(file))
const entries = (file) => [file, ...names.get(file).filter((path) => names.has(path))]

// The node tests and the modules they load join vitest's test files, so one walk of vitest's graph answers for both.
const vitest = await createVitest('test', {
  root, watch: false, related: all ? undefined : [...related].map((path) => join(root, path)),
  include: [...defaultInclude, ...new Set(nodeTests.flatMap(entries))],
})
const reached = new Set((await vitest.getRelevantTestSpecifications()).map((spec) => relative(root, spec.moduleId)))
await vitest.close()
const reaching = [...[...reached].filter((file) => /\.(test|spec)\.[cm]?[jt]sx?$/u.test(file)),
  ...nodeTests.filter((file) => related.has(file) || entries(file).some((entry) => reached.has(entry)))].sort()
// A test that says `deploy-check: full run only` (deploy-check's own marker) needs a host that a Beelink gate is not.
const deferred = reaching.filter((file) => readFileSync(join(root, file), 'utf8').includes('deploy-check: full run only'))
const selected = reaching.filter((file) => !deferred.includes(file))

// Largest first, each file to the shard holding the fewest bytes, as disco's tools/affected-tests.mjs splits its set.
const load = Array(count).fill(0)
const tests = selected.map((file) => [file, statSync(join(root, file)).size]).sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
  .filter(([, size]) => { const to = load.indexOf(Math.min(...load)); load[to] += size; return to === index - 1 })
  .map(([file]) => file).sort()
if (!process.argv.includes('--run')) process.stdout.write(tests.map((test) => `${test}\n`).join(''))
else {
  console.error(`affected-tests: ${base}..HEAD changes ${changed.length} files${all ? ', selecting every test file' : ''}; ` +
    `selected ${selected.length}: ${selected.join(' ')}${deferred.length ? `; deferred to a full run: ${deferred.join(' ')}` : ''}`)
  console.error(`affected-tests: shard ${index}/${count} runs ${tests.length}: ${tests.join(' ')}`)
  const steps = [], unit = tests.filter((test) => !NODE_TEST.test(test)), integration = tests.filter((test) => NODE_TEST.test(test))
  if (index === 1 && (all || changed.some((path) => path.endsWith('.ts')))) steps.push([join(root, 'node_modules/.bin/tsc'), ['--noEmit']])
  if (unit.length) steps.push([join(root, 'node_modules/.bin/vitest'), ['run', ...unit]])
  if (integration.length) steps.push([process.execPath, ['--test', ...integration]])
  let exit = 0
  for (const [command, args] of steps) {
    console.error(`affected-tests: ${basename(command)} ${args.join(' ')}`)
    const { status, signal } = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
    // A killed step keeps its signal's code, which deploy-check holds on; any other failure is a red.
    if (status !== 0 && exit === 0) exit = signal ? 128 + constants.signals[signal] : 1
  }
  process.exit(exit)
}
