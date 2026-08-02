import { describe, expect, it } from 'vitest'
import { BoundedDiagnosticBuffer } from '../src/backends/diagnostic-buffer.js'

describe('BoundedDiagnosticBuffer', () => {
  it('preserves small diagnostics exactly', () => {
    const diagnostics = new BoundedDiagnosticBuffer(32, 8)
    diagnostics.append('first ')
    diagnostics.append(Buffer.from('last'))

    expect(diagnostics.totalBytes).toBe(10)
    expect(diagnostics.retainedBytes).toBe(10)
    expect(diagnostics.render()).toBe('first last')
  })

  it('retains a fixed-size head and tail after arbitrarily large output', () => {
    const diagnostics = new BoundedDiagnosticBuffer(16, 4)
    diagnostics.append('HEAD')
    for (let index = 0; index < 10_000; index += 1) diagnostics.append(`-${index}-`)
    diagnostics.append('TAIL')

    expect(diagnostics.totalBytes).toBeGreaterThan(50_000)
    expect(diagnostics.retainedBytes).toBe(16)
    expect(diagnostics.render()).toMatch(/^HEAD\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n/)
    expect(diagnostics.render()).toMatch(/TAIL$/)
  })

  it('bounds the rendered error while keeping both ends', () => {
    const diagnostics = new BoundedDiagnosticBuffer(64, 16)
    diagnostics.append('START-')
    diagnostics.append('x'.repeat(1_000))
    diagnostics.append('-FINISH')

    const rendered = diagnostics.render(48)
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(48)
    expect(rendered).toContain('START')
    expect(rendered).toContain('FINISH')
  })
})
