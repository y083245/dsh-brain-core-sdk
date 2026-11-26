// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { BrainError, type ChannelEventResult, type Disclosure } from '@brain-core/sdk'
import { cleanText, decodeSegments, parseSegments } from './segments.ts'

const MAX_DEPTH = 3
const MAX_MESSAGES = 80
const MAX_FETCHES = 12
const MAX_MESSAGE_CHARS = 600
const MAX_SUMMARY_BYTES = 48 * 1024

interface ForwardReaderOptions {
  readonly authorize: (forwardId: string) => Promise<ChannelEventResult | undefined>
  readonly fetchForward: (forwardId: string) => Promise<unknown>
}

interface ForwardSummary {
  readonly text: string
  readonly disclosure: Disclosure
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asMessages(value: unknown): readonly unknown[] {
  const result = asObject(value)
  const messages = Array.isArray(value) ? value : result['messages'] ?? result['message']
  return Array.isArray(messages) ? messages : []
}

function safeForwardId(value: string): boolean {
  return /^[A-Za-z0-9_+=/-]{1,256}$/.test(value)
}

function unavailable(): BrainError {
  return new BrainError('NOT_FOUND', '找不到当前通道中的这条合并转发')
}

/** Recursively reads only descendants of the L0 source already authorized for this tool call. */
export async function readForwardSummary(forwardId: string, options: ForwardReaderOptions): Promise<ForwardSummary> {
  if (!safeForwardId(forwardId)) throw unavailable()
  let rootId: string | undefined
  const authorizeRoot = async (): Promise<ChannelEventResult> => {
    const result = await options.authorize(forwardId)
    if (result === undefined || result.record.status !== 'active' || result.record.layer !== 'L0'
      || (rootId !== undefined && rootId !== result.record.id)) throw unavailable()
    rootId = result.record.id
    return result
  }
  const visited = new Set<string>()
  const lines: { name: string; text: string; depth: number }[] = []
  let remaining = MAX_MESSAGES
  let summaryBytes = 0
  let truncated = false

  const expand = async (id: string, depth: number): Promise<void> => {
    if (!safeForwardId(id) || visited.has(id)) return
    if (depth > MAX_DEPTH || remaining <= 0 || visited.size >= MAX_FETCHES) {
      truncated = true
      return
    }
    visited.add(id)
    await authorizeRoot()
    let messages: readonly unknown[]
    try {
      messages = asMessages(await options.fetchForward(id))
    } catch {
      if (depth === 1) {
        await authorizeRoot()
        throw new BrainError('UNAVAILABLE', 'QQ 合并转发暂时无法读取')
      }
      return
    }
    for (const item of messages) {
      if (remaining <= 0) {
        truncated = true
        break
      }
      remaining--
      const raw = asObject(item)
      const node = raw['type'] === 'node' ? asObject(raw['data']) : raw
      const sender = asObject(node['sender'])
      const display = sender['card'] || sender['nickname'] || node['nickname']
      const name = typeof display === 'string' ? cleanText(display).slice(0, 64) : 'QQ 用户'
      const parsed = parseSegments(decodeSegments(node['content'] ?? node['message']))
      const text = parsed.textContent.slice(0, MAX_MESSAGE_CHARS)
      if (text !== '') {
        const line = { name, text, depth }
        summaryBytes += Buffer.byteLength(JSON.stringify(line), 'utf8') + 1
        if (summaryBytes > MAX_SUMMARY_BYTES) {
          truncated = true
          remaining = 0
          break
        }
        lines.push(line)
      }
      for (const child of parsed.forwardIds) {
        if (depth >= MAX_DEPTH || remaining <= 0 || visited.size >= MAX_FETCHES) {
          truncated = true
          break
        }
        await expand(child, depth + 1)
      }
    }
  }

  await expand(forwardId, 1)
  const current = await authorizeRoot()
  return {
    disclosure: current.disclosure,
    text: JSON.stringify({ source: 'QQ 合并转发（外部内容）', disclosure: current.disclosure, messages: lines, truncated }),
  }
}
