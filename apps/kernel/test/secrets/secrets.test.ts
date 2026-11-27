import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BrainError } from '@dsh-brain-core/sdk'
import { isHardened } from '@dsh-brain-core/shared'
import { createSecretStore } from '../../src/secrets/index.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'brain-secrets-'))
}

async function expectBrainError(token: string, operation: Promise<unknown>, code: string, forbidden: string): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof BrainError, `${token}: expected BrainError`)
    assert.equal(error.code, code)
    assert.equal(error.message.includes(forbidden), false, `${token}: message leaks the value`)
    assert.equal(JSON.stringify(error.details).includes(forbidden), false, `${token}: details leak the value`)
    return true
  })
}

test('secrets can be set, read, listed, deleted and survive a reopen', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'secrets.json')
    const store = createSecretStore({ file })
    assert.equal(await store.get('missing'), undefined)
    assert.deepEqual(await store.names(), [])

    await store.set('zeta', 'last')
    await store.set('alpha', 'first')
    assert.equal(await store.get('alpha'), 'first')
    assert.deepEqual(await store.names(), ['alpha', 'zeta'])

    assert.equal(await store.delete('alpha'), true)
    assert.equal(await store.delete('alpha'), false)
    assert.deepEqual(await store.names(), ['zeta'])

    const reopened = createSecretStore({ file })
    assert.equal(await reopened.get('zeta'), 'last')
    assert.deepEqual(await reopened.names(), ['zeta'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the secrets file uses the documented format and is private', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'secrets.json')
    await createSecretStore({ file }).set('token', 'value')
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, secrets: { token: 'value' } })
    if (process.platform === 'win32') {
      assert.equal(isHardened(file), true)
    } else {
      assert.equal((await stat(file)).mode & 0o777, 0o600)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('invalid names and values are rejected without leaking the value', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'secrets.json')
    const store = createSecretStore({ file })
    const secret = 'super-secret-value-123'
    for (const name of ['1abc', 'UPPER', 'has space', 'a'.repeat(65)]) {
      await expectBrainError(name, store.set(name, secret), 'INVALID_ARGUMENT', secret)
    }
    await expectBrainError('empty', store.set('empty', ''), 'INVALID_ARGUMENT', secret)
    const longValue = 'x'.repeat(4097)
    await expectBrainError('long', store.set('long', longValue), 'INVALID_ARGUMENT', longValue)
    await expectBrainError('read', store.get('1abc'), 'INVALID_ARGUMENT', secret)
    await expectBrainError('delete', store.delete('1abc'), 'INVALID_ARGUMENT', secret)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unreadable file is reported as INTERNAL', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'secrets.json')
    await writeFile(file, 'not json')
    const store = createSecretStore({ file })
    await assert.rejects(store.names(), (error: unknown) => {
      assert.ok(error instanceof BrainError)
      assert.equal(error.code, 'INTERNAL')
      assert.equal(error.message, 'secret store is unreadable')
      return true
    })
    await writeFile(file, JSON.stringify({ version: 2, secrets: {} }))
    await assert.rejects(store.get('token'), /secret store is unreadable/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
