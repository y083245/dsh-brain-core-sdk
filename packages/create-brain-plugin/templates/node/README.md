# __ID__

由 `create-brain-plugin` 生成的 Brain Core Node 插件，适用于 npm 预览版 `1.0.2-rc.1`。
需要 Node.js ≥ 24.12，以及提供 `brain` 命令的内核：`npm install -g @dsh-brain-core/kernel@next`。

## 本地开发

```bash
npm install
npm test
npm run typecheck
brain plugin check .
```

开发态 `main` 指向 `src/index.ts`，由 Node 直接运行 TypeScript。`npm test` 使用
`@dsh-brain-core/testkit` 加载假内核，检查清单、注册、卸载与卸载后的注册限制，并调用 `hello`；
有记忆写入权限时还检查写入记录。`brain plugin check .` 额外运行静态规则检查；`notes` 是检查盲区提示。
在源码仓内调试模板时，可临时将 `sdk` 与 `testkit` 依赖指向本地包的绝对 `file:` 路径。

`src/config.ts` 提供 Schemastery schema，内核加载
`$BRAIN_HOME/state/plugins/__ID__/config.json` 时用它校验并填充默认值。
修改配置需先停内核再编辑该文件；控制台自动配置表单将在后续版本接入。
工具必须同时声明在 `brain.tools` 中，并在 `apply` 内注册；仅申请实际使用的权限。

## 构建并发布到 npm / Git

1. 模板默认含 `"private": true` 防止误发布。准备发布 npm 时移除此字段，并将包名改为自己拥有的名字，
   例如 `@your-scope/brain-plugin-__ID__` 或无 scope 包名。npm 包名和 `brain.id` 相互独立。
2. 执行 `npm run build`。现成的 `tsconfig.build.json` 仅编译 `src`，覆盖开发配置的 `noEmit: true`，
   设置 `noEmit: false`、`outDir: "dist"`、`rootDir: "src"`，生成 `dist/index.js`、`dist/config.js`。
   开发配置的 `allowImportingTsExtensions: true` 配合 `rewriteRelativeImportExtensions: true`，
   让相对 `.ts` 导入在输出中变成 `.js`；也可在源码中使用 `.js` 导入。
3. 发布前**同时**将 `package.json` 的 `main` 改为 `./dist/index.js`，`brain.config` 改为 `./dist/config.js`。
   增加 `files` 白名单，包含 `dist` 及实际需要的资源、迁移目录，例如：

   ```json
   {
     "main": "./dist/index.js",
     "files": ["dist", "assets", "migrations"],
     "brain": { "config": "./dist/config.js" }
   }
   ```

   此片段需合并到原配置，保留原有完整 `brain` 清单；未使用的资源目录可以从白名单移除。
4. 宿主只注入 `@dsh-brain-core/sdk` 与 `@dsh-brain-core/chat-kit`；不要依赖该 scope 下的其他内部支持包。
   其他第三方生产依赖走
   `npm install --ignore-scripts --omit=dev`，不能依赖 `postinstall` 生成文件或下载二进制。
   `testkit`、TypeScript 等开发依赖不会在插件安装阶段安装。
5. 发布前运行以下命令，确认包中包含编译产物、资源和完整清单：

   ```bash
   npm test
   npm run typecheck
   npm run build
   npm pack --dry-run
   brain plugin check .
   npm publish --access public
   ```

   `npm pack --dry-run` 只预览文件；`brain plugin check .` 应在入口已切到 `dist` 后再次通过。
   发布 Git 版本时，仓库根目录必须直接是插件包，带有 `package.json.brain`、可运行的 `dist` 与所需资源；
   将编译产物纳入对应 Git 提交，不依赖安装脚本构建。使用公开可获取的 `git+https://...` 地址，建议固定提交。

## 用户安装、启用与升级

使用 CLI 安装、确认、启停或升级前，请先停止正在运行的 `brain console` 或 `brain start`。

```bash
brain plugin install <包名> --yes && brain plugin enable __ID__
```

也可先执行 `brain plugin install <包名>` 预览权限，再执行
`brain plugin confirm __ID__` 和 `brain plugin enable __ID__`。
升级使用 `brain plugin upgrade __ID__ <包名>@<版本> --yes`，再按需执行启用命令。
墨潮控制台「印谱」也可输入 npm 包名、符合要求的 `git+https://...` 地址或本地目录。

公开指南：[发布](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/guides/publishing.md)、
[清单](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/guides/manifest.md)、
[权限](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/guides/permissions.md)、
[测试](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/guides/testing.md)。
