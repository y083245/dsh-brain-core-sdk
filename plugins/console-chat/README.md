# @dsh-brain-core/plugin-console-chat

墨潮控制台聊天通道插件（ID `console-chat`，kind `channel`），提供「与她对话」页面、入站消息、
身份关联、记忆写入、会话唤醒与 `send_message` 工具。当前预览版 `1.0.1-rc.1`。

```bash
brain plugin install @dsh-brain-core/plugin-console-chat@next --yes
brain plugin enable console-chat
brain console
```

需要已安装 `@dsh-brain-core/kernel@next`。也可在控制台「印谱」中安装同名 npm 包，
确认权限后启用。默认通道为 `console-chat:private:owner`，无需插件配置或外部聊天服务；
也支持 `console-chat:group:<id>`。

权限包括 `channel.provide`、`channel.send`、`agent.session`、`memory.ingest`、`identity.link`、`tools.register`。
消息记录为 `console-chat.message`，来源信任为 `owner`，默认可见性为 `subject`。
页面历史列表保存在插件运行期间的内存中；记忆通过内核管理。
插件还注册 `/messages`（GET / POST）和 `/ui`（GET），由宿主挂载在 `/api/v1/plugins/console-chat/` 下。

[开发者指南](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/guides/README.md) ·
[权限指南](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/guides/permissions.md)

许可协议：PolyForm Noncommercial License 1.0.0，商业用途需另行授权。
