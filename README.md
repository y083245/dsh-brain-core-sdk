# Brain Core SDK

Brain Core SDK 是一个本地 AI 助手运行时和 TypeScript 插件 SDK。它让同一个助手在控制台、QQ 等通道之间共享身份和记忆，通过权限规则控制每个通道可读取的数据和可调用的工具。

项目提供 `brain` 命令、墨潮（INKTIDE）控制台、本地 SQLite 记忆存储和检索，以及附属 DSH 模型运行时。插件可以接入消息通道、扩展工具能力、运行定时活动或增强记忆检索。

> **架构说明**：Brain Core SDK 是一个**独立运行的本地运行时**（内部自带隔离的附属 DSH 沙盒，不会读写你的主 DSH 目录），**不是**安装在 DSH 内部的插件。请不要在 DSH 的插件界面中搜索安装本项目的 npm 包，直接按下方步骤在终端安装 `brain` 本体即可。

---

## 一、安装 Brain 本体

支持 macOS、Linux 和 Windows，需要 **Node.js 24.12 或更高版本**。

### 方式 1：通过 npm 安装（推荐，当前预览版 `1.0.0-rc.1`）

```sh
npm install -g @dsh-brain-core/kernel@next
brain --version
```

> 当前发布在 `next` 预览通道，安装时请在包名后加上 `@next`（正式版 `1.0.0` 发布后可直接安装 `@dsh-brain-core/kernel`）。

### 方式 2：从源码部署

需要 Git、Node.js 24.12+ 与 pnpm 10.28.0：

```sh
git clone https://github.com/y083245/dsh-brain-core-sdk.git
cd dsh-brain-core-sdk
pnpm install --frozen-lockfile
pnpm build
```

> 从源码部署时，下文所有 `brain ...` 命令都可以用 `node apps/kernel/src/cli.ts ...` 替代运行。

---

## 二、启动与首次使用

### 1. 启动墨潮控制台（推荐）

```sh
brain console
```

控制台会自动拉起本地内核，并默认监听本机回环地址 `http://127.0.0.1:17346`（不会对外网暴露）。

打开终端打印的网址，输入终端打印的一次性登录令牌，按顺序完成 3 步初始化：

1. **选择角色卡**：从内置的 4 套出厂人设中选定初始角色（也可后续自定义）。
2. **配置模型与密钥**：进入「设置」，分别为 **`chat`**（对话回复）和 **`activity`**（记忆整理/后台活动）明确选择供应商、模型与思考强度，并填写 API Key。
3. **安装并启用通道插件**：参考下一节安装控制台对话插件（`console-chat`）或 QQ 插件（`qq`），启用后即可开始对话；日常可在控制台查看、检索、审阅或遗忘记忆，并在「设置 → 记忆」调整跨通道记忆共享与自动整理开关。

### 2. 仅启动后台 API（无界面模式）

如果不需要控制台界面，可单独启动内核 API（默认监听 `http://127.0.0.1:17345`）：

```sh
brain start --port 17345
```

> 持久化数据（SQLite 记忆库、配置、插件与密钥库）默认保存在用户目录下的 `~/.brain-core`，可通过设置环境变量 `BRAIN_HOME` 指定其他目录。

---

## 三、安装与管理插件

Brain Core 的插件运行在 Brain Core 自己的插件宿主中，可以通过 **墨潮控制台图形界面** 或 **`brain plugin` 命令行** 直接输入 npm 包名安装。

### 官方插件包列表

| npm 包名（预览版） | 插件 ID | 说明 |
| --- | --- | --- |
| `@dsh-brain-core/plugin-console-chat@next` | `console-chat` | 墨潮控制台内置聊天通道，装完即可在网页里直接对话 |
| `@dsh-brain-core/plugin-qq@next` | `qq` | QQ 私聊/群聊通道（对接 OneBot v11 协议端，支持图片/动图/表情包与主动消息） |
| `@dsh-brain-core/plugin-web-reader@next` | `web-reader` | 网页正文抓取与阅读工具 |
| `@dsh-brain-core/plugin-memory-vector@next` | `memory-vector` | 本地 BVEC 量化向量记忆检索增强 |

### 方式 1：在墨潮控制台安装（最简单）

1. 启动 `brain console` 并登录控制台。
2. 进入 **「印谱」**（插件管理页）→ 点击安装插件。
3. 在「插件来源」输入框填入 npm 包名（例如 `@dsh-brain-core/plugin-console-chat@next` 或 `@dsh-brain-core/plugin-qq@next`），也支持填本地目录路径或 `git+...` 地址。
4. 核对插件申请的权限清单后确认安装，点击开关即可实时启用。

> 若采用「从源码部署」，仓库 `plugins/` 目录下的官方插件会自动出现在「印谱」列表中，直接点击即可一键安装、启用或更新。

### 方式 2：在终端用命令行安装与管理

> 注意：使用命令行修改插件、模型或密钥前，请先停止正在运行的 `brain console` 或 `brain start`。

```sh
# 安装控制台对话插件与 QQ 通道插件（加 --yes 可跳过权限交互确认）
brain plugin install @dsh-brain-core/plugin-console-chat@next
brain plugin install @dsh-brain-core/plugin-qq@next

# 查看、启停、升级与卸载
brain plugin list
brain plugin enable <插件ID>
brain plugin disable <插件ID>
brain plugin upgrade <插件ID> <新npm包名或路径>
brain plugin uninstall <插件ID> --keep-data
```

### QQ 插件接入提示

`@dsh-brain-core/plugin-qq@next` 本身不包含 QQ 客户端，需要你自行运行兼容 OneBot v11 的协议端（如 SnowLuma、NapCat、Lagrange），并配置协议端 Token 与私聊/群聊白名单（默认拒绝未在白名单内的会话）。详细配置步骤请查看 [QQ 插件使用说明](plugins/qq-channel/README.md)。

---

## 四、常用命令速查

```sh
brain --version
brain console [--port 17346] [--api-port 17345] [--cross-channel off|shadow|on]
brain start [--port 17345] [--cross-channel off|shadow|on]
brain model set <chat|activity> --provider <p> --model <m> --effort <e>
brain secret set <name>
brain plugin install|upgrade|enable|disable|uninstall|list|check ...
brain doctor --isolation
```

---

## 五、开发自己的插件（SDK 与脚手架）

使用官方脚手架可以快速创建一个带类型检查、契约测试与静态合规检查的插件项目：

```sh
npm create brain-plugin@next my-plugin -- --kind capability --yes
cd my-plugin
npm install
npm test
brain plugin check .
```

插件开发完整指引、`BrainContext` API、清单 Schema、HTTP OpenAPI 与测试工具详见 [SDK 开发者指南](packages/sdk/README.md)。

---

## 授权许可

项目许可采用 **PolyForm Noncommercial License 1.0.0**，版权归 xiaoyuan 所有（© 2026）。许可允许在条款规定的非商业用途下使用、修改和分发项目。**商业用途须取得版权方的单独授权。** 完整条款见 [LICENSE](LICENSE)。

第三方依赖和资源适用各自的许可证，控制台字体的许可见 [OFL.txt](apps/console/web/public/fonts/OFL.txt)。

# 支持打赏入口。个人开发不易，打赏支持项目，十分感谢🙏🙏🙏。后续插件功能将会持续更新。
<img width="226" height="354" alt="dc39a43fd178d2c66b989f56e464239c" src="https://github.com/user-attachments/assets/afad3452-028c-456f-a729-a70740983384" />
<img width="226" height="354" alt="f88d2c9b93426c281f79375c5abfe68a" src="https://github.com/user-attachments/assets/10febd03-7d10-4a8c-956c-642598d3e444" />
