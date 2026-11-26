import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createFileProcessedLog, createMemoryProcessedLog } from '../../src/memory-extraction/index.ts'

const FIRST = `l0_${'1'.repeat(26)}`
const SECOND = `l0_${'2'.repeat(26)}`

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'brain-extraction-log-'))
}

test('the in-memory log remembers what it was given', async () => {
  const log = createMemoryProcessedLog()
  assert.equal(log.has(FIRST), false)
  await log.add([FIRST, SECOND])
  assert.equal(log.has(FIRST), true)
  assert.equal(log.has(SECOND), true)
})

test('the file log survives a reopen and keeps only ids', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'processed.log')
    const log = await createFileProcessedLog(file)
    assert.equal(log.has(FIRST), false)

    await log.add([FIRST, SECOND])
    assert.equal(log.has(FIRST), true)
    assert.equal(log.has(SECOND), true)

    const contents = await readFile(file, 'utf8')
    assert.equal(contents, `${FIRST}\n${SECOND}\n`)

    const reopened = await createFileProcessedLog(file)
    assert.equal(reopened.has(FIRST), true)
    assert.equal(reopened.has(SECOND), true)

    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('lines that are not a full L0 id are skipped, including a torn last line', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'processed.log')
    await writeFile(file, `${FIRST}\n${SECOND}\nl0_torn-`, { mode: 0o600 })

    const log = await createFileProcessedLog(file)
    assert.equal(log.has(FIRST), true)
    assert.equal(log.has(SECOND), true)
    assert.equal(log.has('l0_torn-'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an id appended after a torn last line survives a reopen', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'processed.log')
    await writeFile(file, `${FIRST}\nl0_torn-`, { mode: 0o600 })

    const log = await createFileProcessedLog(file)
    await log.add([SECOND])

    assert.equal(await readFile(file, 'utf8'), `${FIRST}\nl0_torn-\n${SECOND}\n`)

    const reopened = await createFileProcessedLog(file)
    assert.equal(reopened.has(FIRST), true)
    assert.equal(reopened.has(SECOND), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
