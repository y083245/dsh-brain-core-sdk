import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { BrainError } from '@brain-core/sdk'
import {
  DEFAULT_PRICE_BOOK,
  computeCostMicros,
  createModelAccountingStore,
  createPluginLlmExecutor,
  formatDayInTimezone,
  loadPriceBook,
  lookupPrice,
  savePriceBook,
  validatePriceBook,
  type DetailedLlmClient,
} from '../../src/model-accounting/index.ts'
import { openAccountingDb } from '../../src/model-accounting/ledger.ts'
import type { AccountingEntryInput, RuntimeSettings } from '../../src/contracts/index.ts'
import { createLogger } from '../../src/log/index.ts'
import { FakeClock } from '../fakes/index.ts'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brain-accounting-test-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('prices: missing file yields DEFAULT_PRICE_BOOK copy, save/load roundtrips with 0600, corrupted throws UNAVAILABLE', async () => {
  await withTempDir(async (dir) => {
    const pricesFile = path.join(dir, 'state', 'model-prices.json')
    const missing = await loadPriceBook(pricesFile)
    assert.deepEqual(missing, DEFAULT_PRICE_BOOK)
    assert.notEqual(missing, DEFAULT_PRICE_BOOK)
    assert.notEqual(missing.models, DEFAULT_PRICE_BOOK.models)

    const saved = await savePriceBook(pricesFile, {
      version: 1,
      currency: 'USD',
      models: {
        'deepseek-official/deepseek-flash': {
          inputPerMillion: 0.28,
          outputPerMillion: 0.42,
          cacheReadPerMillion: 0.028,
          cacheWritePerMillion: 0.28,
        },
        'deepseek-flash': {
          inputPerMillion: 0.5,
          outputPerMillion: 1,
          cacheReadPerMillion: 0.05,
          cacheWritePerMillion: 0.5,
        },
      },
    })
    assert.equal(saved.currency, 'USD')

    if (process.platform !== 'win32') {
      const st = await stat(pricesFile)
      assert.equal(st.mode & 0o777, 0o600)
    }

    const loaded = await loadPriceBook(pricesFile)
    assert.deepEqual(loaded, saved)

    // Exact provider/model beats bare model
    const exact = lookupPrice(loaded, 'deepseek-official', 'deepseek-flash')
    assert.equal(exact?.inputPerMillion, 0.28)
    const fallback = lookupPrice(loaded, 'other-provider', 'deepseek-flash')
    assert.equal(fallback?.inputPerMillion, 0.5)
    assert.equal(lookupPrice(loaded, 'unknown', 'unknown-model'), undefined)

    // Corrupted JSON throws UNAVAILABLE
    await writeFile(pricesFile, '{broken-json', 'utf8')
    await assert.rejects(
      () => loadPriceBook(pricesFile),
      (err: unknown) => err instanceof BrainError && err.code === 'UNAVAILABLE',
    )

    // Invalid schema on disk throws UNAVAILABLE
    await writeFile(pricesFile, JSON.stringify({ version: 2, currency: 'CNY', models: {} }), 'utf8')
    await assert.rejects(
      () => loadPriceBook(pricesFile),
      (err: unknown) => err instanceof BrainError && err.code === 'UNAVAILABLE',
    )
  })
})

test('prices: validatePriceBook rejects invalid inputs and computeCostMicros avoids float drift and handles unknown models', () => {
  assert.throws(
    () => validatePriceBook(null),
    (err: unknown) => err instanceof BrainError && err.code === 'INVALID_ARGUMENT',
  )
  assert.throws(
    () => validatePriceBook({ version: 2, currency: 'CNY', models: {} }),
    (err: unknown) => err instanceof BrainError && err.code === 'INVALID_ARGUMENT',
  )
  assert.throws(
    () => validatePriceBook({ version: 1, currency: '   ', models: {} }),
    (err: unknown) => err instanceof BrainError && err.code === 'INVALID_ARGUMENT',
  )
  assert.throws(
    () => validatePriceBook({
      version: 1,
      currency: 'CNY',
      models: {
        bad: { inputPerMillion: -1, outputPerMillion: 1, cacheReadPerMillion: 0, cacheWritePerMillion: 0 },
      },
    }),
    (err: unknown) => err instanceof BrainError && err.code === 'INVALID_ARGUMENT',
  )

  const unknownCost = computeCostMicros(
    { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 0 },
    undefined,
    'CNY',
  )
  assert.deepEqual(unknownCost, { costMicros: 0, currency: 'CNY', priced: false })

  // 100 * 0.29 in IEEE-754 is 28.999999999999996; integer micros must round cleanly to 29
  const floatTrap = computeCostMicros(
    { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { inputPerMillion: 0.29, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 },
    'CNY',
  )
  assert.deepEqual(floatTrap, { costMicros: 29, currency: 'CNY', priced: true })

  const precise = computeCostMicros(
    { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 100_000 },
    DEFAULT_PRICE_BOOK.models['deepseek-official/deepseek-flash'],
    'CNY',
  )
  assert.deepEqual(precise, { costMicros: 2_300_000, currency: 'CNY', priced: true })
})

test('ledger: 0600 SQLite permissions, multi-owner breakdown, dailyTrend windowing, and price hot-reload', async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'agent', 'accounting.db')
    const pricesFile = path.join(dir, 'model-prices.json')
    const clock = new FakeClock(Date.UTC(2026, 10, 20, 12, 0, 0))
    const store = await createModelAccountingStore({ dbPath, pricesFile, clock })

    try {
      if (process.platform !== 'win32') {
        const dbStat = await stat(dbPath)
        assert.equal(dbStat.mode & 0o777, 0o600)
      }

      // Verify WAL mode, STRICT table, and indexes directly on the SQLite file
      const probe = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const jm = probe.prepare('PRAGMA journal_mode').get() as { readonly journal_mode: string }
        assert.equal(jm.journal_mode.toLowerCase(), 'wal')
        const tableInfo = probe.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'usage_ledger'").get() as { readonly sql: string } | undefined
        assert.ok(tableInfo?.sql.includes('STRICT'))
        const idxRows = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_ledger'").all() as Array<{ readonly name: string }>
        assert.ok(idxRows.some((r) => r.name === 'usage_ledger_day'))
        assert.ok(idxRows.some((r) => r.name === 'usage_ledger_plugin_day'))
      } finally {
        probe.close()
      }

      const secureProbe = await openAccountingDb(path.join(dir, 'agent', 'secure-probe.db'))
      try {
        const sd = secureProbe.prepare('PRAGMA secure_delete').get() as { readonly secure_delete: number }
        assert.equal(sd.secure_delete, 1)
      } finally {
        secureProbe.close()
      }

      // Record entries across multiple days (10 days) and multiple owners on 2026-11-20
      for (let offset = 9; offset >= 1; offset -= 1) {
        const d = String(20 - offset).padStart(2, '0')
        await store.record({
          tAt: Date.UTC(2026, 10, 20 - offset, 10, 0, 0),
          day: `2026-11-${d}`,
          owner: 'agent:chat',
          agentClass: 'chat',
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
        })
      }

      const e1 = await store.record({
        tAt: clock.now(),
        day: '2026-11-20',
        owner: 'agent:chat',
        agentClass: 'chat',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        usage: { inputTokens: 100_000, outputTokens: 50_000, cacheReadTokens: 300_000, cacheWriteTokens: 0 },
        channel: 'console-chat:dm:owner',
        wakeId: 'wake_1',
      })
      assert.ok(e1.id.startsWith('acc_'))
      assert.equal(e1.priced, true)
      assert.equal(e1.costMicros, 230_000)

      await store.record({
        tAt: clock.now() + 10,
        day: '2026-11-20',
        owner: 'kernel:extraction',
        agentClass: 'kernel',
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        usage: { inputTokens: 10_000, outputTokens: 5_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })

      await store.record({
        tAt: clock.now() + 20,
        day: '2026-11-20',
        owner: 'plugin:alpha',
        pluginId: 'alpha',
        agentClass: 'activity',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        usage: { inputTokens: 20_000, outputTokens: 10_000, cacheReadTokens: 10_000, cacheWriteTokens: 0 },
      })

      // Unpriced model for plugin:beta
      const unpricedEntry = await store.record({
        tAt: clock.now() + 30,
        day: '2026-11-20',
        owner: 'plugin:beta',
        pluginId: 'beta',
        agentClass: 'activity',
        provider: 'local',
        model: 'custom-unpriced',
        usage: { inputTokens: 5_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })
      assert.equal(unpricedEntry.priced, false)
      assert.equal(unpricedEntry.costMicros, 0)

      if (process.platform !== 'win32') {
        for (const suffix of ['', '-wal', '-shm']) {
          const file = `${dbPath}${suffix}`
          try {
            const st = await stat(file)
            assert.equal(st.mode & 0o777, 0o600)
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
          }
        }
      }

      const alphaToday = await store.todayUsage('2026-11-20', 'alpha')
      assert.deepEqual(alphaToday, { tokens: 40_000, costMicros: 41_000, calls: 1 })

      const sum7 = await store.summary({
        day: '2026-11-20',
        days: 7,
        sharedQuotaWarning: true,
        dailyTokenLimit: 1_000_000,
        dailyCostMicrosLimit: 500_000,
      })
      assert.equal(sum7.day, '2026-11-20')
      assert.equal(sum7.currency, 'CNY')
      assert.equal(sum7.sharedQuotaWarning, true)
      assert.equal(sum7.todayTokens, 450_000 + 15_000 + 40_000 + 6_000)
      assert.equal(sum7.todayCostMicros, 230_000 + 100_000 + 41_000 + 0)
      // cacheRead = 310_000, input + cacheRead + cacheWrite = 135_000 + 310_000 + 0 = 445_000
      assert.ok(Math.abs(sum7.todayCacheHitRatio - 310_000 / 445_000) < 1e-9)

      assert.deepEqual(
        sum7.byPlugin.map((p) => p.owner),
        ['agent:chat', 'kernel:extraction', 'plugin:alpha', 'plugin:beta'],
      )
      const betaRow = sum7.byPlugin.find((p) => p.owner === 'plugin:beta')
      assert.equal(betaRow?.unpricedCalls, 1)
      assert.equal(betaRow?.pluginId, 'beta')

      // 7-day trend ending 2026-11-20 -> 2026-11-14 .. 2026-11-20
      assert.equal(sum7.dailyTrend.length, 7)
      assert.equal(sum7.dailyTrend[0]?.day, '2026-11-14')
      assert.equal(sum7.dailyTrend[6]?.day, '2026-11-20')

      // Non-finite summary days (NaN / Infinity) safely fall back to 7 days
      const sumNan = await store.summary({ day: '2026-11-20', days: Number.NaN })
      assert.equal(sumNan.dailyTrend.length, 7)
      const sumInf = await store.summary({ day: '2026-11-20', days: Number.POSITIVE_INFINITY })
      assert.equal(sumInf.dailyTrend.length, 7)

      // Hot-update prices
      await store.setPrices({
        version: 1,
        currency: 'USD',
        models: {
          'deepseek-official/deepseek-flash': {
            inputPerMillion: 10,
            outputPerMillion: 20,
            cacheReadPerMillion: 1,
            cacheWritePerMillion: 10,
          },
        },
      })
      const currentPrices = await store.prices()
      assert.equal(currentPrices.currency, 'USD')
      const diskPrices = JSON.parse(await readFile(pricesFile, 'utf8')) as { currency: string }
      assert.equal(diskPrices.currency, 'USD')

      const afterUpdate = await store.record({
        tAt: clock.now() + 40,
        day: '2026-11-21',
        owner: 'plugin:alpha',
        pluginId: 'alpha',
        agentClass: 'activity',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        usage: { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })
      assert.equal(afterUpdate.currency, 'USD')
      assert.equal(afterUpdate.costMicros, 20_000)

      // Invalid usage or null/non-object entry rejected with INVALID_ARGUMENT
      await assert.rejects(
        () => store.record(null as unknown as AccountingEntryInput),
        (err: unknown) => err instanceof BrainError && err.code === 'INVALID_ARGUMENT',
      )
      await assert.rejects(
        () => store.record({
          tAt: clock.now(),
          day: '2026-11-20',
          owner: 'plugin:alpha',
          agentClass: 'activity',
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          usage: { inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
        (err: unknown) => err instanceof BrainError && err.code === 'INVALID_ARGUMENT',
      )
    } finally {
      await store.close()
      await store.close()
    }

    await assert.rejects(
      () => store.todayUsage('2026-11-20'),
      (err: unknown) => err instanceof BrainError && err.code === 'UNAVAILABLE',
    )
  })
})

test('llm-router: controlled execution, maxOutputTokens clamping, rate limits, invalid args, and zero-leak logging', async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'accounting.db')
    const pricesFile = path.join(dir, 'model-prices.json')
    // 2026-11-20T23:30:00Z -> 2026-11-21 in Asia/Tokyo (+09:00), 2026-11-20 in America/New_York (-05:00)
    const clock = new FakeClock(Date.UTC(2026, 10, 20, 23, 30, 0))
    assert.equal(formatDayInTimezone(clock.now(), 'Asia/Tokyo'), '2026-11-21')
    assert.equal(formatDayInTimezone(clock.now(), 'America/New_York'), '2026-11-20')
    const crossDayUtc = Date.UTC(2026, 10, 20, 15, 30, 0)
    assert.equal(formatDayInTimezone(crossDayUtc, 'Asia/Shanghai'), '2026-11-20')
    assert.equal(formatDayInTimezone(crossDayUtc, 'Asia/Tokyo'), '2026-11-21')
    assert.match(formatDayInTimezone(clock.now(), 'Invalid/Timezone'), /^\d{4}-\d{2}-\d{2}$/)

    const store = await createModelAccountingStore({ dbPath, pricesFile, clock })
    const logs: string[] = []
    const log = createLogger({
      write: (line) => logs.push(line),
      now: () => clock.now(),
      secrets: () => ['sk-secret1234567890abcdef'],
    })

    const calls: Array<{ system: string; user: string; maxOutputTokens: number }> = []
    let failWith: Error | null = null
    const llm: DetailedLlmClient = {
      async completeDetailed(req) {
        calls.push(req)
        if (failWith !== null) throw failWith
        return {
          text: 'summary result',
          tokens: 1500,
          usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
          provider: 'deepseek-official',
          model: 'deepseek-flash',
        }
      },
    }

    let settingsState: RuntimeSettings = {
      agents: { activity: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'low' } },
      timezone: 'Asia/Tokyo',
      accounting: {
        dailyTokenLimit: 10_000,
        dailyCostMicrosLimit: 50_000,
        pluginDailyTokenLimit: 4_000,
        pluginLimits: {
          'alpha-plugin': {
            dailyTokenLimit: 3_000,
            dailyCallsLimit: 2,
            maxOutputTokens: 512,
          },
        },
      },
    }

    const executor = createPluginLlmExecutor({
      llm,
      accounting: store,
      settings: async () => settingsState,
      clock,
      log,
    })

    try {
      // Invalid arguments never touch llm
      await assert.rejects(
        () => executor.complete('', { system: 's', user: 'u', maxOutputTokens: 100 }),
        (err: unknown) => err instanceof BrainError && err.code === 'INVALID_ARGUMENT',
      )
      await assert.rejects(
        () => executor.complete('alpha-plugin', { system: 's', user: 'u', maxOutputTokens: 0 }),
        (err: unknown) => err instanceof BrainError && err.code === 'INVALID_ARGUMENT',
      )
      await assert.rejects(
        () => executor.complete('alpha-plugin', { system: 's', user: 'u', maxOutputTokens: 16385 }),
        (err: unknown) => err instanceof BrainError && err.code === 'INVALID_ARGUMENT',
      )
      await assert.rejects(
        () => executor.complete('alpha-plugin', { system: 123 as unknown as string, user: 'u', maxOutputTokens: 100 }),
        (err: unknown) => err instanceof BrainError && err.code === 'INVALID_ARGUMENT',
      )
      assert.equal(calls.length, 0)

      // Normal call clamps maxOutputTokens to pluginLimits['alpha-plugin'].maxOutputTokens (512)
      const secretPrompt = 'CONFIDENTIAL_PROMPT_TEXT_XYZ sk-secret1234567890abcdef'
      const out = await executor.complete('alpha-plugin', {
        system: secretPrompt,
        user: 'USER_PRIVATE_INPUT_ABC',
        maxOutputTokens: 2048,
      })
      assert.deepEqual(out, { text: 'summary result', tokens: 1500 })
      assert.equal(calls.length, 1)
      assert.equal(calls[0]?.maxOutputTokens, 512)

      // Recorded under Tokyo date 2026-11-21
      const alphaUsage = await store.todayUsage('2026-11-21', 'alpha-plugin')
      assert.equal(alphaUsage.tokens, 1500)
      assert.equal(alphaUsage.calls, 1)

      // Second call succeeds -> total 3000 tokens, 2 calls
      await executor.complete('alpha-plugin', { system: 'sys', user: 'usr', maxOutputTokens: 256 })
      assert.equal(calls.length, 2)
      assert.equal(calls[1]?.maxOutputTokens, 256)

      // Third call hits pluginLimits['alpha-plugin'].dailyTokenLimit (3000) & dailyCallsLimit (2) -> RATE_LIMITED without calling llm
      await assert.rejects(
        () => executor.complete('alpha-plugin', { system: secretPrompt, user: 'u', maxOutputTokens: 100 }),
        (err: unknown) => err instanceof BrainError && err.code === 'RATE_LIMITED',
      )
      assert.equal(calls.length, 2)

      // Calls limit alone (token limit high)
      settingsState = {
        ...settingsState,
        accounting: {
          dailyTokenLimit: 100_000,
          pluginLimits: {
            'calls-capped': { dailyCallsLimit: 1, dailyTokenLimit: 100_000 },
          },
        },
      }
      await executor.complete('calls-capped', { system: 's', user: 'u', maxOutputTokens: 100 })
      await assert.rejects(
        () => executor.complete('calls-capped', { system: 's', user: 'u', maxOutputTokens: 100 }),
        (err: unknown) => err instanceof BrainError && err.code === 'RATE_LIMITED',
      )
      assert.equal(calls.length, 3)

      // Global dailyTokenLimit blocks another plugin
      settingsState = {
        ...settingsState,
        accounting: {
          dailyTokenLimit: 4500, // already used 1500+1500+1500 = 4500
        },
      }
      await assert.rejects(
        () => executor.complete('beta-plugin', { system: 's', user: 'u', maxOutputTokens: 100 }),
        (err: unknown) => err instanceof BrainError && err.code === 'RATE_LIMITED',
      )
      assert.equal(calls.length, 3)

      // Global dailyCostMicrosLimit blocks when cost reached
      settingsState = {
        ...settingsState,
        accounting: {
          dailyTokenLimit: 1_000_000,
          dailyCostMicrosLimit: 6000, // 3 calls * (1000*1 + 500*2) = 6000 micros
        },
      }
      await assert.rejects(
        () => executor.complete('beta-plugin', { system: 's', user: 'u', maxOutputTokens: 100 }),
        (err: unknown) => err instanceof BrainError && err.code === 'RATE_LIMITED',
      )
      assert.equal(calls.length, 3)

      // Error containing sensitive prompt / secret is NOT leaked to logs
      settingsState = {
        agents: {},
        timezone: 'Asia/Tokyo',
        accounting: { dailyTokenLimit: 1_000_000 },
      }
      failWith = new Error(`upstream failed for Bearer tok_secret_xyz and ${secretPrompt} USER_PRIVATE_INPUT_ABC`)
      await assert.rejects(
        () => executor.complete('gamma-plugin', { system: secretPrompt, user: 'USER_PRIVATE_INPUT_ABC', maxOutputTokens: 100 }),
      )

      const joinedLogs = logs.join('\n')
      assert.equal(joinedLogs.includes('CONFIDENTIAL_PROMPT_TEXT_XYZ'), false)
      assert.equal(joinedLogs.includes('USER_PRIVATE_INPUT_ABC'), false)
      assert.equal(joinedLogs.includes('sk-secret1234567890abcdef'), false)
      assert.equal(joinedLogs.includes('tok_secret_xyz'), false)
    } finally {
      await store.close()
    }
  })
})

test('ledger: byPlugin sorts equal-cost rows by totalTokens DESC then owner ASC', async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'accounting.db')
    const pricesFile = path.join(dir, 'model-prices.json')
    const clock = new FakeClock(Date.UTC(2026, 10, 20, 12, 0, 0))
    const store = await createModelAccountingStore({ dbPath, pricesFile, clock })
    try {
      // Insert in deliberately unsorted order; all three tie-test plugins cost exactly 1_000 micros
      await store.record({
        tAt: clock.now(),
        day: '2026-11-20',
        owner: 'plugin:z-same',
        pluginId: 'z-same',
        agentClass: 'activity',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        usage: { inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })
      await store.record({
        tAt: clock.now() + 1,
        day: '2026-11-20',
        owner: 'plugin:a-same',
        pluginId: 'a-same',
        agentClass: 'activity',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        usage: { inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })
      await store.record({
        tAt: clock.now() + 2,
        day: '2026-11-20',
        owner: 'plugin:m-more-tokens',
        pluginId: 'm-more-tokens',
        agentClass: 'activity',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 10_000, cacheWriteTokens: 0 },
      })
      await store.record({
        tAt: clock.now() + 3,
        day: '2026-11-20',
        owner: 'agent:top',
        agentClass: 'chat',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        usage: { inputTokens: 2_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })
      await store.record({
        tAt: clock.now() + 4,
        day: '2026-11-20',
        owner: 'plugin:low',
        pluginId: 'low',
        agentClass: 'activity',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        usage: { inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      })

      const sum = await store.summary({ day: '2026-11-20' })
      assert.deepEqual(
        sum.byPlugin.map((p) => p.owner),
        ['agent:top', 'plugin:m-more-tokens', 'plugin:a-same', 'plugin:z-same', 'plugin:low'],
      )
    } finally {
      await store.close()
    }
  })
})

test('llm-router: independent plugin dailyTokenLimit, global pluginDailyTokenLimit fallback, prototype keys, and executor timezone persistence', async () => {
  await withTempDir(async (dir) => {
    const dbPath = path.join(dir, 'accounting.db')
    const pricesFile = path.join(dir, 'model-prices.json')
    // 2026-11-20T15:30:00Z -> 2026-11-20 in Asia/Shanghai (+08:00), 2026-11-21 in Asia/Tokyo (+09:00)
    const clock = new FakeClock(Date.UTC(2026, 10, 20, 15, 30, 0))
    const store = await createModelAccountingStore({ dbPath, pricesFile, clock })
    const logs: string[] = []
    const log = createLogger({ write: (line) => logs.push(line), now: () => clock.now() })

    let callCount = 0
    const llm: DetailedLlmClient = {
      async completeDetailed() {
        callCount += 1
        return {
          text: 'ok',
          tokens: 1500,
          usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
          provider: 'deepseek-official',
          model: 'deepseek-flash',
        }
      },
    }

    let settingsState: RuntimeSettings = {
      agents: {},
      timezone: 'Asia/Shanghai',
      accounting: {
        dailyTokenLimit: 1_000_000,
        pluginDailyTokenLimit: 1_500,
        pluginLimits: {
          // High dailyCallsLimit (100) ensures dailyTokenLimit (1_500) is tested independently
          'token-only-plugin': { dailyTokenLimit: 1_500, dailyCallsLimit: 100 },
        },
      },
    }

    const executor = createPluginLlmExecutor({
      llm,
      accounting: store,
      settings: async () => settingsState,
      clock,
      log,
    })

    try {
      // 1. Plugin dailyTokenLimit blocks independently without hitting dailyCallsLimit
      await executor.complete('token-only-plugin', { system: 's', user: 'u', maxOutputTokens: 100 })
      assert.equal(callCount, 1)
      await assert.rejects(
        () => executor.complete('token-only-plugin', { system: 's', user: 'u', maxOutputTokens: 100 }),
        (err: unknown) => err instanceof BrainError && err.code === 'RATE_LIMITED',
      )
      assert.equal(callCount, 1)

      // 2. Unlisted plugin falls back to global accounting.pluginDailyTokenLimit
      await executor.complete('unlisted-plugin', { system: 's', user: 'u', maxOutputTokens: 100 })
      assert.equal(callCount, 2)
      await assert.rejects(
        () => executor.complete('unlisted-plugin', { system: 's', user: 'u', maxOutputTokens: 100 }),
        (err: unknown) => err instanceof BrainError && err.code === 'RATE_LIMITED',
      )
      assert.equal(callCount, 2)

      // 3. Prototype property names (toString / constructor) do not hit Object.prototype
      settingsState = {
        ...settingsState,
        accounting: {
          dailyTokenLimit: 1_000_000,
          pluginDailyTokenLimit: 10_000,
          pluginLimits: {},
        },
      }
      const protoOut = await executor.complete('toString', { system: 's', user: 'u', maxOutputTokens: 100 })
      assert.equal(protoOut.tokens, 1500)
      const ctorOut = await executor.complete('constructor', { system: 's', user: 'u', maxOutputTokens: 100 })
      assert.equal(ctorOut.tokens, 1500)
      assert.equal(callCount, 4)

      // 4. Executor records entries using configured timezone day across midnight boundary
      await executor.complete('tz-shanghai', { system: 's', user: 'u', maxOutputTokens: 100 })
      assert.equal((await store.todayUsage('2026-11-20', 'tz-shanghai')).calls, 1)
      assert.equal((await store.todayUsage('2026-11-21', 'tz-shanghai')).calls, 0)

      settingsState = { ...settingsState, timezone: 'Asia/Tokyo' }
      await executor.complete('tz-tokyo', { system: 's', user: 'u', maxOutputTokens: 100 })
      assert.equal((await store.todayUsage('2026-11-21', 'tz-tokyo')).calls, 1)
      assert.equal((await store.todayUsage('2026-11-20', 'tz-tokyo')).calls, 0)

      clock.set(Date.UTC(2026, 10, 20, 23, 30, 0))
      settingsState = { ...settingsState, timezone: 'America/New_York' }
      await executor.complete('tz-ny', { system: 's', user: 'u', maxOutputTokens: 100 })
      assert.equal((await store.todayUsage('2026-11-20', 'tz-ny')).calls, 1)
      assert.equal((await store.todayUsage('2026-11-21', 'tz-ny')).calls, 0)
    } finally {
      await store.close()
    }
  })
})
