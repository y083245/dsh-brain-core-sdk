import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { purgeSessions } from '../src/index.ts'
import { removeTree } from '../src/platform.ts'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

function locked(code: string): Error {
  return Object.assign(new Error(code), { code })
}

async function brainHome(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-purge-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }))
  return dir
}

async function session(home: string, cwd: string, id: string, attachments: readonly string[], extra: readonly string[] = []): Promise<string> {
  const dir = path.join(home, 'state', 'satellite', 'dsh-home', 'sessions', cwd, id)
  await mkdir(dir, { recursive: true })
  const lines = attachments.map(hash => JSON.stringify({ type: 'message', content: { attachmentId: `sha256:${hash}` } }))
  await writeFile(path.join(dir, 'session.v4.jsonl'), lines.join('\n'))
  for (const name of extra) await writeFile(path.join(dir, name), 'held')
  return dir
}

async function attachment(home: string, hash: string): Promise<string> {
  const file = path.join(home, 'state', 'satellite', 'dsh-home', 'attachments', 'v1', 'objects', hash.slice(0, 2), hash)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, 'image')
  return file
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

const sessionFile = (dir: string): string => path.join(dir, 'session.v4.jsonl')

test('it deletes the named sessions and only the attachments nobody else uses', async t => {
  const home = await brainHome(t)
  const first = await session(home, 'cwd-a', 's1', [A, B])
  const second = await session(home, 'cwd-b', 's2', [B])
  const onlyFirst = await attachment(home, A)
  const shared = await attachment(home, B)

  assert.deepEqual(await purgeSessions(home, ['s1']), [])
  assert.equal(await exists(first), false)
  assert.equal(await exists(second), true)
  assert.equal(await exists(onlyFirst), false)
  assert.equal(await exists(shared), true)
})

test('an EACCES while removing the session directory itself is thrown', async t => {
  const home = await brainHome(t)
  const dir = await session(home, 'cwd-a', 's1', [])
  const remove = async (target: string): Promise<void> => {
    if (path.resolve(target) === path.resolve(dir)) throw locked('EACCES')
    await removeTree(target)
  }

  await assert.rejects(() => purgeSessions(home, ['s1'], { remove }), /EACCES/)
  assert.equal(await exists(sessionFile(dir)), true)
})

test('a held sibling keeps the session file and its attachments, and a retry finishes the job', async t => {
  const home = await brainHome(t)
  const dir = await session(home, 'cwd-a', 's1', [A], ['workspace.txt'])
  const image = await attachment(home, A)
  const remove = async (target: string): Promise<void> => {
    if (path.basename(target) === 'workspace.txt') throw locked('EBUSY')
    await removeTree(target)
  }

  assert.deepEqual(await purgeSessions(home, ['s1'], { remove }), ['s1'])
  assert.equal(await exists(sessionFile(dir)), true)
  assert.equal(await exists(path.join(dir, 'workspace.txt')), true)
  assert.equal(await exists(image), true)

  assert.deepEqual(await purgeSessions(home, ['s1']), [])
  assert.equal(await exists(dir), false)
  assert.equal(await exists(image), false)
})

test('when only the final directory removal is held, the attachments are already gone and a retry finishes', async t => {
  const home = await brainHome(t)
  const dir = await session(home, 'cwd-a', 's1', [A])
  const image = await attachment(home, A)
  const remove = async (target: string): Promise<void> => {
    if (path.resolve(target) === path.resolve(dir)) throw locked('EBUSY')
    await removeTree(target)
  }

  assert.deepEqual(await purgeSessions(home, ['s1'], { remove }), ['s1'])
  assert.equal(await exists(sessionFile(dir)), true)
  assert.equal(await exists(image), false)

  assert.deepEqual(await purgeSessions(home, ['s1']), [])
  assert.equal(await exists(dir), false)
})

test('a held attachment unlink is returned without throwing, and a retry finishes', async t => {
  const home = await brainHome(t)
  const dir = await session(home, 'cwd-a', 's1', [A])
  const image = await attachment(home, A)
  const unlink = async (): Promise<void> => { throw locked('EBUSY') }

  assert.deepEqual(await purgeSessions(home, ['s1'], { unlink }), ['s1'])
  assert.equal(await exists(sessionFile(dir)), true)
  assert.equal(await exists(image), true)

  assert.deepEqual(await purgeSessions(home, ['s1']), [])
  assert.equal(await exists(dir), false)
  assert.equal(await exists(image), false)
})

test('an attachment shared by two deleted sessions is deleted', async t => {
  const home = await brainHome(t)
  await session(home, 'cwd-a', 's1', [A])
  await session(home, 'cwd-b', 's2', [A])
  const image = await attachment(home, A)

  assert.deepEqual(await purgeSessions(home, ['s1', 's2']), [])
  assert.equal(await exists(image), false)
})

test('an attachment shared with a session locked in phase one is kept', async t => {
  const home = await brainHome(t)
  const first = await session(home, 'cwd-a', 's1', [B])
  const second = await session(home, 'cwd-b', 's2', [B], ['hold'])
  const image = await attachment(home, B)
  const remove = async (target: string): Promise<void> => {
    if (path.basename(target) === 'hold') throw locked('EBUSY')
    await removeTree(target)
  }

  assert.deepEqual(await purgeSessions(home, ['s1', 's2'], { remove }), ['s2'])
  assert.equal(await exists(first), false)
  assert.equal(await exists(sessionFile(second)), true)
  assert.equal(await exists(image), true)
})

test('only sessions one level below the cwd directory are touched', async t => {
  const home = await brainHome(t)
  const root = path.join(home, 'state', 'satellite', 'dsh-home', 'sessions')
  const shallow = path.join(root, 's1')
  const deep = path.join(root, 'x', 'other', 's1')
  await mkdir(shallow, { recursive: true })
  await mkdir(deep, { recursive: true })
  await writeFile(sessionFile(shallow), '')
  await writeFile(sessionFile(deep), '')

  assert.deepEqual(await purgeSessions(home, ['s1']), [])
  assert.equal(await exists(sessionFile(shallow)), true)
  assert.equal(await exists(sessionFile(deep)), true)
})

test('one held copy keeps the id, both session files and both attachments', async t => {
  const home = await brainHome(t)
  const first = await session(home, 'cwd-a', 'same', [A])
  const second = await session(home, 'cwd-b', 'same', [B], ['hold'])
  const firstImage = await attachment(home, A)
  const secondImage = await attachment(home, B)
  const remove = async (target: string): Promise<void> => {
    if (path.basename(target) === 'hold') throw locked('EBUSY')
    await removeTree(target)
  }

  assert.deepEqual(await purgeSessions(home, ['same'], { remove }), ['same'])
  assert.equal(await exists(sessionFile(first)), true)
  assert.equal(await exists(sessionFile(second)), true)
  assert.equal(await exists(firstImage), true)
  assert.equal(await exists(secondImage), true)

  assert.deepEqual(await purgeSessions(home, ['same']), [])
  assert.equal(await exists(first), false)
  assert.equal(await exists(second), false)
  assert.equal(await exists(firstImage), false)
  assert.equal(await exists(secondImage), false)
})

for (const code of ['EPERM', 'ENOTEMPTY']) {
  test(`a ${code} while removing a sibling is treated as locked`, async t => {
    const home = await brainHome(t)
    const dir = await session(home, 'cwd-a', 's1', [C], ['hold'])
    const image = await attachment(home, C)
    const remove = async (target: string): Promise<void> => {
      if (path.basename(target) === 'hold') throw locked(code)
      await removeTree(target)
    }

    assert.deepEqual(await purgeSessions(home, ['s1'], { remove }), ['s1'])
    assert.equal(await exists(sessionFile(dir)), true)
    assert.equal(await exists(image), true)
  })
}

test('a locked id is returned once even when it was requested twice', async t => {
  const home = await brainHome(t)
  await session(home, 'cwd-a', 's1', [A], ['hold'])
  const remove = async (target: string): Promise<void> => {
    if (path.basename(target) === 'hold') throw locked('EBUSY')
    await removeTree(target)
  }
  assert.deepEqual(await purgeSessions(home, ['s1', 's1'], { remove }), ['s1'])
})

test('errors other than the three lock codes are thrown', async t => {
  const home = await brainHome(t)
  await session(home, 'cwd-a', 's1', [], ['hold'])
  const remove = async (): Promise<void> => { throw locked('EACCES') }
  await assert.rejects(() => purgeSessions(home, ['s1'], { remove }), /EACCES/)
})

test('an attachment file that is already gone is not an error', async t => {
  const home = await brainHome(t)
  await session(home, 'cwd-a', 's1', [A])
  assert.deepEqual(await purgeSessions(home, ['s1']), [])
})

test('an id that is not on disk counts as deleted', async t => {
  const home = await brainHome(t)
  const kept = await session(home, 'cwd-a', 's2', [A])
  assert.deepEqual(await purgeSessions(home, ['missing']), [])
  assert.equal(await exists(kept), true)
})

test('the remaining session file is readable after another one is deleted', async t => {
  const home = await brainHome(t)
  await session(home, 'cwd-a', 's1', [])
  const kept = await session(home, 'cwd-a', 's2', [])
  await purgeSessions(home, ['s1'])
  assert.equal(await readFile(sessionFile(kept), 'utf8'), '')
})
