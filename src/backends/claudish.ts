/**
 * Claudish backend — Claude Code workflow, non-Anthropic brain.
 *
 * Runs the same `claude -p` subprocess as the Claude backend, but
 * spawns it with `ANTHROPIC_BASE_URL=<claudish-url>` so outbound
 * API calls go to a local `claudish` proxy. Claudish translates the
 * Anthropic request format into the target provider's format
 * (Z.AI / OpenRouter / Gemini / whatever) and streams back.
 *
 * Model id scheme: `claudish/<claudish-model-spec>`. claudish's own
 * scheme is `provider@model` (`openrouter@deepseek/deepseek-r1`), so
 * callers type e.g. `bridge/claudish/openrouter@deepseek/deepseek-r1`
 * or `bridge/claudish/google@gemini-2.0-flash`. We pass the `<rest>`
 * verbatim to Claude Code as `--model`; claudish reads it, routes it.
 *
 * Why a separate backend and not a flag on ClaudeBackend: lets you
 * register BOTH at once with different ANTHROPIC_BASE_URL values, and
 * puts the choice into the model id where it belongs. No env flip
 * required to switch between real-Anthropic and claudish-brained.
 */

import { ClaudeBackend, type ClaudeBackendOptions } from './claude.js'

export interface ClaudishBackendOptions extends Omit<ClaudeBackendOptions, 'harness' | 'anthropicBaseUrl'> {
  /** Claudish proxy URL. Required — claudish uniquely IS the override. */
  claudishUrl: string
}

export class ClaudishBackend extends ClaudeBackend {
  constructor(opts: ClaudishBackendOptions) {
    super({
      bin: opts.bin,
      timeoutMs: opts.timeoutMs,
      harness: 'claudish',
      anthropicBaseUrl: opts.claudishUrl,
    })
  }
}
