import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { makeBrainHome, modeOf, startConsole, type TempHome, type TestConsole } from './helpers.ts'

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

const CHAT_FLASH = { agentClass: 'chat', provider: 'deepseek-official', model: 'deepseek-flash', effort: 'high' }

test('a valid selection is written to settings.json with mode 600 and invalidates that class only', async () => {
  await withConsole(async (consoleServer, home) => {
    const result = await consoleServer.request('PUT', '/api/v1/console/settings/model', { body: CHAT_FLASH })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    const data = result.body.data as { chat?: unknown; activity?: unknown }
    assert.deepEqual(data.chat, { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'high' })
    assert.equal(data.activity, undefined, 'the other class stays unset')

    const file = path.join(home.state, 'settings.json')
    const stored = JSON.parse(await readFile(file, 'utf8')) as { agents: Record<string, unknown> }
    assert.deepEqual(stored.agents.chat, { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'high' })
    if (process.platform !== 'win32') assert.equal(await modeOf(file), 0o600)
    assert.deepEqual(consoleServer.invalidated, ['chat'])
  })
})

test('a second class selection keeps the first and invalidates the second class', async () => {
  await withConsole(async (consoleServer, home) => {
    await consoleServer.request('PUT', '/api/v1/console/settings/model', { body: CHAT_FLASH })
    await consoleServer.request('PUT', '/api/v1/console/settings/model', {
      body: { agentClass: 'activity', provider: 'deepseek-official', model: 'deepseek-v4-pro', effort: 'model-default' },
    })
    const stored = JSON.parse(await readFile(path.join(home.state, 'settings.json'), 'utf8')) as { agents: Record<string, unknown> }
    assert.deepEqual(stored.agents.chat, { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'high' })
    assert.deepEqual(stored.agents.activity, { provider: 'deepseek-official', model: 'deepseek-v4-pro', effort: 'model-default' })
    assert.deepEqual(consoleServer.invalidated, ['chat', 'activity'])
  })
})

test('saving a model keeps the other settings fields already in the file', async () => {
  await withConsole(async (consoleServer, home) => {
    await mkdir(home.state, { recursive: true })
    await writeFile(path.join(home.state, 'settings.json'), JSON.stringify({ agents: {}, timezone: 'Asia/Shanghai', ownTimePerDay: 3 }), 'utf8')
    await consoleServer.request('PUT', '/api/v1/console/settings/model', { body: CHAT_FLASH })
    const stored = JSON.parse(await readFile(path.join(home.state, 'settings.json'), 'utf8')) as Record<string, unknown>
    assert.equal(stored.timezone, 'Asia/Shanghai')
    assert.equal(stored.ownTimePerDay, 3)
  })
})

test('a submission with a missing field or an illegal effort is 400 INVALID_ARGUMENT and writes nothing', async () => {
  await withConsole(async (consoleServer, home) => {
    const cases: readonly unknown[] = [
      { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'high' },
      { agentClass: 'chat', model: 'deepseek-flash', effort: 'high' },
      { agentClass: 'chat', provider: 'deepseek-official', effort: 'high' },
      { agentClass: 'chat', provider: 'deepseek-official', model: 'deepseek-flash' },
      { agentClass: 'chat', provider: 'deepseek-official', model: 'deepseek-flash', effort: 'extreme' },
      { agentClass: 'chat', provider: '   ', model: 'deepseek-flash', effort: 'high' },
      { agentClass: 'system', provider: 'deepseek-official', model: 'deepseek-flash', effort: 'high' },
      'not an object',
    ]
    for (const body of cases) {
      const result = await consoleServer.request('PUT', '/api/v1/console/settings/model', { body })
      assert.equal(result.status, 400, JSON.stringify(body))
      assert.equal((result.body.error as { code?: string }).code, 'INVALID_ARGUMENT')
    }
    const stored = await readFile(path.join(home.state, 'settings.json'), 'utf8').catch(() => undefined)
    assert.equal(stored, undefined)
    assert.deepEqual(consoleServer.invalidated, [])
  })
})

test('GET /settings shows nothing selected before any choice and the emptied option afterwards', async () => {
  await withConsole(async (consoleServer) => {
    const before = await consoleServer.request('GET', '/api/v1/console/settings')
    const beforeData = before.body.data as { agents: Record<string, unknown> }
    assert.deepEqual(beforeData.agents, {})
    assert.equal(beforeData.agents.chat, undefined)

    await consoleServer.request('PUT', '/api/v1/console/settings/model', { body: CHAT_FLASH })
    const after = await consoleServer.request('GET', '/api/v1/console/settings')
    const afterData = after.body.data as { agents: Record<string, unknown> }
    assert.deepEqual(afterData.agents.chat, { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'high' })
    assert.equal(afterData.agents.activity, undefined)
  })
})

test('GET /settings carries the shared quota warning until the Brain-specific key is saved', async () => {
  await withConsole(async (consoleServer) => {
    const before = await consoleServer.request('GET', '/api/v1/console/settings')
    assert.equal((before.body.data as { sharedQuotaWarning: boolean }).sharedQuotaWarning, true)

    await consoleServer.request('PUT', '/api/v1/console/settings/secret', { body: { name: 'deepseek-api-key', value: 'sk-shared' } })
    const stillShared = await consoleServer.request('GET', '/api/v1/console/settings')
    assert.equal((stillShared.body.data as { sharedQuotaWarning: boolean }).sharedQuotaWarning, true, 'the main DSH key does not end sharing')

    await consoleServer.request('PUT', '/api/v1/console/settings/secret', { body: { name: 'brain-deepseek-api-key', value: 'sk-own' } })
    const own = await consoleServer.request('GET', '/api/v1/console/settings')
    const data = own.body.data as { sharedQuotaWarning: boolean; secretNames: readonly string[] }
    assert.equal(data.sharedQuotaWarning, false)
    assert.deepEqual(data.secretNames, ['brain-deepseek-api-key', 'deepseek-api-key'])
  })
})

test('the shell page carries the shared quota notice while the Brain key is missing, and drops it once saved', async () => {
  await withConsole(async (consoleServer) => {
    const { TOKEN } = await import('./helpers.ts')
    const spaHtml = await consoleServer.html('/', TOKEN)
    assert.ok(!spaHtml.includes('id="shared-quota-warning"'))
    const before = await consoleServer.request('GET', '/api/v1/console/ui/state?page=settings')
    assert.equal((before.body.data as { sharedQuotaWarning: boolean }).sharedQuotaWarning, true)

    await consoleServer.request('PUT', '/api/v1/console/settings/secret', { body: { name: 'brain-deepseek-api-key', value: 'sk-own' } })
    const after = await consoleServer.request('GET', '/api/v1/console/ui/state?page=settings')
    assert.equal((after.body.data as { sharedQuotaWarning: boolean }).sharedQuotaWarning, false)
  })
})
