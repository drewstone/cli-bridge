/** Removes common credential shapes from text that leaves the process: child stderr, commands in a trace. */
export function redactCredentials(text: string): string {
  return text
    .replace(/\b(Bearer\s+)[^\s,;]+/giu, '$1<redacted>')
    .replace(/\b(Basic\s+)[A-Za-z0-9+/]{12,}={0,2}/gu, '$1<redacted>')
    .replace(/\b(sk-(?:ant-|proj-)?|gh[opusr]_|github_pat_|xox[a-z]-)[A-Za-z0-9_-]{8,}/gu, '<redacted>')
    .replace(/\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)[^\s"',;]+/giu, '$1<redacted>')
    .replace(/(--[a-z0-9-]*(?:api-?key|token|secret|password)[a-z0-9-]*\s+)[^\s"',;]+/giu, '$1<redacted>')
    .replace(/(:\/\/)[^/\s:@]+:[^/\s@]+@/gu, '$1<redacted>@')
}
