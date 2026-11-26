// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { OneBotEvent } from './types.ts'
export type HealthState = 'disconnected' | 'ws_connected' | 'healthy' | 'degraded'
export class OneBotHealth {
  state: HealthState = 'disconnected'
  authError = false
  lastHeartbeat: number | undefined
  private online = false
  private good = false
  private botOffline = false
  connected(): void {
    this.state = 'ws_connected'
    this.lastHeartbeat = undefined
    this.online = false
    this.good = false
    this.botOffline = false
  }
  disconnected(): void { this.state = 'disconnected' }
  authFailed(): void { this.authError = true }
  event(event: OneBotEvent, now = Date.now()): void {
    if (this.state === 'disconnected') return
    if (event.post_type === 'meta_event' && event.meta_event_type === 'heartbeat') {
      this.lastHeartbeat = now
      this.online = event.status?.online === true
      this.good = event.status?.good === true
    }
    if (event.post_type === 'notice' && event.notice_type === 'bot_status') {
      if (event.sub_type === 'offline') this.botOffline = true
      if (event.sub_type === 'online') this.botOffline = false
    }
    if (this.lastHeartbeat !== undefined || this.botOffline) this.state = this.online && this.good && !this.botOffline && this.lastHeartbeat !== undefined && now - this.lastHeartbeat <= 90_000 ? 'healthy' : 'degraded'
  }
  stale(now: number, connectedAt: number): boolean { return now - (this.lastHeartbeat ?? connectedAt) > 90_000 }
  degrade(): void { if (this.state !== 'disconnected') this.state = 'degraded' }
}
