# create-brain-plugin

Brain Core 插件脚手架，当前 npm 预览版为 `1.0.2-rc.1`（`next`），需要 Node.js ≥ 24.12。
支持 `channel`、`activity`、`capability`、`memory-provider` 四种 kind，以及 Node TypeScript / Python 进程外两种运行时。

```bash
npm create brain-plugin@next my-plugin -- --kind capability --yes
cd my-plugin
npm install
npm test
npm run typecheck
npm run build
brain plugin check .
```

`brain` 命令来自 `npm install -g @dsh-brain-core/kernel@next`。
可用 `--id <id>` 指定清单 ID，默认取目录名；`--yes` 使用默认值并跳过询问。
`--runtime process` 生成 Python ≥ 3.11 模板，需要安装 `uv`，首次先执行 `uv sync --no-dev`；
进程模板的 `brain plugin check .` 只检查清单，不执行契约测试或静态扫描。

模板默认 `private: true`。准备发 npm 时移除此字段，设置自己的包名、`files` 白名单，
Node 模板需构建并同时将 `main` / `brain.config` 改为 `./dist/index.js` / `./dist/config.js`。
生成的 README 包含完整开发、发布与安装步骤。

[开发者指南](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/guides/README.md) ·
[发布指南](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/guides/publishing.md)

许可协议：PolyForm Noncommercial License 1.0.0，商业用途需另行授权。
