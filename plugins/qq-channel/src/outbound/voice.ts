// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import type { PluginStorage } from '@dsh-brain-core/sdk'
import type { QqVoiceSettings } from '../config.ts'

export interface VoiceDependencies {
  readonly storage: Pick<PluginStorage, 'read' | 'list'>
  readonly settings: () => QqVoiceSettings
  /** Host-supplied probe, isolated and permission-checked by the caller. */
  readonly probeDuration: (bytes: Uint8Array) => Promise<number>
  readonly normalize?: (bytes: Uint8Array) => Promise<Uint8Array>
  /** Must apply channel guard, serialization, rate limits, and audit. */
  readonly send: (channel: string, segment: { readonly type: 'record'; readonly data: { readonly file: string } }) => Promise<string>
  readonly readSent?: (channel: string, messageId: string) => Promise<unknown>
}
const MAX_RPC_BYTES = 8 * 1024 * 1024
function pathFor(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}\.(?:wav|mp3|ogg|opus|amr|m4a)$/i.test(id)) throw new Error('Invalid voice ID')
  return `voices/${id}`
}
export class VoiceLibrary {
  private readonly deps: VoiceDependencies
  constructor(deps: VoiceDependencies) { this.deps = deps }
  async list(): Promise<readonly string[]> {
    if (!this.deps.settings().enabled) throw new Error('Voice disabled')
    const paths = await this.deps.storage.list('voices/')
    return paths.flatMap((path) => { const id = path.startsWith('voices/') ? path.slice(7) : ''; try { pathFor(id); return [id] } catch { return [] } })
  }
  async send(channel: string, id: string, verify = false): Promise<{ readonly messageId: string; readonly verification: 'verified' | 'failed' | 'not_requested' }> {
    const settings = this.deps.settings()
    if (!settings.enabled) throw new Error('Voice disabled')
    let bytes = await this.deps.storage.read(pathFor(id))
    const maxBytes = Math.min(settings.maxBytes, 4 * 1024 * 1024)
    if (!bytes || bytes.length === 0 || bytes.length > maxBytes) throw new Error('Voice unavailable or too large')
    const seconds = await this.deps.probeDuration(bytes)
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > Math.min(settings.maxSeconds, 300)) throw new Error('Invalid voice duration')
    if (settings.normalizeLoudness) {
      if (!this.deps.normalize) throw new Error('Voice normalization unavailable')
      bytes = await this.deps.normalize(bytes)
      if (!bytes.length || bytes.length > maxBytes) throw new Error('Normalized voice too large')
    }
    const file = `base64://${Buffer.from(bytes).toString('base64')}`
    const segment = { type: 'record' as const, data: { file } }
    // Include a conservative nested JSON-RPC envelope and JSON escaping overhead.
    const inner = JSON.stringify({ action: 'send_msg', params: { channel, message: [segment] } })
    const line = JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(128), method: 'http.fetch', params: { options: { body: Buffer.from(inner).toString('base64') } } })
    if (Buffer.byteLength(line) >= MAX_RPC_BYTES - 4096) throw new Error('Voice exceeds RPC budget')
    const messageId = await this.deps.send(channel, segment)
    if (verify || settings.verifyReadback) {
      try {
        if (!this.deps.readSent) throw new Error('Voice verification unavailable')
        const result = await this.deps.readSent(channel, messageId) as { message_id?: unknown; message?: unknown }
        if (String(result?.message_id) !== messageId || !Array.isArray(result?.message) || !result.message.some((part: unknown) => !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'record')) throw new Error('Voice verification failed')
        return { messageId, verification: 'verified' }
      } catch {
        return { messageId, verification: 'failed' }
      }
    }
    return { messageId, verification: 'not_requested' }
  }
}
