# 进程外插件：stdio JSON-RPC

脚手架默认 `runtime: "node"`，适合直接使用 SDK 类型、以 testkit 验证的轻量 TypeScript 插件。复杂依赖、跨语言实现或需要独立故障恢复的第三方插件可选 `runtime: "process"`：

```sh
npm create brain-plugin@next my-plugin -- --kind capability --runtime process --yes
```

process 使用独立子进程，故障会撤销注册并限次重启。它与 Node 插件一样经宿主接口检查权限，但独立进程和环境白名单**不构成操作系统安全沙盒**，无法阻止恶意进程自行访问宿主文件或联网。仍需审查可信来源。

## 清单与启动

```json
{
  "id": "my-plugin",
  "kinds": ["capability"],
  "api": "^1.0.0",
  "runtime": "process",
  "process": { "command": "uv", "args": ["run", "--no-sync", "python", "main.py"] },
  "permissions": ["tools.register"],
  "tools": [{ "name": "hello", "effect": "read", "load": "core", "summary": "Say hello" }]
}
```

宿主以 `spawn(command, args, { cwd: 插件目录, shell: false })` 启动。command 不是 shell 命令行，参数须单独填写。Python 脚手架需要目标机有 uv 与 Python ≥ 3.11；包根含 pyproject.toml 时安装期执行 uv sync --no-dev，见[发布指南](publishing.md)。

## 传输和生命周期

UTF-8 stdio，一行一个 JSON-RPC 2.0 对象，每行最多 8 MiB；不是 Content-Length 帧协议，不支持批量数组。stdout 仅用于协议，Python 每次写入后 flush。请求带 id，响应带同一个 id；两个方向会同时存在请求，应持续读取并关联响应，不可在等待自己的响应时阻塞宿主回调。

1. 启动后，宿主请求 initialize，传 apiVersion/pluginId/version/config/permissions。
2. 插件响应 `{ "apiVersion": "1.0.0" }`。返回主版本必须**严格与内核一致**，不是“当前或上一个主版本”。不要返回 caret 范围。
3. 插件用带 id 的普通请求注册工具、通道或 provider，处理响应并确认成功后，发送无 id 的 plugin.ready 通知。宿主等握手与 ready 后完成启用。当前协议层没有统一请求超时，不应依赖它自动处理卡住的初始化。
4. 停用发 shutdown 通知，3 秒未退出会终止进程树。进程退出时所有注册与订阅撤销，未完成 RPC 拒绝。
5. 曾就绪的进程崩溃，按 1/2/4 秒退避重启；60 秒窗口最多重启 3 次，超过后标记失败。初始化失败不走这套就绪后重启流程。

stderr 单独写入 `$BRAIN_HOME/state/plugins/<id>/stderr.log`，上限 1 MiB，超限覆盖，Unix 文件权限 0600，不并入内核日志。即使是这个文件也不应记录聊天原文或密钥。

## 宿主 → 插件：请求

| 方法 | params | result |
| --- | --- | --- |
| `initialize` | apiVersion、pluginId、version、config、permissions | `{ apiVersion }` |
| `tool.invoke` | name（短名）、args、call | ToolOutput：string 或 `{ text, images? }` |
| `channel.send` | channel、message | `{ messageId? }`，主动投递必须有平台确认的非空 ID |
| `channel.members` | channel | personId 字符串数组 |
| `channel.resolveIdentity` | account | `{ displayName? }` 或 null |
| `memoryProvider.search` | query | `{ id, score }[]` |
| `memoryProvider.onRecord` | record | 任意确认结果 |
| `memoryProvider.onForgotten` | ids | 任意确认结果 |
| `memoryProvider.health` | 空对象 | `{ status: "ok"/"degraded"/"down", model?, dimension? }` |
| `schedule.fire` | id | 任意确认结果 |
| `http.request` | routeId、request | 路由数据，由宿主封装 HTTP 响应 |
| `http.wsEvent` | subscriptionId、event | 任意确认结果；通过响应推进 WebSocket 背压 |

进程桥接注册的 MemoryProvider 会转发以上四个 provider 方法，所以 process 实现应全部处理。call 包含 channel、wakeId、可选 callToken，读当前通道事件时原样回传，不能伪造或缓存。

## 宿主 → 插件：通知

| 方法 | params |
| --- | --- |
| `event` | name、payload（由 events.on 订阅） |
| `shutdown` | 无，释放资源后退出 |

通知没有 id，不回响应。http.wsEvent 是请求，不是通知；event 是通知，不要混淆。

## 插件 → 宿主：请求

这些名称是协议的完整方法名，不是任意 ctx 成员都能自动映射。调用转给真实 BrainContext，仍检查权限。除 plugin.ready 外均发送普通请求并处理响应。

| 方法 | params / result 说明 |
| --- | --- |
| `memory.ingest` | `{ event }` → `{ id }` |
| `memory.record` | `{ input }` → MemoryRecord |
| `memory.update` | `{ id, patch, expectedVersion, view? }` |
| `memory.remove` | `{ id, view? }` |
| `memory.search` | `{ request, view? }` |
| `memory.readChannelEvent` | `{ recordId, call }` → `{ record, disclosure }`，仅活动工具调用 |
| `memory.context` | `{ request }` |
| `memory.forget` | `{ selector }` |
| `memory.readL0` | `{ request? }`，request 含 afterId/from/to/limit |
| `memory.writeDerived` | `{ input }` |
| `memory.provide` | 无参数；之后处理 memoryProvider.* 回调 |
| `agent.wake` | `{ channel, input }` → WakeResult |
| `agent.rotate` | `{ channel }`，相当于 session.rotate |
| `tools.register` | `{ name, description, parameters }`；实现通过 tool.invoke 回调 |
| `channel.provide` | 无参数；随后处理 channel.* 回调 |
| `channel.send` | `{ channel, message }` |
| `identity.resolve` | `{ account }` → personId |
| `identity.link` | `{ account, personId }` |
| `scheduler.every` | `{ id, ms }` |
| `scheduler.at` | `{ id, timeMs }` |
| `scheduler.ownTime` | `{ id, name, everyMs }` |
| `events.on` | `{ name }`；通过 event 通知接收 payload |
| `events.emit` | `{ name, payload }`；name 必须以本插件 ID 加点开头 |
| `http.route` | `{ routeId, method, path }`；请求通过 http.request 回调 |
| `http.fetch` | `{ url, options? }`；options.body 用 base64，result 为 `{ status, headers, base64 }` |
| `http.subscribeWebSocket` | `{ subscriptionId, options }`；options 采用 WebSocketSubscribeOptions |
| `http.unsubscribeWebSocket` | `{ subscriptionId }` |
| `console.page` | `{ id, title, entry }` |
| `secrets.get` | `{ name }` → string 或 null |
| `storage.read` | `{ path }` → `{ base64 }` 或 null |
| `storage.write` | `{ path, base64 }` |
| `storage.remove` | `{ path }` |
| `storage.list` | `{ prefix? }` → 相对路径数组 |
| `logger.log` | `{ level: "info"/"warn"/"error", event, fields? }` |
| `llm.complete` | `{ request }` → `{ text, tokens }` |

http.fetch 的 options.redirect 可选 follow/error；body 即使原本是字符串，也要编码成 base64。WebSocket 是宿主管理的文本订阅：options.configKey 指向经权限验证的顶层配置 URL，auth 支持宿主解析 secrets，事件类型为 open/message/close/error。宿主有消息大小与队列上限，插件要及时响应回调。

## 插件 → 宿主：通知

`plugin.ready` 无参数、无 id。它表示注册完成，不是请求，不等待响应；其他调用不能为了省事改成通知，否则宿主不会执行相应 ctx 操作。

## 错误

BrainError 转成 `{ code: -32000, message, data: { code, details } }`，data.code 是 PERMISSION_DENIED、INVALID_ARGUMENT 等 SDK 错误码。未知方法为 -32601；其他异常转成 INTERNAL 并隐藏原异常文案。按 id 关联失败，不能把错误响应误当成功。

过长、非 JSON 或形状错误的输入行会被丢弃并留下协议诊断，不保证返回错误响应。不要用超大图片试探上限；base64 膨胀后整行仍须低于 8 MiB。

## 环境变量

只继承 PATH/LANG/LC_ALL/TZ；Windows 另继承 SystemRoot/ComSpec/PATHEXT/WINDIR。HOME 与 USERPROFILE 指向 `$BRAIN_HOME/state/plugins/<id>/home`，TMPDIR/TEMP/TMP 指向同级 tmp。父环境的模型密钥、平台 token 和自定义变量不会自动传给插件；用 secrets.get 读取获批密钥。

MCP 本地命令可通过 mcp.env 显式设置完整字面值或 config/secret 引用，见[MCP 桥接](mcp.md)。纯 process 清单没有任意 env 字段。

## 最小 Python 协议骨架

以下仅演示握手与退出；搭配无工具、空 permissions 的 process 清单使用：

```python
import json
import sys

def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()

for line in sys.stdin:
    request = json.loads(line)
    if request.get("method") == "initialize":
        send({"jsonrpc": "2.0", "id": request["id"], "result": {"apiVersion": "1.0.0"}})
        send({"jsonrpc": "2.0", "method": "plugin.ready"})
    elif request.get("method") == "shutdown":
        break
```

完整脚手架参考[process 模板](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/create-brain-plugin/templates/process/main.py)。`brain plugin check` 对 process 只验证清单，协议并发、回调、故障恢复和真实平台行为须自行测试，见[测试](testing.md)。
