import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import {
  AccountingApiError,
  createAccountingPageController,
  createHttpAccountingPageApi,
  formatMicros,
  renderAccountingView,
  type AccountingBudgetConfig,
  type AccountingPageApi,
  type AccountingSummary,
  type ModelPriceBook,
} from '../../src/pages/accounting/index.ts'

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly authorization: string | undefined
  readonly body: string
}

async function withTestServer(
  handler: (req: IncomingMessage, res: ServerResponse, recorded: RecordedRequest) => void,
  run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: RecordedRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      requests.push(recorded)
      handler(req, res, recorded)
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${String(address.port)}`

  try {
    await run(baseUrl, requests)
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
}

function sampleSummary(overrides: Partial<AccountingSummary> = {}): AccountingSummary {
  return {
    day: '2026-11-20',
    currency: 'CNY',
    todayTokens: 120_000,
    todayCostMicros: 250_000,
    todayCacheHitRatio: 0.625,
    dailyTokenLimit: 1_000_000,
    dailyCostMicrosLimit: 1_000_000,
    sharedQuotaWarning: false,
    byPlugin: [
      {
        owner: 'agent:chat',
        calls: 10,
        inputTokens: 40_000,
        outputTokens: 10_000,
        cacheReadTokens: 50_000,
        cacheWriteTokens: 0,
        totalTokens: 100_000,
        costMicros: 200_000,
        currency: 'CNY',
        unpricedCalls: 0,
      },
      {
        owner: 'plugin:web-reader',
        pluginId: 'web-reader',
        calls: 2,
        inputTokens: 12_000,
        outputTokens: 8_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 20_000,
        costMicros: 50_000,
        currency: 'CNY',
        unpricedCalls: 0,
      },
    ],
    dailyTrend: [
      { day: '2026-11-19', calls: 5, totalTokens: 60_000, costMicros: 120_000, currency: 'CNY' },
      { day: '2026-11-20', calls: 12, totalTokens: 120_000, costMicros: 250_000, currency: 'CNY' },
    ],
    ...overrides,
  }
}

function samplePrices(overrides: Partial<ModelPriceBook> = {}): ModelPriceBook {
  return {
    version: 1,
    currency: 'CNY',
    models: {
      'deepseek-official/deepseek-flash': {
        inputPerMillion: 1,
        outputPerMillion: 2,
        cacheReadPerMillion: 0.1,
        cacheWritePerMillion: 1,
      },
    },
    ...overrides,
  }
}

test('createHttpAccountingPageApi covers 4 routes, Bearer auth, and envelope errors', async () => {
  const expectedSummary = sampleSummary()
  const expectedPrices = samplePrices()
  const expectedBudget: AccountingBudgetConfig = {
    dailyTokenLimit: 500_000,
    dailyCostMicrosLimit: 2_000_000,
    pluginDailyTokenLimit: 50_000,
  }

  await withTestServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET' && req.url === '/api/v1/console/accounting/summary?days=30') {
      res.end(JSON.stringify({ ok: true, data: expectedSummary, meta: { requestId: 'req-1' } }))
      return
    }
    if (req.method === 'GET' && req.url === '/api/v1/console/accounting/prices') {
      res.end(JSON.stringify({ ok: true, data: expectedPrices, meta: { requestId: 'req-2' } }))
      return
    }
    if (req.method === 'PUT' && req.url === '/api/v1/console/accounting/prices') {
      res.end(JSON.stringify({ ok: true, data: expectedPrices, meta: { requestId: 'req-3' } }))
      return
    }
    if (req.method === 'PUT' && req.url === '/api/v1/console/accounting/budget') {
      res.end(JSON.stringify({ ok: true, data: expectedBudget, meta: { requestId: 'req-4' } }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'missing', details: {} },
      meta: { requestId: 'req-404' },
    }))
  }, async (baseUrl, requests) => {
    const api = createHttpAccountingPageApi(`${baseUrl}/`, 'console-secret-tok')

    const sum = await api.getSummary(30)
    assert.deepEqual(sum, expectedSummary)

    const prices = await api.getPrices()
    assert.deepEqual(prices, expectedPrices)

    const savedPrices = await api.savePrices(expectedPrices)
    assert.deepEqual(savedPrices, expectedPrices)

    const savedBudget = await api.saveBudget(expectedBudget)
    assert.deepEqual(savedBudget, expectedBudget)

    assert.deepEqual(
      requests.map((r) => ({ method: r.method, url: r.url, authorization: r.authorization })),
      [
        { method: 'GET', url: '/api/v1/console/accounting/summary?days=30', authorization: 'Bearer console-secret-tok' },
        { method: 'GET', url: '/api/v1/console/accounting/prices', authorization: 'Bearer console-secret-tok' },
        { method: 'PUT', url: '/api/v1/console/accounting/prices', authorization: 'Bearer console-secret-tok' },
        { method: 'PUT', url: '/api/v1/console/accounting/budget', authorization: 'Bearer console-secret-tok' },
      ],
    )
    assert.deepEqual(JSON.parse(requests[2]!.body), expectedPrices)
    assert.deepEqual(JSON.parse(requests[3]!.body), expectedBudget)
  })

  await withTestServer((_req, res) => {
    res.statusCode = 401
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      ok: false,
      error: { code: 'UNAUTHENTICATED', message: 'bad token', details: {} },
      meta: { requestId: 'req-auth' },
    }))
  }, async (baseUrl) => {
    const api = createHttpAccountingPageApi(baseUrl, 'wrong')
    await assert.rejects(
      () => api.getSummary(),
      (err: unknown) => err instanceof AccountingApiError && err.code === 'UNAUTHENTICATED' && err.status === 401 && err.requestId === 'req-auth',
    )
    await assert.rejects(
      () => api.getPrices(),
      (err: unknown) => err instanceof AccountingApiError && err.code === 'UNAUTHENTICATED',
    )
    await assert.rejects(
      () => api.savePrices(expectedPrices),
      (err: unknown) => err instanceof AccountingApiError && err.code === 'UNAUTHENTICATED',
    )
    await assert.rejects(
      () => api.saveBudget(expectedBudget),
      (err: unknown) => err instanceof AccountingApiError && err.code === 'UNAUTHENTICATED',
    )
  })

  const failingApi = createHttpAccountingPageApi('http://127.0.0.1:1', 'tok', (async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof globalThis.fetch)
  await assert.rejects(
    () => failingApi.getSummary(),
    (err: unknown) => err instanceof AccountingApiError && err.code === 'UNAVAILABLE' && err.status === 0,
  )
})

test('controller manages initial load, period switching (7/14/30), price & budget updates, and errors', async () => {
  const requestedDays: Array<number | undefined> = []
  let currentSummary = sampleSummary()
  let currentPrices = samplePrices()
  let failSave = false

  const api: AccountingPageApi = {
    async getSummary(days) {
      requestedDays.push(days)
      return currentSummary
    },
    async getPrices() {
      return currentPrices
    },
    async savePrices(book) {
      if (failSave) throw new Error('invalid price payload')
      currentPrices = book
      return book
    },
    async saveBudget(budget) {
      if (failSave) throw new Error('invalid budget payload')
      currentSummary = {
        ...currentSummary,
        ...(budget.dailyTokenLimit === undefined ? {} : { dailyTokenLimit: budget.dailyTokenLimit }),
        ...(budget.dailyCostMicrosLimit === undefined ? {} : { dailyCostMicrosLimit: budget.dailyCostMicrosLimit }),
      }
      return budget
    },
  }

  const controller = createAccountingPageController(api)
  const initialHtml = renderAccountingView(controller.state())
  assert.match(initialHtml, /尚未加载花费账本/)
  assert.equal(initialHtml.includes('NaN'), false)
  assert.equal(initialHtml.includes('undefined'), false)

  await controller.load()
  assert.equal(controller.state().days, 7)
  assert.deepEqual(requestedDays, [7])
  assert.equal(controller.state().summary?.todayCostMicros, 250_000)

  await controller.setDays(30)
  assert.equal(controller.state().days, 30)
  assert.deepEqual(requestedDays, [7, 30])

  await controller.setDays(14)
  assert.equal(controller.state().days, 14)
  assert.deepEqual(requestedDays, [7, 30, 14])

  currentSummary = sampleSummary({ todayCostMicros: 320_000 })
  await controller.refresh()
  assert.equal(controller.state().summary?.todayCostMicros, 320_000)
  assert.deepEqual(requestedDays, [7, 30, 14, 14])

  const nextPrices = samplePrices({ currency: 'USD' })
  const savedPricesOk = await controller.savePrices(nextPrices)
  assert.equal(savedPricesOk, true)
  assert.equal(controller.state().prices?.currency, 'USD')
  assert.equal(controller.state().noticeMessage, '价格配置已保存')

  const savedBudgetOk = await controller.saveBudget({ dailyTokenLimit: 250_000, dailyCostMicrosLimit: 500_000 })
  assert.equal(savedBudgetOk, true)
  assert.equal(controller.state().summary?.dailyCostMicrosLimit, 500_000)
  assert.equal(controller.state().noticeMessage, '日限额预算已保存')

  failSave = true
  const failPricesResult = await controller.savePrices(nextPrices)
  assert.equal(failPricesResult, false)
  assert.match(controller.state().errorMessage ?? '', /invalid price payload/)
  const failResult = await controller.saveBudget({ dailyTokenLimit: 100 })
  assert.equal(failResult, false)
  assert.match(controller.state().errorMessage ?? '', /invalid budget payload/)
})

test('renderAccountingView renders Apple glass cards, D17 banners, 3 SVG charts with threshold colors, and escapes XSS', () => {
  assert.equal(formatMicros(1_500_000), '1.50')
  assert.equal(formatMicros(1_234), '0.0012')

  // 1. Shared quota warning + green budget (<80%)
  const greenHtml = renderAccountingView({
    summary: sampleSummary({ sharedQuotaWarning: true, todayCostMicros: 400_000, dailyCostMicrosLimit: 1_000_000 }),
    prices: samplePrices(),
    budget: null,
    days: 7,
    loading: false,
    savingPrices: false,
    savingBudget: false,
    errorMessage: null,
    noticeMessage: null,
  })
  assert.ok(greenHtml.includes('class="glass-card"'))
  assert.ok(greenHtml.includes('class="accounting-kpi-grid"'))
  assert.ok(greenHtml.includes('未配置独立 API Key，当前与主 DSH 共用配额'))
  assert.ok(greenHtml.includes('data-chart="budget-meter"'))
  assert.ok(greenHtml.includes('data-tone-color="#30D158"'))
  assert.ok(greenHtml.includes('data-chart="plugin-cost-breakdown"'))
  assert.ok(greenHtml.includes('data-table="plugin-cost-table"'))
  assert.ok(greenHtml.includes('data-owner="plugin:web-reader"'))
  assert.ok(greenHtml.includes('data-plugin-id="web-reader"'))
  assert.ok(greenHtml.includes('data-chart="daily-cost-trend"'))
  assert.ok(greenHtml.includes('data-form="price-book"'))
  assert.ok(greenHtml.includes('data-form="budget-limits"'))
  assert.equal(greenHtml.includes('sk-'), false)
  assert.equal(greenHtml.includes('apiKey'), false)

  // 2. Dedicated quota shield + amber (80-99%) + red (>=100%)
  const amberHtml = renderAccountingView({
    summary: sampleSummary({ sharedQuotaWarning: false, todayCostMicros: 850_000, dailyCostMicrosLimit: 1_000_000 }),
    prices: samplePrices(),
    budget: null,
    days: 14,
    loading: false,
    savingPrices: false,
    savingBudget: false,
    errorMessage: null,
    noticeMessage: null,
  })
  assert.ok(amberHtml.includes('data-role="dedicated-quota-shield"'))
  assert.equal(amberHtml.includes('未配置独立 API Key'), false)
  assert.ok(amberHtml.includes('data-tone-color="#FF9F0A"'))

  const redHtml = renderAccountingView({
    summary: sampleSummary({ sharedQuotaWarning: false, todayCostMicros: 1_200_000, dailyCostMicrosLimit: 1_000_000 }),
    prices: samplePrices(),
    budget: null,
    days: 30,
    loading: false,
    savingPrices: false,
    savingBudget: false,
    errorMessage: null,
    noticeMessage: null,
  })
  assert.ok(redHtml.includes('data-tone-color="#FF453A"'))

  // 3. Full HTML escaping against XSS across all dynamic fields
  const xssPayload = '<script>alert("xss")</script>'
  const xssAttr = '" onmouseover="alert(1)'
  const xssHtml = renderAccountingView({
    summary: sampleSummary({
      day: `2026-11-20${xssPayload}`,
      currency: `CNY${xssPayload}`,
      byPlugin: [
        {
          owner: `plugin:${xssAttr}`,
          pluginId: `plug${xssPayload}`,
          calls: 1,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 150,
          costMicros: 200,
          currency: `CNY${xssPayload}`,
          unpricedCalls: 1,
        },
      ],
      dailyTrend: [
        { day: `11-20${xssPayload}`, calls: 1, totalTokens: 150, costMicros: 200, currency: `CNY${xssPayload}` },
      ],
    }),
    prices: samplePrices({
      currency: `CNY${xssPayload}`,
      models: {
        [`provider/${xssPayload}`]: {
          inputPerMillion: 1,
          outputPerMillion: 2,
          cacheReadPerMillion: 0.1,
          cacheWritePerMillion: 1,
        },
      },
    }),
    budget: null,
    days: 7,
    loading: false,
    savingPrices: false,
    savingBudget: false,
    errorMessage: `err${xssPayload}`,
    noticeMessage: `ok${xssPayload}`,
  })
  assert.equal(xssHtml.includes('<script>'), false)
  assert.equal(xssHtml.includes('onmouseover="alert(1)"'), false)
  assert.equal(xssHtml.includes(xssAttr), false)
  assert.ok(xssHtml.includes('<td class="mono">plugin:&quot; onmouseover=&quot;alert(1)</td>'))
  assert.ok(xssHtml.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'))

  // 4. 30-day full daily trend keeps every bar within SVG viewBox="0 0 480 154"
  const thirtyDays = Array.from({ length: 30 }, (_, idx) => ({
    day: `2026-11-${String(idx + 1).padStart(2, '0')}`,
    calls: 1,
    totalTokens: 10_000 + idx * 100,
    costMicros: 20_000 + idx * 500,
    currency: 'CNY',
  }))
  const thirtyDayHtml = renderAccountingView({
    summary: sampleSummary({ dailyTrend: thirtyDays }),
    prices: samplePrices(),
    budget: null,
    days: 30,
    loading: false,
    savingPrices: false,
    savingBudget: false,
    errorMessage: null,
    noticeMessage: null,
  })
  const trendSvgMatch = /<svg[^>]*data-chart="daily-cost-trend"[^>]*>([\s\S]*?)<\/svg>/.exec(thirtyDayHtml)
  assert.ok(trendSvgMatch !== null)
  const rectMatches = [...trendSvgMatch[1]!.matchAll(/<rect x="(\d+)" y="\d+" width="(\d+)"/g)]
  assert.equal(rectMatches.length, 30)
  for (const rect of rectMatches) {
    const x = Number(rect[1])
    const width = Number(rect[2])
    assert.ok(x >= 0, `bar x=${String(x)} must be >= 0`)
    assert.ok(x + width <= 480, `bar right edge ${String(x + width)} must stay within viewBox 480`)
  }
})
