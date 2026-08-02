const DEFAULT_DIAGNOSTIC_BYTES = 64 * 1024
const DEFAULT_HEAD_BYTES = 4 * 1024

/**
 * Retains the beginning and end of noisy subprocess diagnostics in fixed space.
 * Diagnostic output is never part of a successful answer, so allowing it to
 * consume the server heap cannot improve user-visible capability.
 */
export class BoundedDiagnosticBuffer {
  private readonly head: Buffer
  private readonly tail: Buffer
  private headLength = 0
  private tailLength = 0
  private tailWriteOffset = 0
  private observedBytes = 0

  constructor(maxBytes = DEFAULT_DIAGNOSTIC_BYTES, headBytes = DEFAULT_HEAD_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) {
      throw new Error('maxBytes must be an integer of at least 2')
    }
    if (!Number.isSafeInteger(headBytes) || headBytes < 1 || headBytes >= maxBytes) {
      throw new Error('headBytes must be a positive integer smaller than maxBytes')
    }
    this.head = Buffer.allocUnsafe(headBytes)
    this.tail = Buffer.allocUnsafe(maxBytes - headBytes)
  }

  append(chunk: string | Uint8Array): void {
    const bytes = typeof chunk === 'string'
      ? Buffer.from(chunk)
      : Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    this.observedBytes += bytes.length

    let offset = 0
    if (this.headLength < this.head.length) {
      const copied = Math.min(this.head.length - this.headLength, bytes.length)
      bytes.copy(this.head, this.headLength, 0, copied)
      this.headLength += copied
      offset = copied
    }
    if (offset < bytes.length) this.appendTail(bytes.subarray(offset))
  }

  get totalBytes(): number {
    return this.observedBytes
  }

  get retainedBytes(): number {
    return this.headLength + this.tailLength
  }

  render(maxOutputBytes?: number): string {
    if (maxOutputBytes !== undefined && (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1)) {
      throw new Error('maxOutputBytes must be a positive integer')
    }

    const omittedBytes = Math.max(0, this.observedBytes - this.retainedBytes)
    const retained = Buffer.concat([
      this.head.subarray(0, this.headLength),
      ...(omittedBytes > 0 ? [Buffer.from(`\n[... ${omittedBytes} bytes omitted ...]\n`)] : []),
      this.readTail(),
    ])
    if (maxOutputBytes === undefined) return retained.toString('utf8')
    if (retained.length <= maxOutputBytes) return retained.toString('utf8')

    const marker = Buffer.from('\n[... clipped ...]\n')
    if (maxOutputBytes <= marker.length) {
      return retained.subarray(0, maxOutputBytes).toString('utf8')
    }
    const contentBytes = maxOutputBytes - marker.length
    const headBytes = Math.ceil(contentBytes / 2)
    const tailBytes = contentBytes - headBytes
    return Buffer.concat([
      retained.subarray(0, headBytes),
      marker,
      retained.subarray(retained.length - tailBytes),
    ]).toString('utf8')
  }

  private appendTail(bytes: Buffer): void {
    if (bytes.length >= this.tail.length) {
      bytes.copy(this.tail, 0, bytes.length - this.tail.length)
      this.tailLength = this.tail.length
      this.tailWriteOffset = 0
      return
    }

    const firstCopy = Math.min(bytes.length, this.tail.length - this.tailWriteOffset)
    bytes.copy(this.tail, this.tailWriteOffset, 0, firstCopy)
    if (firstCopy < bytes.length) {
      bytes.copy(this.tail, 0, firstCopy)
    }
    this.tailWriteOffset = (this.tailWriteOffset + bytes.length) % this.tail.length
    this.tailLength = Math.min(this.tail.length, this.tailLength + bytes.length)
  }

  private readTail(): Buffer {
    if (this.tailLength === 0) return Buffer.alloc(0)
    const start = (this.tailWriteOffset - this.tailLength + this.tail.length) % this.tail.length
    if (start + this.tailLength <= this.tail.length) {
      return this.tail.subarray(start, start + this.tailLength)
    }
    const first = this.tail.subarray(start)
    return Buffer.concat([first, this.tail.subarray(0, this.tailLength - first.length)])
  }
}
