/**
 * codeburn plugin — CLI commands for the plugin socket (teams issue #3).
 *
 * Registers: plugin list | info <name> | verify <name>
 *
 * The socket is the user-facing escape hatch: when a plugin is silently
 * rejected (bad manifest, name/dir mismatch, CLI version out of range,
 * unsigned without CODEBURN_PLUGIN_DEV=1), `codeburn plugin list` prints
 * the reason. There is no on-the-wire behavior here — this is a read-only
 * inspector for the manifest layer.
 */

import type { Command } from 'commander'
import { stat } from 'fs/promises'
import { join } from 'path'

import { defaultPluginsDir, loadPlugins, currentCliVersion, verifyPlugin, readPluginManifestRaw } from './loader.js'
import { parsePluginManifest, type PluginManifest } from './manifest.js'

export function registerPluginCommands(program: Command): void {
  const plugin = program
    .command('plugin')
    .description('Inspect the plugin socket: list, info, verify (no installation; see docs/sync/README.md for `codeburn plugin add`)')

  plugin
    .command('list')
    .description('List every plugin the loader found, with status (loaded | rejected) and reason for rejections')
    .option('--dir <path>', 'Override the plugins directory (defaults to ~/.config/codeburn/plugins)')
    .action(async (opts: { dir?: string }) => {
      const loads = await loadPlugins(opts.dir)
      if (loads.length === 0) {
        process.stdout.write(`No plugins found in ${opts.dir ?? defaultPluginsDir()}.\n`)
        return
      }
      for (const load of loads) {
        if (load.status === 'loaded') {
          const m = load.manifest
          const caps: string[] = []
          if (m.capabilities.commands.length > 0) caps.push(`commands=${m.capabilities.commands.length}`)
          if (m.capabilities.syncAttributes.length > 0) caps.push(`syncAttrs=${m.capabilities.syncAttributes.length}`)
          if (m.capabilities.payloadSections.length > 0) caps.push(`sections=${m.capabilities.payloadSections.length}`)
          process.stdout.write(`loaded   ${m.name}@${m.version}  (${caps.join(', ')})\n`)
        } else {
          process.stdout.write(`rejected ${load.name}  ${load.reason}\n`)
        }
      }
    })

  plugin
    .command('info <name>')
    .description('Print the full manifest of a loaded plugin plus on-disk payload sections')
    .option('--dir <path>', 'Override the plugins directory')
    .action(async (name: string, opts: { dir?: string }) => {
      const loads = await loadPlugins(opts.dir)
      const loaded = loads.find((l): l is Extract<typeof l, { status: 'loaded' }> => l.status === 'loaded' && l.manifest.name === name)
      if (loaded) {
        const m = loaded.manifest
        process.stdout.write(JSON.stringify(m, null, 2) + '\n')
        const sections = await listOnDiskSections(loaded.dir, m)
        if (sections.length > 0) {
          process.stdout.write(`\non-disk payload sections: ${sections.join(', ')}\n`)
        } else {
          process.stdout.write(`\nno on-disk payload sections yet (plugin has not written any).\n`)
        }
        return
      }
      const rejected = loads.find((l): l is Extract<typeof l, { status: 'rejected' }> => l.status === 'rejected' && l.name === name)
      if (rejected) {
        throw new Error(`Plugin "${name}" is not loaded: ${rejected.reason}`)
      }
      throw new Error(`Plugin "${name}" not found in ${opts.dir ?? defaultPluginsDir()}.`)
    })

  plugin
    .command('verify <name>')
    .description('Re-run the verification hook for a named plugin and print the result (release-key signing lands in 9b)')
    .option('--dir <path>', 'Override the plugins directory')
    .action(async (name: string, opts: { dir?: string }) => {
      const dir = join(opts.dir ?? defaultPluginsDir(), name)
      const manifest = await readManifestForVerify(dir, name)
      if (!manifest) {
        throw new Error(`Plugin "${name}" could not be loaded for verify.`)
      }
      const result = await verifyPlugin(dir, manifest, process.env)
      if (result.ok) {
        process.stdout.write(`verified  ${name}@${manifest.version}\n`)
      } else {
        throw new Error(`unverified  ${name}@${manifest.version}  ${result.reason ?? 'verification failed'}`)
      }
    })
}

/// Reads the manifest at <dir>/codeburn-plugin.json and parses it via the
/// same loader path (so a verify command reports the same shape list/info do).
async function readManifestForVerify(dir: string, name: string): Promise<PluginManifest | null> {
  const { raw, reason } = await readPluginManifestRaw(dir)
  if (reason) {
    process.stderr.write(`Plugin "${name}": ${reason}\n`)
    return null
  }
  const parsed = parsePluginManifest(raw, `${name}/codeburn-plugin.json`)
  if (!parsed.ok) {
    process.stderr.write(`Plugin "${name}": ${parsed.reason}\n`)
    return null
  }
  return parsed.manifest
}

async function listOnDiskSections(dir: string, m: PluginManifest): Promise<string[]> {
  const out: string[] = []
  for (const name of m.capabilities.payloadSections) {
    const file = join(dir, 'sections', `${name}.json`)
    try {
      const info = await stat(file)
      if (info.isFile() && info.size <= 256 * 1024) out.push(name)
    } catch { /* missing is fine, sections are optional */ }
  }
  return out
}

// Re-export so consumers can pin the version pinned by the socket itself.
export { defaultPluginsDir, currentCliVersion }