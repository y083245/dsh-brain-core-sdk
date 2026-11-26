import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import {
  makeBrainHome, makeFakeDshHome, modeOf, snapshotDir, startConsole, TOKEN,
  type TempHome, type TestConsole,
} from './helpers.ts'

const SENTINEL = 'sk-console-sentinel-9c41f0'

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

test('saved secret values never come back from any route or the shell HTML', async () => {
  await withConsole(async (consoleServer, home) => {
    const saved = await consoleServer.request('PUT', '/api/v1/console/settings/secret', {
      body: { name: 'deepseek-api-key', value: `${SENTINEL}-shared` },
    })
    assert.equal(saved.status, 200)
    assert.ok(!saved.text.includes(SENTINEL))
    assert.deepEqual(saved.body.data, { saved: 'deepseek-api-key', secretNames: ['deepseek-api-key'] })

    const second = await consoleServer.request('PUT', '/api/v1/console/settings/secret', {
      body: { name: 'brain-deepseek-api-key', value: `${SENTINEL}-own` },
    })
    assert.equal(second.status, 200)
    assert.ok(!second.text.includes(SENTINEL))
    assert.deepEqual(second.body.data, {
      saved: 'brain-deepseek-api-key',
      secretNames: ['brain-deepseek-api-key', 'deepseek-api-key'],
    })

    const settings = await consoleServer.request('GET', '/api/v1/console/settings')
    assert.ok(!settings.text.includes(SENTINEL))
    const data = settings.body.data as { secretNames: readonly string[] }
    assert.deepEqual(data.secretNames, ['brain-deepseek-api-key', 'deepseek-api-key'])

    const html = await consoleServer.html('/', TOKEN)
    assert.ok(!html.includes(SENTINEL), 'the shell HTML must never echo a secret value')
    const uiState = await consoleServer.request('GET', '/api/v1/console/ui/state?page=settings')
    assert.ok(!uiState.text.includes(SENTINEL), 'the UI state must never echo a secret value')
    const mainHtml = (uiState.body.data as { mainHtml: string }).mainHtml
    assert.match(mainHtml, /brain-deepseek-api-key：已保存/)
    assert.match(mainHtml, /deepseek-api-key：已保存/)

    // 只有名字进了响应，值只在 state/secrets.json 里。
    const stored = await readFile(path.join(home.state, 'secrets.json'), 'utf8')
    assert.ok(stored.includes(`${SENTINEL}-own`))
  })
})

test('state/secrets.json is written with mode 600', async () => {
  if (process.platform === 'win32') return
  await withConsole(async (consoleServer, home) => {
    await consoleServer.request('PUT', '/api/v1/console/settings/secret', { body: { name: 'deepseek-api-key', value: SENTINEL } })
    assert.equal(await modeOf(path.join(home.state, 'secrets.json')), 0o600)
  })
})

test('an invalid secret name or value is refused without writing anything', async () => {
  await withConsole(async (consoleServer, home) => {
    const cases: readonly unknown[] = [
      { name: '../escape', value: SENTINEL },
      { name: 'UPPER', value: SENTINEL },
      { name: '', value: SENTINEL },
      { name: 'deepseek-api-key', value: '' },
      { name: 'deepseek-api-key', value: 'x'.repeat(4097) },
      { name: 'deepseek-api-key', value: 42 },
      'not an object',
    ]
    for (const body of cases) {
      const result = await consoleServer.request('PUT', '/api/v1/console/settings/secret', { body })
      assert.equal(result.status, 400, JSON.stringify(body))
      assert.equal((result.body.error as { code?: string }).code, 'INVALID_ARGUMENT')
      assert.ok(!result.text.includes(SENTINEL), 'an error must not echo the value')
    }
    const stored = await readFile(path.join(home.state, 'secrets.json'), 'utf8').catch(() => undefined)
    assert.equal(stored, undefined)
  })
})

test('saving a secret invalidates both agent classes', async () => {
  await withConsole(async (consoleServer) => {
    await consoleServer.request('PUT', '/api/v1/console/settings/secret', { body: { name: 'deepseek-api-key', value: SENTINEL } })
    assert.deepEqual(consoleServer.invalidated, ['chat', 'activity'])
  })
})

test('a damaged secrets file is INTERNAL on GET /settings instead of being silently emptied', async () => {
  await withConsole(async (consoleServer, home) => {
    await mkdir(home.state, { recursive: true })
    const cases: readonly string[] = [
      JSON.stringify({ version: 2, secrets: {} }),
      JSON.stringify({ version: 1, secrets: { BAD_NAME: 'val' } }),
      JSON.stringify({ version: 1, secrets: { 'ok-name': '' } }),
    ]
    for (const contents of cases) {
      await writeFile(path.join(home.state, 'secrets.json'), contents, 'utf8')
      const result = await consoleServer.request('GET', '/api/v1/console/settings')
      assert.equal(result.status, 500, contents)
      assert.equal((result.body.error as { code?: string }).code, 'INTERNAL', contents)
      assert.ok(!result.text.includes('val'), 'the error must not echo a stored value')
    }
  })
})

test('the console never writes into a DSH_HOME that already holds its own credentials (D17)', async () => {
  const previous = process.env.DSH_HOME
  const dshHome = await makeFakeDshHome()
  process.env.DSH_HOME = dshHome.dir
  const home = await makeBrainHome()
  const consoleServer = await startConsole(home)
  try {
    const before = await snapshotDir(dshHome.dir)
    assert.deepEqual(before.entries, ['profiles/', 'profiles/cordis.patch.yml', 'state/', 'state/secrets.json'])

    await consoleServer.request('PUT', '/api/v1/console/settings/secret', { body: { name: 'deepseek-api-key', value: SENTINEL } })
    await consoleServer.request('PUT', '/api/v1/console/settings/secret', { body: { name: 'brain-deepseek-api-key', value: SENTINEL } })
    await consoleServer.request('PUT', '/api/v1/console/settings/model', {
      body: { agentClass: 'chat', provider: 'deepseek-official', model: 'deepseek-flash', effort: 'high' },
    })
    await consoleServer.request('PUT', '/api/v1/console/settings/role-card', {
      body: { mode: 'raw', name: '小满', text: '# 小满\n' },
    })
    await consoleServer.request('GET', '/api/v1/console/settings')
    await consoleServer.html('/', TOKEN)

    const after = await snapshotDir(dshHome.dir)
    assert.deepEqual(after.entries, before.entries, 'no file may be added or removed in the DSH home')
    assert.deepEqual(after.hashes, before.hashes, 'no file in the DSH home may change')
    // 主 DSH 的凭据也完全没被读进 Brain 的密钥库。
    const brainSecrets = JSON.parse(await readFile(path.join(home.state, 'secrets.json'), 'utf8')) as {
      secrets: Record<string, string>
    }
    assert.equal(brainSecrets.secrets['deepseek-api-key'], SENTINEL)
    assert.equal(Object.values(brainSecrets.secrets).includes('dsh-sentinel-value'), false)
  } finally {
    await consoleServer.close()
    await home.close()
    await dshHome.close()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
