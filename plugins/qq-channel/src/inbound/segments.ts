// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { normalizeMessageId } from '../onebot/types.ts'

const MAX_LOCATIONS = 8
const MAX_FORWARD_IDS = 16
const MAX_SEGMENTS = 256

export interface Segment {
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
}
export interface ParsedSegments {
  readonly textContent: string
  readonly plainContent: string
  readonly media: readonly Readonly<Record<string, unknown>>[]
  readonly forwardIds: readonly string[]
  readonly quotedIds: readonly string[]
}
export function cleanText(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  // External text may contain invisible control characters.
  return String(value)
    .replace(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g,
      '',
    )
    .replace(/\r\n?/g, '\n')
}
export function parseSegments(segments: readonly Segment[]): ParsedSegments {
  const text: string[] = [],
    plain: string[] = [],
    media: Readonly<Record<string, unknown>>[] = [],
    forwardIds: string[] = [],
    quotedIds: string[] = []
  for (const { type, data } of segments) {
    if (type === 'text' || type === 'markdown') {
      const value = cleanText(data.text ?? data.content)
      text.push(value)
      plain.push(value)
    } else if (type === 'image' || type === 'mface') {
      const emojiId = cleanText(data.emoji_id)
      const hasEmojiId = emojiId !== '' && emojiId !== '0'
      const url = typeof data.url === 'string' && data.url.length <= 4096 ? data.url : undefined
      const file = typeof data.file === 'string' && data.file.length <= 256 ? data.file : undefined
      if (media.length < MAX_LOCATIONS) {
        media.push({
          type, ...(url === undefined ? {} : { url }), ...(file === undefined ? {} : { file }),
          isMarketSticker: type === 'mface' || hasEmojiId,
          ...(hasEmojiId && /^[A-Za-z0-9_+=/-]{1,128}$/.test(emojiId) ? { emojiId } : {}),
        })
        const summary = type === 'mface' ? cleanText(data.summary).slice(0, 96) : ''
        text.push(`[图片#${media.length}]${summary ? ` ${summary}` : ''}`)
      } else {
        text.push('[图片]')
      }
    } else if (type === 'forward') {
      const id = cleanText(data.id ?? data.res_id ?? data.file_id ?? data.forward_id)
      if (forwardIds.length < MAX_FORWARD_IDS && /^[A-Za-z0-9_+=/-]{1,256}$/.test(id)) {
        forwardIds.push(id)
        text.push(`[转发#${id}]`)
      } else {
        text.push('[转发]')
      }
    } else if (type === 'reply') {
      try {
        const id = normalizeMessageId(data.id)
        quotedIds.push(id)
        text.push(`[引用 #${id}]`)
      } catch {
        text.push('[引用]')
      }
    } else if (type === 'at') text.push(`[@${cleanText(data.qq)}]`)
    else if (type === 'record') {
      const duration = Number(cleanText(data.duration))
      text.push(duration > 0 && Number.isFinite(duration) ? `[语音 ${Math.round(duration)}s]` : '[语音]')
    }
    else if (type === 'video') text.push('[视频]')
    else if (type === 'file') text.push(`[文件: ${cleanText(data.name)}]`)
    else if (type === 'json' || type === 'xml') text.push('[卡片分享]')
  }
  return { textContent: text.join(''), plainContent: plain.join(''), media, forwardIds, quotedIds }
}

/** Parse structured OneBot segments or legacy CQ strings without interpreting embedded text as instructions. */
export function decodeSegments(value: unknown): readonly Segment[] {
  if (Array.isArray(value))
    return value.slice(0, MAX_SEGMENTS).filter(
      (item): item is Segment =>
        !!item &&
        typeof item === 'object' &&
        typeof item.type === 'string' &&
        !!item.data &&
        typeof item.data === 'object' &&
        !Array.isArray(item.data),
    )
  if (typeof value !== 'string') return []
  const decode = (s: string): string =>
    s.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&')
  const result: Segment[] = []
  const pattern = /\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g
  let offset = 0
  let match: RegExpExecArray | null
  while (result.length < MAX_SEGMENTS && (match = pattern.exec(value))) {
    if (match.index > offset)
      result.push({ type: 'text', data: { text: decode(value.slice(offset, match.index)) } })
    const data: Record<string, string> = Object.create(null)
    for (const field of (match[2] ?? '').split(',').slice(1)) {
      const at = field.indexOf('=')
      if (at > 0) data[field.slice(0, at)] = decode(field.slice(at + 1))
    }
    result.push({ type: match[1] ?? '', data })
    offset = pattern.lastIndex
  }
  if (offset < value.length && result.length < MAX_SEGMENTS)
    result.push({ type: 'text', data: { text: decode(value.slice(offset)) } })
  return result
}
