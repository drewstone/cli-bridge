/**
 * Narrowing for untyped provider JSON.
 *
 * Native harnesses emit shapes cli-bridge does not control, so every read of
 * one starts by proving the value is the kind it is about to be treated as.
 */

export function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}
