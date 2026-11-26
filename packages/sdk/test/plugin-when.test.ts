import assert from 'node:assert/strict'
import test from 'node:test'
import { evalWhen, parseWhen } from '../src/plugin.ts'
import type { WakeFeatures, WhenExpr } from '../src/plugin.ts'
import { BrainError } from '../src/types.ts'

const features = (overrides: Partial<{
  hasMedia: boolean
  hasForward: boolean
  poke: boolean
  kind: string
}> = {}): WakeFeatures => ({
  message: { hasMedia: overrides.hasMedia ?? false, hasForward: overrides.hasForward ?? false },
  event: { poke: overrides.poke ?? false },
  channel: { kind: overrides.kind ?? 'private' },
})

function invalidArgument(run: () => unknown): BrainError {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof BrainError, `expected BrainError, got ${String(error)}`)
    assert.equal(error.code, 'INVALID_ARGUMENT')
    return error
  }
  assert.fail('expected parseWhen to throw')
}

test('parseWhen understands the four atoms', () => {
  assert.deepEqual(parseWhen('message.hasMedia'), { anyOf: [[{ feature: 'message.hasMedia' }]] })
  assert.deepEqual(parseWhen('message.hasForward'), { anyOf: [[{ feature: 'message.hasForward' }]] })
  assert.deepEqual(parseWhen('event.poke'), { anyOf: [[{ feature: 'event.poke' }]] })
  assert.deepEqual(parseWhen('channel.kind == "group"'), {
    anyOf: [[{ feature: 'channel.kind', equals: 'group' }]],
  })
  assert.deepEqual(parseWhen('channel.kind == "a_b-c1"'), {
    anyOf: [[{ feature: 'channel.kind', equals: 'a_b-c1' }]],
  })
})

test('parseWhen groups && before ||', () => {
  assert.deepEqual(parseWhen('message.hasMedia && event.poke'), {
    anyOf: [[{ feature: 'message.hasMedia' }, { feature: 'event.poke' }]],
  })
  assert.deepEqual(parseWhen('message.hasMedia || event.poke'), {
    anyOf: [[{ feature: 'message.hasMedia' }], [{ feature: 'event.poke' }]],
  })
  assert.deepEqual(parseWhen('message.hasMedia && event.poke || message.hasForward'), {
    anyOf: [[{ feature: 'message.hasMedia' }, { feature: 'event.poke' }], [{ feature: 'message.hasForward' }]],
  })
  assert.deepEqual(parseWhen('message.hasMedia || event.poke && message.hasForward'), {
    anyOf: [[{ feature: 'message.hasMedia' }], [{ feature: 'event.poke' }, { feature: 'message.hasForward' }]],
  })
  assert.deepEqual(parseWhen('  message.hasMedia   &&   event.poke  '), {
    anyOf: [[{ feature: 'message.hasMedia' }, { feature: 'event.poke' }]],
  })
})

test('parseWhen rejects everything outside the grammar', () => {
  for (const text of [
    '',
    '   ',
    'message.hasVideo',
    'message',
    'channel.kind',
    'Channel.kind == "group"',
    '(message.hasMedia)',
    '(message.hasMedia || event.poke)',
    'message.hasMedia()',
    'constructor',
    '__proto__',
    'channel.kind == \'group\'',
    'channel.kind == group',
    'channel.kind == "Group"',
    'channel.kind = "group"',
    'channel.kind == "gro up"',
    'channel.kind == ""',
    'message.hasMedia &&',
    '|| message.hasMedia',
    'message.hasMedia && && event.poke',
    'message.hasMedia message.hasForward',
    'message.hasMedia && (event.poke)',
    'message.hasMedia & event.poke',
    'message.hasMedia | event.poke',
    'message.hasMedia, event.poke',
    'message.hasMedia; event.poke',
    'message.hasMedia==',
    'channel.kind == "group" extra',
  ]) {
    invalidArgument(() => parseWhen(text))
  }
})

test('evalWhen is true when any group matches and all of its atoms match', () => {
  const expr = parseWhen('message.hasMedia && event.poke || channel.kind == "group"')
  assert.equal(evalWhen(expr, features()), false)
  assert.equal(evalWhen(expr, features({ hasMedia: true })), false)
  assert.equal(evalWhen(expr, features({ poke: true })), false)
  assert.equal(evalWhen(expr, features({ hasMedia: true, poke: true })), true)
  assert.equal(evalWhen(expr, features({ kind: 'group' })), true)
  assert.equal(evalWhen(expr, features({ kind: 'private', hasMedia: true, poke: true })), true)
})

test('evalWhen truth table for each atom', () => {
  const atoms: Array<[string, WakeFeatures, WakeFeatures]> = [
    ['message.hasMedia', features({ hasMedia: true }), features()],
    ['message.hasForward', features({ hasForward: true }), features()],
    ['event.poke', features({ poke: true }), features()],
    ['channel.kind == "group"', features({ kind: 'group' }), features({ kind: 'private' })],
  ]
  for (const [text, yes, no] of atoms) {
    const expr: WhenExpr = parseWhen(text)
    assert.equal(evalWhen(expr, yes), true, text)
    assert.equal(evalWhen(expr, no), false, text)
  }
})

test('evalWhen combines || and && independently of atom order', () => {
  const expr = parseWhen('message.hasMedia || message.hasForward && event.poke')
  assert.equal(evalWhen(expr, features({ hasMedia: false, hasForward: true, poke: false })), false)
  assert.equal(evalWhen(expr, features({ hasMedia: false, hasForward: true, poke: true })), true)
  assert.equal(evalWhen(expr, features({ hasMedia: true, hasForward: false, poke: false })), true)
})

test('parseWhen needs == after channel.kind', () => {
  invalidArgument(() => parseWhen('channel.kind && "group"'))
})
