import assert from 'node:assert/strict'
import test from 'node:test'
import { BrainError, type Viewer } from '@dsh-brain-core/sdk'
import type { WriteIdentity } from '../../src/contracts/index.ts'
import { openTempBrain } from './helpers.ts'

const CHANNEL_A = 'qq:group:1001'
const CHANNEL_B = 'qq:group:1002'
const OWNER_CHANNEL = 'qq:private:9999'

const QQ_IDENTITY: WriteIdentity = {
  kind: 'plugin',
  source: 'qq',
  trust: 'external',
  defaultVisibility: 'origin',
  channels: [CHANNEL_A, CHANNEL_B, OWNER_CHANNEL],
  eventKinds: ['qq.message'],
}

const WX_IDENTITY: WriteIdentity = {
  kind: 'plugin',
  source: 'wx',
  trust: 'external',
  defaultVisibility: 'origin',
  channels: [CHANNEL_A],
  eventKinds: ['wx.message'],
}

async function expectNotFound(work: Promise<unknown>): Promise<BrainError> {
  let caught: unknown
  try {
    await work
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof BrainError, `expected BrainError, got ${String(caught)}`)
  assert.equal(caught.code, 'NOT_FOUND')
  assert.equal(caught.message, 'record not found')
  return caught
}

test('readChannelEvent: returns visible same-channel same-source L0 with disclosure and legacy suffix', async () => {
  const brain = await openTempBrain({ ownerChannels: [OWNER_CHANNEL] })
  try {
    const pAlice = await brain.memory.identity.resolve('qq:101')
    const pAlias = await brain.memory.identity.resolve('qq:102')
    await brain.memory.identity.merge(pAlias, pAlice)

    const { id: originId } = await brain.memory.service.ingest({
      kind: 'qq.message',
      channel: CHANNEL_A,
      subjects: [pAlice],
      actor: pAlice,
      content: { text: 'hello group' },
      visibility: 'origin',
      tEvent: 1000,
      idempotencyKey: 'rce-origin',
    }, QQ_IDENTITY)

    const { id: legacyId } = await brain.memory.service.ingest({
      kind: 'qq.message',
      channel: CHANNEL_A,
      subjects: [pAlice],
      actor: pAlice,
      content: { text: 'old log', legacy: true },
      visibility: 'origin',
      tEvent: 1001,
      idempotencyKey: 'rce-legacy',
    }, QQ_IDENTITY)

    const { id: subjectId } = await brain.memory.service.ingest({
      kind: 'qq.message',
      channel: CHANNEL_A,
      subjects: [pAlias],
      actor: pAlias,
      content: { text: 'secret with alice' },
      visibility: 'subject',
      tEvent: 1002,
      idempotencyKey: 'rce-subject',
    }, QQ_IDENTITY)

    const { id: openId } = await brain.memory.service.ingest({
      kind: 'qq.message',
      channel: CHANNEL_A,
      subjects: [pAlice],
      actor: pAlice,
      content: { text: 'open message' },
      visibility: 'open',
      tEvent: 1003,
      idempotencyKey: 'rce-open',
    }, QQ_IDENTITY)

    const viewer: Viewer = { caller: 'qq', channel: CHANNEL_A, participants: [pAlice] }

    const resOrigin = await brain.memory.readChannelEvent(originId, 'qq', viewer)
    assert.equal(resOrigin.record.id, originId)
    assert.equal(resOrigin.record.content.text, 'hello group')
    assert.equal(resOrigin.disclosure.speakable, 'yes')
    assert.equal(resOrigin.disclosure.label, '就在这里说过')

    const resLegacy = await brain.memory.readChannelEvent(legacyId, 'qq', viewer)
    assert.equal(resLegacy.record.id, legacyId)
    assert.equal(resLegacy.disclosure.label, '就在这里说过（旧系统历史存档，仅作事实参考，不作为当前说话语气）')

    const resSubject = await brain.memory.readChannelEvent(subjectId, 'qq', viewer)
    assert.equal(resSubject.record.id, subjectId)
    assert.equal(resSubject.disclosure.speakable, 'if-subject-raises')

    const resOpen = await brain.memory.readChannelEvent(openId, 'qq', viewer)
    assert.equal(resOpen.record.id, openId)
    assert.equal(resOpen.disclosure.speakable, 'yes')
  } finally {
    await brain.close()
  }
})

test('readChannelEvent: missing, other channel, other source, non-L0, tombstoned, internal, and invisible records all throw indistinguishable NOT_FOUND', async () => {
  const brain = await openTempBrain({ ownerChannels: [OWNER_CHANNEL] })
  try {
    const pAlice = await brain.memory.identity.resolve('qq:201')
    const pBob = await brain.memory.identity.resolve('qq:202')

    const { id: otherChannelId } = await brain.memory.service.ingest({
      kind: 'qq.message',
      channel: CHANNEL_B,
      subjects: [pAlice],
      actor: pAlice,
      content: { text: 'in channel B' },
      visibility: 'open',
      tEvent: 2000,
      idempotencyKey: 'rce-other-ch',
    }, QQ_IDENTITY)

    const { id: otherSourceId } = await brain.memory.service.ingest({
      kind: 'wx.message',
      channel: CHANNEL_A,
      subjects: [pAlice],
      actor: pAlice,
      content: { text: 'from wx' },
      visibility: 'origin',
      tEvent: 2001,
      idempotencyKey: 'rce-other-src',
    }, WX_IDENTITY)

    const { id: tombstonedId } = await brain.memory.service.ingest({
      kind: 'qq.message',
      channel: CHANNEL_A,
      subjects: [pAlice],
      actor: pAlice,
      content: { text: 'to forget' },
      visibility: 'origin',
      tEvent: 2002,
      idempotencyKey: 'rce-tomb',
    }, QQ_IDENTITY)

    const { id: internalId } = await brain.memory.service.ingest({
      kind: 'qq.message',
      channel: CHANNEL_A,
      subjects: [pAlice],
      actor: pAlice,
      content: { text: 'raw internal', conclusion: 'internal conclusion' },
      visibility: 'internal',
      tEvent: 2003,
      idempotencyKey: 'rce-internal',
    }, QQ_IDENTITY)

    const { id: subjectOnlyId } = await brain.memory.service.ingest({
      kind: 'qq.message',
      channel: CHANNEL_A,
      subjects: [pAlice],
      actor: pAlice,
      content: { text: 'alice private' },
      visibility: 'subject',
      tEvent: 2004,
      idempotencyKey: 'rce-subj-hide',
    }, QQ_IDENTITY)

    const { id: ownerOnlyId } = await brain.memory.service.ingest({
      kind: 'qq.message',
      channel: CHANNEL_A,
      subjects: [pAlice],
      actor: pAlice,
      content: { text: 'owner only' },
      visibility: 'owner',
      tEvent: 2005,
      idempotencyKey: 'rce-owner-hide',
    }, QQ_IDENTITY)

    const l1 = await brain.memory.service.record({
      layer: 'L1',
      kind: 'l1.fact',
      channel: CHANNEL_A,
      subjects: [pAlice],
      actor: pAlice,
      content: { text: 'derived L1' },
      evidence: [{ id: subjectOnlyId }],
      visibility: 'origin',
    }, QQ_IDENTITY)

    await brain.memory.service.forget({ by: 'record', id: tombstonedId })

    const bobViewer: Viewer = { caller: 'qq', channel: CHANNEL_A, participants: [pBob] }
    const nullViewer: Viewer = { caller: 'qq', channel: null, participants: [pAlice] }

    const missingErr = await expectNotFound(brain.memory.readChannelEvent('l0_00000000000000000000000000', 'qq', bobViewer))
    const emptyErr = await expectNotFound(brain.memory.readChannelEvent('', 'qq', bobViewer))
    const otherChannelErr = await expectNotFound(brain.memory.readChannelEvent(otherChannelId, 'qq', bobViewer))
    const otherSourceErr = await expectNotFound(brain.memory.readChannelEvent(otherSourceId, 'qq', bobViewer))
    const nonL0Err = await expectNotFound(brain.memory.readChannelEvent(l1.id, 'qq', bobViewer))
    const tombstonedErr = await expectNotFound(brain.memory.readChannelEvent(tombstonedId, 'qq', bobViewer))
    const internalErr = await expectNotFound(brain.memory.readChannelEvent(internalId, 'qq', bobViewer))
    const subjectErr = await expectNotFound(brain.memory.readChannelEvent(subjectOnlyId, 'qq', bobViewer))
    const ownerErr = await expectNotFound(brain.memory.readChannelEvent(ownerOnlyId, 'qq', bobViewer))
    const nullViewerErr = await expectNotFound(brain.memory.readChannelEvent(subjectOnlyId, 'qq', nullViewer))

    for (const err of [emptyErr, otherChannelErr, otherSourceErr, nonL0Err, tombstonedErr, internalErr, subjectErr, ownerErr, nullViewerErr]) {
      assert.equal(err.code, missingErr.code)
      assert.equal(err.message, missingErr.message)
    }
  } finally {
    await brain.close()
  }
})
