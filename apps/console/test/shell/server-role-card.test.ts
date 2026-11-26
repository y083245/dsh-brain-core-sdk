import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { makeBrainHome, modeOf, startConsole, TOKEN, type TempHome, type TestConsole } from './helpers.ts'

async function withConsole(run: (consoleServer: TestConsole, home: TempHome) => Promise<void>): Promise<void> {
  const home = await makeBrainHome()
  const consoleServer = await startConsole(home)
  try {
    await run(consoleServer, home)
  } finally {
    await consoleServer.close()
    await home.close()
  }
}

const INTERVIEW = {
  name: '  小满 ',
  summary: ' 一个记事、也会打岔的人 ',
  tone: ' 轻、短句 ',
  traits: [{ trait: ' 记性好 ', manifestation: ' 会主动提起你上周随口说的事 ' }],
}

test('with no role card the shell shows the choose-a-card banner', async () => {
  await withConsole(async (consoleServer) => {
    const html = await consoleServer.html('/', TOKEN)
    assert.ok(!html.includes('role-card-active'))
    const uiState = await consoleServer.request('GET', '/api/v1/console/ui/state?page=settings')
    const uiData = uiState.body.data as { roleCardName: string | null; mainHtml: string }
    assert.equal(uiData.roleCardName, null)
    assert.match(uiData.mainHtml, /data-warning="role-card-missing"/)
    assert.match(uiData.mainHtml, /先选角色卡（未选角色卡时唤醒返回 UNAVAILABLE）/)
    const settings = await consoleServer.request('GET', '/api/v1/console/settings')
    assert.equal((settings.body.data as { roleCard: unknown }).roleCard, null)
    assert.deepEqual((settings.body.data as { availableRoleCards: unknown }).availableRoleCards, [])
  })
})

test('an interview card is saved, becomes active and invalidates both classes', async () => {
  await withConsole(async (consoleServer, home) => {
    const result = await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
      body: { mode: 'interview', interview: INTERVIEW },
    })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.data, { name: '小满' })
    assert.deepEqual(consoleServer.invalidated, ['chat', 'activity'])

    const saved = await readFile(path.join(home.state, 'roles', '小满.md'), 'utf8')
    assert.match(saved, /^# 小满/)
    assert.match(saved, /定位：一个记事、也会打岔的人/)
    assert.match(saved, /- \*\*记性好\*\*：在对话中体现为：会主动提起你上周随口说的事/)
    if (process.platform !== 'win32') {
      assert.equal(await modeOf(path.join(home.state, 'roles', '小满.md')), 0o600)
      assert.equal(await modeOf(path.join(home.state, 'persona', 'active.json')), 0o600)
    }

    const active = JSON.parse(await readFile(path.join(home.state, 'persona', 'active.json'), 'utf8')) as Record<string, unknown>
    assert.deepEqual(active, { version: 1, name: '小满' })

    const settings = await consoleServer.request('GET', '/api/v1/console/settings')
    const data = settings.body.data as { roleCard: { name: string; text: string }; availableRoleCards: readonly string[] }
    assert.equal(data.roleCard.name, '小满')
    assert.match(data.roleCard.text, /^# 小满/)
    assert.deepEqual(data.availableRoleCards, ['小满'])

    const uiState = await consoleServer.request('GET', '/api/v1/console/ui/state?page=settings')
    const uiData = uiState.body.data as { roleCardName: string | null; mainHtml: string }
    assert.equal(uiData.roleCardName, '小满')
    assert.ok(!uiData.mainHtml.includes('data-warning="role-card-missing"'))
    assert.match(uiData.mainHtml, /data-role-card-active="小满"/)
  })
})

test('the interview refuses an empty name, a blank trait or a trait without a manifestation', async () => {
  await withConsole(async (consoleServer, home) => {
    const cases: readonly unknown[] = [
      { mode: 'interview', interview: { ...INTERVIEW, name: '   ' } },
      { mode: 'interview', interview: { ...INTERVIEW, summary: '' } },
      { mode: 'interview', interview: { ...INTERVIEW, tone: ' ' } },
      { mode: 'interview', interview: { ...INTERVIEW, traits: [] } },
      { mode: 'interview', interview: { ...INTERVIEW, traits: [{ trait: '记性好', manifestation: '' }] } },
      { mode: 'interview', interview: { ...INTERVIEW, traits: [{ trait: '记性好' }] } },
      { mode: 'interview', interview: 'not an object' },
      { mode: 'interview' },
      { mode: 'nonsense' },
      'not an object',
    ]
    for (const body of cases) {
      const result = await consoleServer.request('PUT', '/api/v1/console/settings/role-card', { body })
      assert.equal(result.status, 400, JSON.stringify(body))
      assert.equal((result.body.error as { code?: string }).code, 'INVALID_ARGUMENT')
    }
    const active = await readFile(path.join(home.state, 'persona', 'active.json'), 'utf8').catch(() => undefined)
    assert.equal(active, undefined, 'a refused interview must not activate anything')
    assert.deepEqual(consoleServer.invalidated, [])
  })
})

test('a raw role card is saved as-is and activated', async () => {
  await withConsole(async (consoleServer, home) => {
    const result = await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
      body: { mode: 'raw', name: '阿澜', text: '\n# 阿澜\n\n慢一点的人\n\n' },
    })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.data, { name: '阿澜' })
    const saved = await readFile(path.join(home.state, 'roles', '阿澜.md'), 'utf8')
    assert.equal(saved, '# 阿澜\n\n慢一点的人\n')
  })
})

test('a raw role card with a blank name, blank text or a path-like name is refused', async () => {
  await withConsole(async (consoleServer) => {
    const cases: readonly unknown[] = [
      { mode: 'raw', name: '   ', text: '# x' },
      { mode: 'raw', name: '../../escape', text: '# x' },
      { mode: 'raw', name: '..', text: '# x' },
      { mode: 'raw', name: 'a/b', text: '# x' },
      { mode: 'raw', name: '小满', text: '   ' },
      { mode: 'raw', name: '小满' },
    ]
    for (const body of cases) {
      const result = await consoleServer.request('PUT', '/api/v1/console/settings/role-card', { body })
      assert.equal(result.status, 400, JSON.stringify(body))
      assert.equal((result.body.error as { code?: string }).code, 'INVALID_ARGUMENT')
    }
  })
})

test('a role name that is too long or carries a separator or a NUL is refused', async () => {
  await withConsole(async (consoleServer) => {
    const cases: readonly string[] = ['a'.repeat(63), 'a\\b', 'a\0b']
    for (const name of cases) {
      const result = await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
        body: { mode: 'raw', name, text: '# x' },
      })
      assert.equal(result.status, 400, JSON.stringify(name))
      assert.equal((result.body.error as { code?: string }).code, 'INVALID_ARGUMENT')
    }
  })
})

test('an existing card can be picked without touching the interview path', async () => {
  await withConsole(async (consoleServer, home) => {
    await mkdir(path.join(home.state, 'roles'), { recursive: true })
    await writeFile(path.join(home.state, 'roles', '出厂卡.md'), '# 出厂卡\n', 'utf8')
    await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
      body: { mode: 'raw', name: '自建卡', text: '# 自建卡\n' },
    })
    const settings = await consoleServer.request('GET', '/api/v1/console/settings')
    const data = settings.body.data as { availableRoleCards: readonly string[]; roleCard: { name: string } }
    assert.deepEqual(data.availableRoleCards, ['出厂卡', '自建卡'])
    assert.equal(data.roleCard.name, '自建卡')
  })
})

test('state/roles/README.md is documentation, not a card, so it is never offered', async () => {
  await withConsole(async (consoleServer, home) => {
    await mkdir(path.join(home.state, 'roles'), { recursive: true })
    await writeFile(path.join(home.state, 'roles', 'README.md'), '# 角色卡放这里\n', 'utf8')
    await writeFile(path.join(home.state, 'roles', '小满.md'), '# 小满\n', 'utf8')
    const settings = await consoleServer.request('GET', '/api/v1/console/settings')
    const data = settings.body.data as { availableRoleCards: readonly string[] }
    assert.deepEqual(data.availableRoleCards, ['小满'])
    assert.ok(!data.availableRoleCards.includes('README'))
  })
})

test('an active.json naming a path outside rolesDir reads no card instead of escaping it', async () => {
  await withConsole(async (consoleServer, home) => {
    // 文件真的存在：如果名字没过校验，这里就会读到 rolesDir 外面的那张卡。
    await mkdir(path.join(home.state, 'persona'), { recursive: true })
    await writeFile(path.join(home.state, 'escape.md'), '# 逃出去的卡\n', 'utf8')
    for (const name of ['../escape', '..', 'a/b', 'a\\b', 'a\0b', 'a'.repeat(63)]) {
      await writeFile(path.join(home.state, 'persona', 'active.json'), JSON.stringify({ version: 1, name }), 'utf8')
      const settings = await consoleServer.request('GET', '/api/v1/console/settings')
      assert.equal(settings.status, 200, name)
      assert.equal((settings.body.data as { roleCard: unknown }).roleCard, null, name)
      assert.ok(!settings.text.includes('逃出去的卡'), name)
    }

    // 合法名字照旧生效，校验没有把正常的路堵死。
    await mkdir(path.join(home.state, 'roles'), { recursive: true })
    await writeFile(path.join(home.state, 'roles', '小满.md'), '# 小满\n', 'utf8')
    await writeFile(path.join(home.state, 'persona', 'active.json'), JSON.stringify({ version: 1, name: '小满' }), 'utf8')
    const uiState = await consoleServer.request('GET', '/api/v1/console/ui/state?page=settings')
    const uiData = uiState.body.data as { roleCardName: string | null; mainHtml: string }
    assert.equal(uiData.roleCardName, '小满')
    assert.match(uiData.mainHtml, /data-role-card-active="小满"/)
    assert.match(uiData.mainHtml, /小满/)
  })
})

async function makeFactoryRolesDir(cards: Readonly<Record<string, string>>): Promise<{
  readonly dir: string
  close(): Promise<void>
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-factory-roles-'))
  for (const [filename, content] of Object.entries(cards)) {
    await writeFile(path.join(dir, filename), content, 'utf8')
  }
  return {
    dir,
    async close() {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

test('factoryRolesDir lists starter cards, previews origin=factory and activates without polluting state/roles', async () => {
  const home = await makeBrainHome()
  const factory = await makeFactoryRolesDir({
    'README.md': '# 说明文档\n',
    '小满.md': '# 小满\n\n温柔记事的出厂搭档。\n',
    '阿澜.md': '# 阿澜\n\n安静克制的出厂搭档。\n',
  })
  const consoleServer = await startConsole(home, {
    factoryRolesDir: factory.dir,
  })

  try {
    const initial = await consoleServer.request('GET', '/api/v1/console/settings')
    assert.equal(initial.status, 200)
    const initialData = initial.body.data as { roleCard: unknown; availableRoleCards: readonly string[] }
    assert.equal(initialData.roleCard, null)
    assert.deepEqual(initialData.availableRoleCards, ['阿澜', '小满'])

    const unauth = await consoleServer.request('GET', `/api/v1/console/settings/role-card?name=${encodeURIComponent('小满')}`, {
      token: null,
    })
    assert.equal(unauth.status, 401)

    const preview = await consoleServer.request('GET', `/api/v1/console/settings/role-card?name=${encodeURIComponent('小满')}`)
    assert.equal(preview.status, 200)
    assert.deepEqual(preview.body.data, {
      name: '小满',
      text: '# 小满\n\n温柔记事的出厂搭档。\n',
      origin: 'factory',
    })

    const selected = await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
      body: { mode: 'select', name: '小满' },
    })
    assert.equal(selected.status, 200)
    assert.deepEqual(selected.body.data, { name: '小满' })
    assert.deepEqual(consoleServer.invalidated, ['chat', 'activity'])

    // 选中出厂卡后不应将文件拷贝进 state/roles/
    const userRoleEntries = await readdir(path.join(home.state, 'roles')).catch(() => null)
    assert.equal(userRoleEntries, null)

    // activeRoleCard() 直接回显出厂卡原文
    const afterSelect = await consoleServer.request('GET', '/api/v1/console/settings')
    assert.equal(afterSelect.status, 200)
    const afterData = afterSelect.body.data as { roleCard: { name: string; text: string } | null }
    assert.deepEqual(afterData.roleCard, {
      name: '小满',
      text: '# 小满\n\n温柔记事的出厂搭档。\n',
    })
  } finally {
    await consoleServer.close()
    await factory.close()
    await home.close()
  }
})

test('persistRoleCard owns persistence cleanly and leaves active.json untouched on failure', async () => {
  const home = await makeBrainHome()
  const factory = await makeFactoryRolesDir({
    '小满.md': '# 小满\n\n出厂正文。\n',
  })
  const calls: Array<{ name: string; text: string; mode: 'select' | 'interview' | 'raw' }> = []
  let shouldFail = true
  const consoleServer = await startConsole(home, {
    factoryRolesDir: factory.dir,
    persistRoleCard: async (card) => {
      calls.push({ ...card })
      if (shouldFail) {
        throw new Error('simulated kernel commit failure')
      }
    },
  })

  try {
    const failed = await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
      body: { mode: 'select', name: '小满' },
    })
    assert.equal(failed.status, 500)
    assert.deepEqual(calls, [{ name: '小满', text: '# 小满\n\n出厂正文。\n', mode: 'select' }])
    assert.deepEqual(consoleServer.invalidated, [])

    // persistRoleCard 抛错时，server 不应提前写入 active.json
    const activeAfterFailure = await readFile(path.join(home.state, 'persona', 'active.json'), 'utf8').catch(() => undefined)
    assert.equal(activeAfterFailure, undefined)

    shouldFail = false
    const succeeded = await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
      body: { mode: 'raw', name: '新卡', text: '# 新卡\n\n内容' },
    })
    assert.equal(succeeded.status, 200)
    assert.deepEqual(calls[1], { name: '新卡', text: '# 新卡\n\n内容\n', mode: 'raw' })
    assert.deepEqual(consoleServer.invalidated, ['chat', 'activity'])

    // 传入 persistRoleCard 时由调用方唯一写盘，server 自身不双写 active.json 或 roles/
    const activeAfterDelegate = await readFile(path.join(home.state, 'persona', 'active.json'), 'utf8').catch(() => undefined)
    assert.equal(activeAfterDelegate, undefined)
    const userRolesAfterDelegate = await readdir(path.join(home.state, 'roles')).catch(() => null)
    assert.equal(userRolesAfterDelegate, null)
  } finally {
    await consoleServer.close()
    await factory.close()
    await home.close()
  }
})

test('overriding a factory card transitions origin to modified while a custom card reports user', async () => {
  const home = await makeBrainHome()
  const factory = await makeFactoryRolesDir({
    '小满.md': '# 小满\n\n出厂原文。\n',
  })
  const consoleServer = await startConsole(home, {
    factoryRolesDir: factory.dir,
  })

  try {
    const overwrite = await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
      body: { mode: 'raw', name: '小满', text: '# 小满\n\n用户改写版' },
    })
    assert.equal(overwrite.status, 200)

    const modifiedPreview = await consoleServer.request('GET', `/api/v1/console/settings/role-card?name=${encodeURIComponent('小满')}`)
    assert.equal(modifiedPreview.status, 200)
    assert.deepEqual(modifiedPreview.body.data, {
      name: '小满',
      text: '# 小满\n\n用户改写版\n',
      origin: 'modified',
    })

    const createUser = await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
      body: { mode: 'raw', name: '自建人设', text: '# 自建人设\n\n全新内容' },
    })
    assert.equal(createUser.status, 200)

    const userPreview = await consoleServer.request('GET', `/api/v1/console/settings/role-card?name=${encodeURIComponent('自建人设')}`)
    assert.equal(userPreview.status, 200)
    assert.deepEqual(userPreview.body.data, {
      name: '自建人设',
      text: '# 自建人设\n\n全新内容\n',
      origin: 'user',
    })

    const settings = await consoleServer.request('GET', '/api/v1/console/settings')
    const data = settings.body.data as { availableRoleCards: readonly string[] }
    assert.deepEqual(data.availableRoleCards, ['小满', '自建人设'])
  } finally {
    await consoleServer.close()
    await factory.close()
    await home.close()
  }
})

test('hidden.json hides factory cards and is removed once the last hidden card is unhidden', async () => {
  const home = await makeBrainHome()
  const factory = await makeFactoryRolesDir({
    '小满.md': '# 小满\n\n出厂版。\n',
    '阿澜.md': '# 阿澜\n\n出厂版。\n',
  })
  const consoleServer = await startConsole(home, { factoryRolesDir: factory.dir })

  try {
    const hiddenFile = path.join(home.state, 'roles', 'hidden.json')
    await mkdir(path.join(home.state, 'roles'), { recursive: true })
    await writeFile(hiddenFile, JSON.stringify({ version: 1, names: ['小满'] }), 'utf8')

    const settings = await consoleServer.request('GET', '/api/v1/console/settings')
    assert.deepEqual((settings.body.data as { availableRoleCards: readonly string[] }).availableRoleCards, ['阿澜'])

    const hiddenPreview = await consoleServer.request('GET', `/api/v1/console/settings/role-card?name=${encodeURIComponent('小满')}`)
    assert.equal(hiddenPreview.status, 404)
    assert.equal((hiddenPreview.body.error as { code?: string }).code, 'NOT_FOUND')

    const hiddenSelect = await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
      body: { mode: 'select', name: '小满' },
    })
    assert.equal(hiddenSelect.status, 404)
    assert.equal((hiddenSelect.body.error as { code?: string }).code, 'NOT_FOUND')

    // 用户通过 raw 保存同名卡应自动解除隐藏，清空后删除 hidden.json
    const resave = await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
      body: { mode: 'raw', name: '小满', text: '# 小满\n\n重新启用' },
    })
    assert.equal(resave.status, 200)

    const hiddenStat = await stat(hiddenFile).catch(() => null)
    assert.equal(hiddenStat, null, 'hidden.json should be removed once empty')

    const restoredPreview = await consoleServer.request('GET', `/api/v1/console/settings/role-card?name=${encodeURIComponent('小满')}`)
    assert.equal(restoredPreview.status, 200)
    assert.deepEqual(restoredPreview.body.data, {
      name: '小满',
      text: '# 小满\n\n重新启用\n',
      origin: 'modified',
    })

    // 损坏的 hidden.json 不应阻断列表读取
    await writeFile(hiddenFile, '{not-valid-json', 'utf8')
    const afterCorrupt = await consoleServer.request('GET', '/api/v1/console/settings')
    assert.equal(afterCorrupt.status, 200)
    assert.deepEqual((afterCorrupt.body.data as { availableRoleCards: readonly string[] }).availableRoleCards, ['阿澜', '小满'])
  } finally {
    await consoleServer.close()
    await factory.close()
    await home.close()
  }
})

test('GET /settings/role-card and PUT reject README variants, Windows-illegal chars, missing/traversal names and return 404 for unknown cards', async () => {
  const home = await makeBrainHome()
  const factory = await makeFactoryRolesDir({
    'README.md': '# 禁止读取\n',
    '小满.md': '# 小满\n',
  })
  const consoleServer = await startConsole(home, { factoryRolesDir: factory.dir })

  try {
    // 缺失 name
    const missing = await consoleServer.request('GET', '/api/v1/console/settings/role-card')
    assert.equal(missing.status, 400)
    assert.equal((missing.body.error as { code?: string }).code, 'INVALID_ARGUMENT')

    for (const invalidName of [
      '',
      '   ',
      'README',
      'readme',
      'ReadMe',
      'C:README',
      'a:b',
      'a*b',
      'a?b',
      'a"b',
      'a<b',
      'a>b',
      'a|b',
      'a\x07b',
      '..',
      '.',
      '../escape',
      'a/b',
      'a\\b',
      'a\0b',
      'x'.repeat(63),
    ]) {
      const getRes = await consoleServer.request(
        'GET',
        `/api/v1/console/settings/role-card?name=${encodeURIComponent(invalidName)}`,
      )
      assert.equal(getRes.status, 400, `GET ${JSON.stringify(invalidName)}`)
      assert.equal((getRes.body.error as { code?: string }).code, 'INVALID_ARGUMENT')

      const putRes = await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
        body: { mode: 'raw', name: invalidName, text: '# x' },
      })
      assert.equal(putRes.status, 400, `PUT ${JSON.stringify(invalidName)}`)
      assert.equal((putRes.body.error as { code?: string }).code, 'INVALID_ARGUMENT')
    }

    const notFound = await consoleServer.request('GET', `/api/v1/console/settings/role-card?name=${encodeURIComponent('不存在的卡')}`)
    assert.equal(notFound.status, 404)
    assert.equal((notFound.body.error as { code?: string }).code, 'NOT_FOUND')
  } finally {
    await consoleServer.close()
    await factory.close()
    await home.close()
  }
})

test('symlink escapes and .md directories are excluded from availableRoleCards and return 404', async () => {
  const home = await makeBrainHome()
  const factory = await makeFactoryRolesDir({
    '小满.md': '# 小满\n\n安全卡。\n',
  })
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'brain-outside-secret-'))
  const outsideFile = path.join(outsideDir, 'secret.txt')
  await writeFile(outsideFile, 'TOP-SECRET-OUTSIDE-CONTENT\n', 'utf8')
  const consoleServer = await startConsole(home, { factoryRolesDir: factory.dir })

  try {
    const userRolesDir = path.join(home.state, 'roles')
    await mkdir(userRolesDir, { recursive: true })
    // .md 同名目录（用户目录与出厂目录各放一个）
    await mkdir(path.join(userRolesDir, 'dir-user.md'), { recursive: true })
    await mkdir(path.join(factory.dir, 'dir-factory.md'), { recursive: true })

    // 指向目录外文件的软链（在允许 symlink 的平台执行）
    let symlinkCreated = false
    try {
      await symlink(outsideFile, path.join(userRolesDir, 'evil-user.md'))
      await symlink(outsideFile, path.join(factory.dir, 'evil-factory.md'))
      symlinkCreated = true
    } catch {
      symlinkCreated = false
    }

    const settings = await consoleServer.request('GET', '/api/v1/console/settings')
    assert.equal(settings.status, 200)
    const available = (settings.body.data as { availableRoleCards: readonly string[] }).availableRoleCards
    assert.deepEqual(available, ['小满'])

    for (const badCard of ['dir-user', 'dir-factory']) {
      const res = await consoleServer.request('GET', `/api/v1/console/settings/role-card?name=${encodeURIComponent(badCard)}`)
      assert.equal(res.status, 404, badCard)
      assert.equal((res.body.error as { code?: string }).code, 'NOT_FOUND')
    }

    if (symlinkCreated) {
      for (const evilCard of ['evil-user', 'evil-factory']) {
        const preview = await consoleServer.request('GET', `/api/v1/console/settings/role-card?name=${encodeURIComponent(evilCard)}`)
        assert.equal(preview.status, 404, `GET ${evilCard}`)
        assert.equal((preview.body.error as { code?: string }).code, 'NOT_FOUND')
        assert.ok(!preview.text.includes('TOP-SECRET-OUTSIDE-CONTENT'))

        const select = await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
          body: { mode: 'select', name: evilCard },
        })
        assert.equal(select.status, 404, `PUT ${evilCard}`)
        assert.equal((select.body.error as { code?: string }).code, 'NOT_FOUND')
      }
    }
  } finally {
    await consoleServer.close()
    await factory.close()
    await rm(outsideDir, { recursive: true, force: true, maxRetries: 5 })
    await home.close()
  }
})
