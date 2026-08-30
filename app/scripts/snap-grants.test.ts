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
  '$HOME/.config/github-copilot',   // JetBrains stores nest under a variable <ide>/<kind>/<storeId>
  '$HOME/.local/share/opencode',    // opencode*.db sits in the data dir itself
  '$HOME/.local/share/crush',       // projects.json sits in the data dir itself
  '$HOME/.local/share/kilo',        // kilo*.db sits in the data dir itself
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
})
