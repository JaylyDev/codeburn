import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Snap Store review rejected the first submission because every entry was a
// tool's whole root, and personal-files read is recursive: granting $HOME/.claude
// granted .claude/.credentials.json with it. Each entry must name the log
// directory (or file) the provider actually opens, never the root above it.
// The exceptions below are roots only because the provider reads a file sitting
// directly in them, so no narrower path exists without wildcards.
const ROOT_GRANTS_WITH_NO_NARROWER_FORM = new Set([
  '$HOME/.local/share/opencode',    // opencode*.db sits in the data dir itself
  '$HOME/.local/share/crush',       // projects.json sits in the data dir itself
  '$HOME/.local/share/kilo',        // kilo*.db sits in the data dir itself
  '$HOME/.lingtai',                 // per-agent dirs sit directly under the home root
  '$HOME/.lingtai-tui',             // registry.jsonl / brief/projects/* sit directly under the global dir
])

const XDG_PARENTS = ['.config', '.local']

function readPlug(name: string): Record<string, unknown> {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
  const plug = pkg.build.snap.plugs.find(
    (p: unknown) => typeof p === 'object' && p !== null && name in (p as object),
  )
  return (plug as Record<string, Record<string, unknown>>)[name]
}

function readGrants(): string[] {
  return readPlug('ai-agent-session-logs').read as string[]
}

describe('snap personal-files declaration', () => {
  it('names a log path under each tool root, never the root itself', () => {
    const bare: string[] = []
    for (const entry of readGrants()) {
      if (ROOT_GRANTS_WITH_NO_NARROWER_FORM.has(entry)) continue
      const segments = entry.replace('$HOME/', '').split('/')
      const depth = XDG_PARENTS.includes(segments[0] ?? '') ? 3 : 2
      if (segments.length < depth) bare.push(entry)
    }
    expect(bare).toEqual([])
  })

  it('requests read only and never a credential file', () => {
    // Snap Store review (forum topic 52615): credentials must not ride along
    // with the auto-connected session-log plug.
    const plug = readPlug('ai-agent-session-logs')
    expect(Object.keys(plug).sort()).toEqual(['interface', 'read'])
    expect(readGrants().filter(e => e.includes('credential') || e.includes('auth.json')))
      .toEqual([])
  })

  it('keeps the Claude credential file in its own manually-connected plug', () => {
    const plug = readPlug('claude-quota-credentials')
    expect(plug).toBeDefined()
    expect(Object.keys(plug).sort()).toEqual(['interface', 'read'])
    expect(plug.interface).toBe('personal-files')
    expect(plug.read).toEqual(['$HOME/.claude/.credentials.json'])
  })

  it('matches the lowercase path the VS Code Copilot parser actually opens', () => {
    // Linux is case-sensitive: the parser reads globalStorage/github.copilot-chat
    // (copilot.ts getAgentTracesDbPath), never the capitalized GitHub.copilot-chat.
    const grants = readGrants()
    for (const variant of ['Code', 'Code - Insiders', 'VSCodium']) {
      expect(grants).toContain(`$HOME/.config/${variant}/User/globalStorage/github.copilot-chat`)
      expect(grants).not.toContain(`$HOME/.config/${variant}/User/globalStorage/GitHub.copilot-chat`)
    }
  })

  it('never covers a credential file sitting beside a narrowed or removed root', () => {
    const grants = readGrants()
    // pi.ts reads $HOME/.pi/agent/sessions; $HOME/.pi/agent/auth.json is a
    // credential file one directory up and must never be reachable.
    expect(grants).toContain('$HOME/.pi/agent/sessions')
    expect(grants).not.toContain('$HOME/.pi/agent')
    expect(grants.some(e => e.startsWith('$HOME/.pi/agent/auth'))).toBe(false)
    // $HOME/.config/github-copilot holds the Copilot OAuth files hosts.json /
    // apps.json; the only thing under it the parser reads (JetBrains's
    // nitrite stores) sits at a variable depth that can't be granted without
    // also covering those credentials, so the whole root is dropped.
    expect(grants.some(e => e === '$HOME/.config/github-copilot' || e.startsWith('$HOME/.config/github-copilot/'))).toBe(false)
  })
})
