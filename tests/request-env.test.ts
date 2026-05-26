import { describe, it, expect } from 'vitest'
import { applyRequestEnvOverrides, REQUEST_ENV_ALLOWED_PREFIXES } from '../src/executors/request-env.js'

const base: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/root', TANGLE_API_KEY: 'sk-tan-boot' }

describe('applyRequestEnvOverrides — narrow allowlist for the search-MCP A/B', () => {
  it('returns base unchanged when no request env supplied', () => {
    const r = applyRequestEnvOverrides(base, undefined)
    expect(r.env).toEqual(base)
    expect(r.dropped).toEqual([])
  })

  it('THE primary use case: TANGLE_SEARCH_DEFAULT_PROVIDER override is accepted', () => {
    const r = applyRequestEnvOverrides(base, { TANGLE_SEARCH_DEFAULT_PROVIDER: 'you' })
    expect(r.env.TANGLE_SEARCH_DEFAULT_PROVIDER).toBe('you')
    expect(r.env.PATH).toBe('/usr/bin') // base preserved
    expect(r.dropped).toEqual([])
  })

  it('accepts all search-axis prefixes (every provider can be A/B-toggled per request)', () => {
    const req = {
      TANGLE_SEARCH_DEFAULT_PROVIDER: 'you',
      EXA_INCLUDE_AUTOPROMPT: 'true',
      TAVILY_TOPIC: 'news',
      PERPLEXITY_MODEL: 'sonar-pro',
      BRAVE_COUNTRY: 'US',
    }
    const r = applyRequestEnvOverrides(base, req)
    expect(r.dropped).toEqual([])
    for (const [k, v] of Object.entries(req)) expect(r.env[k]).toBe(v)
  })

  it('REJECTS PATH / LD_PRELOAD / NODE_OPTIONS injection (the multi-tenant safety case)', () => {
    const r = applyRequestEnvOverrides(base, {
      PATH: '/tmp/attacker:/usr/bin',
      LD_PRELOAD: '/tmp/attacker.so',
      NODE_OPTIONS: '--require /tmp/attacker.js',
    })
    expect(r.env.PATH).toBe('/usr/bin') // base preserved, NOT overridden
    expect(r.env.LD_PRELOAD).toBeUndefined()
    expect(r.env.NODE_OPTIONS).toBeUndefined()
    expect(r.dropped.map((d) => d.key).sort()).toEqual(['LD_PRELOAD', 'NODE_OPTIONS', 'PATH'])
    expect(r.dropped.every((d) => d.reason === 'key not on allowlist')).toBe(true)
  })

  it('REJECTS secret-suffix keys EVEN IF prefix matches (no key leak via request body / logs)', () => {
    const r = applyRequestEnvOverrides(base, {
      TANGLE_API_KEY: 'sk-tan-attacker',         // matches TANGLE_ prefix? no — not on the SEARCH allowlist
      YDC_API_KEY: 'attacker-key',               // matches YDC_ prefix BUT _API_KEY suffix → forbidden
      EXA_API_TOKEN: 'attacker-token',           // matches EXA_ prefix BUT _TOKEN suffix → forbidden
      TAVILY_SECRET: 'attacker-secret',          // matches TAVILY_ BUT _SECRET → forbidden
    })
    expect(r.env.TANGLE_API_KEY).toBe('sk-tan-boot') // base preserved
    expect(r.env.YDC_API_KEY).toBeUndefined()
    expect(r.env.EXA_API_TOKEN).toBeUndefined()
    expect(r.env.TAVILY_SECRET).toBeUndefined()
    // YDC/EXA/TAVILY dropped with the secret-suffix reason; TANGLE_API_KEY dropped as not-on-allowlist.
    expect(r.dropped.find((d) => d.key === 'YDC_API_KEY')?.reason).toMatch(/secret-suffix/)
    expect(r.dropped.find((d) => d.key === 'TANGLE_API_KEY')?.reason).toBe('key not on allowlist')
  })

  it('overrides win over base for allowed keys (the merge semantics callers depend on)', () => {
    const baseWithSearchPin: NodeJS.ProcessEnv = { ...base, TANGLE_SEARCH_DEFAULT_PROVIDER: 'exa' }
    const r = applyRequestEnvOverrides(baseWithSearchPin, { TANGLE_SEARCH_DEFAULT_PROVIDER: 'you' })
    expect(r.env.TANGLE_SEARCH_DEFAULT_PROVIDER).toBe('you')
  })

  it('drops empty values + caps value size (prevents 16k attacker payload)', () => {
    const huge = 'x'.repeat(5_000)
    const r = applyRequestEnvOverrides(base, { TANGLE_SEARCH_DEFAULT_PROVIDER: '', TANGLE_SEARCH_BIG: huge })
    expect(r.env.TANGLE_SEARCH_DEFAULT_PROVIDER).toBeUndefined()
    expect(r.env.TANGLE_SEARCH_BIG).toBeUndefined()
    expect(r.dropped.find((d) => d.key === 'TANGLE_SEARCH_DEFAULT_PROVIDER')?.reason).toBe('empty value')
    expect(r.dropped.find((d) => d.key === 'TANGLE_SEARCH_BIG')?.reason).toMatch(/exceeds/)
  })

  it('caps per-request key count (prevents flooding the spawn env)', () => {
    const lots: Record<string, string> = {}
    for (let i = 0; i < 30; i += 1) lots[`TANGLE_SEARCH_K${i}`] = 'v'
    const r = applyRequestEnvOverrides(base, lots)
    const accepted = Object.keys(r.env).filter((k) => k.startsWith('TANGLE_SEARCH_K')).length
    expect(accepted).toBeLessThanOrEqual(16)
    expect(r.dropped.some((d) => /per-request cap/.test(d.reason))).toBe(true)
  })

  it('an exact prefix match (no var-name suffix) is not allowed — must be a real key', () => {
    const r = applyRequestEnvOverrides(base, { TANGLE_SEARCH_: 'oops' })
    expect(r.env.TANGLE_SEARCH_).toBeUndefined()
  })

  it('allowlist itself stays narrow on purpose — operator should widen explicitly, never auto-include', () => {
    // Regression guard: if someone adds CLAUDE_ / OPENAI_ / etc. to the allowlist
    // without a security review, this fails so the diff has to be acknowledged.
    expect([...REQUEST_ENV_ALLOWED_PREFIXES].sort()).toEqual([
      'BRAVE_', 'EXA_', 'GOOGLE_CSE_', 'PARALLEL_', 'PERPLEXITY_', 'SERPAPI_', 'SERPER_', 'TANGLE_SEARCH_', 'TAVILY_', 'YDC_',
    ])
  })
})
