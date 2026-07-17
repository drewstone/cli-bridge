import { describe, it, expect } from 'vitest'
import { discoverModels, parseOpencodeModels, parsePiModels } from '../src/lib/model-discovery.js'

describe('parseOpencodeModels', () => {
  const providers = ['deepseek', 'kimi-for-coding', 'zai-coding-plan']
  const sample = [
    'opencode/big-pickle',
    'deepseek/deepseek-v4-pro',
    'kimi-for-coding/k2p7',
    'kimi-for-coding/k3',
    'moonshotai/kimi-k2.6',
    'zai-coding-plan/glm-5.2',
  ].join('\n')

  it('keeps only models under routable provider prefixes', () => {
    const ids = parseOpencodeModels(sample, providers)
    expect(ids).toContain('kimi-for-coding/k2p7')
    expect(ids).toContain('kimi-for-coding/k3')
    expect(ids).toContain('deepseek/deepseek-v4-pro')
    expect(ids).toContain('zai-coding-plan/glm-5.2')
  })

  it('drops free tiers and unconfigured providers', () => {
    const ids = parseOpencodeModels(sample, providers)
    expect(ids).not.toContain('opencode/big-pickle')
    expect(ids).not.toContain('moonshotai/kimi-k2.6')
  })

  it('strips ANSI color codes', () => {
    const ids = parseOpencodeModels('\x1b[32mkimi-for-coding/k3\x1b[0m', providers)
    expect(ids).toEqual(['kimi-for-coding/k3'])
  })
})

describe('parsePiModels', () => {
  const providers = ['deepseek', 'openai-codex', 'zai-glm']
  const table = [
    'provider               model                       context  max-out  thinking  images',
    'anthropic              claude-3-5-sonnet           200K     8K       no        yes',
    'deepseek               deepseek-v4-pro             1M       384K     yes       no',
    'openai-codex           gpt-5.5                     272K     128K     yes       yes',
    'zai-glm                glm-4.7                     200K     128K     yes       yes',
  ].join('\n')

  it('parses the whitespace table into provider/model ids', () => {
    const ids = parsePiModels(table, providers)
    expect(ids).toContain('deepseek/deepseek-v4-pro')
    expect(ids).toContain('openai-codex/gpt-5.5')
    expect(ids).toContain('zai-glm/glm-4.7')
  })

  it('skips the header row and unconfigured providers', () => {
    const ids = parsePiModels(table, providers)
    expect(ids.some((id) => id.startsWith('provider/'))).toBe(false)
    expect(ids.some((id) => id.startsWith('anthropic/'))).toBe(false)
  })
})

describe('discoverModels fallback', () => {
  it('returns the curated seed (never empty) when the CLI binary is missing', async () => {
    const fallback = [{ id: 'kimi-for-coding/k2p6', note: 'seed' }]
    const models = await discoverModels('discovery-test-missing-bin', {
      bin: '/nonexistent/binary-xyz',
      args: ['models'],
      providers: ['kimi-for-coding'],
      parse: parseOpencodeModels,
      fallback,
    })
    expect(models).toEqual(fallback)
    expect(models.length).toBeGreaterThan(0)
  })
})
