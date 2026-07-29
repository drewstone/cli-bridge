/**
 * One place that turns a thrown failure into the `{ message, type }` pair a
 * caller sees, so a reason cannot be lost between the run buffer and the HTTP
 * response.
 *
 * Kept free of route and backend imports on purpose: the run registry owns the
 * buffered stream and must be able to attach the reason to the terminal delta
 * itself. The mapping is therefore structural — a `code` string on the error, or
 * the class name — rather than a list of `instanceof` checks, which also means a
 * new typed error surfaces its own code without touching this file.
 *
 * `type` is advisory metadata for the caller. HTTP status selection stays with
 * the route's `errorResponse`, which maps the real error object, so a failure
 * before the first delta and the same failure after it produce the same status.
 */

/** Error classes whose name alone determines the reported type. */
const TYPE_BY_ERROR_NAME: Record<string, string> = {
  ModeNotSupportedError: 'mode_not_supported',
  RunReplayCursorError: 'invalid_replay_cursor',
}

export function describeRunFailure(error: unknown): { message: string; type: string } {
  const message = error instanceof Error ? error.message : String(error)
  return { message, type: failureType(error) }
}

function failureType(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'server_error'
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && code.length > 0) return code
  const name = (error as { name?: unknown }).name
  if (typeof name === 'string' && TYPE_BY_ERROR_NAME[name]) return TYPE_BY_ERROR_NAME[name]
  return 'server_error'
}
