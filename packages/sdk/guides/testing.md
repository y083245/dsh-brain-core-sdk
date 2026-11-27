# 离线测试与独立合规检查

`@dsh-brain-core/testkit` 提供假内核、假通道和契约测试。它模拟记忆、权限、工具、调度与会话，不需要真实模型或平台服务。假内核的网络、密钥与存储不使用真实环境；**它不会隔离插件自己直接执行的任意代码**。插件仍须遵守经 ctx 访问外部能力的规则。

脚手架已配置 testkit 为开发依赖与 npm test。独立添加时安装与宿主预览版本一致的 `@dsh-brain-core/testkit@next`，SDK 用作生产依赖；最终交付无需携带 testkit。

## 完整工具测试

下面是一个独立测试文件，包含清单、入口和断言：

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrainContext } from '@dsh-brain-core/sdk'
import { createTestKernel, runPluginContractTests } from '@dsh-brain-core/testkit'

const manifest = {
  id: 'hello-kit', kinds: ['capability'], api: '^1.0.0', runtime: 'node',
  permissions: ['tools.register'],
  tools: [{ name: 'hello', effect: 'read', load: 'core', summary: 'Say hello' }],
} as const

function apply(ctx: BrainContext): void {
  ctx.tools.register({
    name: 'hello', description: 'Say hello.',
    parameters: { type: 'object', properties: {} },
    handler: async () => 'hello',
  })
}

test('the registered tool returns hello and unload removes it', async () => {
  const kernel = createTestKernel()
  await kernel.loadPlugin({ apply }, manifest)
  try {
    assert.equal(await kernel.callTool('hello-kit__hello', {}, { channel: 'sample:private:one' }), 'hello')
  } finally {
    await kernel.unload()
  }
  assert.equal(kernel.tools().length, 0)
})

test('the plugin satisfies the contract', async () => {
  for (const result of await runPluginContractTests({ apply }, manifest)) {
    assert.equal(result.ok, true, `${result.name}: ${result.message}`)
  }
})
```

loadPlugin 的第二个参数是 brain 对象，而非整个 package.json。第三个参数可传 config 与 granted；granted 默认清单全部权限，显式设为子集可测试拒绝路径。audience:owner 工具需要 createTestKernel 的 ownerChannels 包含调用通道。

## 时间、网络、密钥与假通道

```ts
import assert from 'node:assert/strict'
import type { BrainContext } from '@dsh-brain-core/sdk'
import { createFakeChannel, createTestKernel } from '@dsh-brain-core/testkit'

const kernel = createTestKernel({ now: 0, ownerChannels: ['sample:private:one'] })
kernel.setSecret('api_token', 'test-token')
kernel.setResponse('https://api.example.com/feed', { status: 200, body: '[]' })
let ticks = 0
await kernel.loadPlugin({
  apply(ctx: BrainContext) {
    ctx.scheduler.every(60_000, () => { ticks += 1 })
  },
}, {
  id: 'ticker', kinds: ['activity'], api: '^1.0.0', runtime: 'node', permissions: [],
})
await kernel.advance(60_000)
assert.equal(ticks, 1)
await kernel.unload()

const channel = createFakeChannel()
channel.setMembers('sample:private:one', ['owner'])
await channel.send('sample:private:one', { text: 'hello' })
assert.equal(channel.sent.length, 1)
```

now/advance 只控制假内核时间，不修改 Date.now()；测试不要断言业务代码 Date.now() 的固定值。setResponse 与 setSecret 只提供测试数据，实际调用仍需对应权限。createFakeChannel 记录 sent 供断言，可作为 channel.provide 的实现。

`kernel.records()` 返回记忆副本；用 layer/kind/channel/content 等字段验证写入。`kernel.useAgent(async (wake, helpers) => ...)` 提供假 agent 回合，可用 helpers.callTool 调用自动绑定当前通道的工具。它不会调用真实模型，不能验证提示词效果或平台发送。

## 契约实际检查什么

runPluginContractTests 返回逐项结果，由调用方断言：manifest、apply（10 秒超时）、tools-registered、no-extra-tools、no-internal-writes（检查 L3 写入尝试）、unload-clean、no-late-register。它验证 apply、声明与注册对应、停用撤销工具/路由/定时器，以及停用后的注册拒绝。

它不自动调用全部工具，不测试参数语义、配置 schema、迁移、平台 API 或每条权限路径。mcp 插件的 tools-registered 被标记为跳过成功，因为假内核不连接 server；仍要实测工具发现与调用。编写自己的拒绝路径、幂等、重试和遗忘处理测试。

## brain plugin check 的真实范围

```sh
npm test
brain plugin check .
brain plugin check --json .
```

| 检查层 | 当前行为 |
| --- | --- |
| 清单 | 读取 package.json.brain，调用 validateManifest；失败则停止后续检查 |
| Node 入口与契约 | 从 main 导入模块，要求 apply，再调用 testkit 契约 |
| Node 静态扫描 | 扫描 .ts/.mts/.js/.mjs；跳过 node_modules、.git、test、tests、__tests__ |
| process 插件 | **仅清单校验，跳过契约测试与静态扫描**；不启动解释器，不验证协议或真实入口 |

静态 must 项检测自建数据库、直接 DSH/Cordis 依赖、读取 DSH home、直接网络、直接文件写入和日志原文等已知模式；prefer-typescript 为 should。must 失败返回 1；should 提醒不会使报告失败；命令行参数或运行异常返回 2。扫描有盲区，不能证明动态 import、拼接模块名或 eval 安全。

check 会导入并执行 Node 插件的代码，应该只对可信代码运行。它不是只读安全审计。清单中的 config/migrations 仅验证路径字符串格式，check 不执行真实配置加载或迁移，不保证产物文件存在。跨平台入口和生产依赖完整性要通过实装验证。

## check 与安装器的区别

check 是开发者独立执行的合规检查，**安装器不会自动运行 check**。安装器检查包结构、清单、API、Node main 路径/存在、符号链接和升级 ID 等，并准备生产依赖；确认、迁移、配置加载和启用另有生命周期步骤。不能把 check 的 must 规则描述成所有安装都会自动拦截的规则。

process 插件请用 Python 或自身语言测试，加上双向 JSON-RPC、握手、回调、退出与重启测试。所有插件发布前仍需在目标系统实际 install → confirm/enable → 调用 → disable → upgrade 验证，流程见[发布指南](publishing.md)。
