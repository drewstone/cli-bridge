/**
 * Bridge execution modes.
 *
 * Every request through cli-bridge runs in exactly one mode. The mode
 * decides the tool surface the harness is allowed to use and, when
 * running hosted, where the harness subprocess lives.
 *
 *   byob              Caller's own cli-bridge; router short-circuits
 *                     to `X-Bridge-Url`. Full harness tools available.
 *                     This is the default when no mode header is set
 *                     and we're serving a user's own bridge.
 *
 *   hosted-safe       Harness runs on the cli-bridge host with every
 *                     tool that can touch the FS or shell hard-
 *                     disabled. Intended for router-hosted requests
 *                     that want harness reply behavior (planner,
 *                     tool-reasoning) without arbitrary code execution.
 *
 *   hosted-sandboxed  Harness runs inside a sandbox-runtime container
 *                     with its own rootfs. Full tools, isolated from
 *                     the router VM. Expensive; rate-limited.
 *
 * Backends decide which modes they support. A backend that doesn't
 * know how to enforce hosted-safe for its CLI MUST reject the request
 * with BackendError('not_configured', ...) rather than silently running
 * with tools still enabled — we never fake safety.
 */

export type BridgeMode = 'byob' | 'hosted-safe' | 'hosted-sandboxed'

export const DEFAULT_MODE: BridgeMode = 'byob'

/**
 * Parse a mode hint from request context. Precedence:
 *   1. Explicit body field `mode`
 *   2. `X-Bridge-Mode` header
 *   3. `X-Sandbox: 1` header → hosted-sandboxed
 *   4. Default (byob)
 *
 * Unknown values throw; we never silently downgrade to byob from a
 * caller that asked for a safer mode.
 */
export function parseMode(input: {
  body?: string | undefined
  bridgeModeHeader?: string | null
  sandboxHeader?: string | null
}): BridgeMode {
  const bodyMode = input.body?.trim().toLowerCase()
  if (bodyMode) return assertMode(bodyMode)

  const header = input.bridgeModeHeader?.trim().toLowerCase()
  if (header) return assertMode(header)

  const sandbox = input.sandboxHeader?.trim().toLowerCase()
  if (sandbox === '1' || sandbox === 'true' || sandbox === 'yes') {
    return 'hosted-sandboxed'
  }

  return DEFAULT_MODE
}

function assertMode(raw: string): BridgeMode {
  if (raw === 'byob' || raw === 'hosted-safe' || raw === 'hosted-sandboxed') {
    return raw
  }
  throw new Error(
    `invalid bridge mode "${raw}" — expected one of: byob, hosted-safe, hosted-sandboxed`,
  )
}

export class ModeNotSupportedError extends Error {
  constructor(backend: string, mode: BridgeMode, reason?: string) {
    super(
      `backend "${backend}" does not support mode "${mode}"${reason ? `: ${reason}` : ''}`,
    )
    this.name = 'ModeNotSupportedError'
  }
}

/**
 * Default mode guard for backends that have not implemented hosted-safe
 * or hosted-sandboxed. Call at the top of a backend's chat() before
 * doing any work. `supported` lists the modes this backend KNOWS how
 * to enforce safely; anything else becomes a ModeNotSupportedError.
 */
export function assertModeSupported(
  backend: string,
  mode: BridgeMode,
  supported: ReadonlyArray<BridgeMode>,
  reason?: string,
): void {
  if (!supported.includes(mode)) {
    throw new ModeNotSupportedError(backend, mode, reason)
  }
}
