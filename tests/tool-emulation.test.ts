/**
 * Unit tests for the prompt-marker tool-emulation path.
 *
 * - Off by default (no env flag, no tools[]) — emulation reports disabled.
 * - On when env flag is set AND caller passed tools[] — directive renders
 *   the tools and the tool_choice constraint, parser extracts JSON tool
 *   calls between the literal markers, and prose around the markers
 *   passes through untouched.
 * - Streaming chunks split mid-marker still parse correctly on the next feed.
 * - Malformed JSON inside a marker is dropped (no synthetic call) but the
 *   stream continues — must not crash the bridge.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isEmulationEnabled,
  renderToolEmulationDirective,
  ToolMarkerParser,
} from '../src/backends/tool-emulation.js'

const sampleTools = [
  {
    type: 'function' as const,
    function: {
      name: 'list_packs',
      description: 'List domain packs',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_stage',
      description: 'Run one harness turn',
      parameters: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
  },
]

describe('isEmulationEnabled', () => {
  const original = process.env.BRIDGE_EMULATE_TOOL_CALLS
  afterEach(() => {
    if (original === undefined) delete process.env.BRIDGE_EMULATE_TOOL_CALLS
    else process.env.BRIDGE_EMULATE_TOOL_CALLS = original
  })

  it('is false when env flag is unset, even with tools[]', () => {
    delete process.env.BRIDGE_EMULATE_TOOL_CALLS
    expect(isEmulationEnabled({ tools: sampleTools })).toBe(false)
  })

  it('is false when env flag is set but tools[] is missing/empty', () => {
    process.env.BRIDGE_EMULATE_TOOL_CALLS = '1'
    expect(isEmulationEnabled({})).toBe(false)
    expect(isEmulationEnabled({ tools: [] })).toBe(false)
  })

  it('is true only when both env flag is "1" AND tools[] has entries', () => {
    process.env.BRIDGE_EMULATE_TOOL_CALLS = '1'
    expect(isEmulationEnabled({ tools: sampleTools })).toBe(true)
    process.env.BRIDGE_EMULATE_TOOL_CALLS = 'true'  // not "1" — must be exact
    expect(isEmulationEnabled({ tools: sampleTools })).toBe(false)
  })
})

describe('renderToolEmulationDirective', () => {
  it('lists each tool name + parameters and includes both markers', () => {
    const text = renderToolEmulationDirective(sampleTools, 'auto')
    expect(text).toContain('list_packs')
    expect(text).toContain('run_stage')
    expect(text).toContain('<<<TOOL_CALL>>>')
    expect(text).toContain('<<<END_TOOL_CALL>>>')
  })

  it('encodes tool_choice="required" as a "must call" directive', () => {
    expect(renderToolEmulationDirective(sampleTools, 'required'))
      .toMatch(/MUST call at least one tool/i)
  })

  it('encodes tool_choice="none" as a "do not call" directive', () => {
    expect(renderToolEmulationDirective(sampleTools, 'none'))
      .toMatch(/Do NOT call any tools/i)
  })

  it('encodes a specific function pin', () => {
    const text = renderToolEmulationDirective(
      sampleTools,
      { type: 'function', function: { name: 'run_stage' } },
    )
    expect(text).toContain('You MUST call the tool named "run_stage"')
  })
})

describe('ToolMarkerParser', () => {
  let parser: ToolMarkerParser
  beforeEach(() => { parser = new ToolMarkerParser() })

  it('extracts a single tool call between markers', () => {
    const chunk = [
      'thinking…',
      '<<<TOOL_CALL>>>',
      '{"id": "call_1", "name": "list_packs", "arguments": {}}',
      '<<<END_TOOL_CALL>>>',
    ].join('\n')
    const out = parser.feed(chunk)
    expect(out.toolCalls).toHaveLength(1)
    expect(out.toolCalls[0]).toMatchObject({ id: 'call_1', name: 'list_packs', arguments: '{}' })
    expect(out.prose.replace(/\n/g, '').trim()).toBe('thinking…')
  })

  it('extracts multiple tool calls in one chunk', () => {
    const chunk = [
      '<<<TOOL_CALL>>>{"name":"a","arguments":{}}<<<END_TOOL_CALL>>>',
      '<<<TOOL_CALL>>>{"name":"b","arguments":{"x":1}}<<<END_TOOL_CALL>>>',
    ].join('\n')
    const out = parser.feed(chunk)
    expect(out.toolCalls).toHaveLength(2)
    expect(out.toolCalls[0]!.name).toBe('a')
    expect(out.toolCalls[1]!.name).toBe('b')
    expect(out.toolCalls[1]!.arguments).toBe('{"x":1}')
  })

  it('handles a marker split across two chunks', () => {
    const a = parser.feed('preamble <<<TOOL_CA')
    expect(a.toolCalls).toHaveLength(0)
    const b = parser.feed('LL>>>{"name":"foo","arguments":{}}<<<END_TOOL_CALL>>> done')
    expect(b.toolCalls).toHaveLength(1)
    expect(b.toolCalls[0]!.name).toBe('foo')
    // Prose around the markers shows up across the two feeds. Whitespace
    // immediately after a parsed marker is normalized away by design so
    // back-to-back marker blocks read clean.
    expect((a.prose + b.prose).trim()).toBe('preamble done')
  })

  it('drops a marker with malformed JSON, keeps the stream alive', () => {
    const out = parser.feed('<<<TOOL_CALL>>>not-json<<<END_TOOL_CALL>>>after')
    const tail = parser.flush()
    expect(out.toolCalls).toHaveLength(0)
    expect(tail.toolCalls).toHaveLength(0)
    // Prose may straddle feed + flush — accumulate.
    expect((out.prose + tail.prose)).toContain('after')
  })

  it('tolerates a JSON code fence inside the marker', () => {
    const chunk = '<<<TOOL_CALL>>>```json\n{"name":"x","arguments":{}}\n```<<<END_TOOL_CALL>>>'
    const out = parser.feed(chunk)
    expect(out.toolCalls).toHaveLength(1)
    expect(out.toolCalls[0]!.name).toBe('x')
  })

  it('synthesizes an id when the model omits one', () => {
    const out = parser.feed('<<<TOOL_CALL>>>{"name":"x","arguments":{}}<<<END_TOOL_CALL>>>')
    expect(out.toolCalls[0]!.id).toMatch(/^emul_/)
  })

  it('flush() returns dangling prose without dropping it', () => {
    const out = parser.feed('only prose, no markers')
    const tail = parser.flush()
    expect(tail.toolCalls).toHaveLength(0)
    // Prose may have been split between feed (safe-to-emit prefix) and
    // flush (anything still buffered). Accumulating must reproduce the
    // input exactly.
    expect(out.prose + tail.prose).toBe('only prose, no markers')
  })
})
