/**
 * Plugin sync exporter seam: per-call attributes and declared extra spans (socket phase 2, slice B).
 *
 * For each loaded plugin with exporters/sync.mjs, spawn the exporter process,
 * pass the batch of calls via stdin, and collect enrichment data (per-call
 * attributes and extra spans) via stdout. All failures (crash, timeout, bad
 * JSON) produce an stderr notice; the plugin contributes nothing this push.
 */

import { spawn } from 'child_process'
import { join } from 'path'
import { stat } from 'fs/promises'
import type { PluginLoad } from './loader.js'
import type { CallWithSession, OtlpAttribute, OtlpSpan } from '../sync/otlp.js'
import { filterPluginAttributes, CORE_SYNC_ATTRIBUTE_KEYS } from '../sync/otlp.js'

export interface PluginEnrichment {
  perCall: Map<string, OtlpAttribute[]>
  extraSpans: OtlpSpan[]
}

export interface ExporterResult {
  perCall: Record<string, OtlpAttribute[]>
  spans: Array<{
    kind: string
    traceId: string
    spanId: string
    name: string
    startNano: string
    endNano: string
    attributes: OtlpAttribute[]
  }>
}

/// Collect enrichment data from all loaded plugins with exporters/sync.mjs.
export async function collectPluginEnrichment(
  loads: PluginLoad[],
  calls: CallWithSession[],
  timeoutMs: number = 30_000,
): Promise<PluginEnrichment> {
  const perCall = new Map<string, OtlpAttribute[]>()
  const extraSpans: OtlpSpan[] = []

  for (const load of loads) {
    if (load.status !== 'loaded') continue
    const result = await runPluginExporter(load, calls, timeoutMs)
    if (!result) continue

    const manifest = load.manifest
    const declaredAttrs = new Set(manifest.capabilities.syncAttributes.map(a => a.key))
    const declaredKinds = new Set(manifest.capabilities.spanKinds)

    // Process per-call attributes
    for (const [key, attrs] of Object.entries(result.perCall)) {
      const guarded = filterPluginAttributes(attrs, declaredAttrs)
      if (guarded.length > 0) {
        // Merge with existing attrs for this key (multiple plugins may contribute)
        const existing = perCall.get(key) ?? []
        perCall.set(key, [...existing, ...guarded])
      }
    }

    // Process extra spans
    for (const span of result.spans) {
      // Check kind is declared
      if (!declaredKinds.has(span.kind)) continue

      // Validate hex IDs
      if (!/^[0-9a-fA-F]{32}$/.test(span.traceId) || !/^[0-9a-fA-F]{16}$/.test(span.spanId)) continue

      // Cap extra spans: max 2x calls.length per plugin
      if (extraSpans.length >= calls.length * 2) break

      // Filter attributes (uses wire-guard sanitizer) and add span_kind
      const attrs = filterPluginAttributes(span.attributes, declaredAttrs)
      attrs.push({ key: 'codeburn.span_kind', value: { stringValue: span.kind } })

      // Check size: drop if >64KB
      const spanJson = JSON.stringify({ ...span, attributes: attrs })
      if (Buffer.byteLength(spanJson, 'utf8') > 65536) continue

      extraSpans.push({
        traceId: span.traceId,
        spanId: span.spanId,
        name: span.name,
        startTimeUnixNano: span.startNano,
        endTimeUnixNano: span.endNano,
        attributes: attrs,
      })
    }
  }

  return { perCall, extraSpans }
}

async function runPluginExporter(
  load: PluginLoad,
  calls: CallWithSession[],
  timeoutMs: number,
): Promise<ExporterResult | null> {
  if (load.status !== 'loaded') return null

  const exporterFile = join(load.dir, 'exporters', 'sync.mjs')

  // Check if exporter exists
  try {
    await stat(exporterFile)
  } catch {
    return null
  }

  return new Promise(resolve => {
    const child = spawn(process.execPath, [exporterFile], {
      env: { ...process.env, CODEBURN_PLUGIN_DIR: load.dir },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    if (child.stdout) {
      child.stdout.on('data', chunk => {
        stdout += chunk.toString('utf8')
        if (stdout.length > 8 * 1024 * 1024) { // 8MB cap
          child.kill()
        }
      })
    }

    if (child.stderr) {
      child.stderr.on('data', chunk => {
        stderr += chunk.toString('utf8')
      })
    }

    child.on('error', () => {
      clearTimeout(timer)
      process.stderr.write(`plugin "${load.manifest.name}": sync exporter failed (spawn error); pushing without it\n`)
      resolve(null)
    })

    child.on('exit', (code, signal) => {
      clearTimeout(timer)

      if (timedOut) {
        process.stderr.write(`plugin "${load.manifest.name}": sync exporter failed (timeout); pushing without it\n`)
        resolve(null)
        return
      }

      if (code !== 0 || signal) {
        process.stderr.write(`plugin "${load.manifest.name}": sync exporter failed (exit ${code}); pushing without it\n`)
        resolve(null)
        return
      }

      try {
        const result = JSON.parse(stdout) as ExporterResult
        resolve(result)
      } catch {
        process.stderr.write(`plugin "${load.manifest.name}": sync exporter failed (bad JSON); pushing without it\n`)
        resolve(null)
      }
    })

    // Send input
    const input = {
      calls: calls.map(c => ({
        key: c.call.deduplicationKey,
        call: c.call,
        sessionId: c.sessionId,
        workingDirectory: c.workingDirectory,
        session: c.session ?? null,
      })),
    }

    child.stdin?.write(JSON.stringify(input))
    child.stdin?.end()
  })
}
