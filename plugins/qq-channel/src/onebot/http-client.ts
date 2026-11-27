// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { PluginHttp, PluginSecrets } from '@dsh-brain-core/sdk'

export class OneBotHttpError extends Error {
  readonly kind: 'auth' | 'http' | 'protocol'
  constructor(kind: 'auth' | 'http' | 'protocol') { super(`OneBot ${kind} error`); this.kind = kind }
}
export class OneBotHttpClient {
  private readonly http: Pick<PluginHttp, 'fetch'>
  private readonly secrets: Pick<PluginSecrets, 'get'>
  private readonly baseUrl: string
  private readonly onAuthError: () => void
  constructor(http: Pick<PluginHttp, 'fetch'>, secrets: Pick<PluginSecrets, 'get'>, baseUrl: string, onAuthError: () => void = () => { }) { this.http = http; this.secrets = secrets; this.baseUrl = baseUrl; this.onAuthError = onAuthError }
  async action<T = unknown>(action: string, params: unknown = {}): Promise<T> {
    if (!/^[a-z][a-z0-9_]*$/.test(action)) throw new OneBotHttpError('protocol')
    let token: string | undefined
    try { token = await this.secrets.get('onebot-http-token') } catch { throw new OneBotHttpError('auth') }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    let url: URL
    try { url = new URL(this.baseUrl) } catch { throw new OneBotHttpError('protocol') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new OneBotHttpError('protocol')
    if (token && url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new OneBotHttpError('auth')
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${action}`
    let response: Awaited<ReturnType<PluginHttp['fetch']>>
    try { response = await this.http.fetch(url.toString(), { method: 'POST', headers, body: JSON.stringify(params), redirect: 'error' }) } catch { throw new OneBotHttpError('http') }
    if (response.status === 401) { this.onAuthError(); throw new OneBotHttpError('auth') }
    if (response.status < 200 || response.status >= 300) throw new OneBotHttpError('http')
    let envelope: { status?: unknown; retcode?: unknown; data?: T }
    try { envelope = JSON.parse(response.text()) as typeof envelope } catch { throw new OneBotHttpError('protocol') }
    if (envelope?.retcode === 1401) { this.onAuthError(); throw new OneBotHttpError('auth') }
    if (!envelope || envelope.status !== 'ok' || envelope.retcode !== 0) throw new OneBotHttpError('protocol')
    return envelope.data as T
  }
}
