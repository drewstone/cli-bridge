import type { ChatRequest } from '../backends/types.js'

/**
 * Parse the `X-Mcp-Config` request header. Accepts the canonical
 * `{ mcpServers: { … } }` shape; invalid JSON is silently dropped
 * rather than 400-ing the whole request so callers can opportunistically
 * set the header without it becoming a brittle hard dep.
 */
export function parseMcpHeader(value: string | undefined): ChatRequest['mcp'] | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object') return parsed as ChatRequest['mcp']
  } catch {
    // ignore — malformed header is best-effort
  }
  return undefined
}

/**
 * Merge MCP inputs from the header and the body, with body winning on
 * per-server name collisions. Either side can be undefined.
 */
export function mergeMcpInputs(
  fromHeader: ChatRequest['mcp'] | undefined,
  fromBody: ChatRequest['mcp'] | undefined,
): ChatRequest['mcp'] | undefined {
  if (!fromHeader && !fromBody) return undefined
  const headerServers = (fromHeader?.mcpServers ?? {}) as Record<string, unknown>
  const bodyServers = (fromBody?.mcpServers ?? {}) as Record<string, unknown>
  const merged = { ...headerServers, ...bodyServers }
  if (Object.keys(merged).length === 0) return undefined
  return { mcpServers: merged } as ChatRequest['mcp']
}
