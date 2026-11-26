# SDK 开发者指南

`@brain-core/sdk` 提供插件清单、`BrainContext`、记忆记录和 API 请求响应的 TypeScript 契约。插件可声明 `channel`、`activity`、`capability` 或 `memory-provider` 类型。

## 检查现有插件示例

先按仓库首页的部署步骤安装工作区依赖，然后从仓库根目录执行以下命令。检查器会验证清单、生命周期和工具声明，并检查插件代码是否遵守权限规则。

```sh
node apps/kernel/src/cli.ts plugin check ./plugins/console-chat
```

完整示例见 [控制台聊天插件](../../plugins/console-chat)、[QQ 通道](../../plugins/qq-channel)和[本地记忆向量插件](../../plugins/memory-vector)。

## 从脚手架创建插件

以下命令在当前工作区创建一个 TypeScript 能力插件。

```sh
node packages/create-brain-plugin/src/cli.ts ./plugins/hello-plugin --kind capability --yes
```

在生成的 `plugins/hello-plugin/package.json` 中，将 `@brain-core/sdk` 和 `@brain-core/testkit` 的版本改为 `workspace:*`，然后从仓库根目录运行以下命令。

```sh
pnpm install
pnpm --filter hello-plugin test
node apps/kernel/src/cli.ts plugin check ./plugins/hello-plugin
```

插件清单位于 `package.json` 的 `brain` 字段。插件在 `apply(ctx, config)` 中通过 `ctx` 使用工具、记忆、通道和调度能力，所需权限和工具应在清单中声明。进程外插件的入口结构见 [process 模板](../create-brain-plugin/templates/process)。

## API 参考

| 参考 | 内容 |
| --- | --- |
| [插件 API 契约](src/plugin.ts) | `BrainContext`、`PluginApply`、清单、权限和工具定义 |
| [插件清单 JSON Schema](generated/json-schema/BrainManifest.json) | 配置校验和编辑器补全 |
| [HTTP OpenAPI](generated/openapi.json) | 内核 HTTP API 的端点和数据格式 |
| [SDK 的公开导出](src/index.ts) | SDK 包可直接导入的类型和运行时方法 |
| [Testkit](../testkit/src/index.ts) | `runPluginContractTests` 和插件测试工具 |

可从源码生成按 `ctx` 成员组织的 API 参考。运行 `pnpm --filter create-brain-plugin gen:api` 后，在本地打开生成的 `docs/plugin-guide/api.md`。
