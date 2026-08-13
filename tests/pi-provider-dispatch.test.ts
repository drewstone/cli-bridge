import { describe, expect, it } from 'vitest'
import {
  annotateProviderDispatchFailureBody,
  providerDispatchFromPiFailure,
  stripProviderDispatchMarker,
} from '../src/backends/pi-inference-transport.js'

describe('Pi provider-dispatch transport proof', () => {
  const marker = 'request-scoped-marker'

  it('carries only Router’s exact pre-dispatch fact through Pi’s message-only error', () => {
    const body = JSON.stringify({
      error: {
        message: 'candidate grant limit exceeded',
        provider_dispatch: 'not_started',
      },
    })

    const annotated = annotateProviderDispatchFailureBody(body, marker)
    const parsed = JSON.parse(annotated) as {
      error: { message: string; provider_dispatch?: string }
    }

    expect(parsed.error.provider_dispatch).toBe('not_started')
    expect(providerDispatchFromPiFailure(parsed.error.message, marker)).toBe('not_started')
    expect(stripProviderDispatchMarker(parsed.error.message, marker))
      .toBe('candidate grant limit exceeded')
  })

  it('does not promote missing, different, or wrong-marker fields', () => {
    const cases = [
      { error: { message: 'provider failed' } },
      { error: { message: 'provider failed', provider_dispatch: 'started' } },
      { error: { message: 'provider failed', provider_dispatch: true } },
    ]

    for (const body of cases) {
      const annotated = annotateProviderDispatchFailureBody(JSON.stringify(body), marker)
      expect(annotated).toBe(JSON.stringify(body))
      expect(providerDispatchFromPiFailure('provider failed', marker)).toBeUndefined()
    }

    const typed = JSON.parse(annotateProviderDispatchFailureBody(
      JSON.stringify({ error: { message: 'rejected', provider_dispatch: 'not_started' } }),
      marker,
    )) as { error: { message: string } }
    expect(providerDispatchFromPiFailure(typed.error.message, 'another-marker')).toBeUndefined()
  })
})
