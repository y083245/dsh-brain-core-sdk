import type { BrainContext } from '@brain-core/sdk'

/** The runtime refuses every ctx call after the plugin's fiber is disposed; this event is the probe. */
export const ALIVE_PROBE_SUFFIX = '.__brain_alive__'
export const ALIVE_PROBE_MS = 250

export function probeName(pluginId: string): string {
  return `${pluginId}${ALIVE_PROBE_SUFFIX}`
}

/**
 * `BrainContext` has no dispose callback, so the only way to notice that the kernel disabled the
 * plugin is to keep calling it: after revocation every method throws PERMISSION_DENIED.
 */
export function watchRevocation(ctx: BrainContext, pluginId: string, onRevoked: () => void | Promise<void>): () => void {
  let revoked = false
  const timer = setInterval(() => {
    if (revoked) return
    try {
      ctx.events.emit(probeName(pluginId), {})
    } catch {
      revoked = true
      clearInterval(timer)
      void Promise.resolve(onRevoked()).catch(() => undefined)
    }
  }, ALIVE_PROBE_MS)
  timer.unref()
  return () => { revoked = true; clearInterval(timer) }
}
