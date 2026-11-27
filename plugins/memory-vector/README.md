# @dsh-brain-core/plugin-memory-vector

Brain Core 记忆检索提供者（ID `memory-vector`，kind `memory-provider`），使用插件存储内的
`vectors.bvec` 和 `meta.json` 保存量化向量及元数据。当前预览版 `1.0.1-rc.1`。
启动时分页索引原始记忆并通过内核的 provider 接口参与检索，不自行打开内核数据库。

```bash
brain plugin install @dsh-brain-core/plugin-memory-vector@next --yes
brain plugin enable memory-vector
```

需要 `@dsh-brain-core/kernel@next`。默认无需外部服务：使用确定性 `hash-ngram-v1`、256 维的本地 hash embedding；
它不是远程语义模型。若使用 HTTP embedding，先停止内核，编辑
`$BRAIN_HOME/state/plugins/memory-vector/config.json`，再启动，例如：

```json
{
  "endpoint": "http://127.0.0.1:11434/v1",
  "modelName": "your-embedding-model",
  "dimension": 1024,
  "normalized": true,
  "timeoutMs": 15000
}
```

将 `modelName` 和 `dimension` 改为服务实际返回的模型和维度。HTTP 模式使用兼容的 `/embeddings` 接口；
模型、维度与现有索引不匹配会报告 `EMBEDDING_MISMATCH`，需规划索引重建，不能直接混用。
实现还支持 `apiKey` / `apiKeySecret`；当前清单未声明 `secrets:<名称>`，使用 secret 引用前需补充对应权限并重新授权，
否则宿主会拒绝读取。不要把凭据提交到仓库。
此插件未声明配置 schema，配置字段以导出的 `MemoryVectorConfig` 为准。

权限为 `memory.readL0`、`memory.writeDerived`、`network:config:endpoint` 和 `lan:config:endpoint`；
后两项允许访问配置的 embedding 地址，包括经授权的局域网服务。安装前可先不带 `--yes` 查看权限。

[检索实现](https://github.com/y083245/dsh-brain-core-sdk/blob/main/plugins/memory-vector/src/index.ts) ·
[权限指南](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/guides/permissions.md)

许可协议：PolyForm Noncommercial License 1.0.0，商业用途需另行授权。
