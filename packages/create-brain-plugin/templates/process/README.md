# __ID__

由 `create-brain-plugin` 生成的 Brain Core 进程外插件，适用于 npm 预览版 `1.0.2-rc.1`。
通过 stdio 上逐行传输的 JSON-RPC 2.0 与内核通信（protocol v0）。

## 本地运行与检查

需要 Python ≥ 3.11、已安装且位于 PATH 的 `uv`，以及提供 `brain` 命令的
`@dsh-brain-core/kernel@next`（Node.js ≥ 24.12）。首次运行前先同步依赖：

```bash
uv sync --no-dev
uv run --no-sync python main.py
```

每行输入一条 JSON-RPC 消息。`initialize` 握手返回 `{"apiVersion":"1.0.0"}`，
其 `apiVersion` 主版本必须与当前内核完全一致；随后注册 `hello` 工具并发送 `plugin.ready`，
用 `shutdown` 结束。stdout 仅写协议消息，诊断日志应写 stderr。

```bash
brain plugin check .
```

对 `runtime: "process"` 插件，该命令**仅校验 `package.json.brain` 清单**，契约测试和静态扫描均跳过。
通过检查不代表协议实现正确；开发后须自行测试 JSON-RPC 2.0 的握手、工具调用、错误响应、关闭过程，
以及真实内核中的安装启用。增加工具时同步修改 `main.py` 的 `TOOLS` 和 `brain.tools`。

子进程仅继承宿主允许的环境变量白名单，`HOME`/`USERPROFILE` 和 `TMP`/`TEMP`/`TMPDIR`
重定向到插件自己的目录；不要假设能读取宿主的完整环境、主目录或凭据。
插件通过内核提供的 RPC 能力工作，仍需在清单中申请相应权限。

## 发布到 npm / Git

- 默认 `"private": true` 防止误发；发布 npm 前移除此字段，设置自己拥有的包名，例如
  `@your-scope/brain-plugin-__ID__`。包名与 `brain.id` 相互独立。
- 增加 `files` 白名单，包含 `main.py`、`pyproject.toml`、首次 `uv sync` 生成的 `uv.lock` 及实际资源。
  不发布 `.venv`；若有其他 Python 模块，也要包含在包中。
- 无需 Node 构建步骤，但目标机必须装好清单 `brain.process.command` 所需解释器或启动器，本模板为 `uv`。
  安装阶段内核会在存在 `pyproject.toml` 时运行 `uv sync --no-dev`。
- 发布前执行 `npm pack --dry-run` 和 `brain plugin check .`，并完成上述协议与真实安装测试，
  再执行 `npm publish --access public`。不要依赖 npm 的 `postinstall`，npm 生产依赖安装禁用脚本。
- Git 安装时仓库根目录即插件包，必须包含完整清单、Python 文件、锁文件及资源；
  使用公开可获取的 `git+https://...` 地址，建议固定提交。

## 用户安装与启用

使用 CLI 安装、确认、启停或升级前，请先停止正在运行的 `brain console` 或 `brain start`。

```bash
brain plugin install <spec> --yes && brain plugin enable __ID__
```

`<spec>` 可为 npm 包名（可带版本）、符合要求的 `git+https://...` 地址或本地目录；
墨潮控制台「印谱」也支持这些输入。也可先不带 `--yes` 安装以预览权限，
再执行 `brain plugin confirm __ID__` 和 `brain plugin enable __ID__`。
升级使用 `brain plugin upgrade __ID__ <spec> --yes`，再按需执行启用命令。

公开指南：[进程插件](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/guides/process-plugins.md)、
[发布](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/guides/publishing.md)、
[权限](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/guides/permissions.md)。
