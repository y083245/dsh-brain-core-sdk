// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChannelEventResult } from '@brain-core/sdk'
import { readForwardSummary } from '../src/inbound/forward.ts'

const evidence: ChannelEventResult = {
  record: {
    id: 'l0_forward', layer: 'L0', kind: 'qq.message', source: 'qq', channel: 'qq:group:1001',
    subjects: ['person1'], actor: 'person1', content: {}, evidence: [], visibility: 'origin', trust: 'external',
    confidence: 1, importance: 0.5, tEvent: 1, tIngest: 1, status: 'active', version: 1,
  },
  disclosure: { label: '本通道听说', speakable: 'yes' },
}

test('QQ forward reads only the authorized root and its three-level chain', async () => {
  const fetches: string[] = []
  const checks: string[] = []
  const result = await readForwardSummary('root', {
    authorize: async (id) => { checks.push(id); return evidence },
    fetchForward: async (id) => {
      fetches.push(id)
      if (id === 'root') return { messages: [{ sender: { nickname: '昵称' }, message: '正文[CQ:forward,id=child]' }] }
      if (id === 'child') return [{ type: 'node', data: { nickname: '次级', content: [{ type: 'forward', data: { id: 'grandchild' } }] } }]
      return [{ message: '叶节点[CQ:forward,id=root][CQ:forward,id=too-deep]' }]
    },
  })
  assert.deepEqual(fetches, ['root', 'child', 'grandchild'])
  assert.ok(checks.length >= fetches.length + 1)
  assert.ok(checks.every((id) => id === 'root'))
  assert.deepEqual(result.disclosure, evidence.disclosure)
  const data = JSON.parse(result.text) as { source: string; messages: { text: string }[]; truncated: boolean }
  assert.match(data.source, /外部内容/)
  assert.equal(data.messages[0]?.text, '正文[转发#child]')
  assert.equal(data.truncated, true)
})

test('QQ forward checks revocation before each request and before disclosing data', async () => {
  let active = false
  let calls = 0
  const read = () => readForwardSummary('root', {
    authorize: async () => active ? evidence : undefined,
    fetchForward: async () => {
      calls++
      active = false
      return [{ message: 'never disclose[CQ:forward,id=child]' }]
    },
  })
  await assert.rejects(read(), { code: 'NOT_FOUND' })
  assert.equal(calls, 0)
  active = true
  await assert.rejects(read(), { code: 'NOT_FOUND' })
  assert.equal(calls, 1)
})
