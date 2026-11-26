# Brain Core SDK

Brain Core SDK 是一个本地 AI 助手运行时和 TypeScript 插件 SDK。它让同一个助手在控制台、QQ 等通道之间共享身份和记忆，通过权限规则控制每个通道可读取的数据和可调用的工具。

项目提供 `brain` 命令、墨潮（INKTIDE）控制台、本地 SQLite 记忆存储和检索，以及附属 DSH 模型运行时。插件可以接入消息通道、扩展工具能力、运行定时活动或增强记忆检索。

## 从源码部署

支持 macOS、Linux 和 Windows。需要 Git、Node.js 24.12 或更高版本，以及 pnpm 10.28.0。在终端执行以下命令获取源码、安装依赖并构建控制台。

```sh
git clone https://github.com/y083245/dsh-brain-core-sdk.git
cd dsh-brain-core-sdk
pnpm install --frozen-lockfile
pnpm build
```

### 启动控制台

```sh
node apps/kernel/src/cli.ts console
```

打开终端打印的地址，默认是 `http://127.0.0.1:17346`。使用终端打印的令牌登录，在控制台选定角色卡，分别为 `chat` 和 `activity` 配置供应商、模型和思考强度，并填写所需的模型凭据。

### 仅启动 API

```sh
node apps/kernel/src/cli.ts start --port 17345
```

控制台会同时启动内核。如果只需要 API，可单独使用 `start`。两种方式都绑定本机回环地址。持久化数据默认位于用户目录下的 `.brain-core`，可用 `BRAIN_HOME` 指定其他位置。

## SDK 开发者文档

插件快速开始、`BrainContext` API、清单 Schema、HTTP OpenAPI、脚手架和测试工具都可以从 [SDK 开发者指南](packages/sdk/README.md) 找到。

## 授权许可

项目许可采用 **PolyForm Noncommercial License 1.0.0**，版权归 xiaoyuan 所有（© 2026）。许可允许在条款规定的非商业用途下使用、修改和分发项目。**商业用途须取得版权方的单独授权。** 完整条款见 [LICENSE](LICENSE)。

第三方依赖和资源适用各自的许可证，控制台字体的许可见 [OFL.txt](apps/console/web/public/fonts/OFL.txt)。

# 支持打赏入口。个人开发不易，打赏支持项目，十分感谢🙏🙏🙏。后续插件功能将会持续更新。
<img width="226" height="354" alt="dc39a43fd178d2c66b989f56e464239c" src="https://github.com/user-attachments/assets/afad3452-028c-456f-a729-a70740983384" />
<img width="226" height="354" alt="f88d2c9b93426c281f79375c5abfe68a" src="https://github.com/user-attachments/assets/10febd03-7d10-4a8c-956c-642598d3e444" />

