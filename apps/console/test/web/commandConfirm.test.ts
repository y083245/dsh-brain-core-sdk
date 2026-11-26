import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentProcessStatus } from '../../web/src/api/types.ts'
import {
  buildCommandCovenantConfig,
  canCloseConfirmCovenant,
  describeCrossChannelActionSubtitle,
  describeRestartChatActionSubtitle,
  evaluateChatRestart,
  getNextCrossChannelMode,
  requiresCrossChannelConfirm,
  resolvePaletteOpenWithConfirm,
} from '../../web/src/shell/commandConfirm.ts'

function makeChatProcess(overrides: Partial<AgentProcessStatus> = {}): AgentProcessStatus {
  return {
    agentClass: 'chat',
    status: 'running',
    recoveryPhase: 'running',
    pid: 4242,
    activeSessions: 1,
    selection: {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      effort: 'high',
    },
    deniedApprovals: 0,
    ...overrides,
  }
}

test('getNextCrossChannelMode cycles off -> shadow -> on -> off and defaults unknown to shadow', () => {
  assert.equal(getNextCrossChannelMode('off'), 'shadow')
  assert.equal(getNextCrossChannelMode('shadow'), 'on')
  assert.equal(getNextCrossChannelMode('on'), 'off')
  assert.equal(getNextCrossChannelMode(null), 'shadow')
  assert.equal(getNextCrossChannelMode(undefined), 'shadow')
})

test('requiresCrossChannelConfirm only requires hold-to-stamp when target mode is on', () => {
  assert.equal(requiresCrossChannelConfirm('on'), true)
  assert.equal(requiresCrossChannelConfirm('shadow'), false)
  assert.equal(requiresCrossChannelConfirm('off'), false)
})

test('describeCrossChannelActionSubtitle annotates hold confirmation only for shadow -> on', () => {
  assert.equal(describeCrossChannelActionSubtitle('shadow'), '当前：shadow · 需长按准许')
  assert.equal(describeCrossChannelActionSubtitle('off'), '当前：off')
  assert.equal(describeCrossChannelActionSubtitle('on'), '当前：on')
  assert.equal(describeCrossChannelActionSubtitle(null), '当前：未知')
  assert.equal(describeCrossChannelActionSubtitle(undefined), '当前：未知')
})

test('evaluateChatRestart allows restarting when process is unknown or in stable states with model', () => {
  assert.deepEqual(evaluateChatRestart(undefined), {
    canRestart: true,
    reason: null,
    notice: null,
  })
  assert.deepEqual(evaluateChatRestart(null), {
    canRestart: true,
    reason: null,
    notice: null,
  })

  for (const status of ['idle', 'running', 'stopped', 'crashed', 'failed'] as const) {
    const result = evaluateChatRestart(makeChatProcess({ status, recoveryPhase: 'idle' }))
    assert.deepEqual(result, { canRestart: true, reason: null, notice: null }, status)
  }
})

test('evaluateChatRestart blocks when model selection is missing', () => {
  const result = evaluateChatRestart(makeChatProcess({ status: 'stopped', selection: null }))
  assert.equal(result.canRestart, false)
  assert.equal(result.reason, 'no-model')
  assert.ok(result.notice && result.notice.includes('模型'))
})

test('evaluateChatRestart blocks when chat is starting, restarting, or stopping', () => {
  const starting = evaluateChatRestart(makeChatProcess({ status: 'starting', recoveryPhase: 'idle' }))
  assert.equal(starting.canRestart, false)
  assert.equal(starting.reason, 'restarting')
  assert.ok(starting.notice && starting.notice.length > 0)

  const recovering = evaluateChatRestart(
    makeChatProcess({ status: 'crashed', recoveryPhase: 'restarting' }),
  )
  assert.equal(recovering.canRestart, false)
  assert.equal(recovering.reason, 'restarting')
  assert.ok(recovering.notice && recovering.notice.length > 0)

  const stopping = evaluateChatRestart(makeChatProcess({ status: 'stopping', recoveryPhase: 'idle' }))
  assert.equal(stopping.canRestart, false)
  assert.equal(stopping.reason, 'stopping')
  assert.ok(stopping.notice && stopping.notice.length > 0)
})

test('describeRestartChatActionSubtitle always marks hold confirmation and surfaces blocked states', () => {
  assert.equal(
    describeRestartChatActionSubtitle(makeChatProcess()),
    '重启聊天附属运行时 · 需长按确认',
  )
  assert.equal(
    describeRestartChatActionSubtitle(undefined),
    '重启聊天附属运行时 · 需长按确认',
  )
  assert.match(
    describeRestartChatActionSubtitle(makeChatProcess({ selection: null })),
    /未选择模型.*需长按确认/,
  )
  assert.match(
    describeRestartChatActionSubtitle(makeChatProcess({ status: 'starting' })),
    /启动或重启中.*需长按确认/,
  )
  assert.match(
    describeRestartChatActionSubtitle(makeChatProcess({ status: 'stopping' })),
    /停止中.*需长按确认/,
  )
})

test('buildCommandCovenantConfig builds cross-channel enable covenant matching MemoryPage copy', () => {
  const config = buildCommandCovenantConfig('enable-cross-channel')
  assert.equal(config.intent, 'enable-cross-channel')
  assert.equal(config.title, '准许')
  assert.equal(
    config.body,
    '启用后，符合可见性与披露约束的记忆可以跨通道使用。跨通道使用仍会写入审计记录。',
  )
  assert.equal(config.stampLabel, '准许')
  assert.equal(config.stampAriaLabel, '按住 0.9 秒以准许跨通道')
  assert.equal(config.cancelLabel, '算了')
  assert.equal(config.stampDisabled, false)
  assert.equal(config.blockReason, null)
  assert.equal(config.blockNotice, null)
})

test('buildCommandCovenantConfig builds restart-chat covenant for ready and blocked states', () => {
  const ready = buildCommandCovenantConfig('restart-chat', makeChatProcess())
  assert.equal(ready.intent, 'restart-chat')
  assert.equal(ready.title, '重启')
  assert.equal(ready.body, '重启会打断进行中的会话。')
  assert.equal(ready.stampLabel, '重启')
  assert.equal(ready.stampAriaLabel, '按住 0.9 秒以确认：重启 chat')
  assert.equal(ready.cancelLabel, '算了')
  assert.equal(ready.stampDisabled, false)
  assert.equal(ready.blockReason, null)
  assert.equal(ready.blockNotice, null)

  const noModel = buildCommandCovenantConfig('restart-chat', makeChatProcess({ selection: null }))
  assert.equal(noModel.stampDisabled, true)
  assert.equal(noModel.blockReason, 'no-model')
  assert.ok(noModel.blockNotice && noModel.blockNotice.includes('模型'))

  const restarting = buildCommandCovenantConfig(
    'restart-chat',
    makeChatProcess({ recoveryPhase: 'restarting' }),
  )
  assert.equal(restarting.stampDisabled, true)
  assert.equal(restarting.blockReason, 'restarting')
  assert.ok(restarting.blockNotice && restarting.blockNotice.length > 0)

  const stopping = buildCommandCovenantConfig(
    'restart-chat',
    makeChatProcess({ status: 'stopping' }),
  )
  assert.equal(stopping.stampDisabled, true)
  assert.equal(stopping.blockReason, 'stopping')
  assert.ok(stopping.blockNotice && stopping.blockNotice.length > 0)
})

test('resolvePaletteOpenWithConfirm preserves pending Covenant while confirming and dismisses when idle', () => {
  assert.deepEqual(resolvePaletteOpenWithConfirm(null, false), {
    keepConfirmOpen: false,
    dismissConfirm: false,
    suppressPalette: false,
  })
  assert.deepEqual(resolvePaletteOpenWithConfirm(null, true), {
    keepConfirmOpen: false,
    dismissConfirm: false,
    suppressPalette: false,
  })

  for (const intent of ['enable-cross-channel', 'restart-chat'] as const) {
    assert.deepEqual(
      resolvePaletteOpenWithConfirm(intent, true),
      {
        keepConfirmOpen: true,
        dismissConfirm: false,
        suppressPalette: true,
      },
      `${intent} confirming`,
    )
    assert.deepEqual(
      resolvePaletteOpenWithConfirm(intent, false),
      {
        keepConfirmOpen: false,
        dismissConfirm: true,
        suppressPalette: false,
      },
      `${intent} idle`,
    )
  }

  assert.equal(canCloseConfirmCovenant(true), false)
  assert.equal(canCloseConfirmCovenant(false), true)
})
