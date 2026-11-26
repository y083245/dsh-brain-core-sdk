// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export type OneBotId = string | number
export interface OneBotSegment {
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
}
export interface OneBotEvent {
  readonly post_type?: string
  readonly meta_event_type?: string
  readonly notice_type?: string
  readonly sub_type?: string
  readonly status?: {
    readonly online?: boolean
    readonly good?: boolean
  }
  readonly [key: string]: unknown
}
export function normalizeMessageId(value: unknown): string {
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isSafeInteger(value))) throw new Error('Invalid message ID')
  const id = String(value)
  if (!/^-?[1-9]\d*$/.test(id)) throw new Error('Invalid message ID')
  return id
}
export function normalizeAccountId(value: unknown): string {
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isSafeInteger(value))) throw new Error('Invalid account ID')
  const id = String(value)
  if (!/^[1-9]\d*$/.test(id)) throw new Error('Invalid account ID')
  return id
}
