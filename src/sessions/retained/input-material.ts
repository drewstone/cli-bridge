/**
 * Live child inputs a retained session was created with.
 *
 * `agent_profile` and `mcp` are credential-bearing and are NOT durable session
 * metadata. They are held in memory only until the native child has been
 * spawned with them, after which the child owns the materialized state and a
 * lost child is not eligible for silent restart. Only their presence is
 * recorded durably, so a restart can refuse a continuation it cannot reproduce
 * exactly instead of starting a differently-configured one.
 */

import { recordValue } from './json-values.js'

export interface RetainedInputMaterial {
  hasAgentProfile: boolean
  agentProfile?: unknown
  hasMcp: boolean
  mcp?: unknown
}

export class RetainedInputMaterialStore {
  private readonly byId = new Map<string, RetainedInputMaterial>()

  record(id: string, material: RetainedInputMaterial): void {
    this.byId.set(id, material)
  }

  get(id: string): RetainedInputMaterial | undefined {
    return this.byId.get(id)
  }

  forget(id: string): void {
    this.byId.delete(id)
  }
}

export function describeInputMaterial(input: { agent_profile?: unknown; mcp?: unknown }): RetainedInputMaterial {
  return {
    hasAgentProfile: input.agent_profile !== undefined,
    ...(input.agent_profile !== undefined ? { agentProfile: input.agent_profile } : {}),
    hasMcp: input.mcp !== undefined,
    ...(input.mcp !== undefined ? { mcp: input.mcp } : {}),
  }
}

/** The durable marker that exact profile/MCP inputs were supplied at creation. */
export function inputPresenceMetadata(material: RetainedInputMaterial): Record<string, unknown> {
  if (!material.hasAgentProfile && !material.hasMcp) return {}
  return {
    retained_input_presence: {
      ...(material.hasAgentProfile ? { agent_profile: true } : {}),
      ...(material.hasMcp ? { mcp: true } : {}),
    },
  }
}

/** True when the record was created with inputs this process can no longer reproduce. */
export function requiresRecordedInputs(metadata: Record<string, unknown>): boolean {
  const presence = recordValue(metadata.retained_input_presence)
  return presence?.agent_profile === true || presence?.mcp === true
}
