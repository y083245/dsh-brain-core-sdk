# @dsh-brain-core/legacy-cleanup

旧 QQ bridge 接入的迁移清理工具，提供清理计划、修改前备份和恢复能力，当前预览版 `1.0.1-rc.1`。
这是可独立使用的维护工具；普通安装 `@dsh-brain-core/kernel` 不需要执行清理。

CLI 为 `brain-legacy-cleanup`，包含 `plan`、`apply`、`restore`。
所有命令必须显式指定 `--dsh-home`；`apply` / `restore` 还需要 `--yes`。
`apply` 先将备份存入 `$BRAIN_HOME/state/legacy-cleanup/<timestamp>/`。
先查看工具的 `--help` 和计划，再决定是否执行修改；本包不是通用的 DSH 删除器。

[项目说明](https://github.com/y083245/dsh-brain-core-sdk/blob/main/README.md)

许可协议：PolyForm Noncommercial License 1.0.0，商业用途需另行授权。
