# @dsh-brain-core/shared

Brain Core 内部共享工具，导出状态目录访问控制、原子文件操作、ULID 与注入内容扫描函数。
当前预览版 `1.0.2-rc.1`，一般由 `@dsh-brain-core/kernel` 及其依赖自动引入，无需单独安装。

第三方插件应使用 SDK 的 `ctx.storage` 等接口，宿主不会向插件注入此支持包。

[插件 SDK](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/README.md)

许可协议：PolyForm Noncommercial License 1.0.0，商业用途需另行授权。
