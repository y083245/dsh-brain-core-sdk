import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BrainError } from '@dsh-brain-core/sdk'
import { createPluginLogger } from '../../src/plugin-runtime/plugin-logger.ts'
import { createPluginStorage } from '../../src/plugin-runtime/index.ts'

async function temp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'plugin-storage-'))
}
const refused = (e: unknown): boolean => e instanceof BrainError && e.code === 'PERMISSION_DENIED'

test('storage: write, read, list and remove work; a missing file reads as undefined', async () => {
  const dir = path.join(await temp(), 'qq')
  const storage = createPluginStorage(dir)
  assert.equal(await storage.read('a.txt'), undefined)
  await storage.write('a.txt', 'hello')
  await storage.write('sub/deep/b.bin', new Uint8Array([1, 2, 3]))
  assert.equal(new TextDecoder().decode(await storage.read('a.txt')), 'hello')
  assert.deepEqual([...(await storage.read('sub/deep/b.bin'))!], [1, 2, 3])
  assert.deepEqual(await storage.list(), ['a.txt', 'sub/deep/b.bin'])
  assert.deepEqual(await storage.list('sub'), ['sub/deep/b.bin'])
  await storage.remove('a.txt')
  assert.equal(await storage.read('a.txt'), undefined)
  await storage.remove('a.txt')
})

test('storage: .. and absolute paths are refused everywhere', async () => {
  const dir = path.join(await temp(), 'qq')
  const storage = createPluginStorage(dir)
  for (const bad of ['../x', 'a/../../x', '..', '/etc/passwd', '..\\x', 'C:\\x', 'a/..']) {
    await assert.rejects(storage.write(bad, 'x'), refused, bad)
    await assert.rejects(storage.read(bad), refused, bad)
    await assert.rejects(storage.remove(bad), refused, bad)
  }
  await assert.rejects(storage.list('../'), refused)
})

test('storage: a symlink leading outside is refused', async (t) => {
  const base = await temp()
  const dir = path.join(base, 'qq')
  const outside = path.join(base, 'outside')
  await mkdir(dir, { recursive: true })
  await mkdir(outside)
  await writeFile(path.join(outside, 'secret.txt'), 'top secret')
  try {
    await symlink(outside, path.join(dir, 'link'), 'dir')
  } catch (error) {
    if (process.platform === 'win32') { t.skip('creating a symlink needs a privilege Windows runners may lack'); return }
    throw error
  }
  const storage = createPluginStorage(dir)
  await assert.rejects(storage.write('link/new.txt', 'x'), refused)
  await assert.rejects(storage.write('link/deeper/new.txt', 'x'), refused)
  await assert.rejects(storage.read('link/secret.txt'), refused)
  await assert.rejects(storage.remove('link/secret.txt'), refused)
  assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'top secret')
})

function logger(dir: string, secrets: string[] = []) {
  return createPluginLogger({ dir, now: () => 42, secrets: () => secrets })
}
/** Polls every 10 ms until plugin.log holds `expected` parseable lines; gives up after 2 s. */
async function lines(dir: string, expected = 1): Promise<Record<string, unknown>[]> {
  const started = Date.now()
  let seen = 0
  for (;;) {
    try {
      const text = (await readFile(path.join(dir, 'plugin.log'), 'utf8')).trim()
      const rows = text === '' ? [] : text.split('\n')
      seen = rows.length
      if (rows.length >= expected) return rows.map((l) => JSON.parse(l) as Record<string, unknown>)
    } catch {
      // not there yet, or a half-written line: look again
    }
    if (Date.now() - started > 2000) throw new Error(`plugin.log: waited ${Date.now() - started} ms for ${expected} line(s), read ${seen}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('logger: one JSON line with t, level, event and the allowed fields', async () => {
  const dir = path.join(await temp(), 'qq')
  logger(dir).warn('started', { count: 3, ok: true, name: 'x' })
  assert.deepEqual(await lines(dir), [{ t: 42, level: 'warn', event: 'started', count: 3, ok: true, name: 'x' }])
})

test('logger: content, text, message, body and prompt are dropped whatever the case; objects are dropped', async () => {
  const dir = path.join(await temp(), 'qq')
  logger(dir).info('e', {
    content: 'a', Text: 'b', MESSAGE: 'c', body: 'd', Prompt: 'e', keep: 'k', obj: { a: 1 }, list: [1], nothing: null,
  } as never)
  assert.deepEqual(await lines(dir), [{ t: 42, level: 'info', event: 'e', keep: 'k' }])
})

test('logger: strings are cut to 200 characters and secrets are masked', async () => {
  const dir = path.join(await temp(), 'qq')
  logger(dir, ['supersecretvalue']).error('e', { long: 'x'.repeat(500), leak: 'token=supersecretvalue' })
  const [line] = await lines(dir)
  assert.equal((line!.long as string).length, 200)
  assert.equal(line!.leak, 'token=[redacted]')
})

test('logger: past 1 MiB the file is cleared and restarted', async () => {
  const dir = path.join(await temp(), 'qq')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'plugin.log'), 'x'.repeat(1024 * 1024))
  logger(dir).info('fresh')
  assert.deepEqual(await lines(dir), [{ t: 42, level: 'info', event: 'fresh' }])
})

// ---- review round 1 -------------------------------------------------------------------------------------------------

test('storage: backslash spellings of .. are refused', async () => {
  const storage = createPluginStorage(path.join(await temp(), 'qq'))
  for (const bad of ['a\\..\\..\\x', 'a\\..\\x', '..\\..\\x', 'a/..\\x']) {
    await assert.rejects(storage.write(bad, 'x'), refused, bad)
    await assert.rejects(storage.read(bad), refused, bad)
    await assert.rejects(storage.remove(bad), refused, bad)
    await assert.rejects(storage.list(bad), refused, bad)
  }
})

test('storage: list with a prefix that is a symlink leading outside is refused', async (t) => {
  const base = await temp()
  const dir = path.join(base, 'qq')
  const outside = path.join(base, 'outside')
  await mkdir(dir, { recursive: true })
  await mkdir(outside)
  await writeFile(path.join(outside, 'secret.txt'), 'top secret')
  try {
    await symlink(outside, path.join(dir, 'link'), 'dir')
  } catch (error) {
    if (process.platform === 'win32') { t.skip('creating a symlink needs a privilege Windows runners may lack'); return }
    throw error
  }
  const storage = createPluginStorage(dir)
  await assert.rejects(storage.list('link'), refused)
  assert.deepEqual(await storage.list(), [])
})

test('logger: fields named t, level or event cannot overwrite those three', async () => {
  const dir = path.join(await temp(), 'qq')
  logger(dir).warn('real', { t: 1, level: 'info', event: 'fake', keep: 'k' })
  assert.deepEqual(await lines(dir), [{ t: 42, level: 'warn', event: 'real', keep: 'k' }])
})

test('logger: a secret in the event name is masked too', async () => {
  const dir = path.join(await temp(), 'qq')
  logger(dir, ['supersecretvalue']).info('started supersecretvalue', { n: 1 })
  assert.deepEqual(await lines(dir), [{ t: 42, level: 'info', event: 'started [redacted]', n: 1 }])
})
