# 权限与风险

`brain.permissions` 声明插件需要的能力。安装时展示权限，确认后才授予；`ctx` 对未获批调用抛出 `PERMISSION_DENIED`。只申请当前功能需要的权限，并在发布说明中解释网络目标、记忆读取、发送与模型调用的用途。

## 全部普通权限

| 权限 | 允许的接口与范围 | 需要关注的风险 |
| --- | --- | --- |
| `memory.ingest` | `ctx.memory.ingest` 写 L0，受 source 通道与事件类型约束 | 外部内容标 external，不伪造来源 |
| `memory.record` | `record/update/remove` 操作 L1、L2 | 写入需证据，不可写 L3 |
| `memory.search` | `search`、可选 `readChannelEvent` | 按插件视角过滤；readChannelEvent 仅活动工具调用可读同通道、同来源可见 L0，须原样传 call |
| `memory.context` | `ctx.memory.context` 获取上下文 | 不自行绕过披露策略 |
| `memory.forget` | `ctx.memory.forget` | 可遗忘自己来源/通道的允许范围，按人遗忘不授予插件 |
| `memory.readL0` | `readL0`、`provide` | 仅 memory-provider，可读原始层建索引，须处理遗忘 |
| `memory.writeDerived` | `writeDerived` | 仅 memory-provider，写有证据的衍生 L1 候选 |
| `agent.session` | `ctx.agent.session/wake`、session.rotate | 会触发回合与相应模型消耗；只操作获准的自身通道 |
| `tools.register` | `ctx.tools.register` | 工具名须在清单中，副作用如实声明 |
| `channel.provide` | `ctx.channel.provide` | 提供平台发送、成员和身份实现 |
| `channel.send` | `ctx.channel.send`、effect:send 工具 | 对外发送受审计、频率和通道范围控制 |
| `identity.link` | `ctx.identity.resolve/link` | 账号须带本插件前缀，避免错误绑定身份 |
| `schedule.ownTime` | `ctx.scheduler.ownTime` | 活动调度与打扰控制；every/at 不需要此权限 |
| `llm.invoke` | `ctx.llm.complete` | 经宿主调用并统一记账、限额；服务或模型未配置时可能 UNAVAILABLE |

`source.trust` 不接受 self；不是所有外部来源都能自称 owner。`ctx.storage`、`ctx.logger`、`ctx.events`、路由注册和一般定时器虽没有单列上述权限，仍受路径、命名、生命周期及日志脱敏约束。

## 全部资源权限

| 权限形式 | 含义 |
| --- | --- |
| `network:<host>` | 公网精确域名/IPv4，或 `*.example.com` 的子域名 |
| `network:config:<key>` | 配置字段指定的公网主机，可取字符串或字符串数组 |
| `lan:<host>` | 明确授权一个精确主机，包含内网、回环目标；不允许通配 |
| `lan:config:<key>` | 明确授权配置 URL 的主机，包含内网、回环目标 |
| `secrets:<name>` | `ctx.secrets.get(name)`，只读该名字的密钥 |

主机小写，不含协议、路径或端口。`*.example.com` 不包含裸域 `example.com`；通配基域至少两段且不能是 IP。lan 支持方括号 IPv6，如 `lan:[::1]`。

配置键匹配 `^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$`；这是配置对象上的键，不代表点路径自动展开。`network:config`、`lan:config` 缺 key 会被拒绝。secret 名匹配 `^[a-z][a-z0-9._-]{0,23}$`。未知写法及重复权限均令清单失败。

公网权限不能授权私网访问：宿主会检查目标及解析地址、重定向，防止用外部 URL 绕进内网。连接本地服务必须明确声明 lan；同时需要公网和内网可为同一 config key 分别声明，但要向用户说明扩大的访问范围。HTTP 经 ctx.http.fetch；受控文本 WebSocket 使用可选的 ctx.http.subscribeWebSocket，并绑定顶层配置 URL 键，不能用它任意覆盖目标。

```ts
import { hostAllowed, parsePermission } from '@dsh-brain-core/sdk'

const permission = parsePermission('network:*.example.com')
if (permission.kind === 'network') {
  console.log(hostAllowed(permission.host, 'api.example.com')) // true
  console.log(hostAllowed(permission.host, 'example.com')) // false
}
```

MCP 的 `secret:<name>` 是值引用，`secrets:<name>` 才是权限名。密钥缺失会使依赖它的连接失败；不可将密钥写入清单、源码、日志或交付包。

## 安装、确认与升级

CLI 无交互式确认。`brain plugin install <spec> --yes` 直接确认，之后执行 `brain plugin enable <id>`。不带 --yes 会准备包、展示权限并留下 pending 状态，查看后用 `brain plugin confirm <id>` 确认，再 enable。

升级新增权限时，不带 --yes 会保留旧版，新版等待确认；执行 `brain plugin confirm <id>` 才切换。`brain plugin upgrade <id> <spec> --yes` 同时确认新增权限。无新增权限的升级直接完成；原启停状态保留。权限减少不需要重新授权。

权限确认不是代码安全证明；Node 同进程与 process 子进程都要求审查可信代码。安装器也不会自动运行独立 check。验证步骤见[测试](testing.md)和[发布与交付](publishing.md)。
