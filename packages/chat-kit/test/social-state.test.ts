import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createSocialStateMachine,
  createWakeConfigToolSpec,
  DEFAULT_WAKE_CONFIG,
  parseWakeConfigArgs,
} from '../src/index.ts'
import { createFakeEnv } from './fake-timers.ts'

describe('social-state', () => {
  it('always wakes private channels and bypasses group cooldown', () => {
    const env = createFakeEnv(10_000)
    const sm = createSocialStateMachine({ clock: env.clock })

    assert.equal(sm.getState('p:1').mode, 'lurking')
    assert.deepEqual(sm.getState('p:1').config, DEFAULT_WAKE_CONFIG)

    const d1 = sm.evaluateWake('p:1', { channelKind: 'private', text: 'hi' })
    assert.equal(d1.shouldWake, true)
    assert.equal(d1.reason, 'private-message')
    assert.equal(d1.nextMode, 'active')
    assert.equal(d1.suggestedDebounceMs, DEFAULT_WAKE_CONFIG.quietDebounceMs)

    env.advanceBy(100)
    const d2 = sm.evaluateWake('p:1', { channelKind: 'private', text: 'second' })
    assert.equal(d2.shouldWake, true)
    assert.equal(d2.reason, 'private-message')
    assert.equal(sm.getState('p:1').lastWakeAt, 10_100)
  })

  it('handles group mention, keywords, always mode, active window, auto-lurk, and cooldown', () => {
    const env = createFakeEnv(100_000)
    const sm = createSocialStateMachine({
      clock: env.clock,
      defaultConfig: {
        keywords: ['小满', 'AI', '  '],
        activeWindowMs: 5_000,
        lurkAfterMs: 10_000,
        minWakeIntervalMs: 2_000,
        quietDebounceMs: 1_200,
      },
    })

    // Initial group message without trigger -> lurking-skip
    const skip1 = sm.evaluateWake('g:1', { channelKind: 'group', text: 'hello everyone' })
    assert.deepEqual(skip1, {
      shouldWake: false,
      reason: 'lurking-skip',
      nextMode: 'lurking',
      suggestedDebounceMs: 0,
    })

    // Direct mention wakes and sets active
    const mention1 = sm.evaluateWake('g:1', { channelKind: 'group', text: '@bot hey', mentioned: true })
    assert.equal(mention1.shouldWake, true)
    assert.equal(mention1.reason, 'direct-mention')
    assert.equal(mention1.nextMode, 'active')
    assert.equal(mention1.suggestedDebounceMs, 1_200)

    // Within cooldown (< 2000ms): active-thread is suppressed by cooldown-skip
    env.advanceBy(1_500)
    const cooldownSkip = sm.evaluateWake('g:1', { channelKind: 'group', text: 'follow up' })
    assert.deepEqual(cooldownSkip, {
      shouldWake: false,
      reason: 'cooldown-skip',
      nextMode: 'active',
      suggestedDebounceMs: 0,
    })

    // Direct mention bypasses cooldown
    const mentionBypass = sm.evaluateWake('g:1', { channelKind: 'group', text: '@bot urgent', mentioned: true })
    assert.equal(mentionBypass.shouldWake, true)
    assert.equal(mentionBypass.reason, 'direct-mention')

    // At exact cooldown boundary (2000ms) and inside activeWindowMs (5000ms): active-thread wakes
    env.advanceBy(2_000)
    const activeThread = sm.evaluateWake('g:1', { channelKind: 'group', text: 'continuing' })
    assert.equal(activeThread.shouldWake, true)
    assert.equal(activeThread.reason, 'active-thread')

    // Past activeWindowMs (5000ms) but before lurkAfterMs (10000ms): skips as lurking-skip while mode stays active
    env.advanceBy(4_999)
    assert.equal(sm.evaluateWake('g:1', { channelKind: 'group', text: 'still active at 4999' }).reason, 'active-thread')

    env.advanceBy(5_000)
    const afterActiveWindow = sm.evaluateWake('g:1', { channelKind: 'group', text: 'random chatter' })
    assert.deepEqual(afterActiveWindow, {
      shouldWake: false,
      reason: 'lurking-skip',
      nextMode: 'active',
      suggestedDebounceMs: 0,
    })

    // Empty/whitespace keyword in config must never match
    assert.equal(sm.evaluateWake('g:1', { channelKind: 'group', text: 'empty keyword check' }).reason, 'lurking-skip')

    // Case-insensitive keyword wakes
    const kwWake = sm.evaluateWake('g:1', { channelKind: 'group', text: 'Let us talk about ai today' })
    assert.equal(kwWake.shouldWake, true)
    assert.equal(kwWake.reason, 'keyword')

    // At lurkAfterMs - 1, still active; at lurkAfterMs, transitions to lurking
    env.advanceBy(9_999)
    assert.equal(sm.evaluateWake('g:1', { channelKind: 'group', text: 'before lurk' }).nextMode, 'active')
    env.advanceBy(1)
    const autoLurk = sm.evaluateWake('g:1', { channelKind: 'group', text: 'hello folks' })
    assert.deepEqual(autoLurk, {
      shouldWake: false,
      reason: 'lurking-skip',
      nextMode: 'lurking',
      suggestedDebounceMs: 0,
    })
    assert.equal(sm.getState('g:1').mode, 'lurking')

    // groupTrigger = 'always' wakes even when lurking
    sm.updateConfig('g:1', { groupTrigger: 'always' })
    const alwaysWake = sm.evaluateWake('g:1', { channelKind: 'group', text: 'anything' })
    assert.equal(alwaysWake.shouldWake, true)
    assert.equal(alwaysWake.reason, 'always')

    // Keyword and always triggers are also suppressed within cooldown
    env.advanceBy(500)
    assert.equal(sm.evaluateWake('g:1', { channelKind: 'group', text: 'talk about AI' }).reason, 'cooldown-skip')
    assert.equal(sm.evaluateWake('g:1', { channelKind: 'group', text: 'more chatter' }).reason, 'cooldown-skip')
  })

  it('blocks all messages when muted including private and direct mention', () => {
    const env = createFakeEnv(50_000)
    const sm = createSocialStateMachine({ clock: env.clock })
    sm.updateConfig('p:muted', { mode: 'muted' })
    sm.updateConfig('g:muted', { mode: 'muted', groupTrigger: 'always' })

    assert.deepEqual(sm.evaluateWake('p:muted', { channelKind: 'private', text: 'wake up' }), {
      shouldWake: false,
      reason: 'muted-skip',
      nextMode: 'muted',
      suggestedDebounceMs: 0,
    })
    assert.deepEqual(sm.evaluateWake('g:muted', { channelKind: 'group', text: '@bot', mentioned: true }), {
      shouldWake: false,
      reason: 'muted-skip',
      nextMode: 'muted',
      suggestedDebounceMs: 0,
    })
  })

  it('validates config patches and supports exportState / importState round-trip', () => {
    const env = createFakeEnv(20_000)
    const sm1 = createSocialStateMachine({ clock: env.clock })
    sm1.updateConfig('g:1', { keywords: ['test'], activeWindowMs: 10_000, mode: 'active' })
    sm1.evaluateWake('g:1', { channelKind: 'group', text: '@bot', mentioned: true })

    const snapshot = sm1.exportState()
    const jsonRoundTrip = JSON.parse(JSON.stringify(snapshot)) as unknown

    const sm2 = createSocialStateMachine({ clock: env.clock })
    sm2.importState(jsonRoundTrip)
    assert.deepEqual(sm2.getState('g:1'), sm1.getState('g:1'))

    assert.throws(() => sm1.updateConfig('', { mode: 'active' }), RangeError)
    assert.throws(() => sm1.updateConfig('g:1', { mode: 'invalid' as never }), RangeError)
    assert.throws(() => sm1.updateConfig('g:1', { groupTrigger: 'bad' as never }), RangeError)
    assert.throws(() => sm1.updateConfig('g:1', { activeWindowMs: -1 }), RangeError)
    assert.throws(() => sm1.updateConfig('g:1', { lurkAfterMs: Number.NaN }), RangeError)
    assert.throws(() => sm1.updateConfig('g:1', { keywords: [123] as never }), TypeError)
    assert.throws(() => sm2.importState({ version: 2, channels: {} }), TypeError)
  })

  it('exports RFC 8.9 set_wake_config tool spec and parses args safely', () => {
    const spec = createWakeConfigToolSpec()
    assert.equal(spec.name, 'set_wake_config')
    assert.equal(spec.parameters.type, 'object')

    const parsed = parseWakeConfigArgs({
      channel: 'qq:group:123',
      mode: 'muted',
      groupTrigger: 'keyword',
      keywords: ['早安'],
      quietDebounceMs: 500,
    })
    assert.deepEqual(parsed, {
      channel: 'qq:group:123',
      patch: {
        mode: 'muted',
        groupTrigger: 'keyword',
        keywords: ['早安'],
        quietDebounceMs: 500,
      },
    })

    assert.throws(() => parseWakeConfigArgs(null), TypeError)
    assert.throws(() => parseWakeConfigArgs({ mode: 'sleeping' }), RangeError)
    assert.throws(() => parseWakeConfigArgs({ minWakeIntervalMs: -5 }), RangeError)
    assert.throws(() => parseWakeConfigArgs({ channel: '   ' }), RangeError)

    const props = spec.parameters.properties as Record<string, unknown>
    assert.ok('shortAsciiWordBoundary' in props)
    assert.ok('speakerIds' in props)
    assert.ok('replyProbability' in props)
    assert.ok('maxWakePerHour' in props)

    const parsedExtended = parseWakeConfigArgs({
      shortAsciiWordBoundary: true,
      speakerIds: ['10001', '10002'],
      replyProbability: 0.25,
      maxWakePerHour: 12,
    })
    assert.deepEqual(parsedExtended, {
      patch: {
        shortAsciiWordBoundary: true,
        speakerIds: ['10001', '10002'],
        replyProbability: 0.25,
        maxWakePerHour: 12,
      },
    })

    assert.throws(() => parseWakeConfigArgs({ shortAsciiWordBoundary: 'true' }), TypeError)
    assert.throws(() => parseWakeConfigArgs({ speakerIds: '10001' }), TypeError)
    assert.throws(() => parseWakeConfigArgs({ speakerIds: [10001] }), TypeError)
    assert.throws(() => parseWakeConfigArgs({ replyProbability: -0.01 }), RangeError)
    assert.throws(() => parseWakeConfigArgs({ replyProbability: 1.01 }), RangeError)
    assert.throws(() => parseWakeConfigArgs({ replyProbability: Number.NaN }), RangeError)
    assert.throws(() => parseWakeConfigArgs({ maxWakePerHour: -1 }), RangeError)
    assert.throws(() => parseWakeConfigArgs({ maxWakePerHour: 1.5 }), RangeError)
    assert.throws(() => parseWakeConfigArgs({ maxWakePerHour: Number.POSITIVE_INFINITY }), RangeError)
  })

  it('supports shortAsciiWordBoundary without breaking non-ASCII or long keywords', () => {
    const env = createFakeEnv(10_000)
    const sm = createSocialStateMachine({
      clock: env.clock,
      defaultConfig: {
        keywords: ['DS', '小满', 'hello'],
        shortAsciiWordBoundary: true,
        minWakeIntervalMs: 0,
      },
    })

    // Short ASCII keyword matches at word boundaries including CJK-adjacent
    assert.equal(sm.evaluateWake('g:1', { channelKind: 'group', text: 'hi DS!' }).reason, 'keyword')
    assert.equal(sm.evaluateWake('g:1', { channelKind: 'group', text: '你好DS' }).reason, 'keyword')
    assert.equal(sm.evaluateWake('g:1', { channelKind: 'group', text: 'ds' }).reason, 'keyword')

    // Trimmed whitespace around short ASCII keyword still uses word-boundary matching
    sm.updateConfig('g:trim', { keywords: [' DS '], shortAsciiWordBoundary: true })
    assert.equal(sm.evaluateWake('g:trim', { channelKind: 'group', text: 'ADS' }).reason, 'lurking-skip')
    assert.equal(sm.evaluateWake('g:trim', { channelKind: 'group', text: 'hi DS!' }).reason, 'keyword')

    // Does not match inside longer identifiers or underscore words
    sm.updateConfig('g:2', { mode: 'lurking' })
    assert.equal(sm.evaluateWake('g:2', { channelKind: 'group', text: 'ADS' }).reason, 'lurking-skip')
    assert.equal(sm.evaluateWake('g:2', { channelKind: 'group', text: 'DSL' }).reason, 'lurking-skip')
    assert.equal(sm.evaluateWake('g:2', { channelKind: 'group', text: 'ds_1' }).reason, 'lurking-skip')
    assert.equal(sm.evaluateWake('g:2', { channelKind: 'group', text: '1ds' }).reason, 'lurking-skip')

    // Non-ASCII and >4 char keywords still use substring match
    assert.equal(sm.evaluateWake('g:2', { channelKind: 'group', text: '早安小满啊' }).reason, 'keyword')
    assert.equal(sm.evaluateWake('g:2', { channelKind: 'group', text: 'HELLO123' }).reason, 'keyword')

    // When shortAsciiWordBoundary is false, DS matches substring as before
    sm.updateConfig('g:3', { shortAsciiWordBoundary: false })
    assert.equal(sm.evaluateWake('g:3', { channelKind: 'group', text: 'ADS' }).reason, 'keyword')
  })

  it('handles quotedSelf, isPoke, speakerIds, replyProbability, and trigger precedence', () => {
    const env = createFakeEnv(20_000)
    const speakers = ['u-vip']
    const sm = createSocialStateMachine({
      clock: env.clock,
      defaultConfig: {
        keywords: ['bot'],
        speakerIds: speakers,
        replyProbability: 0.4,
        activeWindowMs: 5_000,
        lurkAfterMs: 10_000,
        minWakeIntervalMs: 3_000,
      },
    })

    // Defensive clone of speakerIds
    speakers.push('u-mutated')
    assert.deepEqual(sm.getState('g:1').config.speakerIds, ['u-vip'])

    // quotedSelf with empty text wakes as direct-mention
    const q1 = sm.evaluateWake('g:1', { channelKind: 'group', text: '', quotedSelf: true })
    assert.equal(q1.shouldWake, true)
    assert.equal(q1.reason, 'direct-mention')

    // Within cooldown: speaker, keyword, active-thread, probability are suppressed; quotedSelf & isPoke bypass
    env.advanceBy(500)
    assert.equal(
      sm.evaluateWake('g:1', { channelKind: 'group', text: 'hello', actor: 'u-vip' }).reason,
      'cooldown-skip',
    )
    assert.equal(
      sm.evaluateWake('g:1', { channelKind: 'group', text: 'bot' }).reason,
      'cooldown-skip',
    )
    assert.equal(
      sm.evaluateWake('g:1', { channelKind: 'group', text: 'chat', randomRoll: 0.1 }).reason,
      'cooldown-skip',
    )

    const pokeBypass = sm.evaluateWake('g:1', { channelKind: 'group', text: '', isPoke: true })
    assert.equal(pokeBypass.shouldWake, true)
    assert.equal(pokeBypass.reason, 'poke')

    env.advanceBy(500)
    const quoteBypass = sm.evaluateWake('g:1', {
      channelKind: 'group',
      text: '',
      quotedSelf: true,
      isPoke: true,
    })
    assert.equal(quoteBypass.reason, 'direct-mention')

    // Past cooldown and lurkAfterMs: verify precedence poke > speaker > keyword > always > active-thread > probability
    env.advanceBy(15_000)
    assert.equal(sm.evaluateWake('g:1', { channelKind: 'group', text: 'bot', actor: 'u-vip', isPoke: true }).reason, 'poke')

    env.advanceBy(15_000)
    assert.equal(sm.evaluateWake('g:1', { channelKind: 'group', text: 'bot', actor: 'u-vip' }).reason, 'speaker')

    // Past activeWindowMs, probability edge cases (0, < p, == p, 1)
    env.advanceBy(15_000)
    assert.equal(sm.evaluateWake('g:1', { channelKind: 'group', text: 'random', randomRoll: 0.4 }).reason, 'lurking-skip')
    assert.equal(sm.evaluateWake('g:1', { channelKind: 'group', text: 'random', randomRoll: 0.39 }).reason, 'probability')

    sm.updateConfig('g:prob0', { replyProbability: 0 })
    assert.equal(sm.evaluateWake('g:prob0', { channelKind: 'group', text: 'x', randomRoll: 0 }).reason, 'lurking-skip')

    sm.updateConfig('g:prob1', { replyProbability: 1 })
    assert.equal(sm.evaluateWake('g:prob1', { channelKind: 'group', text: 'x', randomRoll: 0.999999 }).reason, 'probability')

    // Invalid randomRoll throws RangeError
    assert.throws(() => sm.evaluateWake('g:1', { channelKind: 'group', text: 'x', randomRoll: -0.01 }), RangeError)
    assert.throws(() => sm.evaluateWake('g:1', { channelKind: 'group', text: 'x', randomRoll: 1 }), RangeError)
    assert.throws(() => sm.evaluateWake('g:1', { channelKind: 'group', text: 'x', randomRoll: Number.NaN }), RangeError)
    assert.throws(() => sm.evaluateWake('g:1', { channelKind: 'group', text: 'x', randomRoll: Number.POSITIVE_INFINITY }), RangeError)
  })

  it('enforces sliding 1-hour maxWakePerHour on non-private channels only', () => {
    const env = createFakeEnv(1_000_000)
    const sm = createSocialStateMachine({
      clock: env.clock,
      defaultConfig: {
        maxWakePerHour: 2,
        minWakeIntervalMs: 1_000,
      },
    })

    // First two wakes succeed
    const w1 = sm.evaluateWake('g:budget', { channelKind: 'group', text: '@bot 1', mentioned: true })
    assert.equal(w1.shouldWake, true)
    env.advanceBy(10_000)
    const w2 = sm.evaluateWake('g:budget', { channelKind: 'group', text: '', isPoke: true })
    assert.equal(w2.shouldWake, true)

    const beforeSkip = sm.getState('g:budget')

    // 3rd wake within 1 hour (even direct-mention) is blocked without mutating state
    env.advanceBy(10_000)
    const skip = sm.evaluateWake('g:budget', { channelKind: 'group', text: '@bot 3', mentioned: true })
    assert.deepEqual(skip, {
      shouldWake: false,
      reason: 'hourly-budget-skip',
      nextMode: 'active',
      suggestedDebounceMs: 0,
    })
    assert.equal(sm.getState('g:budget').lastWakeAt, beforeSkip.lastWakeAt)
    assert.equal(sm.getState('g:budget').lastActivityAt, beforeSkip.lastActivityAt)

    // At 1_000_000 + 3_599_999 (just before 1h from w1), still blocked
    env.setNow(1_000_000 + 3_599_999)
    assert.equal(
      sm.evaluateWake('g:budget', { channelKind: 'group', text: '@bot', mentioned: true }).reason,
      'hourly-budget-skip',
    )

    // At exact 1_000_000 + 3_600_000, w1 expires and wake succeeds
    env.setNow(1_000_000 + 3_600_000)
    const w3 = sm.evaluateWake('g:budget', { channelKind: 'group', text: '@bot ok', mentioned: true })
    assert.equal(w3.shouldWake, true)
    assert.equal(w3.reason, 'direct-mention')

    // maxWakePerHour: 0 blocks all group wakes without altering lurking mode, but never blocks private
    sm.updateConfig('g:zero', { maxWakePerHour: 0 })
    const zeroSkip = sm.evaluateWake('g:zero', { channelKind: 'group', text: '@bot', mentioned: true })
    assert.deepEqual(zeroSkip, {
      shouldWake: false,
      reason: 'hourly-budget-skip',
      nextMode: 'lurking',
      suggestedDebounceMs: 0,
    })
    assert.equal(sm.getState('g:zero').lastWakeAt, undefined)

    sm.updateConfig('p:zero', { maxWakePerHour: 0 })
    assert.equal(sm.evaluateWake('p:zero', { channelKind: 'private', text: 'hi' }).reason, 'private-message')
    sm.updateConfig('p:zero', { mode: 'muted' })
    assert.equal(sm.evaluateWake('p:zero', { channelKind: 'private', text: 'hi' }).reason, 'muted-skip')
  })

  it('validates new config fields and round-trips v1 snapshots with and without optional fields', () => {
    const env = createFakeEnv(30_000)
    const sm1 = createSocialStateMachine({ clock: env.clock })

    assert.throws(() => sm1.updateConfig('g:1', { shortAsciiWordBoundary: 'yes' as never }), TypeError)
    assert.throws(() => sm1.updateConfig('g:1', { speakerIds: 'u1' as never }), TypeError)
    assert.throws(() => sm1.updateConfig('g:1', { speakerIds: [42] as never }), TypeError)
    assert.throws(() => sm1.updateConfig('g:1', { replyProbability: -0.1 }), RangeError)
    assert.throws(() => sm1.updateConfig('g:1', { replyProbability: 1.1 }), RangeError)
    assert.throws(() => sm1.updateConfig('g:1', { replyProbability: Number.NaN }), RangeError)
    assert.throws(() => sm1.updateConfig('g:1', { maxWakePerHour: -1 }), RangeError)
    assert.throws(() => sm1.updateConfig('g:1', { maxWakePerHour: 2.5 }), RangeError)
    assert.throws(() => sm1.updateConfig('g:1', { maxWakePerHour: Number.POSITIVE_INFINITY }), RangeError)

    sm1.updateConfig('g:ext', {
      shortAsciiWordBoundary: true,
      speakerIds: ['123'],
      replyProbability: 0.5,
      maxWakePerHour: 10,
    })
    const exported = JSON.parse(JSON.stringify(sm1.exportState())) as unknown
    const sm2 = createSocialStateMachine({ clock: env.clock })
    sm2.importState(exported)
    assert.deepEqual(sm2.getState('g:ext').config, sm1.getState('g:ext').config)

    // Backward compatibility with legacy v1 snapshot omitting optional fields
    sm2.importState({
      version: 1,
      channels: {
        'g:legacy': {
          mode: 'lurking',
          config: { ...DEFAULT_WAKE_CONFIG },
        },
      },
    })
    assert.deepEqual(sm2.getState('g:legacy').config, DEFAULT_WAKE_CONFIG)
  })

  it('persists wakeTimestamps across exportState / importState when maxWakePerHour is active', () => {
    const env = createFakeEnv(1_000_000)
    const sm1 = createSocialStateMachine({
      clock: env.clock,
      defaultConfig: { maxWakePerHour: 2, minWakeIntervalMs: 1_000 },
    })

    assert.equal(sm1.evaluateWake('g:budget', { channelKind: 'group', text: '@bot 1', mentioned: true }).shouldWake, true)
    env.advanceBy(10_000)
    assert.equal(sm1.evaluateWake('g:budget', { channelKind: 'group', text: '@bot 2', mentioned: true }).shouldWake, true)

    const exported = sm1.exportState()
    assert.deepEqual(exported.channels['g:budget']?.wakeTimestamps, [1_000_000, 1_010_000])
    const roundTripped = JSON.parse(JSON.stringify(exported)) as unknown

    const sm2 = createSocialStateMachine({
      clock: env.clock,
      defaultConfig: { maxWakePerHour: 2, minWakeIntervalMs: 1_000 },
    })
    sm2.importState(roundTripped)
    assert.deepEqual(sm2.getState('g:budget'), sm1.getState('g:budget'))

    // Hourly budget remains exhausted after restore
    env.advanceBy(10_000)
    assert.equal(
      sm2.evaluateWake('g:budget', { channelKind: 'group', text: '@bot 3', mentioned: true }).reason,
      'hourly-budget-skip',
    )

    // Once the oldest wake expires after 1 hour, budget opens up again
    env.setNow(1_000_000 + 3_600_000)
    assert.equal(
      sm2.evaluateWake('g:budget', { channelKind: 'group', text: '@bot 4', mentioned: true }).shouldWake,
      true,
    )

    // Invalid wakeTimestamps in snapshot throws TypeError
    for (const badWakeTimestamps of ['bad', 123, null, [1_000, 'bad'], [Number.NaN], [Number.POSITIVE_INFINITY]]) {
      assert.throws(() => sm2.importState({
        version: 1,
        channels: {
          'g:bad': {
            mode: 'active',
            config: { ...DEFAULT_WAKE_CONFIG, maxWakePerHour: 2 },
            wakeTimestamps: badWakeTimestamps,
          },
        },
      }), TypeError)
    }

    // Legacy snapshot without wakeTimestamps still imports cleanly
    sm2.importState({
      version: 1,
      channels: {
        'g:no-ts': {
          mode: 'active',
          config: { ...DEFAULT_WAKE_CONFIG, maxWakePerHour: 2 },
        },
      },
    })
    assert.equal(sm2.getState('g:no-ts').wakeTimestamps, undefined)
    assert.equal(
      sm2.evaluateWake('g:no-ts', { channelKind: 'group', text: '@bot', mentioned: true }).shouldWake,
      true,
    )
  })
})
