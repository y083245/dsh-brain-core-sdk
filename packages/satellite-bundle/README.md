# @dsh-brain-core/satellite-bundle

运行于附属 DSH 子进程内的 Brain Core 工具桥及 hardening 补丁。
它将内核授权的工具目录接入 DSH 原生工具表，并逐步校验可用工具面。
当前预览版 `1.0.1-rc.1`，通常由 `@dsh-brain-core/kernel` 通过 `satellite-host` 自动引入与装配。

这是宿主支持包，不是可在「印谱」安装的 Brain 插件；工具桥连接参数由宿主传入。

[项目说明](https://github.com/y083245/dsh-brain-core-sdk/blob/main/README.md)

许可协议：PolyForm Noncommercial License 1.0.0，商业用途需另行授权。
