/** Content digest stamped on spans to identify the installed trace-contract build. */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const PACKAGE = '@tangle-network/agent-trace-contract'
/** Absolute path of the `dist/` directory Node resolves this package's entry to. */
export function traceContractDistDir(fromFile: string = import.meta.url): string {
  return dirname(createRequire(fromFile).resolve(PACKAGE))
}

/**
 * SHA-256 over the resolved `dist/` tree: every file's path and bytes, in a
 * fixed order, with separators no path or content can forge.
 *
 * Whole tree rather than one entry file, because the entry is a re-export list
 * and the behaviour that differs between builds lives in the modules behind it.
 */
export function traceContractBuildId(fromFile: string = import.meta.url): string {
  const dist = traceContractDistDir(fromFile)
  const hash = createHash('sha256')
  for (const relativePath of treeFiles(dist)) {
    hash.update(relativePath)
    hash.update('\0')
    hash.update(readFileSync(join(dist, relativePath)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

const buildIdCache = new Map<string, string | null>()

/**
 * The build id for a producer that must not fail on account of its own
 * provenance: computed once per resolution root, `null` when the installed tree
 * cannot be read at all.
 *
 * A stamp is metadata about a request, so an unreadable `node_modules` costs the
 * stamp and never the completion. `null` is recorded as an absent attribute
 * rather than a placeholder string, because a reader must be able to tell "this
 * producer did not know its build" from "this producer's build is X".
 */
export function traceContractBuildIdOrNull(fromFile: string = import.meta.url): string | null {
  const cached = buildIdCache.get(fromFile)
  if (cached !== undefined) return cached
  let resolved: string | null
  try {
    resolved = traceContractBuildId(fromFile)
  } catch {
    resolved = null
  }
  buildIdCache.set(fromFile, resolved)
  return resolved
}

/** Sorted relative paths of every file under a root, directories walked depth-first.
 *  A top-level `node_modules` is a package-manager artifact, not package content. */
function treeFiles(root: string, prefix = ''): string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (prefix === '' && entry.name === 'node_modules') continue
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...treeFiles(root, relativePath))
    else found.push(relativePath)
  }
  return found.sort()
}
