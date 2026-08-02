/**
 * WHICH BUILD of `@tangle-network/agent-trace-contract` is installed here.
 *
 * The version string cannot answer that question. Two builds of this package
 * both declare `1.0.2` — one bounds how many entries `validateTraceSpans` reads
 * and reports the clipping as `truncated-input`, the other reads whatever the
 * input's `length` claims — so a version comparison passes on both and tells a
 * reader nothing about the code that produced a span.
 *
 * Identity therefore comes from the bytes, twice over:
 *
 * - `traceContractBuildId` hashes the installed `dist/` tree, so two different
 *   builds get two different ids however they version themselves. That id is
 *   what the emitter stamps on every request span.
 * - `verifyInstalledTraceContract` checks the installed tree against the ONE
 *   build the repo's own pnpm-lock.yaml pins. This is an allowlist derived
 *   from the lockfile, not a digest pinned in source and not a denylist of a
 *   known-bad tree: the lockfile names the locked build by the sha512 of its
 *   published tarball, and the per-file expectation is re-derived from tarball
 *   bytes that must re-hash to that sha512 before they are believed. Any
 *   installed tree that is not byte-identical to the locked build fails —
 *   stale, future-corrupt, or decorated — and a legitimate upgrade moves the
 *   lockfile entry, so the expectation follows it with no digest to update by
 *   hand.
 *
 * Resolution goes through Node's own resolver rather than a guessed path, so
 * both describe the build this process would actually import — including when
 * that build is reached through a symlinked virtual store belonging to a
 * different checkout.
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const PACKAGE = '@tangle-network/agent-trace-contract'
const TARBALL_BASENAME = 'agent-trace-contract'

/**
 * The bound the installed build must apply to one `validateTraceSpans` call.
 *
 * Pinned as a literal rather than read from the package, because a probe that
 * derives its own expectation from the module under test cannot fail: a build
 * that dropped the bound would supply `undefined` and the probe would agree
 * with it.
 */
export const EXPECTED_MAX_SPANS_READ = 250_000

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

/** The one registry build the repo's lockfile pins for this package. */
export interface LockedTraceContract {
  version: string
  /** `sha512-…` of the published tarball, straight from the lockfile entry. */
  integrity: string
}

/**
 * Read the repo's own pnpm-lock.yaml entry for this package.
 *
 * Fails closed on zero matching entries (nothing pinned means the provenance
 * check would silently verify nothing) and on more than one (two pinned builds
 * make "the locked build" ambiguous — a side-loaded `file:` variant is exactly
 * the shape that ambiguity hides).
 */
export function lockedTraceContract(lockfilePath: string = defaultLockfilePath(import.meta.url)): LockedTraceContract {
  const text = readFileSync(lockfilePath, 'utf8')
  const entryPattern = /^ {2}'@tangle-network\/agent-trace-contract@([^']+)':\r?\n {4}resolution: \{integrity: (sha512-[A-Za-z0-9+/]+={0,2})\}/gmu
  const entries = [...text.matchAll(entryPattern)]
  const entry = entries[0]
  if (entries.length !== 1 || entry === undefined) {
    const found = entries.map((match) => match[1]).join(', ') || 'none'
    throw new Error(`${lockfilePath} must pin exactly one ${PACKAGE} build; found: ${found}`)
  }
  const version = entry[1]
  const integrity = entry[2]
  if (version === undefined || integrity === undefined) {
    throw new Error(`${lockfilePath} entry for ${PACKAGE} lacks a version or integrity`)
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`${lockfilePath} pins ${PACKAGE}@${version}, which is not a registry release`)
  }
  return { version, integrity }
}

/** What `verifyInstalledTraceContract` found, empty lists meaning byte-identical. */
export interface TraceContractProvenance {
  version: string
  integrity: string
  /** Absolute path of the installed package this process would import. */
  packageDir: string
  /** Files the locked build ships that the installed tree lacks. */
  missing: string[]
  /** Files the installed tree carries that the locked build does not ship. */
  extra: string[]
  /** Files present in both whose bytes differ. */
  mismatched: string[]
}

/**
 * Compare the installed tree, file by file and byte by byte, against the build
 * the lockfile pins. Empty `missing`/`extra`/`mismatched` is the only clean
 * verdict; any tree that is not the locked one — older, newer, or decorated —
 * shows up in one of the three lists.
 */
export async function verifyInstalledTraceContract(fromFile: string = import.meta.url): Promise<TraceContractProvenance> {
  const locked = lockedTraceContract(defaultLockfilePath(fromFile))
  const packageDir = dirname(traceContractDistDir(fromFile))
  const lockedFiles = tarballFiles(await lockedTarballBytes(locked))
  const installed = treeFiles(packageDir)
  const missing = [...lockedFiles.keys()].filter((path) => !installed.includes(path)).sort()
  const extra = installed.filter((path) => !lockedFiles.has(path))
  const mismatched = installed.filter((path) => {
    const lockedBytes = lockedFiles.get(path)
    return lockedBytes !== undefined && !lockedBytes.equals(readFileSync(join(packageDir, path)))
  })
  return { version: locked.version, integrity: locked.integrity, packageDir, missing, extra, mismatched }
}

/** Nearest pnpm-lock.yaml above the given module — the repo's own lockfile. */
function defaultLockfilePath(fromFile: string): string {
  let dir = dirname(fileURLToPath(fromFile))
  for (;;) {
    const candidate = join(dir, 'pnpm-lock.yaml')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`no pnpm-lock.yaml above ${fileURLToPath(fromFile)}`)
    dir = parent
  }
}

/**
 * Bytes of the locked tarball, from a tmp cache or the registry.
 *
 * Any source is acceptable because no source is trusted: whatever bytes come
 * back must re-hash to the lockfile's sha512 or they are discarded. The cache
 * is keyed by that hash, so an upgraded lockfile can never read a stale entry,
 * and a corrupted cache file is a cache miss, not a wrong verdict. When neither
 * source produces matching bytes the check FAILS — it never degrades to "could
 * not verify, assume fine".
 */
async function lockedTarballBytes(locked: LockedTraceContract): Promise<Buffer> {
  const hex = Buffer.from(locked.integrity.slice('sha512-'.length), 'base64').toString('hex')
  const cachePath = join(tmpdir(), `trace-contract-tarball-${hex.slice(0, 32)}.tgz`)
  const cached = await readFile(cachePath).catch(() => null)
  if (cached !== null && sha512Integrity(cached) === locked.integrity) return cached
  const url = `https://registry.npmjs.org/${PACKAGE}/-/${TARBALL_BASENAME}-${locked.version}.tgz`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status} and no cached copy re-hashes to the locked integrity`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (sha512Integrity(bytes) !== locked.integrity) {
    throw new Error(`the registry tarball for ${PACKAGE}@${locked.version} does not hash to the lockfile's integrity`)
  }
  try {
    const tempPath = `${cachePath}.${process.pid}.${Date.now()}`
    await writeFile(tempPath, bytes)
    await rename(tempPath, cachePath)
  } catch {
    // The cache is an optimization; an unwritable tmpdir must not fail the check.
  }
  return bytes
}

function sha512Integrity(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

/**
 * Minimal ustar reader for a registry tarball: gunzip, walk the 512-byte
 * headers, strip the top directory (`package/` for npm publishes). Handles pax
 * and GNU long-name path overrides; every non-file entry type is skipped.
 */
function tarballFiles(tgz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(tgz)
  const files = new Map<string, Buffer>()
  let pendingPath: string | null = null
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = Number.parseInt(headerText(header, 124, 12) || '0', 8)
    const data = tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    const typeflag = String.fromCharCode(header[156] ?? 0)
    if (typeflag === 'x') {
      pendingPath = paxPath(data) ?? pendingPath
      continue
    }
    if (typeflag === 'L') {
      pendingPath = data.toString('utf8').replace(/\0+$/u, '')
      continue
    }
    if (typeflag !== '0' && typeflag !== '\0') {
      pendingPath = null
      continue
    }
    const prefix = headerText(header, 345, 155)
    const headerName = prefix ? `${prefix}/${headerText(header, 0, 100)}` : headerText(header, 0, 100)
    const fullPath = pendingPath ?? headerName
    pendingPath = null
    const relative = fullPath.split('/').slice(1).join('/')
    if (relative.length > 0) files.set(relative, Buffer.from(data))
  }
  return files
}

function headerText(header: Buffer, start: number, length: number): string {
  return header
    .subarray(start, start + length)
    .toString('utf8')
    .split('\0')[0]!
    .trim()
}

/** One pax extended header: length-prefixed `<len> key=value\n` records, byte-indexed. */
function paxPath(data: Buffer): string | null {
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(0x20, at)
    if (space === -1) return null
    const recordLength = Number.parseInt(data.subarray(at, space).toString('utf8'), 10)
    if (!Number.isInteger(recordLength) || recordLength <= 0) return null
    const record = data.subarray(space + 1, at + recordLength).toString('utf8')
    if (record.startsWith('path=')) return record.slice('path='.length).replace(/\n$/u, '')
    at += recordLength
  }
  return null
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
