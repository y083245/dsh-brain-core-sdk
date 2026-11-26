import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createSatellitePageController,
  renderSatellitePage,
  type AgentProcessStatus,
  type IsolationDoctorStatus,
  type SatellitePageApi,
  type SatelliteSnapshot,
} from '../../src/pages/satellite/index.ts'

function baseProcess(agentClass: 'chat' | 'activity', overrides: Partial<AgentProcessStatus> = {}): AgentProcessStatus {
  return {
    agentClass,
    status: 'stopped',
    activeSessions: 0,
    selection: null,
    deniedApprovals: 0,
    ...overrides,
  }
}

function baseSnapshot(overrides: Partial<SatelliteSnapshot> = {}): SatelliteSnapshot {
  return {
    processes: {
      chat: baseProcess('chat'),
      activity: baseProcess('activity'),
    },
    sessions: [],
    isolation: { ok: true, checkedAt: 1700000000000, problems: [] },
    metrics: [],
    sharedQuotaWarning: false,
    ...overrides,
  }
}

test('initial state renders unloaded card without NaN or undefined', () => {
  const api: SatellitePageApi = {
    async getSnapshot() { return baseSnapshot() },
    async restart() {},
    async runIsolationDoctor() { return { ok: true, checkedAt: 0, problems: [] } },
  }
  const controller = createSatellitePageController(api)
  const state = controller.state()

  assert.equal(state.snapshot, null)
  assert.equal(state.summary.empty, true)
  assert.deepEqual(state.displayPhase, { chat: 'idle', activity: 'idle' })
  assert.equal(state.errorMessage, null)

  const html = renderSatellitePage(state)
  assert.match(html, /尚未加载运行时快照/)
  assert.match(html, /暂无唤醒指标数据/)
  assert.equal(html.includes('NaN'), false)
  assert.equal(html.includes('undefined'), false)
  assert.equal(html.includes('<svg'), false)
})

test('recovery phase transitions through crashing -> restarting -> recovered -> running, plus failed and idle', async () => {
  const queue: SatelliteSnapshot[] = [
    baseSnapshot({
      processes: {
        chat: baseProcess('chat', { status: 'running', recoveryPhase: 'crashing', pid: 101 }),
        activity: baseProcess('activity', { status: 'failed', lastError: 'too many crashes' }),
      },
    }),
    baseSnapshot({
      processes: {
        chat: baseProcess('chat', { status: 'restarting', pid: 101 }),
        activity: baseProcess('activity', { status: 'stopped' }),
      },
    }),
    baseSnapshot({
      processes: {
        chat: baseProcess('chat', { status: 'running', pid: 202 }),
        activity: baseProcess('activity', { status: 'stopped' }),
      },
    }),
    baseSnapshot({
      processes: {
        chat: baseProcess('chat', { status: 'running', pid: 202 }),
        activity: baseProcess('activity', { status: 'stopped' }),
      },
    }),
  ]

  const restartCalls: string[] = []
  const api: SatellitePageApi = {
    async getSnapshot() {
      const next = queue.shift()
      if (!next) throw new Error('no more snapshots')
      return next
    },
    async restart(agentClass) {
      restartCalls.push(agentClass)
      queue.push(
        baseSnapshot({
          processes: {
            chat: baseProcess('chat', { status: 'running', pid: 303 }),
            activity: baseProcess('activity', { status: 'stopped' }),
          },
        }),
      )
    },
    async runIsolationDoctor() {
      return { ok: true, checkedAt: 1700000000000, problems: [] }
    },
  }

  const controller = createSatellitePageController(api)

  await controller.refresh()
  assert.equal(controller.state().displayPhase.chat, 'crashing')
  assert.equal(controller.state().displayPhase.activity, 'failed')
  let html = renderSatellitePage(controller.state())
  assert.match(html, /崩溃中/)
  assert.match(html, /连续失败已停止/)
  assert.match(html, /too many crashes/)

  await controller.refresh()
  assert.equal(controller.state().displayPhase.chat, 'restarting')
  assert.equal(controller.state().displayPhase.activity, 'idle')
  html = renderSatellitePage(controller.state())
  assert.match(html, /重启中/)
  assert.match(html, /空闲未启动/)

  await controller.refresh()
  assert.equal(controller.state().displayPhase.chat, 'recovered')
  html = renderSatellitePage(controller.state())
  assert.match(html, /已恢复/)

  await controller.refresh()
  assert.equal(controller.state().displayPhase.chat, 'running')
  html = renderSatellitePage(controller.state())
  assert.match(html, /运行中/)

  await controller.restart('chat')
  assert.deepEqual(restartCalls, ['chat'])
  assert.equal(controller.state().displayPhase.chat, 'recovered')
  html = renderSatellitePage(controller.state())
  assert.match(html, /已恢复/)
})

test('renders model selection missing prompt and selected model details', async () => {
  const api: SatellitePageApi = {
    async getSnapshot() {
      return baseSnapshot({
        processes: {
          chat: baseProcess('chat', { selection: null }),
          activity: baseProcess('activity', {
            status: 'running',
            pid: 999,
            activeSessions: 2,
            deniedApprovals: 1,
            selection: { provider: 'deepseek-official', model: 'deepseek-flash', effort: 'high' },
          }),
        },
      })
    },
    async restart() {},
    async runIsolationDoctor() { return { ok: true, checkedAt: 0, problems: [] } },
  }

  const controller = createSatellitePageController(api)
  await controller.refresh()
  const html = renderSatellitePage(controller.state())

  assert.match(html, /模型未选择/)
  assert.match(html, /请前往设置选择模型与思考强度/)
  assert.match(html, /deepseek-official \/ deepseek-flash \/ high/)
  assert.match(html, /999/)
})

test('renders sharedQuotaWarning only when true and updates isolation doctor problems', async () => {
  const doctorResult: IsolationDoctorStatus = {
    ok: false,
    checkedAt: 1700000001000,
    problems: ['DSH_HOME leak detected', 'missing sandbox isolation'],
  }
  let sharedQuota = true

  const api: SatellitePageApi = {
    async getSnapshot() {
      return baseSnapshot({ sharedQuotaWarning: sharedQuota })
    },
    async restart() {},
    async runIsolationDoctor() {
      return doctorResult
    },
  }

  const controller = createSatellitePageController(api)
  await controller.refresh()
  let html = renderSatellitePage(controller.state())
  assert.match(html, /与主 DSH 共用配额/)
  assert.match(html, /隔离检查通过/)

  const res = await controller.runDoctor()
  assert.equal(res.ok, false)
  html = renderSatellitePage(controller.state())
  assert.match(html, /隔离检查发现问题/)
  assert.match(html, /DSH_HOME leak detected/)
  assert.match(html, /missing sandbox isolation/)

  sharedQuota = false
  await controller.refresh()
  html = renderSatellitePage(controller.state())
  assert.equal(html.includes('与主 DSH 共用配额'), false)
})

test('renders empty metrics state without SVG or NaN, and renders three SVG charts + session warnings when populated', async () => {
  let populated = false
  const api: SatellitePageApi = {
    async getSnapshot() {
      if (!populated) return baseSnapshot()
      return baseSnapshot({
        sessions: [
          { sessionId: 'sess-normal', channel: 'console-chat:private:u1', agentClass: 'chat', toolCount: 10 },
          { sessionId: 'sess-heavy', channel: 'console-chat:group:g1', agentClass: 'chat', toolCount: 20 },
        ],
        metrics: [
          {
            wakeId: 'w1',
            channel: 'console-chat:private:u1',
            agentClass: 'chat',
            profileVersion: 1,
            arrivedAt: 1000,
            firstSendAt: 4300,
            debounceMs: 1500,
            steps: [{ inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 100 }],
            retries: 1,
            outcome: 'acked',
          },
          {
            wakeId: 'w2',
            channel: 'console-chat:private:u1',
            agentClass: 'chat',
            profileVersion: 1,
            arrivedAt: 6000,
            firstSendAt: 8100,
            debounceMs: 1500,
            steps: [
              { inputTokens: 20, outputTokens: 15, cacheReadTokens: 180, cacheWriteTokens: 0 },
              { inputTokens: 10, outputTokens: 10, cacheReadTokens: 190, cacheWriteTokens: 0 },
            ],
            retries: 0,
            outcome: 'acked',
          },
        ],
      })
    },
    async restart() {},
    async runIsolationDoctor() { return { ok: true, checkedAt: 0, problems: [] } },
  }

  const controller = createSatellitePageController(api)
  await controller.refresh()
  let html = renderSatellitePage(controller.state())
  assert.match(html, /暂无唤醒指标数据/)
  assert.equal(html.includes('<svg'), false)
  assert.equal(html.includes('NaN'), false)
  assert.equal(html.includes('undefined'), false)

  populated = true
  await controller.refresh()
  html = renderSatellitePage(controller.state())
  assert.match(html, /data-chart="latency-comparison"/)
  assert.match(html, /data-chart="steps-distribution"/)
  assert.match(html, /data-chart="cache-trend"/)
  assert.match(html, /1800ms/)
  assert.match(html, /1500ms/)
  assert.match(html, /92\.5%/)
  assert.match(html, /sess-normal/)
  assert.match(html, /sess-heavy/)
  assert.match(html, /工具数超阈值告警/)
  assert.equal(html.includes('NaN'), false)
  assert.equal(html.includes('undefined'), false)
})

test('controller captures errors on refresh, restart, and runDoctor, and HTML escapes XSS payloads', async () => {
  let failMode: 'none' | 'refresh' | 'restart' | 'doctor' = 'refresh'
  const api: SatellitePageApi = {
    async getSnapshot() {
      if (failMode === 'refresh') throw new Error('refresh boom')
      return baseSnapshot({
        processes: {
          chat: baseProcess('chat', {
            status: 'failed',
            lastError: '<script>alert(1)</script>',
            selection: { provider: '<img src=x>', model: 'm', effort: 'high' },
          }),
          activity: baseProcess('activity'),
        },
        isolation: {
          ok: false,
          checkedAt: 1700000000000,
          problems: ['<svg onload=alert(2)>'],
        },
        sessions: [
          { sessionId: '<b id="x">s</b>', channel: 'c', agentClass: 'chat', toolCount: 25 },
        ],
      })
    },
    async restart() {
      if (failMode === 'restart') throw new Error('restart boom')
    },
    async runIsolationDoctor() {
      if (failMode === 'doctor') throw new Error('doctor boom')
      return { ok: true, checkedAt: 0, problems: [] }
    },
  }

  const controller = createSatellitePageController(api)
  await controller.refresh()
  assert.equal(controller.state().errorMessage, 'refresh boom')
  assert.match(renderSatellitePage(controller.state()), /refresh boom/)

  failMode = 'restart'
  await controller.restart('chat')
  assert.equal(controller.state().errorMessage, 'restart boom')

  failMode = 'doctor'
  await assert.rejects(() => controller.runDoctor(), /doctor boom/)
  assert.equal(controller.state().errorMessage, 'doctor boom')

  failMode = 'none'
  await controller.refresh()
  assert.equal(controller.state().errorMessage, null)
  const html = renderSatellitePage(controller.state())
  assert.equal(html.includes('<script>'), false)
  assert.equal(html.includes('<img src=x>'), false)
  assert.equal(html.includes('<svg onload=alert(2)>'), false)
  assert.equal(html.includes('<b id="x">'), false)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /data-session-id="&lt;b id=&quot;x&quot;&gt;s&lt;\/b&gt;"/)
})
