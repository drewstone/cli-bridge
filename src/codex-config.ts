/** Keep account settings while giving a turn only its declared MCP servers. */
export function replaceCodexMcpTables(base: string, requested: string): string {
  const kept: string[] = []
  let skipSection = false
  let section = ''
  for (const line of base.split('\n')) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line)
    if (header) {
      section = header[1]!.trim()
      skipSection = tomlRootKey(section) === 'mcp_servers'
    }
    if (skipSection) continue
    const trimmed = line.trimStart()
    if (!header && trimmed.startsWith('[')) throw new Error('Codex base config has unsupported table syntax')
    if (section === '' && !header && trimmed && !trimmed.startsWith('#')
      && trimmed.includes('=') && tomlRootKey(trimmed) === 'mcp_servers') continue
    kept.push(line)
  }
  return `${kept.join('\n').trimEnd()}\n${requested ? `\n${requested}` : ''}`
}

/** Read the first TOML key component; refuse syntax we cannot classify safely. */
function tomlRootKey(text: string): string {
  const input = text.trimStart()
  let key: string
  let rest: string
  if (input.startsWith('"')) {
    let end = 1
    for (; end < input.length; end++) {
      if (input[end] === '\\') { end++; continue }
      if (input[end] === '"') break
    }
    try { key = JSON.parse(input.slice(0, end + 1)) as string } catch {
      throw new Error('Codex base config has unsupported quoted key syntax')
    }
    rest = input.slice(end + 1).trimStart()
  } else if (input.startsWith("'")) {
    const end = input.indexOf("'", 1)
    if (end < 0) throw new Error('Codex base config has unsupported quoted key syntax')
    key = input.slice(1, end)
    rest = input.slice(end + 1).trimStart()
  } else {
    const match = /^[A-Za-z0-9_-]+/.exec(input)
    if (!match) throw new Error('Codex base config has unsupported key syntax')
    key = match[0]
    rest = input.slice(key.length).trimStart()
  }
  if (rest && !rest.startsWith('.') && !rest.startsWith('=')) {
    throw new Error('Codex base config has unsupported key syntax')
  }
  return key
}
