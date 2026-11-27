import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BrainError } from '@dsh-brain-core/sdk'
import { FakeClock } from '../fakes/index.ts'
import {
  ACCOUNT_PATTERN, SELF, createIdentityService, type IdentityService,
} from '../../src/identity-persona/index.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'brain-identity-'))
}

async function open(dir: string): Promise<IdentityService> {
  return createIdentityService({ path: path.join(dir, 'identity.json'), clock: new FakeClock() })
}

async function expectCode(token: string, operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof BrainError, `${token}: expected BrainError`)
    assert.equal(error.code, code, `${token}: wrong error code`)
    return true
  })
}

test('resolve creates one p_ person per new account and rejects malformed accounts', async () => {
  const dir = await tempDir()
  try {
    const identity = await open(dir)
    const person = await identity.resolve('qq:10001')
    assert.match(person, /^p_[0-9A-HJKMNP-TV-Z]{26}$/)
    assert.equal(await identity.resolve('qq:10001'), person)
    assert.deepEqual(await identity.accountsOf(person), ['qq:10001'])

    const malformed = ['qq', 'qq:group:1', 'QQ:1', 'qq:1 2', ' qq:1', 'qq:', '', 'qq\t:1']
    for (const account of malformed) {
      await expectCode(account, identity.resolve(account), 'INVALID_ARGUMENT')
    }
    assert.equal(ACCOUNT_PATTERN.test('douyin:u42'), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('merge moves accounts and leaves every old id resolving to the canonical person', async () => {
  const dir = await tempDir()
  try {
    const identity = await open(dir)
    const first = await identity.resolve('qq:10001')
    const second = await identity.resolve('qq:10002')
    assert.notEqual(first, second)

    await identity.merge(first, second)
    assert.equal(await identity.resolve('qq:10001'), second)
    assert.equal(await identity.resolve('qq:10002'), second)
    assert.deepEqual(await identity.accountsOf(second), ['qq:10001', 'qq:10002'])
    assert.deepEqual(await identity.idsOf(second), [first, second].sort())
    assert.equal(await identity.canonical(first), second)
    // A merged-away id is accepted everywhere and answers for the person it became.
    assert.deepEqual(await identity.accountsOf(first), ['qq:10001', 'qq:10002'])
    assert.deepEqual(await identity.idsOf(first), [first, second].sort())

    const third = await identity.resolve('qq:10003')
    await identity.merge(second, third)
    assert.deepEqual(await identity.idsOf(third), [first, second, third].sort())
    assert.equal(await identity.canonical(first), third)
    assert.equal(await identity.resolve('qq:10001'), third)

    // Merging towards the same canonical person is a no-op.
    await identity.merge(second, third)
    assert.deepEqual(await identity.idsOf(third), [first, second, third].sort())

    // Linking an account to a merged-away id binds it to the canonical person.
    await identity.link('qq:10004', first)
    assert.equal(await identity.resolve('qq:10004'), third)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot is a frozen copy that tolerates unknown ids', async () => {
  const dir = await tempDir()
  try {
    const identity = await open(dir)
    const first = await identity.resolve('qq:1')
    const second = await identity.resolve('qq:2')
    const before = await identity.snapshot()

    await identity.merge(first, second)

    // The old snapshot still shows the world as it was.
    assert.equal(before.canonical(first), first)
    assert.deepEqual(before.idsOf(second), [second])

    const after = await identity.snapshot()
    assert.equal(after.canonical(first), await identity.canonical(first))
    assert.equal(after.canonical(first), second)
    assert.deepEqual(after.idsOf(first), await identity.idsOf(first))
    assert.deepEqual(after.idsOf('p_unknown'), ['p_unknown'])
    assert.equal(after.canonical('p_unknown'), 'p_unknown')
    assert.equal(after.canonical(SELF), SELF)
    assert.deepEqual(after.idsOf(SELF), [SELF])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('split gives the moved accounts their own person and rejects bad input', async () => {
  const dir = await tempDir()
  try {
    const identity = await open(dir)
    const first = await identity.resolve('qq:1')
    const second = await identity.resolve('qq:2')
    await identity.merge(second, first)

    const splitOff = await identity.split(first, ['qq:2'])
    assert.notEqual(splitOff, first)
    assert.equal(await identity.resolve('qq:1'), first)
    assert.equal(await identity.resolve('qq:2'), splitOff)
    assert.deepEqual(await identity.accountsOf(first), ['qq:1'])
    assert.deepEqual(await identity.accountsOf(splitOff), ['qq:2'])

    await expectCode('empty', identity.split(first, []), 'INVALID_ARGUMENT')
    await expectCode('not-owner', identity.split(first, ['qq:2']), 'INVALID_ARGUMENT')
    await expectCode('unknown-account', identity.split(first, ['qq:unknown']), 'INVALID_ARGUMENT')
    await expectCode('mixed', identity.split(first, ['qq:1', 'qq:2']), 'INVALID_ARGUMENT')
    await expectCode('unknown-person', identity.split('p_missing', ['qq:1']), 'NOT_FOUND')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('self cannot be merged or split but accounts can be linked to it', async () => {
  const dir = await tempDir()
  try {
    const identity = await open(dir)
    const person = await identity.resolve('qq:1')

    await identity.link('qq:self', SELF)
    assert.equal(await identity.resolve('qq:self'), SELF)
    assert.deepEqual(await identity.accountsOf(SELF), ['qq:self'])
    assert.equal(await identity.canonical(SELF), SELF)
    assert.deepEqual(await identity.idsOf(SELF), [SELF])

    await expectCode('merge-from-self', identity.merge(SELF, person), 'INVALID_ARGUMENT')
    await expectCode('merge-into-self', identity.merge(person, SELF), 'INVALID_ARGUMENT')
    await expectCode('split-self', identity.split(SELF, ['qq:self']), 'INVALID_ARGUMENT')
    // self keeps working after the rejected calls.
    assert.equal(await identity.canonical(SELF), SELF)
    assert.deepEqual(await identity.accountsOf(SELF), ['qq:self'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('link binds existing accounts and reports conflicts and missing people', async () => {
  const dir = await tempDir()
  try {
    const identity = await open(dir)
    const first = await identity.resolve('qq:1')
    const second = await identity.resolve('qq:2')

    await identity.link('qq:3', first)
    assert.equal(await identity.resolve('qq:3'), first)
    await identity.link('qq:3', first)
    assert.deepEqual(await identity.accountsOf(first), ['qq:1', 'qq:3'])

    await expectCode('conflict', identity.link('qq:3', second), 'CONFLICT')
    await expectCode('missing', identity.link('qq:4', 'p_missing'), 'NOT_FOUND')
    await expectCode('bad-account', identity.link('qq', first), 'INVALID_ARGUMENT')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the identity file survives a reopen, uses the documented format and stays private', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'identity.json')
    const first = await open(dir)
    const a = await first.resolve('qq:1')
    const b = await first.resolve('qq:2')
    await first.merge(a, b)
    await first.link('qq:3', a)
    await first.link('qq:self', SELF)

    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    assert.deepEqual(raw, {
      version: 1,
      accounts: { 'qq:1': b, 'qq:2': b, 'qq:3': b, 'qq:self': SELF },
      persons: { [a]: { mergedInto: b }, [b]: {} },
    })
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600)
    }

    const second = await open(dir)
    assert.equal(await second.resolve('qq:1'), b)
    assert.equal(await second.resolve('qq:3'), b)
    assert.equal(await second.resolve('qq:self'), SELF)
    assert.equal(await second.canonical(a), b)
    assert.deepEqual(await second.idsOf(b), [a, b].sort())
    assert.deepEqual(await second.accountsOf(b), ['qq:1', 'qq:2', 'qq:3'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unreadable file reports UNAVAILABLE and is left untouched', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'identity.json')
    for (const contents of ['not json', '{"version":2}', '{"version":1,"accounts":{},"persons":[]}', '{"version":1,"accounts":{"qq:1":"p_missing"},"persons":{}}', '{"version":1,"accounts":{},"persons":{"p_x":{"mergedInto":"self"}}}']) {
      await writeFile(file, contents)
      await expectCode(contents, createIdentityService({ path: file, clock: new FakeClock() }), 'UNAVAILABLE')
      assert.equal(await readFile(file, 'utf8'), contents)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent resolves of the same new account create a single person', async () => {
  const dir = await tempDir()
  try {
    const identity = await open(dir)
    const people = await Promise.all(Array.from({ length: 10 }, () => identity.resolve('qq:999')))
    assert.equal(new Set(people).size, 1)
    assert.deepEqual(await identity.accountsOf(people[0] as string), ['qq:999'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
