// Static guard for issue #920: every `process.env` read inside
// src/providers/*.ts must be declared in PROVIDER_ENV_VARS for every provider
// whose cache section that file's reads affect — or be allowlisted below with
// a reason. An env var that changes what a provider discovers or how its
// sessions parse but is not fingerprinted means the cache section survives
// the change and serves silently stale numbers, exactly the defect class #920
// reported (nine providers slipped through it).
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { PROVIDER_ENV_VARS } from '../src/session-cache.js'
import { getAllProviders } from '../src/providers/index.js'

// ── src/providers/<file> → provider registry name(s) ────────────────────
// The provider(s) whose cache section the file's env reads affect. Derived
// from the real code at the freeze sha (3600408); registry names come from
// src/providers/index.ts. Do NOT infer this from the filename at runtime —
// the two diverge (e.g. the shared sqlite-session-parser.ts serves two
// providers). A file that contains env reads and is missing here fails the
// guard: add it, with the provider(s) the reads serve.
const FILE_PROVIDERS: Record<string, string[]> = {
  'claude.ts': ['claude'],
  'cline-cli.ts': ['cline-cli'],
  'codebuff.ts': ['codebuff'],
  'codewhale.ts': ['codewhale'],
  'codex.ts': ['codex'],
  'copilot.ts': ['copilot'],
  'droid.ts': ['droid'],
  'hermes.ts': ['hermes'],
  'lingtai-tui.ts': ['lingtai-tui'],
  // Its only literal read is CODEBURN_CURSOR_MAX_BUBBLES (cursor.ts:692);
  // XDG_DATA_HOME is declared for cursor but not read literally in this file.
  'cursor.ts': ['cursor'],
  // The ENV_DIR const (open-design.ts:10) resolves to CODEBURN_OPEN_DESIGN_DIR.
  'open-design.ts': ['open-design'],
  'opencode.ts': ['opencode'],
  'goose.ts': ['goose'],
  'grok.ts': ['grok'],
  'crush.ts': ['crush'],
  'warp.ts': ['warp'],
  'antigravity.ts': ['antigravity'],
  'kilo-code.ts': ['kilo-code'],
  'kimi.ts': ['kimi'],
  'kiro.ts': ['kiro'],
  'mistral-vibe.ts': ['mistral-vibe'],
  'mux.ts': ['mux'],
  'qwen.ts': ['qwen'],
  'ibm-bob.ts': ['ibm-bob'],
  'quickdesk.ts': ['quickdesk'],
  'kimicode.ts': ['kimicode'],
  'zerostack.ts': ['zerostack'],
  // Shared sqlite parser; its only importers in src/ are kilo-code.ts and
  // opencode.ts. Its single read (CODEBURN_VERBOSE) is allowlisted, so this
  // entry is informational — but required, because the file has reads.
  'sqlite-session-parser.ts': ['kilo-code', 'opencode'],
  // Registered (lazy) network provider; its credential reads are allowlisted
  // (see below) because network sources are re-fetched on every run.
  'vercel-gateway.ts': ['vercel-gateway'],
}

// ── Allowlisted reads ────────────────────────────────────────────────────
// Reads that must NOT invalidate a cache section, one-line reason each.
// If you add an entry here, the guard goes silent for that var — so the
// reason must say exactly why a change to it cannot make a cached section
// stale.
const ALLOWLIST: Record<string, string> = {
  CODEBURN_VERBOSE: 'sqlite-session-parser.ts:276 — logging verbosity only; changes no discovered path and no parsed value',
  // vercel-gateway is a registered (lazy) provider — not "not a provider" —
  // but it is network:true (vercel-gateway.ts:123): its single synthetic
  // source is re-fetched on every run and never served from the cached
  // section, because parser.ts:2888 short-circuits network providers past the
  // fingerprint compare. No fingerprint of it can therefore go stale.
  AI_GATEWAY_API_KEY: 'vercel-gateway.ts:20 — network credential; parser.ts:2888 re-fetches every run',
  VERCEL_OIDC_TOKEN: 'vercel-gateway.ts:20 — network credential; parser.ts:2888 re-fetches every run',
}

// ── Static extraction ───────────────────────────────────────────────────

// Resolved relative to this test file, never the process cwd.
const PROVIDERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'providers')

type EnvRead = { varName: string; line: number }

// `const IDENT = 'NAME'` string declarations, used to resolve
// `process.env[IDENT]` reads (open-design.ts does this with ENV_DIR).
const STRING_CONST = /const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(['"])([^'"]*)\2/g

function extractEnvReads(source: string): { reads: EnvRead[]; unresolvable: Array<{ line: number; expr: string }> } {
  const consts = new Map<string, string>()
  for (const m of source.matchAll(STRING_CONST)) consts.set(m[1]!, m[3]!)

  const reads: EnvRead[] = []
  const unresolvable: Array<{ line: number; expr: string }> = []
  const anyRead = /process\.env/g
  for (const m of source.matchAll(anyRead)) {
    const line = source.slice(0, m.index).split('\n').length
    const rest = source.slice(m.index + 'process.env'.length)
    // The expression as written, for failure messages.
    const expr = rest.trim().split(/[;\n]/)[0]!

    if (rest.trimStart().startsWith('[')) {
      const bracket = rest.slice(rest.indexOf('['))
      const literal = /^\[\s*(['"])([A-Z0-9_]+)\1\s*\]/.exec(bracket)
      if (literal) {
        reads.push({ varName: literal[2]!, line })
        continue
      }
      const ident = /^\[\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\]/.exec(bracket)
      if (ident) {
        const resolved = consts.get(ident[1]!)
        if (resolved) {
          reads.push({ varName: resolved, line })
          continue
        }
        unresolvable.push({ line, expr: `process.env[${ident[1]}]` })
        continue
      }
      unresolvable.push({ line, expr: `process.env${expr}` })
      continue
    }

    if (rest.trimStart().startsWith('.')) {
      const dot = /^\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(rest)
      if (dot) {
        reads.push({ varName: dot[1]!, line })
        continue
      }
    }

    // Bare `process.env` or any other form: cannot name a var — fail loudly,
    // an unresolvable read must never be silently skipped.
    unresolvable.push({ line, expr: `process.env${expr}` })
  }
  return { reads, unresolvable }
}

function failWith(problems: string[]): void {
  if (problems.length > 0) throw new Error(`\n${problems.join('\n\n')}`)
}

describe('provider env declarations (#920)', () => {
  it('every process.env read in src/providers is declared for the provider(s) it serves', () => {
    const problems: string[] = []

    for (const entry of readdirSync(PROVIDERS_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue

      const source = readFileSync(join(PROVIDERS_DIR, entry.name), 'utf8')
      const { reads, unresolvable } = extractEnvReads(source)
      if (reads.length === 0 && unresolvable.length === 0) continue

      const served = FILE_PROVIDERS[entry.name]
      if (!served) {
        problems.push(
          `src/providers/${entry.name} reads env vars (${reads.map(r => r.varName).join(', ')}) but is missing from FILE_PROVIDERS — add it with the provider(s) whose cache section these reads affect.`,
        )
        continue
      }

      for (const { line, expr } of unresolvable) {
        problems.push(
          `src/providers/${entry.name}:${line}: unresolvable env read \`${expr}\` — resolve it to a literal name (e.g. \`const IDENT = 'NAME'\` in the same file) so the guard can verify it is declared; an unresolvable read must never be silently skipped.`,
        )
      }

      for (const { varName, line } of reads) {
        if (ALLOWLIST[varName]) continue
        for (const provider of served) {
          if (!(PROVIDER_ENV_VARS[provider] ?? []).includes(varName)) {
            problems.push(
              `provider '${provider}' reads process.env['${varName}'] at src/providers/${entry.name}:${line} but it is not declared in PROVIDER_ENV_VARS['${provider}'] — declare it there (it changes what the provider discovers or how its sessions parse) or add it to ALLOWLIST with a reason.`,
            )
          }
        }
      }
    }

    failWith(problems)
  })

  it('every PROVIDER_ENV_VARS key is a real provider name from the registry', async () => {
    const names = new Set((await getAllProviders()).map(p => p.name))
    const problems: string[] = []
    for (const key of Object.keys(PROVIDER_ENV_VARS)) {
      if (!names.has(key)) {
        // A typo'd key declares nothing and fails silently — the same defect
        // class #920 fixed. Do NOT delete the key or weaken the assertion;
        // surface it so the registry or the key gets corrected.
        problems.push(`PROVIDER_ENV_VARS key '${key}' is not a registered provider name — a typo'd key declares nothing and fails silently.`)
      }
    }
    failWith(problems)
    expect(problems).toEqual([])
  })
})
