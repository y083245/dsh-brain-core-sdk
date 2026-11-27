# `@dsh-brain-core/plugin-qq`（QQ 通道插件）

Brain Core 的 QQ 通道插件（`brain.id = "qq"`）采用项目的 [PolyForm Noncommercial License 1.0.0](https://github.com/y083245/dsh-brain-core-sdk/blob/main/LICENSE)，商业用途须取得版权方的单独授权。它基于 `@dsh-brain-core/sdk`、`@dsh-brain-core/chat-kit` 与 Node.js 内置模块实现。

通过标准 **OneBot v11 HTTP + Forward WebSocket** 协议对接外部独立运行的协议端，让 Brain Core 统一的「她」（全局唯一记忆、人格、PAD 情绪与关系图谱）安全长出 QQ 私聊与群聊感官与四肢。

---

## 1. 运行前提与外部协议端

- 本插件**不包含**任何 QQ 客户端或协议端实现；用户需自行独立运行兼容 OneBot v11 的外部协议端（如 **SnowLuma**、**NapCat**、**Lagrange** 等），并确保其暴露：
  - **OneBot v11 HTTP API**（默认 `http://127.0.0.1:3000`）
  - **OneBot v11 Forward WebSocket**（默认 `ws://127.0.0.1:3001`）
- 插件以 `runtime: "process"` 子进程运行在 Node.js 24+ 上，支持 **Linux / macOS / Windows** 跨平台：既可连接本机 `127.0.0.1`，也可跨机连接局域网/ZeroTier 上的协议端（跨机携带 Token 时须使用 `https://` 与 `wss://`）。
- 图片缩放与动图抽帧优先复用宿主可选 `sharp`，不可用或解码失败时回退到本地 `ffmpeg`。两者均不可用时，字节预算内图片按原图透传，动图提示仅显示首帧；超预算时降级为文本提示。动图拼图按实际帧数、`media.gifFrames` 与 `media.gifCellPx` 自适应布局（默认抽取 6 帧时为 3×2 网格），并受图像尺寸预算限制。
- 启用本地语音发送（`voice.enabled: true`）须同时安装 **`ffmpeg` 与 `ffprobe`**。通过 `media.ffmpegPath` 指定 `ffmpeg` 绝对路径时，会自动查找同目录下的 `ffprobe` / `ffprobe.exe`；否则从 `PATH` 查找。

---

## 2. 安装与启用步骤

使用 CLI 安装、启停或设置密钥前，须先停止正在运行的 `brain console` / `brain start`。也可以直接在墨潮控制台「印谱」在线安装并启用。

### 方式 1：npm 安装（推荐）

当前 npm 预览版为 `1.0.2-rc.1`（`next`）；正式版 `1.0.0` 将发布到 `latest`。核对来源后执行：

```bash
brain plugin install @dsh-brain-core/plugin-qq@next --yes
brain plugin enable qq
```

`--yes` 表示确认授予插件声明的全部权限。CLI 没有交互确认；不加 `--yes` 会预览权限并进入 `pending`，之后执行 `brain plugin confirm qq` 确认，再执行 `brain plugin enable qq`。确认安装后状态为 `disabled`，不会自动启用。npm 包名为 `@dsh-brain-core/plugin-qq`，插件 ID（`brain.id`）为 `qq`。

### 方式 2：从源码目录本地安装

在仓库根目录执行：

```bash
brain plugin install ./plugins/qq-channel --yes
brain plugin enable qq
```

### 设置协议端 Token

在密钥库中写入 OneBot 双 Token（文件权限为 0600），并按下一节完成配置后重启内核：

```bash
brain secret set plugin.qq.onebot-http-token
brain secret set plugin.qq.onebot-ws-token
```

### 双 Token 与单 Token 协议端说明

- **双 Token（如 SnowLuma）**：分别通过 `brain secret set plugin.qq.onebot-http-token` 和 `brain secret set plugin.qq.onebot-ws-token` 设置。
- **单 Token（如 NapCat / Lagrange）**：只设置 `onebot-http-token` 即可；当 `onebot-ws-token` 未设置时，WebSocket 握手会自动回退使用 `onebot-http-token`。
- **安全边界**：明文 `ws://` / `http://` 携带 Token 时仅限本机回环地址（`127.0.0.1` / `[::1]` / `localhost`）；跨机部署携带密钥必须使用 `https://` 与 `wss://`。

---

## 3. 配置、主人通道与人物合并

使用 CLI 停用、修改配置、启用前，须先停止正在运行的 `brain console` 或 `brain start`。然后执行 `brain plugin disable qq`，编辑 `$BRAIN_HOME/state/plugins/qq/config.json`，执行 `brain plugin enable qq`，改完后再重启内核。墨潮控制台「印谱」支持在线启停，插件配置暂需编辑该 JSON 文件。未设置 `BRAIN_HOME` 时，默认目录为 `~/.brain-core`。

```json
{
  "onebotHttpUrl": "http://127.0.0.1:3000",
  "onebotWsUrl": "ws://127.0.0.1:3001",
  "ownerQQ": "10001",
  "allowPrivate": ["10001"],
  "allowGroups": ["20002"],
  "denyPrivate": [],
  "denyGroups": [],
  "ignoredSenders": [],
  "allowAllWhenEmpty": false,
  "botAliases": ["小鲸鱼"]
}
```

### 访问控制默认 Fail-Closed

- `allowPrivate` / `allowGroups` 默认均为空数组且 `allowAllWhenEmpty: false`，即**默认拒绝所有未列入白名单的私聊与群聊**；黑名单（`denyPrivate` / `denyGroups`）与 `ignoredSenders` 优先级始终高于白名单。
- 仅在明确配置 `ownerQQ` 的对应私聊中，主人发送纯文本快捷命令（`/status`、`/silent`、`/active`、`/reset`）才会生效。

### `ownerChannels` 与控制台人物合并

QQ 插件支持内核主动投递。内核在已配置为主人通道的 QQ 私聊中送达当天的约定提醒，使用插件现有的白名单、外发和出站记忆记录。配置时将主人的 `qq:private:<QQ号>` 加入内核 `ownerChannels`，并添加到插件的 `allowPrivate`。

1. 停止内核后，编辑 `$BRAIN_HOME/state/settings.json` 的 `ownerChannels` 数组，加入 `"qq:private:<ownerQQ>"`；或启动时传入 `--owner-channel qq:private:<ownerQQ>`（适用于 `brain console` / `brain start`）。同时在插件配置中设置 `ownerQQ` 并将其加入 `allowPrivate`，使该通道享有主人通道披露与权限边界。
2. 在墨潮控制台（或身份管理界面）将 **`qq:<ownerQQ>`** 与 **`console-chat:owner`** 合并为同一个 `personId`，从而打通控制台与 QQ 的跨通道记忆与人物关系。

---

## 4. 表情收藏（显式协议动作配置）

不同 OneBot v11 协议端对「收藏表情」动作命名与参数键不统一。为防止猜测不存在或危险动作，插件**默认不猜测动作名**（`stickers.collectAction` 默认为 `""`）：

- 未配置 `stickers.collectAction` 时，调用 `qq__collect_sticker` 会明确提示当前协议端未配置表情收藏动作。
- 若你的协议端提供了对应动作，请在插件配置中显式指定：

```json
{
  "stickers": {
    "enabled": true,
    "collectEnabled": true,
    "collectAction": "collect_custom_face",
    "collectParamKey": "id"
  }
}
```

---

## 5. 工具与只读控制台

- **常驻核心工具**：`qq__send_message`（私聊/群聊）、`qq__set_wake_config`（仅群聊）。
- **上下文与按需工具**：`qq__get_message_images`、`qq__get_forward_msg`、`qq__send_poke`、`qq__get_group_members`、`qq__list_stickers`、`qq__get_sticker_image`、`qq__send_sticker`、`qq__collect_sticker`、`qq__sticker_note`、`qq__list_voices`、`qq__send_voice`、`qq__get_message_detail`。
- **墨潮只读状态页与运维路由**（`sandbox=""` 兼容，零密钥回显）：
  - 页面：`GET /api/v1/plugins/qq/ui`（控制台页面 ID：`qq-status`）
  - 运维 JSON：`GET /api/v1/plugins/qq/status`、`POST /api/v1/plugins/qq/probe`、`GET /api/v1/plugins/qq/channels`、`GET /api/v1/plugins/qq/stickers`
