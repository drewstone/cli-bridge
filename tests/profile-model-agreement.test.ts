/**
 * Model agreement between an exact AgentProfile and the request that carries it.
 *
 * `assertExactProfileRequest` is the gate every profiled turn passes before a
 * harness process starts, and it had no direct test. Measured 2026-09-10 on the
 * bridge at 127.0.0.1:3344 (issue #212): a kimi-code profile whose provider is
 * its own harness was refused with `request model "kimi-code/kimi-for-coding"
 * conflicts with agent_profile.model "kimi-code/kimi-for-coding"` — two equal
 * strings, because one side had been stripped of its harness prefix and the
 * other had not. A live pursuit settled `driver-failed` with zero tokens on it,
 * and no profile shape satisfied Runtime, this check, and the Kimi CLI at once.
 *
 * The ids below are the real ones each side composes: agent-runtime builds
 * `harness/provider/model` in `profileBridgeWireModel` (src/runtime/supervise/
 * model-policy.ts), and the Kimi CLI resolves `--model` against literal
 * `config.toml` keys such as `[models."kimi-code/kimi-for-coding"]`.
 *
 * The comparison itself is `modelIdsMatch` from
 * `@tangle-network/agent-profile-materialize`, which owns model-id equality for
 * every writer and reader of an `AgentProfile`. These cases therefore pin what
 * the bridge adds on top of it — the harness prefix, which that package does not
 * own — and not the qualification rule itself, which has its own tests upstream.
 */

import { describe, expect, it } from 'vitest'
import type { AgentProfile } from '@tangle-network/agent-interface'
import type { HarnessId } from '@tangle-network/agent-profile-materialize'
import { assertExactProfileRequest } from '../src/backends/profile-support.js'
import type { ChatRequest } from '../src/backends/types.js'

function request(model: string): ChatRequest {
  return { model, messages: [{ role: 'user', content: 'say ok' }], mode: 'byob' } as ChatRequest
}

function profile(harness: HarnessId, model: AgentProfile['model']): AgentProfile {
  return { name: 'director', harness, model }
}

function check(model: string, harness: HarnessId, declared: AgentProfile['model']): void {
  assertExactProfileRequest(request(model), profile(harness, declared), harness)
}

describe('assertExactProfileRequest — the wire id each harness actually receives', () => {
  it('accepts the claude-code id Runtime composes, under either harness prefix', () => {
    const declared = { default: 'claude-sonnet-4-5', provider: 'anthropic' }
    expect(() => check('claude-code/anthropic/claude-sonnet-4-5', 'claude-code', declared)).not.toThrow()
    // The `claude` prefix is not a spelling variant to be tolerated: a ClaudeBackend
    // registered under its default name claims `claude/` while still stating the
    // `claude-code` harness here, which is the route tests/docker-executor.test.ts drives.
    expect(() => check('claude/anthropic/claude-sonnet-4-5', 'claude-code', declared)).not.toThrow()
  })

  it('accepts the codex id Runtime composes', () => {
    expect(() =>
      check('codex/openai/gpt-5-codex', 'codex', { default: 'openai/gpt-5-codex', provider: 'openai' }),
    ).not.toThrow()
  })

  it('accepts an opencode profile whose provider is its own harness', () => {
    // profiles/opencode-generalist.json: provider `opencode`, default `anthropic/claude-sonnet-4-5`.
    // Runtime keeps one harness prefix, so the provider segment never reaches the bridge.
    expect(() =>
      check('opencode/anthropic/claude-sonnet-4-5', 'opencode', {
        default: 'anthropic/claude-sonnet-4-5',
        provider: 'opencode',
      }),
    ).not.toThrow()
  })

  it('accepts the kimi-code id from issue #212 that the Kimi CLI has a config.toml key for', () => {
    expect(() =>
      check('kimi-code/kimi-for-coding', 'kimi-code', {
        default: 'kimi-for-coding',
        provider: 'kimi-code',
      }),
    ).not.toThrow()
    // The same profile reached through the `kimi` alias prefix.
    expect(() =>
      check('kimi/kimi-for-coding', 'kimi-code', { default: 'kimi-for-coding', provider: 'kimi-code' }),
    ).not.toThrow()
  })

  it('accepts the three-segment kimi-code id a non-harness provider produces', () => {
    // Issue #212's second profile. The bridge is not what refuses this one — the
    // Kimi CLI has no `kimi-code/moonshot/kimi-for-coding` key — so the check must
    // not add a second, different refusal on top.
    expect(() =>
      check('kimi-code/moonshot/kimi-for-coding', 'kimi-code', {
        default: 'kimi-for-coding',
        provider: 'moonshot',
      }),
    ).not.toThrow()
  })

  it('still refuses a request model the profile does not declare, naming both compared ids', () => {
    expect(() =>
      check('codex/openai/gpt-4.1', 'codex', { default: 'gpt-5-codex', provider: 'openai' }),
    ).toThrow(
      'request model "codex/openai/gpt-4.1" selects "openai/gpt-4.1" within harness "codex", '
      + 'which conflicts with agent_profile.model "openai/gpt-5-codex"',
    )
  })

  it('still refuses a request model that selects another harness', () => {
    expect(() =>
      check('codex/openai/gpt-5-codex', 'kimi-code', { default: 'kimi-for-coding', provider: 'kimi-code' }),
    ).toThrow('request model "codex/openai/gpt-5-codex" does not select harness "kimi-code"')
  })

  it('still refuses a profile harness other than the selected one', () => {
    expect(() =>
      assertExactProfileRequest(
        request('kimi-code/kimi-for-coding'),
        profile('claude-code', { default: 'kimi-for-coding', provider: 'kimi-code' }),
        'kimi-code',
      ),
    ).toThrow('agent_profile.harness "claude-code" conflicts with selected harness "kimi-code"')
  })
})

describe('assertExactProfileRequest — a profile that names only its provider', () => {
  it('accepts a provider that is its own harness, present or absent on the wire', () => {
    expect(() => check('kimi-code/kimi-for-coding', 'kimi-code', { provider: 'kimi-code' })).not.toThrow()
    // A caller that states the provider twice still names the same provider, so this is not a
    // disagreement between the request and the profile. Keeping the harness name out of the
    // CLI's own provider argument (#161) is enforced where the argv is built — see
    // tests/codex-backend.test.ts — because that is the only place it also holds for a
    // request that carries no profile at all.
    expect(() =>
      check('kimi-code/kimi-code/kimi-for-coding', 'kimi-code', { provider: 'kimi-code' }),
    ).not.toThrow()
  })

  it('accepts a provider the wire id names', () => {
    expect(() =>
      check('claude-code/anthropic/claude-sonnet-4-5', 'claude-code', { provider: 'anthropic' }),
    ).not.toThrow()
  })

  it('refuses a request that selects no model at all, where the provider cannot be confirmed', () => {
    // agent-runtime composes the bare harness id for a profile with no model: there is
    // nothing to qualify, so the declared provider never reaches the wire. Accepting would
    // let the CLI pick its own provider while the profile named one.
    expect(() => check('codex', 'codex', { provider: 'openai' })).toThrow(
      'request model "codex" selects provider null within harness "codex", '
      + 'not agent_profile.model.provider "openai"',
    )
  })

  it('refuses a request that selects a different provider', () => {
    expect(() => check('kimi-code/moonshot/kimi-for-coding', 'kimi-code', { provider: 'kimi-code' })).toThrow(
      'request model "kimi-code/moonshot/kimi-for-coding" selects provider "moonshot" within harness '
      + '"kimi-code", not agent_profile.model.provider "kimi-code"',
    )
  })
})
