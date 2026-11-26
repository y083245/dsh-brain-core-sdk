// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

interface RateEntry {
  time: number
  readonly token: symbol
  pending: boolean
}

/** Reservations count until sent or explicitly rolled back. */
export class SendRateLimit {
  private readonly entries = new Map<string, RateEntry[]>()
  private perMinute: number
  private perHour: number
  private readonly now: () => number

  constructor(perMinute: number, perHour: number, now: () => number = Date.now) {
    this.perMinute = perMinute
    this.perHour = perHour
    this.now = now
  }

  setLimits(perMinute: number, perHour: number): void {
    this.perMinute = perMinute
    this.perHour = perHour
  }

  reserve(channel: string, count: number): { sent(): void; rollback(): void } {
    if (!Number.isInteger(count) || count < 1) throw new Error('Invalid reservation')
    const now = this.now()
    const entries = (this.entries.get(channel) ?? []).filter((entry) => entry.pending || entry.time > now - 3_600_000)
    this.entries.set(channel, entries)
    const minuteCount = entries.filter((entry) => entry.pending || entry.time > now - 60_000).length
    if (minuteCount + count > this.perMinute || entries.length + count > this.perHour) throw new Error('Rate limit exceeded')
    const pending: RateEntry[] = Array.from({ length: count }, () => ({ time: now, token: Symbol(), pending: true }))
    entries.push(...pending)
    return {
      sent: () => {
        const entry = pending.shift()
        if (!entry) throw new Error('Reservation exhausted')
        entry.time = this.now()
        entry.pending = false
      },
      rollback: () => {
        const tokens = new Set(pending.map((entry) => entry.token))
        this.entries.set(channel, (this.entries.get(channel) ?? []).filter((entry) => !tokens.has(entry.token)))
        pending.length = 0
      },
    }
  }
}
