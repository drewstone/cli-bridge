export const PI_PERMISSION_MARKER_PREFIX = 'cli-bridge.permission-applied.v1'

const PI_PERMISSION_MARKER_PATTERN = /\[cli-bridge-marker:([A-Za-z0-9_-]+)\]$/u

export function piPermissionMarker(token: string, selectedValue: string): string {
  return `${PI_PERMISSION_MARKER_PREFIX}:${token}:${selectedValue}`
}

export function piPermissionTokenFromTitle(title: string): string | null {
  return title.match(PI_PERMISSION_MARKER_PATTERN)?.[1] ?? null
}

export function piPermissionPublicTitle(title: string): string {
  const publicTitle = title.replace(/\s+\[cli-bridge-marker:[A-Za-z0-9_-]+\]$/u, '').trim()
  return publicTitle || 'Pi requests permission'
}

export function piSelectedValue(response: Record<string, unknown>): string {
  if (response.cancelled === true) return 'undefined'
  if (typeof response.value === 'string') return response.value
  if (typeof response.confirmed === 'boolean') return String(response.confirmed)
  return 'undefined'
}

/** Build the tiny Pi extension that turns tool approval into a native select request. */
export function piInteractionExtension(interactionNonce: string): string {
  const nonce = JSON.stringify(interactionNonce)
  const markerPrefix = JSON.stringify(PI_PERMISSION_MARKER_PREFIX)
  return `export default function (pi) {
  const bridgeNonce = ${nonce}
  let permissionNumber = 0
  const sanitizePublicTitle = (value) => String(value ?? '')
    .replace(/[^\\p{L}\\p{N} .,_:\\/-]/gu, ' ')
    .replace(/\\s+/gu, ' ')
    .trim()
    .slice(0, 120) || 'tool'
  pi.on('tool_call', async (event, ctx) => {
    if (!ctx.hasUI) return { block: true, reason: 'interactive approval is unavailable' }
    const token = bridgeNonce + '-' + (++permissionNumber)
    const publicTitle = 'Permission: ' + sanitizePublicTitle(event.toolName)
    const choice = await ctx.ui.select(publicTitle + ' [cli-bridge-marker:' + token + ']', ['allow_once', 'deny'])
    await ctx.ui.notify(${markerPrefix} + ':' + token + ':' + String(choice), 'info')
    if (choice !== 'allow_once') return { block: true, reason: 'permission denied' }
    return undefined
  })
}
`
}
