// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createHash } from 'node:crypto'
import { BrainError, hostAllowed, type PluginMemory, type PluginStorage, type ToolCallContext } from '@dsh-brain-core/sdk'
import { SendRateLimit } from './rate-limit.ts'
import { cleanText } from '../inbound/segments.ts'

const STICKER_URL_HOSTS = ['*.qpic.cn', '*.qq.com', '*.qq.com.cn', '*.gtimg.cn', '*.qlogo.cn'] as const

export interface Sticker { readonly id: string; readonly url?: string }
export interface StickerDependencies {
  readonly action: (name: string, params?: unknown) => Promise<unknown>
  readonly storage: Pick<PluginStorage, 'read' | 'write'>
  readonly memory: Pick<PluginMemory, 'readChannelEvent' | 'record' | 'search'>
  readonly collect?: (stickerId: string) => Promise<void>
  readonly collectPerMinute?: number
  readonly collectPerHour?: number
  readonly now?: () => number
  readonly ttlMs?: number
}
function clean(value: string): string { return cleanText(value).replace(/\n/g, '').trim().slice(0, 500).trim() }
function validId(id: string): boolean { return /^[A-Za-z0-9_-]{1,128}$/.test(id) }
function stickerCdnUrl(value: string): string | undefined {
  if (value.length === 0 || value.length > 4096) return undefined
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.port !== '') return undefined
    if (!STICKER_URL_HOSTS.some((pattern) => hostAllowed(pattern, url.hostname.toLowerCase()))) return undefined
    url.hash = ''
    return url.href
  } catch {
    return undefined
  }
}
function containsSticker(value: unknown, id: string): boolean {
  if (!Array.isArray(value)) return false
  return value.some((item) => {
    if (!item || typeof item !== 'object') return false
    const media = item as Record<string, unknown>
    return [media.emojiId, media.stickerId, media.file].some((v) => v === id)
  })
}
export class StickerLibrary {
  private readonly deps: StickerDependencies
  private cached: readonly Sticker[] = []
  private refreshed = 0
  private readonly collectLimit: SendRateLimit
  constructor(deps: StickerDependencies) { this.deps = deps; this.collectLimit = new SendRateLimit(Math.min(deps.collectPerMinute ?? 2, 2), Math.min(deps.collectPerHour ?? 10, 10), deps.now) }
  async list(refresh = false): Promise<readonly Sticker[]> {
    const now = (this.deps.now ?? Date.now)()
    if (!refresh && this.refreshed && now - this.refreshed < (this.deps.ttlMs ?? 300_000)) return this.cached
    try {
      const raw = await this.deps.action('fetch_custom_face')
      const list = Array.isArray(raw) ? raw : (raw as { faces?: unknown })?.faces
      if (!Array.isArray(list)) throw new Error('Unsupported response')
      const seen = new Set<string>()
      const entries: Sticker[] = []
      for (const entry of list) {
        let sticker: Sticker | undefined
        if (typeof entry === 'string') {
          const normalizedUrl = stickerCdnUrl(entry)
          if (normalizedUrl !== undefined) {
            const id = `cf_${createHash('sha256').update(normalizedUrl).digest('hex').slice(0, 24)}`
            if (validId(id)) sticker = { id, url: normalizedUrl }
          }
        } else if (entry && typeof entry === 'object') {
          const item = entry as Record<string, unknown>
          const id = String(item.id ?? item.emoji_id ?? '')
          if (validId(id)) sticker = { id, ...(typeof item.url === 'string' ? { url: item.url } : {}) }
        }
        if (!sticker || seen.has(sticker.id)) continue
        seen.add(sticker.id)
        entries.push(sticker)
        if (entries.length >= 1000) break
      }
      this.cached = entries
      this.refreshed = now
      await this.deps.storage.write('stickers-cache.json', JSON.stringify(this.cached.map(({ id }) => ({ id }))))
    } catch {
      try {
        const bytes = await this.deps.storage.read('stickers-cache.json')
        const parsed: unknown = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : []
        if (Array.isArray(parsed)) this.cached = parsed.filter((item): item is Sticker => !!item && typeof item.id === 'string' && validId(item.id)).map((item) => ({ id: item.id })).slice(0, 1000)
      } catch { /* Cache is disposable. */ }
    }
    return this.cached
  }
  async detail(stickerId: string): Promise<Sticker | undefined> {
    if (!validId(stickerId)) throw new Error('Invalid sticker ID')
    const known = (await this.list()).find((item) => item.id === stickerId)
    if (!known) return undefined
    try {
      const raw = await this.deps.action('fetch_custom_face_detail', { id: stickerId }) as Record<string, unknown>
      return { ...known, ...(typeof raw?.url === 'string' ? { url: raw.url } : {}) }
    } catch { return known }
  }
  async collect(stickerId: string, evidenceRecordId: string, call: ToolCallContext): Promise<void> {
    if (!validId(stickerId) || !this.deps.memory.readChannelEvent) throw new Error('Invalid evidence')
    try {
      const result = await this.deps.memory.readChannelEvent(evidenceRecordId, call)
      if (result.record.id !== evidenceRecordId || result.record.layer !== 'L0' || result.record.channel !== call.channel || result.record.status !== 'active' || !containsSticker(result.record.content.media, stickerId)) throw new Error('NOT_FOUND')
    } catch { throw new Error('NOT_FOUND') }
    if (!this.deps.collect) throw new Error('Sticker collection unsupported')
    const reservation = this.collectLimit.reserve(call.channel, 1)
    try {
      const latest = await this.deps.memory.readChannelEvent(evidenceRecordId, call)
      if (latest.record.id !== evidenceRecordId || latest.record.layer !== 'L0' || latest.record.channel !== call.channel || latest.record.status !== 'active' || !containsSticker(latest.record.content.media, stickerId)) throw new Error('NOT_FOUND')
      await this.deps.collect(stickerId)
      reservation.sent()
      this.refreshed = 0
    } finally { reservation.rollback() }
  }
  async meanings(stickerId: string, call: ToolCallContext): Promise<readonly { readonly note: string; readonly tags: readonly string[]; readonly disclosure: { readonly speakable: 'yes' | 'if-subject-raises' | 'never'; readonly label: string } }[]> {
    if (!validId(stickerId)) throw new Error('Invalid sticker ID')
    const result = await this.deps.memory.search({ query: stickerId, scope: 'here', layers: ['L2'] }, { channel: call.channel })
    return result.items.flatMap(({ record, disclosure }) => {
      if (record.channel !== call.channel || record.kind !== 'l2.expression' || record.status !== 'active' || record.content.stickerId !== stickerId || disclosure.speakable === 'never' || typeof record.content.note !== 'string') return []
      return [{ note: clean(record.content.note), tags: Array.isArray(record.content.tags) ? record.content.tags.filter((tag): tag is string => typeof tag === 'string').map(clean).slice(0, 20) : [], disclosure }]
    })
  }
  async note(stickerId: string, evidenceRecordId: string, note: string, tags: readonly string[], call: ToolCallContext): Promise<void> {
    const cleanedNote = clean(note).trim()
    if (!cleanedNote) throw new BrainError('INVALID_ARGUMENT', 'Invalid note')
    if (!validId(stickerId) || !this.deps.memory.readChannelEvent) throw new Error('Invalid evidence')
    const cleanedTags = tags.slice(0, 20).map((t) => clean(t).trim()).filter(Boolean)
    let result
    try { result = await this.deps.memory.readChannelEvent(evidenceRecordId, call) } catch { throw new Error('NOT_FOUND') }
    const record = result.record
    if (record.id !== evidenceRecordId || record.layer !== 'L0' || record.channel !== call.channel || record.status !== 'active' || !containsSticker(record.content.media, stickerId)) throw new Error('NOT_FOUND')
    try { const latest = await this.deps.memory.readChannelEvent(evidenceRecordId, call); if (latest.record.id !== evidenceRecordId || latest.record.layer !== 'L0' || latest.record.status !== 'active' || latest.record.channel !== call.channel || !containsSticker(latest.record.content.media, stickerId)) throw new Error('NOT_FOUND') } catch { throw new Error('NOT_FOUND') }
    await this.deps.memory.record({ layer: 'L2', kind: 'l2.expression', channel: record.channel, subjects: [], actor: 'self', content: { stickerId, note: cleanedNote, tags: cleanedTags }, evidence: [{ id: record.id }], visibility: 'origin' })
  }
}
