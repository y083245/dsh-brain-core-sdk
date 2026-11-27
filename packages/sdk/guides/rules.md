# 插件合规规则 R1–R10

这些规则面向插件作者和审查者。必须遵守不代表安装器已自动覆盖每一项；独立 `brain plugin check` 只检查其中可识别的清单、契约与静态模式，详见[测试范围](testing.md)。人工审查与实装验收仍不可少。

| 编号 | 要求 | 实现与验证 |
| --- | --- | --- |
| R1 | 长期记忆统一经 ctx.memory | 不自建事实、关系或对话数据库。ctx.storage 只放缓存、辅助索引、游标和运行状态；静态 no-own-database 识别已知数据库导入 |
| R2 | 角色会话与人设由宿主管理 | 经 ctx.agent.session/wake 进入回合，不自行拼装角色人格或系统提示词；需要人工审查 |
| R3 | 不直接接触底层 DSH 或宿主内部实现 | 不依赖 @deepseek-ai/*、Cordis，不读写 DSH home、不装 DSH bundle/preset/MCP、不直接调用 DSH 接口；插件 MCP 只经宿主桥接 |
| R4 | 清单完整且真实 | 合法 id/kinds/api/runtime/permissions，source/tools 与实现对应；使用 validateManifest 与契约测试，命名规则见清单指南 |
| R5 | 只用获批能力与明确网络目标 | 经 ctx.http、ctx.secrets、ctx.storage，不绕开授权直接联网或写宿主文件；私网精确授权 lan |
| R6 | 保留来源、证据与披露边界 | 外部输入标 external，不把外部文本当指令、不写 L3；衍生记忆须带证据，记忆增强索引同步处理遗忘 |
| R7 | 工具副作用与外发如实声明 | read/write/send 不能混用；发消息通过通道，send 需要 channel.send，敏感动作限制 owner |
| R8 | 日志与事件不得携带原文和密钥 | 只传 id、计数、枚举；logger 字段过滤不能替代作者自律，不把原文拼进 event 字符串或事件 payload |
| R9 | 数据迁移与升级可恢复 | 使用 SemVer，私有数据采用编号 .mjs 迁移；独立 check 不执行迁移，需自行验证升级失败恢复与重试 |
| R10 | 类型、测试与生命周期完整 | Node 推荐 TypeScript + SDK 类型，保留契约与行为测试；process 用自身语言和协议测试；经 ctx 注册的工具/路由/定时器随停用撤销 |

## 运行时依赖边界

允许使用 `@dsh-brain-core/sdk`、`@dsh-brain-core/chat-kit` 及**不依赖安装脚本的普通生产依赖**。并非“插件只能有 SDK 一个依赖”。testkit、TypeScript 和测试工具属于开发依赖。

安装器会剔除所有 @dsh-brain-core/* 生产依赖，再链接宿主 SDK 和原依赖中声明的 chat-kit；其余内部包不会注入。普通生产依赖安装使用 ignore-scripts/omit=dev，所以不能要求 postinstall、原生编译或安装脚本下载资源。详见[发布与依赖机制](publishing.md)。

## storage 与记忆边界

向量索引、搜索缓存和分页游标可以存在私有 storage；人的偏好、关系、经历与对话原文应进入记忆服务，由宿主执行披露、保留和遗忘。memory-provider 必须处理 onForgotten，避免索引继续持有已遗忘的数据。不得利用缓存或日志留存一份无法遗忘的原文。

## 日志示例

```ts
import type { BrainContext } from '@dsh-brain-core/sdk'

export function apply(ctx: BrainContext): void {
  ctx.logger.info('plugin.enabled', { plugin: ctx.plugin.id, count: 1 })
}
```

fields 只接收 string/number/boolean；content/text/message 等键会被过滤。不要在日志 event、异常文案或 stderr 中另行拼出密钥/聊天原文。内建事件只传 ID 和数量，自定义事件名称以 `<plugin id>.` 开头。

## 发布前自检

先运行 npm test 与 brain plugin check，再检查真正的 npm pack 文件列表，最后实装目标版本。权限说明、配置前置条件、迁移与恢复、平台差异和 process 解释器要求都应写入自己的用户交付说明。

Node 插件与宿主同进程，process 有故障与环境边界但不是操作系统沙盒。静态扫描和权限预览都不能代替代码信任判断；安装器也不会自动执行 check。发布步骤见[发布指南](publishing.md)。
