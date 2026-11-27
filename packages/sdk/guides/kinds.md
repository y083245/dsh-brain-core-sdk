# 四类插件

`brain.kinds` 是非空、去重的类型数组，可以组合类型。`runtime` 与类型独立：四类都可以声明 node 或 process；process 通过协议访问宿主，不会自动得到 Node 的对象接口。

| 类型 | 用途 | 常见接口与权限 |
| --- | --- | --- |
| `channel` | 接入聊天平台、收消息、提供身份/成员和发送实现 | `ctx.channel.provide`、`ctx.identity.resolve`、`ctx.memory.ingest`、`ctx.agent.wake` |
| `activity` | 定时或外部事件触发的活动，如周期读取订阅 | `ctx.scheduler.every/at/ownTime`、`ctx.agent.session/wake` |
| `capability` | 注册供模型调用的工具，如网页读取、天气查询 | `ctx.tools.register`、`ctx.http.fetch` |
| `memory-provider` | 构建辅助索引或提供记忆检索候选 | `ctx.memory.readL0/writeDerived/provide` |

## channel

通道标识形如 `mychat:private:account` 或 `mychat:group:room`，source 前缀必须为插件 ID。通过 `ctx.channel.provide` 提供 `send`、`members`、`resolveIdentity`。`members` 返回 personId；先用 `ctx.identity.resolve('<id>:<account>')` 建立身份，不把平台账号直接当作 personId。

将入站消息经 `ctx.memory.ingest` 写入 L0，再将返回的记录 ID 放入唤醒消息。用 `ctx.agent.wake` 或 `session.wake` 让宿主完成一轮，避免自行组装角色提示词。需要主动联系主人时，按[主动消息](proactive-messaging.md) opt-in。

## activity

`every`、`at` 不需要 `schedule.ownTime` 权限；`ownTime` 需要。定时回调用于采集与活动任务；会话与角色决策仍经 `ctx.agent`。调度器注册随停用撤销，避免自己创建无法追踪的后台循环。

```ts
import type { BrainContext } from '@dsh-brain-core/sdk'

export function apply(ctx: BrainContext): void {
  ctx.scheduler.every(60_000, () => {
    ctx.logger.info('feed.tick', { count: 1 })
  })
}
```

## capability 与写入记忆

纯工具能力可以不提供通道。未声明 source 的能力工具默认可用于所有通道，仍受 `tools.channels` 和 `audience` 限制。

若工具写入记忆，申请 `memory.ingest` 或 `memory.record`，填入自己的 `source.channels` 与 `source.eventKinds`，并把工具副作用设为 `write`。即使没有真实平台，也应使用自己命名空间里的来源通道，例如 `weather:report:local`。声明 source 后工具默认限于自己的来源，面向其他平台时需显式设置 tools.channels。来源通道并不等同于通道发送实现；没有 provider 时不能靠它发消息。

## memory-provider 已可使用

记忆增强插件已接入真实宿主。清单须含 `memory-provider`；`memory.readL0` 和 `memory.writeDerived` 只能由这一类型申请。`ctx.memory.provide` 注册 `MemoryProvider` 并需要 `memory.readL0`。

provider 必须实现 `search(query)`（返回 `{ id, score }` 候选）和 `onForgotten(ids)`（清除对应索引）；可实现 `onRecord(record)` 和 `health()`。检索候选仍由内核读取记录、检查可见性；辅助索引不能成为绕过披露规则的通道。`writeDerived` 写入带证据的衍生 L1 候选，不能写 L3。

以下是只返回空候选的类型完整骨架，不代表有效检索实现：

```ts
import type { BrainContext, MemoryProvider } from '@dsh-brain-core/sdk'

export function apply(ctx: BrainContext): void {
  const provider: MemoryProvider = {
    search: async () => [],
    onForgotten: async () => {},
    health: async () => ({ status: 'ok' }),
  }
  ctx.memory.provide(provider)
}
```

实际索引、重建、模型维度校验与遗忘处理可参考 [memory-vector 源码](https://github.com/y083245/dsh-brain-core-sdk/blob/main/plugins/memory-vector/src/index.ts)。缓存向量与游标可用 ctx.storage 保存；事实、关系和对话原文仍归记忆服务管理。更多权限见[权限表](permissions.md)。
