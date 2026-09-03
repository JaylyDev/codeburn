import { codeburn } from './ipc'

/** Fire-and-forget consent-gated telemetry. The main process decides whether
 *  anything is sent (see app/electron/telemetry.ts); the renderer only names the
 *  event. Nothing about it is load-bearing, so a preload that predates the
 *  bridge method, returns nothing, or throws must degrade to "no tracking"
 *  rather than take a click handler down with it. */
export function trackEvent(name: string, props?: Record<string, unknown>): void {
  if (typeof codeburn.telemetryTrack !== 'function') return
  try {
    void Promise.resolve(codeburn.telemetryTrack(name, props)).catch(() => {})
  } catch { /* a bridge that throws synchronously is still just no tracking */ }
}
