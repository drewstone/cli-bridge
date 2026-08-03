import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (packageJson.name !== '@tangle-network/cli-bridge') throw new Error('release package name is not @tangle-network/cli-bridge')
if (Object.keys(packageJson.bin ?? {}).join(',') !== 'cli-bridge') throw new Error('release must expose exactly one cli-bridge bin')
if (packageJson.publishConfig?.provenance !== true || packageJson.publishConfig?.access !== 'public') throw new Error('release must require public npm provenance')
const publishWorkflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')
if (!publishWorkflow.includes('id-token: write') || !publishWorkflow.includes('--provenance')) throw new Error('trusted publishing workflow lacks OIDC or provenance')
const testWorkflow = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8')
if (!testWorkflow.includes('pnpm source-install:check')) throw new Error('required CI omits the clean source install check')
if (!packageJson.scripts?.['release:check']?.includes('source-install:check')) {
  throw new Error('release preflight omits the clean source install check')
}
if (!publishWorkflow.includes('pnpm release:check')) throw new Error('publish workflow bypasses the release preflight')

const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' })
const report = JSON.parse(raw.slice(raw.indexOf('[')))
const files = report[0]?.files?.map(file => file.path).sort() ?? []
const allowed = /^(?:dist\/|README\.md$|LICENSE$|package\.json$)/u
const unexpected = files.filter(file => !allowed.test(file))
if (unexpected.length > 0) throw new Error(`release tarball contains non-release files: ${unexpected.join(', ')}`)
if (!files.includes('dist/cli.js')) throw new Error('release tarball does not contain dist/cli.js')
if (files.some(file => /(?:src|tests|scripts|\.env|\.sqlite|node_modules)/u.test(file))) {
  throw new Error('release tarball contains source, tests, scripts, secrets, or installed dependencies')
}
console.log(`package release check passed: ${files.length} whitelisted files, dist/cli.js present`)
