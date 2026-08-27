import { describe, expect, it } from 'vitest'
import {
  buildImportGraph,
  cyclicComponents,
  graphViolations,
  resolveImportSpecifier,
} from '../scripts/check-import-graph.js'

describe('parser-backed import graph', () => {
  it('captures static, re-export, type, require, and dynamic imports with TypeScript resolution', () => {
    const files = new Map([
      ['src/a.ts', [
        "import value from './b.js'",
        "export { thing } from './c.js'",
        "type Imported = import('./d.js').Value",
        "const required = require('./e.js')",
        "const loaded = import('./f.js')",
        'void value; void thing; void (0 as Imported); void required; void loaded',
      ].join('\n')],
      ['src/b.ts', 'export default 1'],
      ['src/c.tsx', 'export const thing = 2'],
      ['src/d.mts', 'export type Value = string'],
      ['src/e.cts', 'export = 3'],
      ['src/f/index.ts', 'export const loaded = true'],
    ])
    const graph = buildImportGraph(files)
    expect([...graph.edges.get('src/a.ts')!].sort()).toEqual([
      'src/b.ts',
      'src/c.tsx',
      'src/d.mts',
      'src/e.cts',
      'src/f/index.ts',
    ])
  })

  it('resolves .js, extensionless, and index imports without accepting package names', () => {
    const files = new Set(['src/a.ts', 'src/b.ts', 'src/c.tsx', 'src/nested/index.mts'])
    expect(resolveImportSpecifier('src/a.ts', './b.js', files)).toBe('src/b.ts')
    expect(resolveImportSpecifier('src/a.ts', './c', files)).toBe('src/c.tsx')
    expect(resolveImportSpecifier('src/a.ts', './nested', files)).toBe('src/nested/index.mts')
    expect(resolveImportSpecifier('src/a.ts', 'external-package', files)).toBeNull()
  })

  it('detects a mutation that creates a new cycle and rejects SCC enlargement', () => {
    const baseline = buildImportGraph(new Map([
      ['src/a.ts', "import './b.js'"],
      ['src/b.ts', 'export const value = 1'],
    ]))
    const mutated = buildImportGraph(new Map([
      ['src/a.ts', "import './b.js'"],
      ['src/b.ts', "import './a.js'; export const value = 1"],
    ]))
    expect(cyclicComponents(baseline)).toEqual([])
    expect(cyclicComponents(mutated)).toEqual([['src/a.ts', 'src/b.ts']])
    expect(graphViolations(mutated, [baseline])).toEqual([
      'new cycle/SCC: src/a.ts -> src/b.ts',
    ])

    const priorCycle = buildImportGraph(new Map([
      ['src/a.ts', "import './b.js'"],
      ['src/b.ts', "import './a.js'"],
      ['src/c.ts', 'export const value = 1'],
    ]))
    const enlarged = buildImportGraph(new Map([
      ['src/a.ts', "import './b.js'"],
      ['src/b.ts', "import './a.js'; import './c.js'"],
      ['src/c.ts', "import './a.js'; export const value = 1"],
    ]))
    expect(graphViolations(enlarged, [priorCycle])).toEqual([
      'enlarged SCC (2 -> 3): src/a.ts -> src/b.ts -> src/c.ts',
    ])
  })
})
