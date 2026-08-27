import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs'])
const TYPESCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const
const SOURCE_ROOTS = ['src', 'scripts'] as const

export interface ImportGraph {
  files: Set<string>
  edges: Map<string, Set<string>>
}

export interface GraphReport {
  label: string
  graph: ImportGraph
  cyclicComponents: string[][]
}

export function buildImportGraph(files: ReadonlyMap<string, string>): ImportGraph {
  const graph: ImportGraph = { files: new Set(files.keys()), edges: new Map() }
  for (const file of graph.files) graph.edges.set(file, new Set())

  for (const [file, source] of files) {
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(file),
    )
    const dependencies = graph.edges.get(file)!
    for (const specifier of moduleSpecifiers(sourceFile)) {
      const resolved = resolveImportSpecifier(file, specifier, graph.files)
      if (resolved) dependencies.add(resolved)
    }
  }
  return graph
}

/** Resolve a relative import against the in-memory source-file set. */
export function resolveImportSpecifier(importer: string, specifier: string, files: ReadonlySet<string>): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier))
  const candidates = moduleCandidates(base)
  return candidates.find(candidate => files.has(candidate)) ?? null
}

export function stronglyConnectedComponents(graph: ImportGraph): string[][] {
  let index = 0
  const indices = new Map<string, number>()
  const lowLinks = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const components: string[][] = []

  const visit = (node: string): void => {
    indices.set(node, index)
    lowLinks.set(node, index)
    index += 1
    stack.push(node)
    onStack.add(node)

    for (const dependency of graph.edges.get(node) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency)
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(dependency)!))
      } else if (onStack.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(dependency)!))
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return
    const component: string[] = []
    while (true) {
      const member = stack.pop()!
      onStack.delete(member)
      component.push(member)
      if (member === node) break
    }
    component.sort()
    components.push(component)
  }

  for (const file of [...graph.files].sort()) {
    if (!indices.has(file)) visit(file)
  }
  return components
}

export function cyclicComponents(graph: ImportGraph): string[][] {
  return stronglyConnectedComponents(graph).filter(component =>
    component.length > 1 || graph.edges.get(component[0]!)?.has(component[0]!),
  )
}

/** Return only cycles that are new or larger than every prior SCC containing them. */
export function graphViolations(current: ImportGraph, priorGraphs: readonly ImportGraph[]): string[] {
  const priorCycles = priorGraphs.flatMap(graph => cyclicComponents(graph))
  const violations: string[] = []
  for (const component of cyclicComponents(current)) {
    const prior = priorCycles.find(previous => component.every(file => previous.includes(file)))
    const enlarged = prior ?? priorCycles.find(previous => previous.every(file => component.includes(file)))
    if (!enlarged) {
      violations.push(`new cycle/SCC: ${component.join(' -> ')}`)
    } else if (component.length > enlarged.length) {
      violations.push(`enlarged SCC (${enlarged.length} -> ${component.length}): ${component.join(' -> ')}`)
    }
  }
  return violations
}

export function moduleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const result: string[] = []
  const add = (value: ts.Node | undefined): void => {
    if (value && ts.isStringLiteral(value)) result.push(value.text)
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier)
    if (ts.isExportDeclaration(node)) add(node.moduleSpecifier)
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal)
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) add(node.moduleReference.expression)
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0])
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return result
}

function moduleCandidates(base: string): string[] {
  const extension = posix.extname(base)
  const candidates: string[] = []
  const add = (value: string): void => {
    if (!candidates.includes(value)) candidates.push(value)
  }

  if (SOURCE_EXTENSIONS.has(extension)) add(base)
  else if (JAVASCRIPT_EXTENSIONS.has(extension)) {
    const stem = base.slice(0, -extension.length)
    for (const replacement of TYPESCRIPT_EXTENSIONS) add(`${stem}${replacement}`)
  } else if (!extension) {
    for (const replacement of TYPESCRIPT_EXTENSIONS) add(`${base}${replacement}`)
  }

  const directory = JAVASCRIPT_EXTENSIONS.has(extension) || SOURCE_EXTENSIONS.has(extension)
    ? base.slice(0, -extension.length)
    : base
  for (const replacement of TYPESCRIPT_EXTENSIONS) add(posix.join(directory, `index${replacement}`))
  return candidates
}

function isSourceFile(file: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(file))
}

function scriptKindFor(file: string): ts.ScriptKind {
  return extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

function readCurrentFiles(repoRoot: string): Map<string, string> {
  const files = new Map<string, string>()
  for (const root of SOURCE_ROOTS) {
    const absoluteRoot = join(repoRoot, root)
    if (!statExists(absoluteRoot)) continue
    walk(absoluteRoot, file => {
      const relativePath = relative(repoRoot, file).split(sep).join('/')
      if (isSourceFile(relativePath)) files.set(relativePath, readFileSync(file, 'utf8'))
    })
  }
  return files
}

function readGitFiles(repoRoot: string, ref: string): Map<string, string> {
  const files = new Map<string, string>()
  const listing = git(repoRoot, ['ls-tree', '-r', '--name-only', ref, '--', ...SOURCE_ROOTS])
  for (const file of listing.split('\n').filter(Boolean)) {
    if (!isSourceFile(file)) continue
    try {
      files.set(file, gitFile(repoRoot, file, ref))
    } catch {
      // A path that disappears between the tree listing and show is absent from this snapshot.
    }
  }
  return files
}

function walk(directory: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(directory)) {
    const file = join(directory, entry)
    if (statExists(file) && statSync(file).isDirectory()) walk(file, visit)
    else visit(file)
  }
}

function statExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function gitFile(repoRoot: string, file: string, ref: string): string {
  return execFileSync('git', ['show', `${ref}:${file}`], { cwd: repoRoot, encoding: 'utf8' })
}

function refOrNull(repoRoot: string, args: string[]): string | null {
  try {
    return git(repoRoot, args)
  } catch {
    return null
  }
}

export function runGraphAudit(repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')): {
  reports: GraphReport[]
  violations: string[]
} {
  const head = git(repoRoot, ['rev-parse', 'HEAD'])
  const mergeBase = refOrNull(repoRoot, ['merge-base', head, 'origin/main']) ?? git(repoRoot, ['rev-parse', `${head}^1`])
  const parentRefs = [refOrNull(repoRoot, ['rev-parse', `${head}^1`]), refOrNull(repoRoot, ['rev-parse', `${head}^2`])].filter(
    (ref): ref is string => ref !== null,
  )
  const reports = [
    { label: 'merge-base', graph: buildImportGraph(readGitFiles(repoRoot, mergeBase)) },
    ...parentRefs.map((ref, index) => ({ label: `parent-${index + 1}`, graph: buildImportGraph(readGitFiles(repoRoot, ref)) })),
    { label: 'current', graph: buildImportGraph(readCurrentFiles(repoRoot)) },
  ].map(report => ({ ...report, cyclicComponents: cyclicComponents(report.graph) }))
  const current = reports.find(report => report.label === 'current')!
  const prior = reports.filter(report => report.label !== 'current').map(report => report.graph)
  return { reports, violations: graphViolations(current.graph, prior) }
}

function main(): void {
  const result = runGraphAudit()
  for (const report of result.reports) {
    const edgeCount = [...report.graph.edges.values()].reduce((count, edges) => count + edges.size, 0)
    console.log(`${report.label}\tfiles=${report.graph.files.size}\tedges=${edgeCount}\tcycles=${report.cyclicComponents.length}`)
    for (const component of report.cyclicComponents) console.log(`  ${component.join(' -> ')}`)
  }
  if (result.violations.length > 0) {
    console.error('Import graph violations:')
    for (const violation of result.violations) console.error(`  ${violation}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
