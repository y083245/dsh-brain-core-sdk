# 插件开发者指南

用 `@dsh-brain-core/sdk` 为 Brain Core 开发通道、活动、工具能力与记忆增强插件。运行环境为 Node.js ≥ 24.12；当前 npm 预览版为 `1.0.1-rc.1`，使用 `next` 标签安装。内核提供 `brain` CLI，SDK 提供契约，testkit 提供离线测试环境。

## 快速开始

先安装内核 CLI（已安装可跳过），再创建独立项目：

```sh
npm install -g @dsh-brain-core/kernel@next
npm create brain-plugin@next my-plugin -- --kind capability --yes
cd my-plugin
npm install
npm test
brain plugin check .
```

脚手架默认生成 `runtime: "node"` 的 TypeScript 插件，入口导出 `apply(ctx, config)`。清单位于 `package.json.brain`；在 `apply` 中经 `ctx` 注册工具、订阅事件或使用记忆服务。最小工具入口：

```ts
import type { BrainContext } from '@dsh-brain-core/sdk'

export function apply(ctx: BrainContext): void {
  ctx.tools.register({
    name: 'hello',
    description: 'Say hello.',
    parameters: { type: 'object', properties: {} },
    handler: async () => 'hello',
  })
}
```

此入口要求清单声明 `tools.register` 和 `name: "hello"` 的工具。先保留生成的清单与契约测试，再逐步扩展功能。不要把示例入口与另一个 `apply` 同时导出。

## 从开发到交付

`npm test` 验证自己的逻辑；`brain plugin check .` 是单独执行的合规检查，会导入 Node 插件、运行假内核契约测试并扫描代码。**安装器不会自动调用 check**，检查通过也不代表安全审计或真实平台验收完成。进程外插件的 check 仅检查清单。

第三方插件直接发布到自己的 npm scope 或无 scope npm 包，也可交付 Git 仓库、远程 tarball 或本地目录。目前没有官方插件市场、在线插件注册表或提交官方审核的流程。完整的编译、打包和用户安装步骤见[发布与安装](publishing.md)。

## 依赖与运行边界

运行时代码可以使用 `@dsh-brain-core/sdk`、`@dsh-brain-core/chat-kit` 和不依赖安装脚本的普通生产依赖。`@dsh-brain-core/testkit` 是开发依赖。不要依赖宿主内部包、Cordis、DSH 模块或宿主私有配置。

安装时会剔除所有 `@dsh-brain-core/*` 生产依赖，由宿主链接 SDK；声明的 chat-kit 也会注入。其他同 scope 包不会注入。普通依赖以 `npm install --ignore-scripts --omit=dev` 安装。Node 插件与宿主同进程；复杂依赖、跨语言或需要独立故障恢复的插件可选择 `process`，它仍不是操作系统安全沙盒。

## 完整导览

| 指南 | 内容 |
| --- | --- |
| [发布与安装](publishing.md) | 第三方发布渠道、产物、依赖、权限确认与升级 |
| [四类插件](kinds.md) | channel、activity、capability、memory-provider |
| [清单](manifest.md) | 字段、校验、配置模块与迁移 |
| [权限](permissions.md) | 全部权限、网络和密钥边界 |
| [工具](tools.md) | 注册、加载、分组、通道、图片与预算 |
| [进程外插件](process-plugins.md) | stdio JSON-RPC 协议、环境与生命周期 |
| [主动消息](proactive-messaging.md) | 通道 opt-in、投递确认、出站记忆 |
| [MCP 桥接](mcp.md) | 插件自带 MCP server 的声明与安全边界 |
| [测试](testing.md) | testkit、契约与独立 check 的真实范围 |
| [合规规则](rules.md) | R1–R10 与验证责任 |
| [API 参考](api.md) | 从 SDK 源码自动生成的 ctx 接口 |
