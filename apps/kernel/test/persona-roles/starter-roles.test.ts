import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { CrossChannelMode } from '../../src/contracts/index.ts'
import { prepareBrainHome } from '../../src/home/index.ts'
import type { Logger } from '../../src/log/index.ts'
import { openMemory, type Memory } from '../../src/memory-api/index.ts'
import { createPersonaService, createRoleStore, renderStable, type ProfileWriter } from '../../src/persona-roles/index.ts'
import { FakeClock, FakeRecordStore } from '../fakes/index.ts'

const STARTER_ROLE_NAMES = [
  '小鲸鱼-松弛搭子',
  '小鲸鱼-傲娇本味',
  '小鲸鱼-温柔陪伴',
  '小鲸鱼-理性参谋',
] as const

const KERNEL_ROLES_DIR = fileURLToPath(new URL('../../roles', import.meta.url))

const FORBIDDEN_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'YAML frontmatter', pattern: /^---/ },
  { label: 'HTML comment', pattern: /<!--/ },
  { label: 'brace placeholder', pattern: /\{[A-Z0-9_]+\}/ },
  { label: 'mustache placeholder', pattern: /\{\{[^}]+\}\}/ },
  { label: '[NO_REPLY]', pattern: /\[NO_REPLY\]/ },
  { label: 'split token |||', pattern: /\|\|\|/ },
  { label: '<voice> tag', pattern: /<voice\b/i },
  { label: '<sticker> tag', pattern: /<sticker\b/i },
  { label: 'QQ coupling', pattern: /QQ号|群号|AstrBot|NapCat|OneBot|Milky|snowluma|qq-bridge/i },
  { label: 'DSH coupling', pattern: /\bDSH\b|dsh-/i },
  { label: 'model vendor lock-in', pattern: /deepseek-|claude-|gpt-/i },
]

const silentLog: Logger = { info() {}, warn() {}, error() {} }

async function sha256File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath)
  return createHash('sha256').update(bytes).digest('hex')
}

async function openTempMemory(
  t: { after(fn: () => Promise<void> | void): void },
): Promise<{ readonly dir: string; readonly stateDir: string; readonly memory: Memory }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-starter-roles-'))
  const paths = await prepareBrainHome({ env: { BRAIN_HOME: dir }, userHome: os.homedir() })
  const memory = await openMemory({
    paths,
    clock: { now: () => Date.now() },
    log: silentLog,
    crossChannelMode: () => 'shadow' as CrossChannelMode,
    ownerChannels: [],
  })
  t.after(async () => {
    await memory.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  })
  return { dir, stateDir: paths.state, memory }
}

test('all 4 Clean-Room starter role cards exist with clean LF prose and no forbidden tokens', async () => {
  for (const name of STARTER_ROLE_NAMES) {
    const filePath = path.join(KERNEL_ROLES_DIR, `${name}.md`)
    assert.equal(existsSync(filePath), true, `missing factory card ${name}`)

    const raw = await readFile(filePath, 'utf8')
    assert.equal(raw.includes('\r'), false, `${name} must use pure LF line endings`)
    assert.equal(raw.endsWith('\n'), true, `${name} must end with a trailing newline`)
    assert.ok(raw.trim().length >= 1000 && raw.trim().length <= 2000, `${name} length out of range: ${raw.trim().length}`)

    for (const { label, pattern } of FORBIDDEN_PATTERNS) {
      assert.equal(pattern.test(raw), false, `${name} must not contain ${label}`)
    }
  }
})

test('openMemory exposes factory starter roles and selectRoleCard commits L3.1 without copying to userDir', async (t) => {
  const { stateDir, memory } = await openTempMemory(t)

  assert.equal(path.resolve(memory.roles.factoryDir), path.resolve(KERNEL_ROLES_DIR))

  const listed = memory.roles.list()
  for (const name of STARTER_ROLE_NAMES) {
    assert.ok(listed.includes(name), `expected ${name} in roles.list()`)
    assert.equal(memory.roles.origin(name), 'factory')
  }

  // Never pre-selected before owner chooses.
  assert.equal(await memory.persona.roleCard(), null)
  assert.deepEqual(await memory.profiles.current(), { version: 0, stable: '' })

  const target = '小鲸鱼-松弛搭子'
  const version = await memory.persona.selectRoleCard(target)
  assert.equal(version, 1)

  // Origin remains factory and no user overlay file is created.
  assert.equal(memory.roles.origin(target), 'factory')
  assert.equal(existsSync(path.join(stateDir, 'roles', `${target}.md`)), false)

  const active = await memory.persona.roleCard()
  assert.ok(active !== null)
  assert.equal(active.name, target)
  const expectedText = await readFile(path.join(KERNEL_ROLES_DIR, `${target}.md`), 'utf8')
  assert.equal(active.text, expectedText)

  // L3.1 profile committed synchronously with stable bytes and roleCard metadata.
  const currentProfile = await memory.profiles.current()
  assert.equal(currentProfile.version, 1)
  assert.equal(currentProfile.stable, renderStable({ name: target, text: expectedText }))
  const versionDetail = await memory.profiles.getVersion(1)
  assert.deepEqual(versionDetail.data, { roleCard: target })

  const l0Page = await memory.store.list({ layers: ['L0'], kinds: ['kernel.role_card'] }, { limit: 10 })
  assert.equal(l0Page.items.length, 1)
  assert.deepEqual(l0Page.items[0]?.content, { name: target, text: expectedText })
})

test('selectRoleCard rejects missing, invalid, or hidden role names without mutating state', async (t) => {
  const { memory } = await openTempMemory(t)

  for (const bad of ['不存在的人格', '../escape', 'a/b', 'README', '']) {
    await assert.rejects(() => memory.persona.selectRoleCard(bad), /不存在/, bad)
  }
  assert.equal(await memory.persona.roleCard(), null)
  assert.deepEqual(await memory.profiles.current(), { version: 0, stable: '' })
})

test('user override transitions factory card to modified, reset restores factory, and remove only writes hidden.json', async (t) => {
  const { stateDir, memory } = await openTempMemory(t)
  const target = '小鲸鱼-傲娇本味'
  const factoryFile = path.join(KERNEL_ROLES_DIR, `${target}.md`)
  const factoryHashBefore = await sha256File(factoryFile)
  const factoryText = await readFile(factoryFile, 'utf8')

  // 1. User override via saveRoleCard -> origin becomes 'modified', factory file untouched.
  const customText = '你是小鲸鱼（用户定制版），更偏技术讨论。\n'
  const version = await memory.persona.saveRoleCard({ name: target, text: customText })
  assert.equal(version, 1)
  assert.equal(memory.roles.origin(target), 'modified')
  assert.equal(existsSync(path.join(stateDir, 'roles', `${target}.md`)), true)
  assert.equal(await sha256File(factoryFile), factoryHashBefore)
  assert.equal((await memory.profiles.current())?.stable, renderStable({ name: target, text: customText }))

  // 2. reset() removes user overlay and restores factory origin & content.
  memory.roles.reset(target)
  assert.equal(memory.roles.origin(target), 'factory')
  assert.equal(memory.roles.read(target), factoryText)
  assert.equal(existsSync(path.join(stateDir, 'roles', `${target}.md`)), false)

  // 3. remove() writes hidden.json and hides the card without deleting the factory file.
  memory.roles.remove(target)
  assert.equal(memory.roles.exists(target), false)
  assert.equal(memory.roles.list().includes(target), false)
  assert.equal(existsSync(path.join(stateDir, 'roles', 'hidden.json')), true)
  const hiddenDoc = JSON.parse(await readFile(path.join(stateDir, 'roles', 'hidden.json'), 'utf8')) as {
    readonly version: number
    readonly names: readonly string[]
  }
  assert.equal(hiddenDoc.version, 1)
  assert.ok(hiddenDoc.names.includes(target))
  assert.equal(existsSync(factoryFile), true)
  assert.equal(await sha256File(factoryFile), factoryHashBefore)

  // Selecting a hidden factory card is rejected.
  await assert.rejects(() => memory.persona.selectRoleCard(target), /不存在/)
})

test('selectRoleCard and saveRoleCard leave active.json untouched when profiles.commit throws', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-persona-commit-fail-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  const stateDir = path.join(dir, 'state')
  const personaDir = path.join(stateDir, 'persona')
  const activeFile = path.join(personaDir, 'active.json')
  const kernelRoot = path.dirname(KERNEL_ROLES_DIR)
  const roles = createRoleStore({ root: kernelRoot, stateDir })
  const clock = new FakeClock()
  const store = new FakeRecordStore(clock)

  let shouldFail = true
  let version = 0
  const flakyProfiles: ProfileWriter = {
    async commit() {
      if (shouldFail) throw new Error('simulated L3 commit failure')
      version += 1
      return version
    },
  }
  const persona = createPersonaService({
    roles,
    dir: personaDir,
    store,
    profiles: flakyProfiles,
    clock,
  })

  // 1. Failing on initial selectRoleCard must not create active.json.
  await assert.rejects(() => persona.selectRoleCard('小鲸鱼-松弛搭子'), /simulated L3 commit failure/)
  assert.equal(existsSync(activeFile), false)
  assert.equal(await persona.roleCard(), null)

  // 2. Establish a valid active card first, then fail on subsequent selectRoleCard & saveRoleCard.
  shouldFail = false
  assert.equal(await persona.selectRoleCard('小鲸鱼-松弛搭子'), 1)
  assert.equal((await persona.roleCard())?.name, '小鲸鱼-松弛搭子')
  const activeBefore = await readFile(activeFile, 'utf8')

  shouldFail = true
  await assert.rejects(() => persona.selectRoleCard('小鲸鱼-理性参谋'), /simulated L3 commit failure/)
  assert.equal(await readFile(activeFile, 'utf8'), activeBefore)
  assert.equal((await persona.roleCard())?.name, '小鲸鱼-松弛搭子')

  await assert.rejects(
    () => persona.saveRoleCard({ name: '自定义临时卡', text: '临时内容\n' }),
    /simulated L3 commit failure/,
  )
  assert.equal(await readFile(activeFile, 'utf8'), activeBefore)
  assert.equal((await persona.roleCard())?.name, '小鲸鱼-松弛搭子')
})
