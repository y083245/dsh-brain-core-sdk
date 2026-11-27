# @dsh-brain-core/plugin-web-reader

定时读取公开网页的活动插件（ID `web-reader`，kind `activity`）。轮询配置的 URL，
清理网页内容，写入带 L0 证据的 L1 知识记录，并静默唤醒活动会话。当前预览版 `1.0.2-rc.1`。
`feeds` 是页面 URL 列表，不是完整 RSS 订阅解析器。

```bash
brain plugin install @dsh-brain-core/plugin-web-reader@next --yes
brain plugin enable web-reader
```

需要 `@dsh-brain-core/kernel@next`；也可在墨潮「印谱」安装同名包。
先停止内核，编辑 `$BRAIN_HOME/state/plugins/web-reader/config.json`，再启动：

```json
{
  "feeds": ["https://example.com/"],
  "everyMs": 3600000,
  "maxBytes": 262144,
  "maxChars": 4000,
  "timeoutMs": 15000
}
```

默认 `feeds` 为空，不会轮询网页。配置 schema 在加载时校验并填充默认值；控制台自动表单尚未接入。
请求仅允许配置 feeds 对应的公开主机，禁止本地或私有地址；单篇读取也受同样限制。
宿主挂载的 `POST /api/v1/plugins/web-reader/read` 接受 `{ "url": "https://example.com/" }`，
省略 URL 时读取下一项。

权限为 `schedule.ownTime`、`agent.session`、`memory.ingest`、`memory.record`、`network:config:feeds`。
来源通道 `web-reader:feed:default`，默认可见性 `open`、信任 `external`；网页文本按外部不可信内容处理。

[配置与清单](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/guides/manifest.md) ·
[权限](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/guides/permissions.md)

许可协议：PolyForm Noncommercial License 1.0.0，商业用途需另行授权。
