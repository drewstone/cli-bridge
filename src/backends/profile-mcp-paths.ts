import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { ChatRequest, McpServerSpec } from './types.js'
import { registerJailStablePath } from '../jail/index.js'
import { trustedTemporaryRoot, validateStablePath, validateStableTree } from '../jail/path-policy.js'

/** Return true only for local MCP servers that the config materializers can launch. */
export function isStdioMcpSpec(spec: McpServerSpec): boolean {
  if (spec.enabled === false) return false
  if (spec.type === 'stdio') return Boolean(spec.command)
  if (spec.type === 'http' || spec.type === 'sse') return false
  return Boolean(spec.command)
}

/** Reject local MCP launch paths that could widen a jail or race into another tree. */
export function assertSafeMcpServerPaths(
  specs: Record<string, McpServerSpec>,
  baseDir = process.cwd(),
  jailSpec?: ChatRequest['jailSpec'],
): void {
  const dataRoots = [resolve(baseDir), resolve(jailSpec ? trustedTemporaryRoot() : tmpdir())]
  const executableRoots = [
    ...dataRoots,
    '/bin',
    '/usr/bin',
    '/usr/local/bin',
    dirname(process.execPath),
  ]
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.enabled === false || !isStdioMcpSpec(spec)) continue
    if (spec.command && isAbsolute(spec.command)) {
      validateMcpPath(spec.command, `MCP server ${name} command`, 'file', executableRoots, jailSpec)
    } else if (spec.command && baseDir && spec.command.includes('/')) {
      validateMcpPath(resolve(baseDir, spec.command), `MCP server ${name} command`, 'file', [baseDir], jailSpec)
    }
    for (const [index, arg] of (spec.args ?? []).entries()) {
      // Absolute argv values are not necessarily paths: servers commonly use them as opaque
      // identifiers or data. When an absolute value names a host object, however, it is a
      // path-bearing argument and must obey the same identity checks as the command.
      if (isAbsolute(arg) && (existsSync(arg) || jailSpec)) {
        validateMcpPath(
          arg,
          `MCP server ${name} argument ${index}`,
          'file-or-directory',
          dataRoots,
          jailSpec,
        )
      }
    }
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      if (isAbsolute(value) && (existsSync(value) || jailSpec)) {
        validateMcpPath(
          value,
          `MCP server ${name} environment ${key}`,
          'file-or-directory',
          dataRoots,
          jailSpec,
        )
      }
    }
  }
}

function validateMcpPath(
  path: string,
  label: string,
  kind: 'file' | 'file-or-directory',
  allowedRoots: readonly string[],
  jailSpec: ChatRequest['jailSpec'] | undefined,
): void {
  const identity = validateStablePath(path, { label, kind, allowedRoots })
  if (identity.kind === 'directory') {
    // The jail walks this tree again immediately before spawn; walking it now rejects an
    // already-planted symlink before config materialization.
    validateStableTree(path, { label, allowedRoots })
  }
  registerJailStablePath(jailSpec, identity.path)
}
