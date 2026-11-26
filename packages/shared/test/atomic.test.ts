import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { writeFileAtomic } from '../src/atomic.ts'
import { isHardened } from '../src/state-acl.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'brain-atomic-'))
}

test('writeFileAtomic writes the file and leaves it private', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'secrets.json')
    await writeFileAtomic(file, '{"ok":true}')
    assert.equal(await readFile(file, 'utf8'), '{"ok":true}')
    if (process.platform === 'win32') {
      assert.equal(isHardened(file), true)
    } else {
      assert.equal((await stat(file)).mode & 0o777, 0o600)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeFileAtomic replaces an existing file', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'state.json')
    await writeFile(file, 'old')
    await writeFileAtomic(file, 'new')
    assert.equal(await readFile(file, 'utf8'), 'new')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failing rename keeps the old file and removes the temporary one', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'state.json')
    await writeFile(file, 'old')
    await assert.rejects(
      writeFileAtomic(file, 'new', { rename: async () => { throw new Error('crash mid-write') } }),
      /crash mid-write/,
    )
    assert.equal(await readFile(file, 'utf8'), 'old')
    assert.deepEqual(await readdir(dir), ['state.json'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
