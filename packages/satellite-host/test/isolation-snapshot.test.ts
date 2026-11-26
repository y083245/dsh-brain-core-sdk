import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { diffSnapshots, snapshotTree } from '../src/isolation-snapshot.ts'
import { removeTree } from '../src/platform.ts'

test('snapshots detect added, removed and changed files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brain-snap-'))
  t.after(() => removeTree(root))
  await mkdir(path.join(root, 'a'))
  await writeFile(path.join(root, 'a', 'keep.txt'), 'keep')
  await writeFile(path.join(root, 'gone.txt'), 'gone')
  const before = await snapshotTree(root)
  assert.deepEqual(diffSnapshots(before, await snapshotTree(root)), [])

  await writeFile(path.join(root, 'a', 'keep.txt'), 'edit')
  await writeFile(path.join(root, 'new.txt'), 'new')
  await removeTree(path.join(root, 'gone.txt'))
  assert.deepEqual(diffSnapshots(before, await snapshotTree(root)), ['added new.txt', 'changed a/keep.txt', 'removed gone.txt'])
})

test('metadata-only files keep their content unread', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brain-snap-'))
  t.after(() => removeTree(root))
  await writeFile(path.join(root, '.credentials.yaml'), 'secret')
  const [file] = await snapshotTree(root, { metadataOnly: relative => relative === '.credentials.yaml' })
  assert.equal(file?.sha256, undefined)
  assert.equal(file?.size, 6)
  assert.equal(await readFile(path.join(root, '.credentials.yaml'), 'utf8'), 'secret')
})
