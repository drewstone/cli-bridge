import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { lockedTraceContract } from '../src/trace/contract-build.js'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture(version = '2.0.0', packages = ['2.0.0', '2.1.0']) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-lock-')); dirs.push(dir)
  const file = join(dir, 'pnpm-lock.yaml')
  writeFileSync(file, `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@tangle-network/agent-trace-contract':
        specifier: ^2.0.0
        version: ${version}
  tests/consumer:
    dependencies:
      '@tangle-network/agent-trace-contract':
        specifier: ^2.1.0
        version: 2.1.0
packages:
${packages.map(v => `  '@tangle-network/agent-trace-contract@${v}':\n    resolution: {integrity: sha512-${v === '2.0.0' ? 'AAAA' : 'BBBB'}}\n`).join('')}`)
  return file
}
test('selects the root producer, not another workspace consumer', () => {
  expect(lockedTraceContract(fixture())).toEqual({ version: '2.0.0', integrity: 'sha512-AAAA' })
  expect(lockedTraceContract(fixture('2.1.0'))).toEqual({ version: '2.1.0', integrity: 'sha512-BBBB' })
})
test('refuses missing, duplicate, or non-registry root selections', () => {
  expect(() => lockedTraceContract(fixture('2.2.0'))).toThrow(/one integrity/)
  expect(() => lockedTraceContract(fixture('2.0.0', ['2.0.0', '2.0.0']))).toThrow(/one integrity/)
  expect(() => lockedTraceContract(fixture('file:patched'))).toThrow(/root importer/)
})
test('handles the actual multi-document pnpm lock without choosing a toolchain document', () => {
  expect(lockedTraceContract()).toMatchObject({ version: '2.0.0' })
  const file = fixture(); const app = readFileSync(file, 'utf8')
  writeFileSync(file, '---\nimporters:\n  .:\n    configDependencies: {}\n    packageManagerDependencies:\n      pnpm:\n        specifier: 12.6.0\n        version: 12.6.0\n---\n' + app)
  expect(lockedTraceContract(file)).toEqual({ version: '2.0.0', integrity: 'sha512-AAAA' })
  writeFileSync(file, app + '\n---\n' + app)
  expect(() => lockedTraceContract(file)).toThrow(/root importer/)
})
