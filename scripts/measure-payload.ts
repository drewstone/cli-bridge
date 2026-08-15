/**
 * Distinct-payload helper for the retention harnesses.
 *
 * `'x'.repeat(n)` built once and interpolated per delta produces V8 cons
 * strings that all reference ONE backing store, so a naive harness measures a
 * few megabytes no matter how much it appears to stream and reports a leak as
 * absent. Every payload here is a freshly allocated flat string, which is what
 * a socket-fed backend actually produces.
 */

export function distinctPayload(bytes: number, seed: number): string {
  const buf = Buffer.allocUnsafe(bytes)
  buf.fill(97 + (seed % 26))
  // Make the first bytes unique so no two payloads can be deduplicated, and
  // force a fresh flat string rather than a view over shared memory.
  buf.write(String(seed).padStart(12, '0').slice(0, 12), 0, 'latin1')
  return buf.toString('latin1')
}
