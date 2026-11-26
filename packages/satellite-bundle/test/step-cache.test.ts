import assert from 'node:assert/strict'
import test from 'node:test'
import { stepCache } from '../src/step-cache.ts'

test('one load per step key, however many tools ask', async () => {
  let loads = 0
  const lookup = stepCache(async () => ++loads)
  const stepOne = {}
  const stepTwo = {}
  assert.deepEqual(await Promise.all([lookup(stepOne), lookup(stepOne), lookup(stepOne)]), [1, 1, 1])
  assert.equal(await lookup(stepTwo), 2)
  assert.equal(await lookup(stepOne), 1)
})

test('the load gets the arguments of the call that started it', async () => {
  const seen: string[] = []
  const lookup = stepCache(async (_stepKey: object, label: string) => { seen.push(label); return label })
  const stepOne = {}
  const stepTwo = {}
  assert.equal(await lookup(stepOne, 'first'), 'first')
  assert.equal(await lookup(stepOne, 'later'), 'first')
  assert.equal(await lookup(stepTwo, 'second'), 'second')
  assert.deepEqual(seen, ['first', 'second'])
})

test('a failed load fails every tool in that step', async () => {
  const lookup = stepCache(async () => { throw new Error('kernel unreachable') })
  const step = {}
  await assert.rejects(lookup(step), /kernel unreachable/)
  await assert.rejects(lookup(step), /kernel unreachable/)
})
