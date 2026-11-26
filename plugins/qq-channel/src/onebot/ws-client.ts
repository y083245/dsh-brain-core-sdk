// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { PluginHttp, WebSocketEvent } from '@brain-core/sdk'
import { OneBotHealth } from './health.ts'
import { normalizeAccountId, type OneBotEvent } from './types.ts'

const HOST_UNSUPPORTED_HINT =
  '当前 Brain Core 宿主版本不支持 QQ 通道插件所需的 WebSocket 订阅或同通道 L0 读取接口，请升级内核后再启用'

type Subscription = () => void
export interface OneBotWsOptions {
  readonly http: Pick<PluginHttp, 'subscribeWebSocket'>
  readonly health: OneBotHealth
  readonly onEvent: (event: OneBotEvent) => void | Promise<void>
  readonly probe: () => Promise<unknown>
  readonly login: () => Promise<unknown>
  readonly onAuthError?: () => void
  readonly onUnsupportedHost?: (message: string) => void
  readonly random?: () => number
  readonly now?: () => number
  readonly authTransport?: 'header' | 'query'
  readonly setTimeout?: typeof setTimeout
  readonly clearTimeout?: typeof clearTimeout
}
export class OneBotWsClient {
  private retired = true
  private generation = 0
  private subscription: Subscription | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private watchdog: ReturnType<typeof setInterval> | undefined
  private attempt = 0
  private immediateCloses = 0
  private connectedAt = 0
  private probedHeartbeat: number | undefined
  private probedWithoutHeartbeat = false
  private reconnects = 0
  private identity: {
    readonly selfId: string
    readonly selfNickname: string
  } | undefined
  get selfId(): string | undefined { return this.identity?.selfId }
  get selfNickname(): string | undefined { return this.identity?.selfNickname }
  get reconnectCount(): number { return this.reconnects }
  private readonly options: OneBotWsOptions
  constructor(options: OneBotWsOptions) { this.options = options }
  start(): void {
    if (!this.retired) return
    this.retired = false
    void this.connect()
  }
  async stop(): Promise<void> {
    this.retired = true
    this.generation++
    if (this.timer) (this.options.clearTimeout ?? clearTimeout)(this.timer)
    this.timer = undefined
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = undefined
    const s = this.subscription
    this.subscription = undefined
    this.options.health.disconnected()
    this.identity = undefined
    s?.()
  }
  private schedule(): void {
    if (this.retired || this.timer) return
    const delay = Math.round([1000, 2000, 4000, 8000, 15000, 30000][Math.min(this.attempt++, 5)]! * (0.8 + Math.max(0, Math.min(1, (this.options.random ?? Math.random)())) * 0.4))
    this.timer = (this.options.setTimeout ?? setTimeout)(() => {
      this.timer = undefined
      void this.connect()
    }, delay)
  }
  private async connect(): Promise<void> {
    const generation = ++this.generation
    const subscribe = this.options.http.subscribeWebSocket
    if (!subscribe) {
      this.retired = true
      return
    }
    try {
      const subscription = await subscribe({ configKey: 'onebotWsUrl', auth: { secretNames: ['onebot-ws-token', 'onebot-http-token'], transport: this.options.authTransport ?? 'header' }, maxMessageBytes: 1048576 }, event => this.handle(event, generation))
      if (this.retired || generation !== this.generation) {
        subscription()
        return
      }
      this.subscription = subscription
    } catch (error) {
      if (this.retired || generation !== this.generation) return
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
      if (/AUTH|401/i.test(code)) {
        this.immediateCloses++
        if (this.immediateCloses >= 2) {
          this.options.health.authFailed()
          this.options.onAuthError?.()
          await this.stop()
          return
        }
      }
      else if (/PERMISSION|DENIED|INVALID|CONFIG|UNSUPPORTED/i.test(code)) {
        const message = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
          ? error.message
          : ''
        if (/UNSUPPORTED/i.test(code) || message.includes('升级内核') || message.includes('不支持')) {
          this.options.onUnsupportedHost?.(HOST_UNSUPPORTED_HINT)
        }
        await this.stop()
        return
      }
      this.schedule()
    }
  }
  private async handle(event: WebSocketEvent, generation: number): Promise<void> {
    if (this.retired || generation !== this.generation) return
    if (event.type === 'open') {
      this.connectedAt = (this.options.now ?? Date.now)()
      this.options.health.connected()
      this.probedHeartbeat = undefined
      this.probedWithoutHeartbeat = false
      this.identity = undefined
      void this.loadIdentity(generation)
      if (this.watchdog) clearInterval(this.watchdog)
      this.watchdog = setInterval(() => { void this.check(generation) }, 1000)
      this.watchdog.unref?.()
    } else if (event.type === 'message') {
      let parsed: OneBotEvent
      try { parsed = JSON.parse(event.data) as OneBotEvent } catch { return }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      this.attempt = 0
      this.immediateCloses = 0
      this.options.health.event(parsed, (this.options.now ?? Date.now)())
      try { await this.options.onEvent(parsed) } catch { /* Do not expose event contents or listener errors. */ }
    } else {
      if (event.type === 'error' && /PERMISSION|DENIED|CONFIG/i.test(event.code)) {
        await this.stop()
        return
      }
      if ((event.type === 'close' && event.code === 1006 && (this.options.now ?? Date.now)() - this.connectedAt < 3000) || (event.type === 'error' && /401|UNAUTHORIZED/i.test(event.code))) this.immediateCloses++
      if (this.immediateCloses >= 2) {
        this.options.health.authFailed()
        this.options.onAuthError?.()
        await this.stop()
        return
      }
      await this.reconnect(generation)
    }
  }
  private async loadIdentity(generation: number): Promise<void> {
    try {
      const value = await this.options.login()
      if (this.retired || generation !== this.generation || !value || typeof value !== 'object') return
      const login = value as {
        user_id?: unknown
        nickname?: unknown
      }
      const selfId = normalizeAccountId(login.user_id)
      if (typeof login.nickname !== 'string') return
      this.identity = { selfId, selfNickname: login.nickname }
    } catch { /* Login errors are reported by the caller without exposing response data. */ }
  }
  private async reconnect(generation: number): Promise<void> {
    if (generation !== this.generation) return
    this.reconnects++
    this.generation++
    if (this.watchdog) clearInterval(this.watchdog)
    this.options.health.disconnected()
    this.identity = undefined
    const s = this.subscription
    this.subscription = undefined
    s?.()
    this.schedule()
  }
  private async check(generation: number): Promise<void> {
    if (generation !== this.generation || !this.options.health.stale((this.options.now ?? Date.now)(), this.connectedAt)) return
    const heartbeat = this.options.health.lastHeartbeat
    if (heartbeat === undefined ? this.probedWithoutHeartbeat : this.probedHeartbeat === heartbeat) return
    if (heartbeat === undefined) this.probedWithoutHeartbeat = true
    else this.probedHeartbeat = heartbeat
    this.options.health.degrade()
    try { await this.options.probe() } catch {
      await this.reconnect(generation)
      return
    }
  }
}
