# `@brain-core/plugin-qq`（QQ 通道插件）

Brain Core 的 Clean-Room 原创 QQ 通道插件（`brain.id = "qq"`）采用项目的 [PolyForm Noncommercial License 1.0.0](../../LICENSE)，商业用途须取得版权方的单独授权。它仅依赖 `@brain-core/sdk`、`@brain-core/chat-kit` 与 Node.js 内置模块。

通过标准 **OneBot v11 HTTP + Forward WebSocket** 协议对接外部独立运行的协议端，让 Brain Core 统一的「她」（全局唯一记忆、人格、PAD 情绪与关系图谱）安全长出 QQ 私聊与群聊感官与四肢。

---

## 1. 运行前提与外部协议端

- 本插件**不包含**任何 QQ 客户端或协议端实现；用户需自行独立运行兼容 OneBot v11 的外部协议端（如 **SnowLuma**、**NapCat**、**Lagrange** 等），并确保其暴露：
  - **OneBot v11 HTTP API**（默认 `http://127.0.0.1:3000`）
  - **OneBot v11 Forward WebSocket**（默认 `ws://127.0.0.1:3001`）
- 插件以 `runtime: "process"` 子进程运行在 Node.js 24+ 上，支持 **Linux / macOS / Windows** 跨平台：既可连接本机 `127.0.0.1`，也可跨机连接局域网/ZeroTier 上的协议端（跨机携带 Token 时须使用 `https://` 与 `wss://`）。
- 如需查看超限静态图、GIF 动图拼图（3×2 网格）或启用本地语音发送（`voice.enabled`），需本机安装 `ffmpeg`（可通过 `media.ffmpegPath` 指定绝对路径）；缺少 `ffmpeg` 时图片/GIF 自动优雅降级为文本提示。

---

## 2. 安装与启用步骤

```bash
# 1. 本地安装仓库内的 QQ 通道插件（零外部依赖，支持离线安装）
brain plugin install ./plugins/qq-channel
# 或使用 --yes 跳过交互确认：
brain plugin install ./plugins/qq-channel --yes

# 2. 在 0600 密钥库中写入 OneBot 双 Token
brain secret set plugin.qq.onebot-http-token
brain secret set plugin.qq.onebot-ws-token
```

### 双 Token 与单 Token 协议端说明

- **双 Token（如 SnowLuma）**：分别通过 `brain secret set plugin.qq.onebot-http-token` 和 `brain secret set plugin.qq.onebot-ws-token` 设置。
- **单 Token（如 NapCat / Lagrange）**：只设置 `onebot-http-token` 即可；当 `onebot-ws-token` 未设置时，WebSocket 握手会自动回退使用 `onebot-http-token`。
- **安全边界**：明文 `ws://` / `http://` 携带 Token 时仅限本机回环地址（`127.0.0.1` / `[::1]` / `localhost`）；跨机部署携带密钥必须使用 `https://` 与 `wss://`。

---

## 3. 配置、主人通道与人物合并

在停用插件后（`brain plugin disable qq`），编辑 `$BRAIN_HOME/state/plugins/qq/config.json`，然后重新启用（`brain plugin enable qq`）：

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

1. 在内核全局配置中将主人 QQ 私聊通道 **`qq:private:<ownerQQ>`** 加入 `settings.ownerChannels`，使该通道享有主人通道披露与权限边界。
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
