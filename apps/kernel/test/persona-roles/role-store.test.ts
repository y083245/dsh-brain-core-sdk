import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRoleStore, type RoleStore } from '../../src/persona-roles/role-store.ts'

function hashTree(dir: string): string {
  const digest = crypto.createHash('sha256')
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current).sort()) {
      const full = path.join(current, entry)
      digest.update(path.relative(dir, full) + '\0')
      if (fs.statSync(full).isDirectory()) visit(full)
      else digest.update(fs.readFileSync(full))
    }
  }
  if (fs.existsSync(dir)) visit(dir)
  return digest.digest('hex')
}

function makeSandbox(
  factoryCards: Record<string, string> = { 甲: '# 甲\n出厂甲\n', 乙: '# 乙\n出厂乙\n', README: '说明\n' },
  log?: (msg: string) => void,
): {
  readonly root: string
  readonly stateDir: string
  readonly store: RoleStore
  readonly factoryChecksum: () => string
  readonly cleanup: () => void
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-role-store-'))
  fs.mkdirSync(path.join(root, 'roles'), { recursive: true })
  for (const [name, content] of Object.entries(factoryCards)) {
    fs.writeFileSync(path.join(root, 'roles', `${name}.md`), content, 'utf8')
  }
  const stateDir = path.join(root, 'state')
  const store = createRoleStore({ root, stateDir, ...(log ? { log } : {}) })
  return {
    root,
    stateDir,
    store,
    factoryChecksum: () => hashTree(path.join(root, 'roles')),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

test('list filters non-md, directories, and README.md and sorts with zh-CN locale', () => {
  const sb = makeSandbox({ 乙: 'b\n', 甲: 'a\n', alpha: 'x\n', README: 'ignore\n' })
  try {
    fs.writeFileSync(path.join(sb.root, 'roles', 'notes.txt'), 'ignore')
    fs.mkdirSync(path.join(sb.root, 'roles', 'nested'))
    fs.mkdirSync(path.join(sb.root, 'roles', 'dir.md'))
    const expected = ['alpha', '甲', '乙'].sort((a, b) => a.localeCompare(b, 'zh-CN'))
    assert.deepEqual(sb.store.list(), expected)
    assert.equal(sb.store.exists('README'), false)
    assert.equal(sb.store.exists('notes'), false)
    assert.equal(sb.store.exists('dir'), false)
    assert.equal(fs.existsSync(sb.stateDir), false, 'read-only calls must not create stateDir')
  } finally {
    sb.cleanup()
  }
})

test('missing factory roles directory returns empty list and negative lookups', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-role-empty-'))
  try {
    const store = createRoleStore({ root, stateDir: path.join(root, 'state') })
    assert.deepEqual(store.list(), [])
    assert.equal(store.exists('甲'), false)
    assert.equal(store.origin('甲'), null)
    assert.equal(store.path('甲'), null)
    assert.throws(() => store.read('甲'), /人格「甲」不存在/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('O(1) direct lookups avoid directory scans and skip hidden.json when user card exists', () => {
  const logs: string[] = []
  const sb = makeSandbox({ 甲: 'factory-a\n', 乙: 'factory-b\n' }, (m) => logs.push(m))
  try {
    sb.store.write('甲', 'user-a\n')
    fs.writeFileSync(path.join(sb.stateDir, 'roles', 'hidden.json'), '{corrupted', 'utf8')

    // User card exists -> inspectCard must NOT read hidden.json, so zero warnings logged.
    assert.equal(sb.store.exists('甲'), true)
    assert.equal(sb.store.origin('甲'), 'modified')
    assert.equal(sb.store.read('甲'), 'user-a\n')
    assert.equal(sb.store.path('甲'), path.join(sb.stateDir, 'roles', '甲.md'))
    assert.equal(logs.length, 0)

    if (process.platform !== 'win32') {
      // Remove read bit on factoryDir (execute-only 0o111) so readdirSync fails while statSync succeeds.
      fs.chmodSync(sb.store.factoryDir, 0o111)
      try {
        assert.equal(sb.store.exists('乙'), true)
        assert.equal(sb.store.origin('乙'), 'factory')
        assert.equal(sb.store.read('乙'), 'factory-b\n')
        assert.equal(sb.store.path('乙'), path.join(sb.root, 'roles', '乙.md'))
      } finally {
        fs.chmodSync(sb.store.factoryDir, 0o755)
      }
    }
  } finally {
    sb.cleanup()
  }
})

test('origins (factory, user, modified) and write precedence preserve factory directory', () => {
  const sb = makeSandbox()
  try {
    const before = sb.factoryChecksum()
    sb.store.write('甲', '用户版甲\n')
    sb.store.write('丙', '自建丙\n')

    assert.equal(sb.store.origin('甲'), 'modified')
    assert.equal(sb.store.origin('乙'), 'factory')
    assert.equal(sb.store.origin('丙'), 'user')
    assert.equal(sb.store.origin('不存在'), null)

    assert.equal(sb.store.read('甲'), '用户版甲\n')
    assert.equal(sb.store.read('乙'), '# 乙\n出厂乙\n')
    assert.equal(sb.store.path('甲'), path.join(sb.stateDir, 'roles', '甲.md'))
    assert.equal(sb.store.path('乙'), path.join(sb.root, 'roles', '乙.md'))
    assert.equal(sb.factoryChecksum(), before)
  } finally {
    sb.cleanup()
  }
})

test('create enforces uniqueness and rejects existing factory or user cards', () => {
  const sb = makeSandbox()
  try {
    assert.throws(() => sb.store.create('甲', 'dup'), /人格「甲」已存在/)
    sb.store.create('新角色', '内容\n')
    assert.equal(sb.store.origin('新角色'), 'user')
    assert.throws(() => sb.store.create('新角色', 'dup'), /人格「新角色」已存在/)
  } finally {
    sb.cleanup()
  }
})

test('remove hides factory cards, deletes user cards, and removes both for modified cards', () => {
  const sb = makeSandbox()
  try {
    const before = sb.factoryChecksum()
    sb.store.remove('乙')
    assert.equal(sb.store.exists('乙'), false)
    assert.equal(sb.store.origin('乙'), null)
    assert.equal(sb.store.path('乙'), null)
    assert.ok(fs.existsSync(path.join(sb.root, 'roles', '乙.md')))
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(sb.stateDir, 'roles', 'hidden.json'), 'utf8')),
      { version: 1, names: ['乙'] },
    )

    sb.store.write('丙', 'user-c\n')
    sb.store.remove('丙')
    assert.equal(sb.store.exists('丙'), false)
    assert.equal(fs.existsSync(path.join(sb.stateDir, 'roles', '丙.md')), false)

    sb.store.write('甲', 'user-a\n')
    sb.store.remove('甲')
    assert.equal(sb.store.exists('甲'), false)
    assert.equal(fs.existsSync(path.join(sb.stateDir, 'roles', '甲.md')), false)
    assert.throws(() => sb.store.remove('甲'), /人格「甲」不存在/)
    assert.equal(sb.factoryChecksum(), before)
  } finally {
    sb.cleanup()
  }
})

test('hidden.json removes itself when empty and deduplicates corrupted JSON warnings', () => {
  const logs: string[] = []
  const sb = makeSandbox({ 甲: 'a\n', 乙: 'b\n' }, (msg) => logs.push(msg))
  try {
    const hiddenPath = path.join(sb.stateDir, 'roles', 'hidden.json')
    sb.store.remove('乙')
    assert.equal(fs.existsSync(hiddenPath), true)
    assert.equal(sb.store.exists('乙'), false)

    // Writing back the only hidden card deletes hidden.json completely.
    sb.store.write('乙', 'restored\n')
    assert.equal(fs.existsSync(hiddenPath), false)
    assert.equal(sb.store.origin('乙'), 'modified')

    // Corrupted hidden.json emits a single deduplicated warning and acts as empty set.
    fs.writeFileSync(hiddenPath, '{broken-json', 'utf8')
    assert.deepEqual(sb.store.list(), ['甲', '乙'].sort((a, b) => a.localeCompare(b, 'zh-CN')))
    assert.equal(sb.store.exists('甲'), true)
    sb.store.list()
    assert.equal(logs.length, 1)
  } finally {
    sb.cleanup()
  }
})

test('rename handles factory, user, and modified cards and guards invalid/conflicting targets', () => {
  const sb = makeSandbox()
  try {
    const before = sb.factoryChecksum()

    sb.store.rename('甲', '新甲')
    assert.equal(sb.store.origin('新甲'), 'user')
    assert.equal(sb.store.read('新甲'), '# 甲\n出厂甲\n')
    assert.equal(sb.store.exists('甲'), false)

    sb.store.rename('新甲', '终甲')
    assert.equal(sb.store.exists('新甲'), false)
    assert.equal(fs.existsSync(path.join(sb.stateDir, 'roles', '新甲.md')), false)
    assert.equal(sb.store.read('终甲'), '# 甲\n出厂甲\n')

    sb.store.write('乙', '改乙\n')
    sb.store.rename('乙', '新乙')
    assert.equal(sb.store.read('新乙'), '改乙\n')
    assert.equal(sb.store.exists('乙'), false)
    assert.equal(fs.existsSync(path.join(sb.stateDir, 'roles', '乙.md')), false)

    assert.throws(() => sb.store.rename('没有', '甲'), /人格「没有」不存在/)
    assert.throws(() => sb.store.rename('终甲', '新乙'), /人格「新乙」已存在/)
    assert.throws(() => sb.store.rename('终甲', '../bad'), /人格名不合法/)
    assert.equal(sb.factoryChecksum(), before)
  } finally {
    sb.cleanup()
  }
})

test('reset only reverts modified factory cards and throws for factory, user, or missing cards', () => {
  const sb = makeSandbox()
  try {
    sb.store.write('甲', 'modified\n')
    assert.equal(sb.store.origin('甲'), 'modified')
    sb.store.reset('甲')
    assert.equal(sb.store.origin('甲'), 'factory')
    assert.equal(sb.store.read('甲'), '# 甲\n出厂甲\n')

    assert.throws(() => sb.store.reset('甲'), /不是「已修改」/)
    sb.store.write('自建', 'user-only\n')
    assert.throws(() => sb.store.reset('自建'), /不是「已修改」/)
    assert.throws(() => sb.store.reset('缺失'), /不是「已修改」/)
  } finally {
    sb.cleanup()
  }
})

test('permissions are private on POSIX and failed atomic writes clean up .tmp files', () => {
  const sb = makeSandbox()
  try {
    sb.store.write('甲', 'x\n')
    sb.store.remove('乙')
    const userDir = path.join(sb.stateDir, 'roles')
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(userDir).mode & 0o777, 0o700)
      assert.equal(fs.statSync(path.join(userDir, '甲.md')).mode & 0o777, 0o600)
      assert.equal(fs.statSync(path.join(userDir, 'hidden.json')).mode & 0o777, 0o600)
    }

    // Force renameSync failure by creating a directory where the target .md file would be placed.
    const blockerDir = path.join(userDir, '冲突.md')
    fs.mkdirSync(blockerDir)
    assert.throws(() => sb.store.write('冲突', 'payload'))
    const leftovers = fs.readdirSync(userDir).filter((f) => f.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    sb.cleanup()
  }
})

test('invalid and path-traversal names are rejected across read and write operations', () => {
  const sb = makeSandbox()
  try {
    const outside = path.join(sb.root, 'outside.md')
    fs.writeFileSync(outside, 'keep', 'utf8')
    fs.mkdirSync(path.join(sb.stateDir, 'roles'), { recursive: true })
    fs.writeFileSync(path.join(sb.stateDir, 'roles', 'README.md'), 'ignore', 'utf8')

    for (const bad of ['', '.', '..', 'README', '../outside', 'a/b', 'a\\b', 'x\0y']) {
      assert.equal(sb.store.exists(bad), false, bad)
      assert.equal(sb.store.origin(bad), null, bad)
      assert.equal(sb.store.path(bad), null, bad)
      assert.throws(() => sb.store.read(bad), /不存在/, bad)
      assert.throws(() => sb.store.write(bad, 'x'), /人格名不合法/, bad)
      assert.throws(() => sb.store.create(bad, 'x'), /人格名不合法/, bad)
    }
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep')
  } finally {
    sb.cleanup()
  }
})
