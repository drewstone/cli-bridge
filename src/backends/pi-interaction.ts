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
