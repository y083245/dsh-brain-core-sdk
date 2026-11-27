# 工具注册、加载与返回值

工具必须在清单 `tools` 声明，并在入口调用 `ctx.tools.register` 注册实现；需要 `tools.register` 权限。注册使用短名，模型看到 `<plugin id>__<name>`。未声明工具的注册会被拒绝；声明却未注册会使普通 Node 插件契约测试失败。MCP 工具由宿主桥接注册，见[MCP](mcp.md)。

## 加载级别与分组

| load | 出现时机 | 清单要求 |
| --- | --- | --- |
| `core` | 适用通道的基础工具面 | 精简常驻工具，关注 core 数量和 token 预算 |
| `context` | 当前唤醒特征匹配时 | `group`、`when` 必填 |
| `onDemand` | 模型搜索后主动加载组 | `group` 必填 |

`groups` 为每组提供 `summary` 与可选 `usage`。模型经 `tools__search` 找到 onDemand 组，再通过 `tools__load` 激活；组的 usage 在激活结果中返回。会话内已加载组只增不减。不要把所有工具都标 core；每类通道的 core 预算包括内置工具，超过 8 个或估算 2,000 token 会标为超预算。估算按每个工具名称、描述、参数 JSON 的 UTF-8 总字节数除以 3 向上取整后求和，属于宿主诊断值。

```json
{
  "tools": [{
    "name": "inspect_media",
    "effect": "read",
    "load": "context",
    "group": "media",
    "summary": "读取当前消息媒体",
    "when": "message.hasMedia || message.hasForward",
    "channels": ["mychat:*"]
  }],
  "groups": { "media": { "summary": "消息媒体", "usage": "只读取当前可见消息。" } }
}
```

## when 表达式

只支持 `message.hasMedia`、`message.hasForward`、`event.poke` 和 `channel.kind == "group"` 这类原子。channel.kind 的值是小写字母、数字、下划线或短横线构成的字符串。用 `&&`、`||` 连接，&& 优先；没有括号、否定、函数调用或任意 JavaScript。when 只允许出现在 context 工具。

hasMedia 也可由消息的 hasMedia 提示触发，不代表图片已预先附带；工具仍需通过受控接口读取实际资源。hasForward 对应转发标记，poke 对应唤醒事件。

## 通道、主人和副作用

`channels` 每项是 `<source>:<kind>`，任意一段可写 `*`。未填写时，有 source 的插件默认仅自己的来源通道；无 source 的能力插件默认所有通道。它限制工具可见与可调用范围，不能扩展插件记忆或发送权限。

`audience: "owner"` 仅允许在主人通道看见和调用，适合敏感工具。不要把它写成工具参数让模型自行选择身份。

| effect | 语义 |
| --- | --- |
| `read` | 只读，不修改状态 |
| `write` | 修改私有状态、记忆或外部世界 |
| `send` | 对外发送消息，必须有 channel.send 权限，接受发送审计与限频 |

send 专属字段 `sendPerMinute` 是正整数，只能收紧宿主上限；`textArg` 指出哪个参数承载外发文字以启用发送文本检查。其他 effect 不允许这两项。onDemand 的 send 也必须走同一检查。发送要通过通道桥接，不能把直接网络发送藏在 read 工具里。

## 自包含注册示例

以下能力插件返回标准图片结果；清单需要声明 `preview`、`effect: read`、合适的 load 和 tools.register。示例图片使用一个完整的 1×1 PNG：

```ts
import type { BrainContext, ToolDefinition } from '@dsh-brain-core/sdk'

const preview: ToolDefinition = {
  name: 'preview',
  description: 'Return a tiny preview image.',
  parameters: { type: 'object', properties: {} },
  async handler(_args, call) {
    return {
      text: `Preview for ${call.channel}`,
      images: [{
        mediaType: 'image/png',
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=',
      }],
    }
  },
}

export function apply(ctx: BrainContext): void {
  ctx.tools.register(preview)
}
```

`handler(args, call)` 的 args 来自模型，类型为未知值字典，应先验证。call 的 `channel`、`wakeId`、可选 `callToken` 由宿主提供，不能信任模型参数覆盖它们。调用可选 `ctx.memory.readChannelEvent(recordId, call)` 时必须原样传 call；令牌与正在执行的工具绑定，不能缓存复用。

## 输出、Schema 与预算

返回 `string` 或 `{ text: string, images?: [{ mediaType, base64 }] }`。一次最多 4 张图片，单张解码后最多 8 MiB；文本超过 65,536 个 JavaScript 字符（UTF-16 码元）会被截断，不是按 UTF-8 字节数计量。作者应提供正确的图片媒体类型与合法 base64。进程外 stdio 每行还有 8 MiB 限制，base64 膨胀会更早撞上协议上限，应主动压缩图片。

parameters 是根类型为 object 的 JSON Schema。优先用 properties、required、type、description、enum、items；宿主会移除下游模型接口不支持的关键字。schema 不替代处理函数对 URL、路径、参数值与返回值的验证。

工具名匹配 `^[a-z][a-z0-9_]{0,30}$`，不得含双下划线。summary 限 60 码点；keywords 最多 16 个、各最多 32 码点；group.usage 最多 2,000 码点。发布后保留动作名稳定，方便审计和用户升级。

写记忆的工具设为 write，并按[清单](manifest.md)登记 source 和权限：ingest 写 L0 时带 kind/channel/subjects/actor/content/tEvent/idempotencyKey；record 写 L1/L2 时带证据。idempotencyKey 按插件 ID 隔离，同 key 重试返回首次记录而不覆盖。类型和完整接口见[API 参考](api.md)。
