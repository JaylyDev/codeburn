/// Plugin loader for the codeburn plugin socket (phase-1 mechanism).
///
/// Plugins live under ~/.config/codeburn/plugins/<name>/codeburn-plugin.json.
/// Loading is deny-by-default: bad manifest, name/directory mismatch, CLI
/// version outside cliCompat, or a failed verification hook each REJECT the
/// plugin, and the rejection reason is what the surfaces print.
///
/// Verification (phase 9b) will check a release-key signature over the
/// plugin directory. The seam is `verifyPlugin()` below and nothing else:
/// until signing ships, only `CODEBURN_PLUGIN_DEV=1` loads an unsigned
/// plugin, so there is exactly one auditable line between "signed" and
/// "on the wire".

import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { createRequire } from 'module'

import { checkCliCompat, parsePluginManifest, type PluginManifest } from './manifest.js'

/// Resolves from BOTH layouts: src/plugins/loader.ts during tests/tsx and
/// the flattened dist/main.ts bundle at runtime (tsup keeps one file).
const { version: PKG_VERSION } = ((): { version: string } => {
  const req = createRequire(import.meta.url)
  try {
    return req('../package.json')
  } catch {
    return req('../../package.json')
  }
})()

/// Same source of truth as `codeburn --version` (root package.json).
export function currentCliVersion(): string {
  return PKG_VERSION
}

export const MANIFEST_FILE = 'codeburn-plugin.json'

export type PluginLoad =
  | { status: 'loaded', manifest: PluginManifest, dir: string }
  | { status: 'rejected', name: string, dir: string, reason: string }

export function defaultPluginsDir(): string {
  return join(homedir(), '.config', 'codeburn', 'plugins')
}

/// The 9b seam. Return ok:false to keep a plugin off the machine's output.
/// Unsigned plugins are refused unless CODEBURN_PLUGIN_DEV=1, and even then
/// only for local development (this flag is expected to be absent in every
/// real environment).
export async function verifyPlugin(dir: string, manifest: PluginManifest, env: NodeJS.ProcessEnv): Promise<{ ok: boolean, reason?: string }> {
  if (env.CODEBURN_PLUGIN_DEV === '1') return { ok: true }
  void dir
  void manifest
  return { ok: false, reason: 'unsigned plugin (signature verification arrives in 9b; CODEBURN_PLUGIN_DEV=1 allows unsigned plugins for local development only)' }
}

async function readManifest(dir: string): Promise<{ raw?: unknown, reason?: string }> {
  try {
    const file = join(dir, MANIFEST_FILE)
    const info = await stat(file)
    if (!info.isFile() || info.size > 64 * 1024) return { reason: `${MANIFEST_FILE} missing or too large` }
    return { raw: JSON.parse(await readFile(file, 'utf8')) }
  } catch {
    return { reason: `${MANIFEST_FILE} missing or unreadable` }
  }
}

/** Exposed for `codeburn plugin verify` so the verify path uses the same
 *  read+parse pipeline as the loader. Returns {raw} on success, {reason} on
 *  any failure (missing file, oversized, unparseable JSON). */
export async function readPluginManifestRaw(dir: string): Promise<{ raw?: unknown, reason?: string }> {
  return readManifest(dir)
}

export async function loadPlugins(
  pluginsDir: string = defaultPluginsDir(),
  cliVersion: string = currentCliVersion(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<PluginLoad[]> {
  let entries: string[]
  try {
    entries = (await readdir(pluginsDir, { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => e.name)
  } catch {
    return [] // no plugins directory yet: an empty socket, the normal case
  }
  const loads: PluginLoad[] = []
  for (const entry of entries.sort()) {
    const dir = join(pluginsDir, entry)
    const { raw, reason } = await readManifest(dir)
    if (reason) { loads.push({ status: 'rejected', name: entry, dir, reason }); continue }
    const parsed = parsePluginManifest(raw, `${entry}/${MANIFEST_FILE}`)
    if (!parsed.ok) { loads.push({ status: 'rejected', name: entry, dir, reason: parsed.reason }); continue }
    const manifest = parsed.manifest
    if (manifest.name !== entry) {
      loads.push({ status: 'rejected', name: entry, dir, reason: `manifest name "${manifest.name}" does not match directory "${entry}"` })
      continue
    }
    const compat = checkCliCompat(manifest.cliCompat, cliVersion)
    if (compat) {
      loads.push({ status: 'rejected', name: entry, dir, reason: `plugin "${manifest.name}" ${compat}; this CLI is ${cliVersion}` })
      continue
    }
    const verified = await verifyPlugin(dir, manifest, env)
    if (!verified.ok) { loads.push({ status: 'rejected', name: entry, dir, reason: verified.reason ?? 'verification failed' }); continue }
    loads.push({ status: 'loaded', manifest, dir })
  }
  return loads
}

/// Declared sync attributes across loaded plugins, keyed for the wire guard
/// in sync/otlp.ts. Rejected plugins contribute nothing: nothing a plugin
/// declared but failed to load can widen the wire.
export function declaredSyncAttributes(loads: PluginLoad[]): Map<string, PluginManifest['capabilities']['syncAttributes'][number]> {
  const declared = new Map<string, PluginManifest['capabilities']['syncAttributes'][number]>()
  for (const load of loads) {
    if (load.status !== 'loaded') continue
    for (const attr of load.manifest.capabilities.syncAttributes) declared.set(attr.key, attr)
  }
  return declared
}

/// Add-only payload sections. A plugin contributes at most its declared
/// sections; each section is one small JSON file the plugin's own commands
/// maintain. Undeclared names, nested paths, and oversized files never load.
export async function pluginPayloadSections(loads: PluginLoad[]): Promise<Record<string, unknown>> {
  const sections: Record<string, unknown> = {}
  for (const load of loads) {
    if (load.status !== 'loaded') continue
    for (const name of load.manifest.capabilities.payloadSections) {
      try {
        const file = join(load.dir, 'sections', `${name}.json`)
        const info = await stat(file)
        if (!info.isFile() || info.size > 256 * 1024) continue
        sections[`${load.manifest.name}.${name}`] = JSON.parse(await readFile(file, 'utf8'))
      } catch { /* no section written yet: omit it, sections are optional */ }
    }
  }
  return sections
}
