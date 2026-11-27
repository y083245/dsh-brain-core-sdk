# @dsh-brain-core/chat-kit

Brain Core 通道插件可复用的纯逻辑工具：社交唤醒状态机、消息防抖聚合、已读游标、
消息快照、拟人停顿与话题去重。当前预览版 `1.0.1-rc.1`。

```bash
npm install @dsh-brain-core/chat-kit@next
```

```js
import { computeHumanPauseMs, createReadCursor } from '@dsh-brain-core/chat-kit'

const pauseMs = computeHumanPauseMs('你好')
const cursor = createReadCursor()
cursor.onInbound('my-chat:private:owner', 'message-1', Date.now())
cursor.markRead('my-chat:private:owner', 'message-1', Date.now())
console.log(pauseMs, cursor.get('my-chat:private:owner'))
```

通道可按需使用 `createMessageDebouncer`、`createSocialStateMachine`、`buildMessageSnapshot`
和 `createTopicDeduper`。这些函数不替你发送消息、注册通道或写入记忆；实际副作用通过 SDK `ctx` 完成，
并在插件清单中申请权限。调用方可注入时钟、定时器等，具体类型以公开导出为准。
插件将本包声明为生产依赖后，宿主会注入自己的 `chat-kit`；无需复制内核内部代码。

[通道实现示例](https://github.com/y083245/dsh-brain-core-sdk/blob/main/plugins/console-chat/src/index.ts) ·
[API 指南](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/guides/api.md)

许可协议：PolyForm Noncommercial License 1.0.0，商业用途需另行授权。
