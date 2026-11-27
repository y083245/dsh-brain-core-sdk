# @dsh-brain-core/sdk

为 Brain Core 开发独立插件的 TypeScript 契约与运行时校验库：包含 `BrainContext`、清单与权限校验、工具定义、记忆记录和请求响应类型，并导出配置 Schema。支持 channel、activity、capability、memory-provider 四类插件。

需要 **Node.js ≥ 24.12**。当前 npm 预览版为 `1.0.2-rc.1`，使用 `next` 标签。SDK 用于编写插件；运行和管理插件使用 `@dsh-brain-core/kernel` 提供的 `brain` CLI。

## 快速开发并发布插件

```sh
npm install -g @dsh-brain-core/kernel@next
npm create brain-plugin@next my-plugin -- --kind capability --yes
cd my-plugin
npm install && npm test
brain plugin check .
```

在生成的 `apply(ctx, config)` 中注册工具，并在 `package.json.brain` 声明所需权限与工具。check 是独立合规检查，安装器不会自动执行它。testkit 用于开发时的离线契约与行为测试。

准备交付时，将 TypeScript 编译到 dist，同时更新 main 和 brain.config，核对 npm pack 产物，然后发布到自己的 npm scope、无 scope npm 包或符合要求的 Git 仓库。当前没有官方插件市场或向官方提交审核的流程。[发布与用户安装指南](guides/publishing.md)覆盖全部产物、依赖限制、确认和升级步骤。

运行时支持 SDK、chat-kit 和不依赖安装脚本的普通生产依赖；宿主注入自己提供的 SDK 与已声明的 chat-kit，不开放其他内部包。

## 开发者指南目录

| 指南 | 内容 |
| --- | --- |
| [总览与快速开始](guides/README.md) | 开发流程与依赖边界 |
| [发布与用户安装](guides/publishing.md) | npm/Git/目录交付、打包、权限确认、升级 |
| [四类插件](guides/kinds.md) | 通道、活动、工具能力、记忆增强 |
| [清单](guides/manifest.md) | 全字段、校验、配置、迁移 |
| [权限](guides/permissions.md) | 普通权限、网络、内网、密钥 |
| [工具](guides/tools.md) | 加载、分组、发送、图片与预算 |
| [进程外插件](guides/process-plugins.md) | stdio JSON-RPC、环境与恢复 |
| [主动消息](guides/proactive-messaging.md) | 通道 opt-in 与可靠投递 |
| [MCP 桥接](guides/mcp.md) | 自带 server 的工具代理与边界 |
| [测试](guides/testing.md) | testkit、契约、check 范围 |
| [合规规则](guides/rules.md) | R1–R10 与作者责任 |
| [API 参考](guides/api.md) | 从 SDK 源码生成的 ctx 接口 |

## 契约与参考产物

| 参考 | 用途 |
| --- | --- |
| [插件清单 JSON Schema](generated/json-schema/BrainManifest.json) | 编辑器补全与结构参考 |
| [Memory HTTP API OpenAPI 3.1](generated/openapi.json) | **仅覆盖 `/api/v1/memory/*` 记忆接口，全部需 Bearer Token 鉴权**；不含控制台插件管理或插件自定义路由 |
| [插件 API 源码](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/src/plugin.ts) | 清单、权限、BrainContext、PluginApply 等定义 |
| [SDK 公开导出](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/src/index.ts) | 可从包直接导入的接口与方法 |
| [testkit](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/testkit/src/index.ts) | 假内核、假通道与契约测试 |
| [console-chat](https://github.com/y083245/dsh-brain-core-sdk/blob/main/plugins/console-chat/src/index.ts) | Node 通道示例 |
| [qq-channel](https://github.com/y083245/dsh-brain-core-sdk/blob/main/plugins/qq-channel/src/apply.ts) | 平台通道与进程外桥接示例 |
| [memory-vector](https://github.com/y083245/dsh-brain-core-sdk/blob/main/plugins/memory-vector/src/index.ts) | 辅助向量索引与记忆 provider |
| [web-reader](https://github.com/y083245/dsh-brain-core-sdk/blob/main/plugins/web-reader/src/index.ts) | 能力工具示例 |

公开 API 参考随包提供。在源码仓库运行 `pnpm --filter create-brain-plugin gen:api` 可重新生成 `packages/sdk/guides/api.md`。

<details>
<summary>在本仓库源码中调试示例插件</summary>

按[公开仓库首页](https://github.com/y083245/dsh-brain-core-sdk)准备工作区依赖，然后在仓库根目录运行：

```sh
node apps/kernel/src/cli.ts plugin check ./plugins/console-chat
```

开发自己的独立插件优先使用上面的 npm 脚手架流程；源码示例用于理解宿主接口与已有平台实现。

</details>
