const PI_CHILD_BASE_ENV_KEYS = [
  'HOME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'PWD',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'NVM_DIR',
  'PNPM_HOME',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_PACKAGE_DIR',
] as const

const PI_PROVIDER_ENV_ALIASES: Record<string, readonly string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
  openai: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  gemini: ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'],
  moonshot: ['MOONSHOT_API_KEY', 'MOONSHOT_BASE_URL'],
  'zai-coding-paas': ['ZAI_API_KEY', 'ZAI_GLM_API_KEY', 'ZAI_BASE_URL', 'ZAI_GLM_BASE_URL'],
  'zai-glm': ['ZAI_GLM_API_KEY', 'ZAI_GLM_BASE_URL', 'ZAI_API_KEY', 'ZAI_BASE_URL'],
  zai: ['ZAI_API_KEY', 'ZAI_BASE_URL'],
  zhipu: ['ZHIPU_API_KEY', 'ZHIPU_BASE_URL'],
  'tangle-router': ['TANGLE_API_KEY', 'TANGLE_BASE_URL', 'TANGLE_ROUTER_BASE_URL'],
  xai: ['XAI_API_KEY', 'XAI_BASE_URL'],
  groq: ['GROQ_API_KEY', 'GROQ_BASE_URL'],
  mistral: ['MISTRAL_API_KEY', 'MISTRAL_BASE_URL'],
  openrouter: ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL'],
  ollama: ['OLLAMA_HOST'],
}

const PI_BLOCKED_ENV_KEY =
  /(?:^|_)(?:API[_-]?KEY|AUTH(?:ORIZATION|ENTICATION)?|BEARER|COOKIE|CREDENTIALS?|PASSWORD|PASSPHRASE|PRIVATE[_-]?KEY|SECRET|TOKEN)(?:_|$)/iu

function piProviderEnvKeys(provider: string | undefined): Set<string> {
  if (!provider) return new Set()
  const normalized = provider.toLowerCase()
  const prefix = normalized
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_|_$/gu, '')
    .toUpperCase()
  return new Set([
    ...(PI_PROVIDER_ENV_ALIASES[normalized] ?? []),
    ...(prefix ? [`${prefix}_API_KEY`, `${prefix}_AUTH_TOKEN`, `${prefix}_BASE_URL`] : []),
  ])
}

function isSafeProfileEnvKey(key: string): boolean {
  return (
    /^[A-Z][A-Z0-9_]*$/u.test(key) &&
    !key.startsWith('BRIDGE_') &&
    !key.startsWith('CLI_BRIDGE_') &&
    !PI_BLOCKED_ENV_KEY.test(key)
  )
}

export function piChildEnv(
  spec: { provider?: string },
  cwd: string | undefined,
  profileEnv: Record<string, string> | undefined,
  directTools: string | undefined,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  const providerKeys = piProviderEnvKeys(spec.provider)
  const allowedParentKeys = new Set<string>([...PI_CHILD_BASE_ENV_KEYS, ...providerKeys])
  for (const key of allowedParentKeys) {
    const value = process.env[key]
    if (typeof value === 'string' && value.length > 0) out[key] = value
  }
  if (cwd) out.PWD = cwd
  if (directTools) out.MCP_DIRECT_TOOLS = directTools
  for (const [key, value] of Object.entries(profileEnv ?? {})) {
    if (!isSafeProfileEnvKey(key)) continue
    if (allowedParentKeys.has(key) || key === 'MCP_DIRECT_TOOLS') continue
    out[key] = value
  }
  return out
}

export function mapPrivateTreeArgs(args: readonly string[], hostRoot: string, runtimeRoot: string): string[] {
  const prefix = `${hostRoot}/`
  return args.map((value) =>
    value === hostRoot
      ? runtimeRoot
      : value.startsWith(prefix)
        ? `${runtimeRoot}/${value.slice(prefix.length)}`
        : value,
  )
}

export function mapPrivateTreeEnv(
  env: Readonly<Record<string, string>>,
  hostRoot: string,
  runtimeRoot: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, mapPrivateTreeArgs([value], hostRoot, runtimeRoot)[0]!]),
  )
}
