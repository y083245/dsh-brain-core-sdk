# @dsh-brain-core/satellite-host

Brain Core 的附属 DSH 会话与进程管理支持包，提供进程监管、环境与会话隔离、工具桥、模型调用和调试视图接口。
当前预览版 `1.0.1-rc.1`，一般由 `@dsh-brain-core/kernel` 自动引入，无需单独启动。

第三方插件通过 SDK 的 `ctx.agent` 等服务使用宿主能力，不应直接操作 DSH 或依赖本包。
模型及思考强度由用户在内核中选择。

[项目说明](https://github.com/y083245/dsh-brain-core-sdk/blob/main/README.md) ·
[SDK API](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/guides/api.md)

许可协议：PolyForm Noncommercial License 1.0.0，商业用途需另行授权。
