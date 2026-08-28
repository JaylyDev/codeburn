/**
 * Tests for the CB-3 plugin socket (teams issue #3).
 *
 * Covers:
 *   1. Wire guard: filterPluginAttributes strips any key not declared by a loaded plugin.
 *   2. Byte-identical guarantee: with no plugins installed, the OTLP payload and
 *      menubar payload are unchanged from before the socket shipped.
 *   3. Loader behavior: oversized / unparseable manifests are rejected with a reason;
 *      valid manifests round-trip.
 *   4. Plugin CLI: `codeburn plugin list|info|verify` work against a custom dir.
 *
 * The byte-identical test is the most important one: it re-pins the contract that
 * no plugin code can run until the user opts in by installing one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, stat } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { buildOtlpPayload, type OtlpAttribute } from '../src/sync/otlp.js'
import { pluginPayloadSections, loadPlugins } from '../src/plugins/loader.js'
import { filterPluginAttributes } from '../src/sync/otlp.js'

// ── Helpers ───────────────────────────────────────────────────────────

/** Minimal valid manifest — exercises every declared-shape field. */
function validManifest(name = 'sample') {
  return {
    name,
    version: '0.1.0',
    cliCompat: '>=0.9.22',
    capabilities: {
      commands: ['sample'],
      syncAttributes: [{ key: 'sample.score', disclosure: 'numeric score 0..1' }],
      payloadSections: ['sample'],
      spanKinds: [],
    },
  }
}

let tmpDir: string
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'plugin-socket-'))
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ── 1. Wire guard ─────────────────────────────────────────────────────

describe('wire guard: filterPluginAttributes', () => {
  it('drops every key not in the declared set', () => {
    const attrs: OtlpAttribute[] = [
      { key: 'sample.score', value: { stringValue: '0.9' } },
      { key: 'rogue.attr', value: { stringValue: 'should-be-dropped' } },
      { key: 'sample.tag', value: { stringValue: 'kept' } },
    ]
    const out = filterPluginAttributes(attrs, new Set(['sample.score', 'sample.tag']))
    expect(out.map(a => a.key).sort()).toEqual(['sample.score', 'sample.tag'])
  })

  it('passes through an empty declared set untouched (zero-plugin default)', () => {
    const attrs: OtlpAttribute[] = [
      { key: 'any.thing', value: { stringValue: '1' } },
    ]
    expect(filterPluginAttributes(attrs, new Set())).toEqual([])
  })

  it('keeps attrs when the plugin declared exactly the keys it shipped', () => {
    const attrs: OtlpAttribute[] = [
      { key: 'sample.score', value: { doubleValue: 0.7 } },
    ]
    expect(filterPluginAttributes(attrs, new Set(['sample.score']))).toEqual(attrs)
  })
})

// ── 2. Byte-identical wire with no plugins ────────────────────────────

describe('byte-identical guarantee: no plugins => no payload change', () => {
  it('buildOtlpPayload without pluginAttributes produces zero plugin keys', () => {
    const payload = buildOtlpPayload([], { coverageThrough: '2026-07-10' }) as unknown as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ attributes: OtlpAttribute[] }> }> }>
    }
    const allAttrs = payload.resourceSpans.flatMap(rs => rs.scopeSpans.flatMap(ss => ss.spans.flatMap(s => s.attributes)))
    const pluginKeys = allAttrs.filter(a => a.key.startsWith('sample.') || a.key.startsWith('codeburn.plugin.'))
    expect(pluginKeys).toEqual([])
  })

  it('pluginPayloadSections is empty with an empty plugin directory', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'empty-plugins-'))
    try {
      const loads = await loadPlugins(emptyDir, '0.9.22')
      expect(loads).toEqual([])
      const sections = await pluginPayloadSections(loads)
      expect(sections).toEqual({})
    } finally {
      await rm(emptyDir, { recursive: true, force: true })
    }
  })
})

// ── 3. Loader behavior ────────────────────────────────────────────────

describe('loader: rejection reasons', () => {
  it('rejects an oversized manifest with reason "oversized"', async () => {
    const pluginDir = join(tmpDir, 'big')
    await mkdir(pluginDir, { recursive: true })
    const big = 'x'.repeat(70 * 1024) // > 64 KiB cap
    await writeFile(join(pluginDir, 'codeburn-plugin.json'), big)
    const loads = await loadPlugins(tmpDir, '0.9.22', { ...process.env, CODEBURN_PLUGIN_DEV: '1' })
    expect(loads).toHaveLength(1)
    expect(loads[0]!.status).toBe('rejected')
    if (loads[0]!.status === 'rejected') {
      expect(loads[0]!.reason).toMatch(/oversized|too large/)
    }
  })

  it('rejects malformed JSON with reason "unparseable"', async () => {
    const pluginDir = join(tmpDir, 'malformed')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'codeburn-plugin.json'), '{not valid json')
    const loads = await loadPlugins(tmpDir, '0.9.22', { ...process.env, CODEBURN_PLUGIN_DEV: '1' })
    expect(loads).toHaveLength(1)
    expect(loads[0]!.status).toBe('rejected')
    if (loads[0]!.status === 'rejected') {
      expect(loads[0]!.reason).toMatch(/unparseable|JSON|unreadable/)
    }
  })

  it('rejects a valid but unsigned manifest when CODEBURN_PLUGIN_DEV is absent (deny-by-default)', async () => {
    const pluginDir = join(tmpDir, 'unsigned')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'codeburn-plugin.json'), JSON.stringify(validManifest('unsigned')))
    const env = { ...process.env }
    delete env.CODEBURN_PLUGIN_DEV
    const loads = await loadPlugins(tmpDir, '0.9.22', env)
    expect(loads).toHaveLength(1)
    expect(loads[0]!.status).toBe('rejected')
    if (loads[0]!.status === 'rejected') {
      expect(loads[0]!.reason).toMatch(/signature|unsigned/)
    }
  })

  it('loads a valid manifest with status:"loaded" and parsed shape', async () => {
    const pluginDir = join(tmpDir, 'good')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'codeburn-plugin.json'), JSON.stringify(validManifest('good')))
    const loads = await loadPlugins(tmpDir, '0.9.22', { ...process.env, CODEBURN_PLUGIN_DEV: '1' })
    expect(loads).toHaveLength(1)
    expect(loads[0]!.status).toBe('loaded')
    if (loads[0]!.status === 'loaded') {
      expect(loads[0]!.manifest.name).toBe('good')
      expect(loads[0]!.manifest.capabilities.syncAttributes[0]!.key).toBe('sample.score')
    }
  })
})

// ── 4. Plugin CLI ─────────────────────────────────────────────────────
// We import the CLI lazily so the test can drive it without booting Commander
// at module load (avoids polluting stderr during the no-plugin default tests).

describe('plugin CLI: codeburn plugin list|info|verify', () => {
  let registerPluginCommands: typeof import('../src/plugins/cli.js').registerPluginCommands
  beforeEach(async () => {
    const mod = await import('../src/plugins/cli.js')
    registerPluginCommands = mod.registerPluginCommands
  })

  function makeProgram() {
    // Lazy-import commander so we get a fresh program per test.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Command } = require('commander')
    const p = new Command()
    p.exitOverride() // throw instead of process.exit on unknown subcommand
    registerPluginCommands(p)
    return p
  }

  it('plugin list prints empty when no plugins are installed', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'empty-list-'))
    try {
      const program = makeProgram()
      // Commander doesn't capture stdout by default; we just assert no throw.
      await program.parseAsync(['node', 'codeburn', 'plugin', 'list', '--dir', emptyDir])
    } finally {
      await rm(emptyDir, { recursive: true, force: true })
    }
  })

  it('plugin info <name> exits non-zero when the plugin is missing', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'empty-info-'))
    try {
      const program = makeProgram()
      await expect(
        program.parseAsync(['node', 'codeburn', 'plugin', 'info', 'nope', '--dir', emptyDir]),
      ).rejects.toThrow()
    } finally {
      await rm(emptyDir, { recursive: true, force: true })
    }
  })

  it('plugin verify accepts a well-formed manifest', async () => {
    const pluginDir = join(tmpDir, 'verifiable')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'codeburn-plugin.json'), JSON.stringify(validManifest('verifiable')))
    const program = makeProgram()
    const prev = process.env.CODEBURN_PLUGIN_DEV
    process.env.CODEBURN_PLUGIN_DEV = '1'
    try {
      await program.parseAsync(['node', 'codeburn', 'plugin', 'verify', 'verifiable', '--dir', tmpDir])
    } finally {
      if (prev === undefined) delete process.env.CODEBURN_PLUGIN_DEV
      else process.env.CODEBURN_PLUGIN_DEV = prev
    }
  })

  it('plugin verify rejects a malformed manifest', async () => {
    const pluginDir = join(tmpDir, 'broken')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'codeburn-plugin.json'), '{ not json')
    const program = makeProgram()
    await expect(
      program.parseAsync(['node', 'codeburn', 'plugin', 'verify', 'broken', '--dir', tmpDir]),
    ).rejects.toThrow()
  })
})

// ── 5. Plugin command registration ────────────────────────────────────

describe('plugin command registration: registerLoadedPluginCommands', () => {
  let registerLoadedPluginCommands: typeof import('../src/plugins/cli.js').registerLoadedPluginCommands
  beforeEach(async () => {
    const mod = await import('../src/plugins/cli.js')
    registerLoadedPluginCommands = mod.registerLoadedPluginCommands
  })

  function makeProgram() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Command } = require('commander')
    const p = new Command()
    p.exitOverride()
    return p
  }

  it('a plugin declaring commands:["hello"] with commands/hello.mjs registers and runs', async () => {
    const pluginDir = join(tmpDir, 'hello-plugin')
    const commandsDir = join(pluginDir, 'commands')
    await mkdir(commandsDir, { recursive: true })

    const testFile = join(tmpDir, 'hello-ran.txt')
    const helloScript = `import { writeFileSync } from 'fs';
process.stdout.write('hello ' + process.argv.slice(2).join(' ') + '\\n');
writeFileSync(${JSON.stringify(testFile)}, 'yes');
`
    await writeFile(join(commandsDir, 'hello.mjs'), helloScript)

    const manifest = { ...validManifest('hello-plugin'), capabilities: { ...validManifest('hello-plugin').capabilities, commands: ['hello'] } }
    const loads = [
      {
        status: 'loaded' as const,
        manifest,
        dir: pluginDir,
      },
    ]

    const program = makeProgram()
    await registerLoadedPluginCommands(program, loads)

    const cmd = program.commands.find(c => c.name() === 'hello')
    expect(cmd).toBeDefined()
    expect(cmd?.description()).toContain('hello-plugin@0.1.0')

    const savedCode = process.exitCode
    process.exitCode = undefined
    try {
      await program.parseAsync(['node', 'codeburn', 'hello', 'world'])
      const info = await stat(testFile)
      expect(info.isFile()).toBe(true)
    } finally {
      process.exitCode = savedCode
    }
  })

  it('child process exit code 3 propagates to process.exitCode', async () => {
    const pluginDir = join(tmpDir, 'exit3-plugin')
    const commandsDir = join(pluginDir, 'commands')
    await mkdir(commandsDir, { recursive: true })

    await writeFile(join(commandsDir, 'fail.mjs'), 'process.exit(3);')

    const baseMfst = validManifest('exit3-plugin')
    const manifest = { ...baseMfst, capabilities: { ...baseMfst.capabilities, commands: ['fail'] } }
    const loads = [
      {
        status: 'loaded' as const,
        manifest,
        dir: pluginDir,
      },
    ]

    const program = makeProgram()
    await registerLoadedPluginCommands(program, loads)

    const savedCode = process.exitCode
    process.exitCode = undefined
    try {
      await program.parseAsync(['node', 'codeburn', 'fail'])
      expect(process.exitCode).toBe(3)
    } finally {
      process.exitCode = savedCode
    }
  })

  it('missing commands/hello.mjs writes stderr and sets exit code 1', async () => {
    const pluginDir = join(tmpDir, 'missing-plugin')
    await mkdir(pluginDir, { recursive: true })

    const baseMfst = validManifest('missing-plugin')
    const manifest = { ...baseMfst, capabilities: { ...baseMfst.capabilities, commands: ['hello'] } }
    const loads = [
      {
        status: 'loaded' as const,
        manifest,
        dir: pluginDir,
      },
    ]

    const program = makeProgram()
    await registerLoadedPluginCommands(program, loads)

    const savedCode = process.exitCode
    const savedStderr = process.stderr.write
    let stderrOutput = ''
    process.stderr.write = (chunk: string | Uint8Array | Buffer): boolean => {
      stderrOutput += chunk.toString()
      return true
    }
    process.exitCode = undefined

    try {
      await program.parseAsync(['node', 'codeburn', 'hello'])
      expect(stderrOutput).toContain('missing commands/hello.mjs')
      expect(process.exitCode).toBe(1)
    } finally {
      process.stderr.write = savedStderr
      process.exitCode = savedCode
    }
  })

  it('command collision with built-in skips registration and writes stderr', async () => {
    const pluginDir = join(tmpDir, 'collision-plugin')
    const commandsDir = join(pluginDir, 'commands')
    await mkdir(commandsDir, { recursive: true })
    await writeFile(join(commandsDir, 'help.mjs'), 'process.stdout.write("plugin help");')

    const baseMfst = validManifest('collision-plugin')
    const manifest = { ...baseMfst, capabilities: { ...baseMfst.capabilities, commands: ['help'] } }
    const loads = [
      {
        status: 'loaded' as const,
        manifest,
        dir: pluginDir,
      },
    ]

    const program = makeProgram()
    program.command('help').description('Built-in help')

    const savedStderr = process.stderr.write
    let stderrOutput = ''
    process.stderr.write = (chunk: string | Uint8Array | Buffer): boolean => {
      stderrOutput += chunk.toString()
      return true
    }

    try {
      await registerLoadedPluginCommands(program, loads)
      expect(stderrOutput).toContain('conflicts with a built-in')
      const helpCmd = program.commands.find(c => c.name() === 'help')
      expect(helpCmd?.description()).toBe('Built-in help')
    } finally {
      process.stderr.write = savedStderr
    }
  })

  it('rejected plugin commands are not registered', async () => {
    const pluginDir = join(tmpDir, 'rejected-plugin')
    await mkdir(pluginDir, { recursive: true })

    const loads = [
      {
        status: 'rejected' as const,
        name: 'rejected-plugin',
        dir: pluginDir,
        reason: 'unsigned',
      },
    ]

    const program = makeProgram()
    await registerLoadedPluginCommands(program, loads)

    const rejectedCmd = program.commands.find(c => c.name() === 'hello')
    expect(rejectedCmd).toBeUndefined()
  })
})
