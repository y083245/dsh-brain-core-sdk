# 通道插件可选接入主动消息

`source.proactiveMessaging` 默认关闭。希望角色通过你的平台主动联系主人时，显式 opt-in；不开启的通道继续按自己的入站与回复逻辑工作，不参与内核主动投递选路。

## 职责边界

内核负责约定提醒、自主生活节律、记忆挑选、披露过滤、主人通道选择、安静时段、活跃会话保护、未回复守卫和冷却。通道插件负责平台投递、身份解析、成员补全、平台白/黑名单、发送限频和出站记忆。不要为内核主动联系另写一套定时器或角色提示词。

内核只在合适的主动回合暴露 `notify__send`，由模型决定是否开口；没有真实发送的安静回合不应冒充成功投递。

## 1. 声明 opt-in

清单开启 proactiveMessaging 时，validateManifest 要求 kinds 包含 channel、permissions 包含 channel.provide/channel.send，source.channels 至少有一个 kind 为 private 的模式。出站入库另需 memory.ingest；通过 identity.resolve 补成员另需 identity.link。

```json
{
  "id": "mychat",
  "kinds": ["channel"],
  "api": "^1.0.0",
  "runtime": "node",
  "permissions": [
    "channel.provide", "channel.send", "identity.link", "memory.ingest", "agent.session", "network:api.mychat.example"
  ],
  "source": {
    "channels": ["mychat:private:*", "mychat:group:*"],
    "eventKinds": ["mychat.message"],
    "defaultVisibility": "origin",
    "trust": "external",
    "proactiveMessaging": true
  }
}
```

不要使用保留 ID notify、owner-console 等，完整规则见[清单](manifest.md)。群聊模式可以同时存在，但主动投递选路面向已绑定的主人私聊。

## 2. 实现 ChannelProvider

`ctx.channel.provide` 的实现必须覆盖 send/members/resolveIdentity。

- send：先验证目标属于允许的私聊并复用平台白名单、静默状态和限频器，再发送。必须等平台确认非空 messageId；空对象、猜测 ID 或排队成功不算主动投递成功。
- members：返回 personId 列表，使用 identity.resolve 建立平台账号到 personId 的映射。冷启动没有入站 L0 缓存时，内核会调用 members，3 秒超时；不能只返回空数组敷衍真实私聊成员。
- resolveIdentity：平台账号到 `{ displayName? } | null`，不代替 identity 服务的 personId 绑定。

下面是自包含的 Node 接口示例。它演示目标限制、平台结果检查和单条幂等出站记录；实际发布时还应接入平台的认证与限频器，并使 config schema 与 allowPrivate 对齐：

```ts
import { BrainError, type BrainContext } from '@dsh-brain-core/sdk'

interface Config { readonly allowPrivate?: readonly string[] }

export function apply(ctx: BrainContext<Config>): void {
  const allowed = new Set(ctx.config.allowPrivate ?? [])
  ctx.channel.provide({
    async send(channel, message) {
      const match = /^mychat:private:(\S+)$/.exec(channel)
      if (!match || !allowed.has(match[1]!)) {
        throw new BrainError('PERMISSION_DENIED', 'Channel is not allowed')
      }
      const text = message.text?.trim()
      if (!text) throw new BrainError('INVALID_ARGUMENT', 'Text is required')
      const response = await ctx.http.fetch('https://api.mychat.example/v1/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: match[1], text }),
      })
      if (response.status !== 200) throw new BrainError('UNAVAILABLE', 'Platform send failed')
      const data: unknown = JSON.parse(response.text())
      const messageId = data !== null && typeof data === 'object' && 'messageId' in data
        && typeof data.messageId === 'string' ? data.messageId.trim() : ''
      if (!messageId) throw new BrainError('UNAVAILABLE', 'Missing platform message ID')
      const personId = await ctx.identity.resolve(`mychat:${match[1]}`)
      await ctx.memory.ingest({
        kind: 'mychat.message', channel, subjects: [personId], actor: 'self',
        visibility: 'origin', content: { direction: 'outbound', text, messageId },
        tEvent: Date.now(), idempotencyKey: `mychat:outbound:${channel}:${messageId}`,
      })
      return { messageId }
    },
    async members(channel) {
      const match = /^mychat:private:(\S+)$/.exec(channel)
      if (!match) return []
      return [await ctx.identity.resolve(`mychat:${match[1]}`)]
    },
    async resolveIdentity(account) {
      return { displayName: account.replace(/^mychat:/, '') }
    },
  })
}
```

平台成功后写**单条** `actor: 'self'` 的出站 L0，去重键绑定通道与平台 messageId。不要在 provider 和外层回调重复入库；平台回放也须沿用同一去重键。idempotencyKey 只防记忆重复，不会让平台发送自动幂等，平台重试要使用平台支持的幂等机制。

QQ 实现可参考 [qq-channel 的 provider 接入](https://github.com/y083245/dsh-brain-core-sdk/blob/main/plugins/qq-channel/src/apply.ts)与[发送流水线](https://github.com/y083245/dsh-brain-core-sdk/blob/main/plugins/qq-channel/src/outbound/sender.ts)。

## 3. process 插件接入

initialize 响应后发送带 id 的 channel.provide 请求，处理成功响应后发 plugin.ready。持续处理宿主的 channel.send/channel.members/channel.resolveIdentity 请求。channel.send 先完成平台投递，再经 memory.ingest 写出站 L0，并返回 `{ messageId }`。

协议是双向并发的：等待 identity.resolve 或 memory.ingest 的响应时仍要读取其他消息，不能让自己的请求阻塞读循环。stdout 每行 JSON 后 flush；详见[完整进程协议](process-plugins.md)。

## 4. 主人侧配置与选路

插件已启用、声明 opt-in，并且私聊通道列入运行目录 state/settings.json 的 ownerChannels 后，才有资格进入主动候选。主人选择模型与相关开关；插件不硬编码模型或思考强度。

```json
{
  "timezone": "Asia/Shanghai",
  "ownerChannels": ["mychat:private:owner1"],
  "quietHours": [3, 8],
  "proactive": { "ownLife": { "enabled": true } }
}
```

内核主动守卫顺序为 quiet → foreground → unanswered → cooldown。未回复守卫检查上次主动开口；成员与披露仍要按目标私聊解析，不能把其他通道的原文直接搬过来。

默认优先平台为 qq、telegram/tg、feishu。第三方通道参与 own-life 自动投递需近 30 天有真实双向互动，多个合格通道按活跃度排序；到期约定提醒也支持已启用、opt-in、绑定主人的第三方私聊，不要求它先成为默认平台。

## 验证清单

用 validateManifest 测试缺 channel 类型、缺权限、没有 private 模式时的拒绝。用 testkit 模拟平台 HTTP 响应，捕获注册的 provider 并验证成功 messageId、空 ID 失败、目标不允许时拒绝、同 ID 重试只产生一条出站 L0、成员返回 personId。

契约测试检查注册和撤销，不能证明主动选路、守卫、真实平台发送或模型决策。最后在自己的测试宿主中绑定 ownerChannels，分别验证安静时段、未回复、冷启动成员补拉和到期提醒，确保没有重复投递。更多离线工具见[测试](testing.md)。
