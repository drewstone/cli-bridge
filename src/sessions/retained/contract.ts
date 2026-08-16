import { z } from 'zod'
import {
  snapshotAgentProfile,
  type AgentProfile,
} from '@tangle-network/agent-interface'
import {
  agentProfilePublicConfigValueSchema,
  agentProfileMcpServerSchema,
  isCredentialBearingProfileConfigName,
} from '@tangle-network/agent-interface/profile-schema'
import { isRuntimeProcessControlEnvironmentName } from '@tangle-network/agent-interface/profile-security'

export const RETAINED_MAX_TEXT_LENGTH = 16_384
export const RETAINED_MAX_CWD_LENGTH = 4_096
export const RETAINED_MAX_JSON_DEPTH = 16
export const RETAINED_MAX_JSON_NODES = 8_192
export const RETAINED_MAX_JSON_ARRAY_LENGTH = 1_024
export const RETAINED_MAX_JSON_MAP_ENTRIES = 256
export const RETAINED_MAX_ENV_ENTRIES = 256
export const RETAINED_MAX_EXECUTION_TIMEOUT_MS = 2_147_483_647

/** Pi and Bridge controls are not caller-owned child environment values. */
const retainedPiProcessControlEnvironmentNames = new Set([
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_PACKAGE_DIR',
  'PI_OFFLINE',
  'PI_TELEMETRY',
])

const retainedMetadataBehavioralKeys = new Set([
  'agent_profile',
  'mcp',
  'execution',
  'env',
  'context',
  'provider_options',
])

const boundedString = z.string().max(RETAINED_MAX_TEXT_LENGTH)

export const retainedInputPartSchema = z.union([
  z.strictObject({
    type: z.literal('text'),
    text: boundedString,
  }),
  z.strictObject({
    type: z.literal('file'),
    filename: boundedString.optional(),
    mediaType: boundedString.optional(),
    url: boundedString.optional(),
    path: boundedString.optional(),
    content: boundedString.optional(),
  }),
  z.strictObject({
    type: z.literal('image'),
    filename: boundedString.optional(),
    mediaType: boundedString.optional(),
    url: boundedString.optional(),
    path: boundedString.optional(),
  }),
])

const netJailSchema = z.strictObject({
  mode: z.enum(['off', 'net-jail']).optional(),
  allow: z.array(z.string().min(1).max(512)).max(RETAINED_MAX_JSON_ARRAY_LENGTH).optional(),
})

const hostExecutionSchema = z.strictObject({
  kind: z.literal('host'),
  jail: z.strictObject({
    mode: z.enum(['off', 'write-jail', 'fs-jail']).optional(),
    root: z.string().max(RETAINED_MAX_CWD_LENGTH).optional(),
  }).optional(),
  netJail: netJailSchema.optional(),
  timeoutMs: z.number().int().positive().max(RETAINED_MAX_EXECUTION_TIMEOUT_MS).optional(),
})

const sandboxExecutionSchema = z.strictObject({
  kind: z.literal('sandbox'),
  repoUrl: z.string().min(1).max(RETAINED_MAX_CWD_LENGTH).optional(),
  gitRef: z.string().min(1).max(512).optional(),
  capability: z.string().min(1).max(256).optional(),
  ttlSeconds: z.number().int().positive().max(31_536_000).optional(),
  netJail: netJailSchema.optional(),
  timeoutMs: z.number().int().positive().max(RETAINED_MAX_EXECUTION_TIMEOUT_MS).optional(),
})

export const retainedExecutionSchema = z.union([
  hostExecutionSchema,
  sandboxExecutionSchema,
]).superRefine((execution, ctx) => {
  if (execution.kind !== 'sandbox' || execution.repoUrl === undefined) return
  let url: URL
  try {
    url = new URL(execution.repoUrl)
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'sandbox repoUrl must be an absolute HTTP(S) URL' })
    return
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'sandbox repoUrl must not contain credentials, query, or fragment' })
  }
})

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).max(256)
export const retainedEnvSchema = z.record(envName, boundedString)
  .refine((value) => Object.keys(value).length <= RETAINED_MAX_ENV_ENTRIES, 'environment has too many entries')

export const retainedPublicRecordSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value) && isBoundedJsonValue(value),
  { message: 'object exceeds retained request bounds' },
)

const credentialAssignmentPattern = /^\s*([A-Za-z][A-Za-z0-9_-]{0,255})\s*[:=]\s*\S/u

export type RetainedExecution = z.infer<typeof retainedExecutionSchema>
export type RetainedInputPart = z.infer<typeof retainedInputPartSchema>

export function containsSecretShapedValue(value: unknown): boolean {
  if (typeof value === 'string') {
    if (!agentProfilePublicConfigValueSchema.safeParse({ kind: 'public', value }).success) return true
    const assignment = credentialAssignmentPattern.exec(value)
    return assignment !== null && isCredentialBearingProfileConfigName(assignment[1]!)
  }
  if (Array.isArray(value)) return value.some(containsSecretShapedValue)
  if (value && typeof value === 'object') return Object.values(value).some(containsSecretShapedValue)
  return false
}

export function parseSafePublicRecord(value: unknown, label: string): Record<string, unknown> {
  const parsed = retainedPublicRecordSchema.safeParse(value ?? {})
  if (!parsed.success) throw new Error(`${label} exceeds retained request bounds`)
  if (containsCredentialBearingKey(parsed.data)) throw new Error(`${label} contains a credential-bearing key`)
  if (containsSecretShapedValue(parsed.data)) throw new Error(`${label} contains a secret-shaped value`)
  return parsed.data
}

/**
 * Validate the request MCP shape with Agent Interface's typed config parser.
 *
 * MCP environment and header names are credential-capable channels. A generic
 * open-record scan would reject valid secret references or admit raw strings.
 * The request shape is adapted only for canonical validation, then preserved.
 */
export function parseSafeRetainedMcp(value: unknown, label = 'retained MCP configuration'): Record<string, unknown> {
  const parsed = retainedPublicRecordSchema.safeParse(value ?? {})
  if (!parsed.success) throw new Error(`${label} exceeds retained request bounds`)

  const servers = parsed.data.mcpServers
  if (servers === undefined) return parsed.data
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(`${label} must contain an object mcpServers map`)
  }
  for (const [name, value] of Object.entries(servers)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${label} server ${JSON.stringify(name)} is invalid`)
    }
    const server = value as Record<string, unknown>
    if (server.metadata !== undefined) {
      if (containsCredentialBearingKey(server.metadata)) {
        throw new Error(`${label} server ${JSON.stringify(name)} metadata contains a credential-bearing key`)
      }
      if (containsSecretShapedValue(server.metadata)) {
        throw new Error(`${label} server ${JSON.stringify(name)} metadata contains a secret-shaped value`)
      }
    }
    const canonical = canonicalMcpServerForValidation(server)
    if (!agentProfileMcpServerSchema.safeParse(canonical).success) {
      throw new Error(`${label} server ${JSON.stringify(name)} is not a valid typed MCP configuration`)
    }
  }
  return parsed.data
}

/**
 * Validate retained metadata while preserving the Agent Interface profile contract.
 *
 * Agent Interface already validates typed secret references in MCP environment and
 * header records. Those references are public identities, not credential values,
 * so only the profile's open metadata surfaces receive the recursive key check.
 */
export function parseSafeRetainedMetadata(value: unknown): Record<string, unknown> {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const profile = source.agent_profile === undefined
    ? undefined
    : snapshotRetainedAgentProfile(source.agent_profile)
  const mcp = source.mcp === undefined
    ? undefined
    : parseSafeRetainedMcp(source.mcp, 'retained metadata MCP configuration')
  if (profile !== undefined && !isBoundedJsonValue(profile)) {
    throw new Error('retained metadata exceeds retained request bounds')
  }
  const withoutProfile = Object.fromEntries(
    Object.entries(source).filter(([key]) => key !== 'agent_profile' && key !== 'mcp'),
  )
  const parsed = parseSafePublicRecord(withoutProfile, 'retained metadata')
  if (profile !== undefined) parsed.agent_profile = profile
  if (mcp !== undefined) parsed.mcp = mcp
  return parsed
}

/** Caller metadata cannot shadow the canonical request channels or credential slots. */
export function parseSafeCallerMetadata(value: unknown): Record<string, unknown> {
  const parsed = parseSafePublicRecord(value, 'retained metadata')
  if (containsUnsafeMetadataKey(parsed)) {
    throw new Error('retained metadata contains an unsupported behavioral or credential key')
  }
  return parsed
}

export function parseSafeRetainedEnv(value: unknown): Record<string, string> {
  const parsed = retainedEnvSchema.safeParse(value ?? {})
  if (!parsed.success) throw new Error('environment contains unsupported names or values')
  if (containsSecretShapedValue(parsed.data)) throw new Error('environment contains a credential-bearing value')
  for (const name of Object.keys(parsed.data)) {
    if (isCredentialBearingProfileConfigName(name)) {
      throw new Error(`environment variable ${JSON.stringify(name)} is credential-bearing`)
    }
    if (isRetainedProcessControlEnvironmentName(name)) {
      throw new Error(`environment variable ${JSON.stringify(name)} is owned by the bridge`)
    }
  }
  return parsed.data
}

export function snapshotRetainedAgentProfile(value: unknown): AgentProfile {
  const profile = snapshotAgentProfile(value)
  if (containsCredentialBearingProfileOpenKey(profile)) {
    throw new Error('agent_profile open metadata contains a credential-bearing key')
  }
  return profile
}

export function isBoundedJsonValue(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new Set<object>()
  let nodes = 0
  while (pending.length > 0) {
    const item = pending.pop()!
    nodes += 1
    if (nodes > RETAINED_MAX_JSON_NODES || item.depth > RETAINED_MAX_JSON_DEPTH) return false
    if (item.value === null || typeof item.value === 'boolean' || typeof item.value === 'number') {
      if (typeof item.value === 'number' && !Number.isFinite(item.value)) return false
      continue
    }
    if (typeof item.value === 'string') {
      if (item.value.length > RETAINED_MAX_TEXT_LENGTH) return false
      continue
    }
    if (typeof item.value !== 'object' || seen.has(item.value)) return false
    seen.add(item.value)
    if (Array.isArray(item.value)) {
      if (item.value.length > RETAINED_MAX_JSON_ARRAY_LENGTH) return false
      for (const child of item.value) pending.push({ value: child, depth: item.depth + 1 })
      continue
    }
    const entries = Object.entries(item.value)
    if (entries.length > RETAINED_MAX_JSON_MAP_ENTRIES) return false
    for (const [key, child] of entries) {
      if (key.length > 512) return false
      pending.push({ value: child, depth: item.depth + 1 })
    }
  }
  try {
    const serialized = JSON.stringify(value)
    return serialized !== undefined && new TextEncoder().encode(serialized).byteLength <= 1_048_576
  } catch {
    return false
  }
}

export function containsCredentialBearingKey(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object' || ancestors.has(value)) return false
  const nextAncestors = new Set(ancestors).add(value)
  if (Array.isArray(value)) return value.some((entry) => containsCredentialBearingKey(entry, nextAncestors))
  return Object.entries(value).some(([key, child]) => {
    if (isCredentialBearingProfileConfigName(key)) return true
    return containsCredentialBearingKey(child, nextAncestors)
  })
}

function containsCredentialBearingProfileOpenKey(profile: AgentProfile): boolean {
  const openRecords: unknown[] = [
    profile.metadata,
    profile.model?.metadata,
    profile.extensions,
    ...Object.values(profile.subagents ?? {}).map(subagent => subagent.metadata),
    ...Object.values(profile.modes ?? {}).map(mode => mode.metadata),
    ...Object.values(profile.mcp ?? {}).map(server => server.metadata),
  ]
  return openRecords.some(record =>
    containsCredentialBearingKey(record) || containsSecretShapedValue(record))
}

function canonicalMcpServerForValidation(server: Record<string, unknown>): Record<string, unknown> {
  const canonical = { ...server }
  if (typeof canonical.type === 'string') {
    canonical.transport = canonical.type
    delete canonical.type
  }
  if (Array.isArray(canonical.args)) {
    canonical.args = canonical.args.map(toAgentProfileConfigValue)
  }
  if (canonical.env && typeof canonical.env === 'object' && !Array.isArray(canonical.env)) {
    canonical.env = mapAgentProfileConfigRecord(canonical.env)
  }
  if (canonical.headers && typeof canonical.headers === 'object' && !Array.isArray(canonical.headers)) {
    canonical.headers = mapAgentProfileConfigRecord(canonical.headers)
  }
  // `timeout` is a Bridge request control. Agent Interface validates the
  // provider-neutral MCP identity; the backend validates this runtime limit.
  delete canonical.timeout
  return canonical
}

function mapAgentProfileConfigRecord(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, toAgentProfileConfigValue(entry)]),
  )
}

function toAgentProfileConfigValue(value: unknown): unknown {
  return typeof value === 'string' ? { kind: 'public', value } : value
}

function isRetainedProcessControlEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase()
  return isRuntimeProcessControlEnvironmentName(name)
    || retainedPiProcessControlEnvironmentNames.has(normalized)
}

function containsUnsafeMetadataKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsUnsafeMetadataKey)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => {
    const normalized = key
      .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
      .replace(/[^A-Za-z0-9]+/gu, '_')
      .replace(/^_+|_+$/gu, '')
      .toLowerCase()
    if (
      isCredentialBearingProfileConfigName(key)
      || retainedMetadataBehavioralKeys.has(normalized)
    ) return true
    return containsUnsafeMetadataKey(child)
  })
}
