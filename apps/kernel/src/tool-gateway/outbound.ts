import type { Clock } from '../contracts/index.ts'
import { dice, significantLength } from './similarity.ts'
import type { WakeRecord } from './types.ts'

const RECENT_LIMIT = 20
const WINDOW_MS = 60_000
const MIN_SIGNIFICANT = 8
const SELF_SIMILAR = 0.65
const PEER_SIMILAR = 0.8
const BLOCKS_BEFORE_REFUSAL = 2

export interface OutboundDeps {
  readonly clock: Clock
  readonly style: () => { readonly enabled: boolean; readonly openers: readonly string[] }
  readonly sendPerMinute: number
  readonly wakeOf: (wakeId: string) => WakeRecord | undefined
}

export interface Outbound {
  check(channel: string, text: string, wakeId?: string): string | null
  admit(pluginId: string, channel: string, perMinute?: number): boolean
  note(channel: string, text: string): void
  recent(channel: string, limit: number): readonly string[]
  forget(channels: readonly string[]): void
}

/** What she said lately, and how fast a plugin may send. Memory only: a restart starts over. */
export function createOutbound(deps: OutboundDeps): Outbound {
  const sent = new Map<string, string[]>()
  const sends = new Map<string, number[]>()

  function check(channel: string, text: string, wakeId?: string): string | null {
    const style = deps.style()
    if (!style.enabled) return null
    const wake = wakeId === undefined ? undefined : deps.wakeOf(wakeId)
    if (wake !== undefined && wake.blocked >= BLOCKS_BEFORE_REFUSAL) return '这一轮不再发了。'
    const refuse = (reason: string): string => {
      if (wake !== undefined) wake.blocked += 1
      return reason
    }

    const opening = text.trimStart()
    const opener = style.openers.find((item) => item !== '' && opening.startsWith(item))
    if (opener !== undefined) return refuse(`没发出去：开头「${opener}」是套话，直接说具体的事，改一次再发。`)

    if (significantLength(text) < MIN_SIGNIFICANT) return null
    if ((sent.get(channel) ?? []).some((earlier) => dice(text, earlier) >= SELF_SIMILAR)) {
      return refuse('没发出去：和你最近说的太像了，换个说法，改一次再发。')
    }
    if (wake !== undefined && wake.peerTexts.some((peer) => dice(text, peer) >= PEER_SIMILAR)) {
      return refuse('没发出去：和别人刚说的撞车了，换个角度，或者这轮不说。')
    }
    return null
  }

  function admit(pluginId: string, channel: string, perMinute?: number): boolean {
    const limit = Math.min(deps.sendPerMinute, perMinute ?? Number.POSITIVE_INFINITY)
    const key = `${pluginId}\u0000${channel}`
    const now = deps.clock.now()
    const times = (sends.get(key) ?? []).filter((at) => at > now - WINDOW_MS)
    if (times.length >= limit) {
      if (times.length === 0) sends.delete(key)
      else sends.set(key, times)
      return false
    }
    times.push(now)
    sends.set(key, times)
    return true
  }

  function note(channel: string, text: string): void {
    const list = sent.get(channel) ?? []
    list.push(text)
    if (list.length > RECENT_LIMIT) list.splice(0, list.length - RECENT_LIMIT)
    sent.set(channel, list)
  }

  function recent(channel: string, limit: number): readonly string[] {
    if (!(limit > 0)) return []
    const list = sent.get(channel) ?? []
    return list.slice(Math.max(0, list.length - Math.floor(limit)))
  }

  function forget(channels: readonly string[]): void {
    for (const channel of channels) sent.delete(channel)
  }

  return { check, admit, note, recent, forget }
}
