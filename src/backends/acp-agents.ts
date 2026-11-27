/**
 * How each ACP agent the Bridge drives starts, takes MCP servers, reports usage and takes input for a
 * running turn. Each entry was measured on the version agent-container's image pins
 * (`infra/nix/agent-clis.json`), against the Router's scripted model with no vendor login.
 *
 * - GitHub Copilot CLI 1.0.113 (`copilot --acp`) runs on an OpenAI-compatible route from its
 *   `COPILOT_PROVIDER_*` variables with `COPILOT_OFFLINE=true`. It ignores `mcpServers` in
 *   `session/new`; it loads them from `--additional-mcp-config @<file>`, each entry naming its
 *   transport. Its `session/prompt` result's usage totals every prompt the process has answered. A
 *   second `session/prompt` ends the running one (`stopReason: cancelled`) and is answered in the
 *   same session. `--allow-all` runs every tool without `session/request_permission`.
 * - Qwen Code 0.28.0 (`qwen --acp`) runs on `OPENAI_*`. It discovers MCP servers in the background
 *   after `session/new`, so a prompt sent at once sees none of their tools; with
 *   `QWEN_CODE_LEGACY_MCP_BLOCKING=1` it answers `session/new` once their tools are listed. It reports
 *   each model call's usage as `_meta.usage` on an empty `agent_message_chunk`, none on the prompt
 *   result. A second `session/prompt` ends the running one, as Copilot's does. `--approval-mode yolo`
 *   runs every tool without asking.
 * - Grok CLI 1.0.88 (`grok agent stdio`) takes its route from `GROK_MODELS_BASE_URL` and its model
 *   entries and default from `~/.grok/config.toml` (a model only in `managed_config.toml` is lost on
 *   `session/resume`). Its model reaches MCP tools only through its own `use_tool` tool. It reports
 *   usage as `_meta.usage` on the prompt result. A second `session/prompt` waits behind the running
 *   one (`_x.ai/queue/changed`), so a steer cancels the running prompt first; the agent answers it
 *   `cancelled` and answers the steer about 0.4 s later. `--always-approve` runs every tool without asking.
 * - DeepSeek Harness 0.2.2-rc.1 (`dsh --profile acp`) takes its provider route and model from a profile
 *   patch, such as `~/.dsh/cordis.patch.yml`, and mounts stdio and HTTP MCP servers from `session/new`.
 *   Its ACP answers carry no token counts (`usage_update` is context occupancy, `used` and `size`, and
 *   the prompt result a stop reason alone); the session's running totals are in its projection cache
 *   (dsh-usage.ts), which the Bridge reads for each turn's usage. It refuses a second `session/prompt`
 *   while one is in flight ("a prompt is already in flight for this session"), so a steer cancels the
 *   running prompt and waits for its `cancelled` answer before it prompts. The Bridge turns off its
 *   session telemetry export (`DSH_TELEMETRY_MODE=DISABLED`).
 * - hermes 0.23.2 (`hermes acp`) steers with its own `/steer` command (acp-native-session.ts).
 */

import type { AcpHarnessName } from '../config.js'
import type { AcpBackendOptions } from './acp.js'
import { dshSessionUsage } from './dsh-usage.js'

export type AcpAgentLaunch = Pick<AcpBackendOptions,
  'acpArgs' | 'unattendedArgs' | 'env' | 'envPassthroughKeys' | 'mcpConfigArgs' | 'cumulativeUsage' | 'usageSource' | 'steer'>

export const acpAgentLaunch: Record<AcpHarnessName, AcpAgentLaunch> = {
  hermes: { acpArgs: ['acp'], steer: { command: '/steer' } },
  dsh: {
    acpArgs: ['--profile', 'acp'],
    env: { DSH_TELEMETRY_MODE: 'DISABLED' },
    envPassthroughKeys: ['DSH_HOME', 'DSH_PERMISSION_MODE'],
    usageSource: dshSessionUsage,
    steer: 'interrupt',
  },
  copilot: {
    acpArgs: ['--acp'],
    unattendedArgs: ['--acp', '--allow-all'],
    envPassthroughKeys: ['COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDER_TYPE', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN',
      'COPILOT_PROVIDER_WIRE_API', 'COPILOT_PROVIDER_MODEL_ID', 'COPILOT_PROVIDER_WIRE_MODEL', 'COPILOT_PROVIDER_AZURE_API_VERSION',
      'COPILOT_PROVIDER_HEADERS', 'COPILOT_PROVIDER_MAX_PROMPT_TOKENS', 'COPILOT_PROVIDER_MAX_OUTPUT_TOKENS', 'COPILOT_MODEL',
      'COPILOT_OFFLINE', 'COPILOT_AUTO_UPDATE'],
    mcpConfigArgs: (path) => ['--additional-mcp-config', `@${path}`],
    cumulativeUsage: true,
    steer: 'prompt',
  },
  qwen: {
    acpArgs: ['--acp'],
    unattendedArgs: ['--acp', '--approval-mode', 'yolo'],
    env: { QWEN_CODE_LEGACY_MCP_BLOCKING: '1' },
    steer: 'prompt',
  },
  grok: {
    acpArgs: ['agent', 'stdio'],
    unattendedArgs: ['agent', '--always-approve', 'stdio'],
    envPassthroughKeys: ['XAI_API_KEY', 'GROK_MODELS_BASE_URL', 'GROK_MODELS_LIST_URL', 'GROK_XAI_API_BASE_URL', 'GROK_MAX_RETRIES'],
    steer: 'interrupt',
  },
}
