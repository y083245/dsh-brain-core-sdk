# 第三方插件发布与用户安装

当前 npm 预览版为 `1.0.2-rc.1`（`next`）。插件 API 范围写 `^1.0.0`，它与 npm 包的预发布版本号分别管理。先阅读[快速开始](README.md)并准备 Node.js ≥ 24.12 与 `brain` CLI。

## 插件发布到哪儿

目前没有官方插件市场、在线插件注册表，也没有向官方提交审核的流程。推荐直接发布到**你自己的 npm scope**（例如 `@alice/brain-plugin-weather`）或无 scope 包（例如 `brain-plugin-weather`）。scope 包要确保对安装者可访问；公开发布可用 `npm publish --access public`。

也可提供仓库根目录就是插件包的 Git 仓库（`git+https://...` 或 `github:owner/repo`）、远程 `.tgz` URL，或者一个本地插件目录。控制台「印谱」使用同一个安装体系；它不是在线市场。

`package.json.name` 是 npm 包名，`brain.id` 是宿主内的插件身份，两者独立。例如包名 `@alice/brain-plugin-weather`、插件 ID `weather`。安装后启用、确认、卸载均使用 `weather`。升级可以换 npm 包名或来源，但新包的 `brain.id` **必须与已安装 ID 一致**。一个宿主不能把同一 ID 当作两个插件重复安装。

## Node 插件发布前清单

1. 删除脚手架的 `"private": true`，设置自己的包名、SemVer 版本、许可证与说明。
2. 将 TypeScript 编译到 `dist/`，并保留 `export function apply` 或等价命名导出。推荐 ESM：`"type": "module"`。
3. **同时**将 `main` 改为 `./dist/index.js`，将 `brain.config` 改为 `./dist/config.js`；只改 main 会使启用时找不到配置模块。存在 `exports` 时也要对齐产物入口。
4. 用 `files` 白名单收进 `dist`、真正使用的资源与迁移目录；剔除测试、凭据、运行状态与开发机专用配置。
5. 源码若用 `./helper.ts` 导入，编译需改写扩展名，例如开启 `rewriteRelativeImportExtensions: true`。否则输出 JS 仍会寻找未发布的 `.ts` 文件。包导入别名也要在目标运行环境实际可解析。
6. 发布产物不得含符号链接。宿主会拒绝包内符号链接；宿主自己后续创建的 SDK 链接不在此限制内。
7. 自己运行编译与测试，用 `npm pack --dry-run` 核对文件列表，再验证真正的安装产物。

以下是独立 npm 项目的 package.json 示例；`schemastery` 功能可通过 SDK 导出的 `Schema` 使用，无需依赖宿主内部包：

```json
{
  "name": "@alice/brain-plugin-weather",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "files": ["dist", "assets", "migrations"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "node --test \"test/*.test.ts\""
  },
  "dependencies": { "@dsh-brain-core/sdk": "^1.0.2-rc.1" },
  "devDependencies": {
    "@dsh-brain-core/testkit": "^1.0.2-rc.1",
    "@types/node": "24.19.2",
    "typescript": "6.0.3"
  },
  "brain": {
    "id": "weather",
    "kinds": ["capability"],
    "api": "^1.0.0",
    "runtime": "node",
    "permissions": ["tools.register", "network:api.example.com"],
    "config": "./dist/config.js",
    "tools": [
      { "name": "forecast", "effect": "read", "load": "onDemand", "group": "weather", "summary": "查询天气" }
    ],
    "groups": { "weather": { "summary": "天气预报" } }
  }
}
```

字段和权限需与实际实现一致。上例的 `forecast` 必须由入口注册；只有真的包含迁移时才添加 `brain.migrations`。`files` 中没有实际存在的资源目录不会自动生成资源。

`tsconfig.build.json` 可独立写成以下配置，避免继承脚手架仅检查类型的 `noEmit: true`：

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "rewriteRelativeImportExtensions": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

## 安装时怎样处理依赖

宿主先复制或解包，再验证清单、API 兼容性、Node main 的存在与路径，以及包内符号链接。随后从 `dependencies` 中剔除所有 `@dsh-brain-core/*` 包，对剩余普通生产依赖执行：

```sh
npm install --ignore-scripts --omit=dev --no-audit --no-fund
```

如果没有普通生产依赖，则不执行这一步。最后宿主链接注入 `@dsh-brain-core/sdk`；如果原 dependencies 声明了 `@dsh-brain-core/chat-kit`，再注入宿主的 chat-kit。其他 `@dsh-brain-core/*` 内部包一律不会注入，不要依赖它们，也不要把 testkit 当作运行时依赖。

不能要求安装器执行 `postinstall`、`prepare` 或其他构建钩子。依赖原生编译脚本或安装期下载二进制的包可能不可用；应改用不依赖安装脚本的生产依赖，并在目标平台实测。`--omit=dev` 不会提供插件运行需要的开发依赖。安装阶段会执行 npm 依赖准备；“权限预览”不等同于不下载、不解包或不运行任何外部工具。

## Git、本地目录与 tarball 边界

| 来源 | 安装方式与要求 |
| --- | --- |
| npm 包、`@scope/pkg@version` | 宿主通过 `npm pack --ignore-scripts` 获取 tarball。推荐固定版本验证与交付。 |
| `git+https://...`、`github:owner/repo` | 同样走 `npm pack --ignore-scripts`。仓库根目录必须直接是插件包，入口和配置产物提前提交就绪。不会运行 `prepare` 构建；不支持选择 monorepo 子目录。建议固定 tag 或 commit。 |
| `https://example.com/weather.tgz` | 远程 tarball 经过 npm pack 获取并解包，仍需有效 package.json 与完整可运行产物。 |
| `./weather` 或绝对目录路径 | 复制目录，跳过所有名为 `node_modules`、`.git` 的目录，再处理依赖；不是原地运行，也不会同步后续源码修改。 |
| `./weather.tgz` 或本地绝对 `.tgz` 路径 | **不支持直接传入**：会被当作本地目录，随后因不是目录而拒绝。请先自己解压并传入插件目录，或提供远程 URL。 |

所有来源都要满足相同的清单与身份规则。不要假设本地目录里已有的 `node_modules` 会随包带过去。以 `-` 开头的 spec 会被拒绝。

## 进程外插件的发布注意点

`runtime: "process"` 要声明 `process.command` 和参数数组，工作目录是安装后的插件包目录，以 `shell: false` 启动。把脚本与资源完整打进包；目标机需自行准备命令对应的解释器与工具，例如脚手架 Python 插件所需的 `uv` 和 Python ≥ 3.11。宿主不会自动安装系统解释器。

包根目录含 `pyproject.toml` 时，安装准备阶段自动执行 `uv sync --no-dev`。即使插件尚未被确认，也已进行该依赖准备。应交付可复现的 Python 依赖配置，并在目标系统验证；Node 依赖禁用脚本的规则不能推导为 Python 构建也绝不执行代码。

启动后 `initialize` 响应必须返回 `apiVersion`，其**主版本严格等于内核主版本**。这比清单安装阶段允许当前或前一个主版本的兼容判断更严格。返回不匹配即启动失败。

只继承 `PATH`、`LANG`、`LC_ALL`、`TZ`，Windows 额外继承 `SystemRoot`、`ComSpec`、`PATHEXT`、`WINDIR`。`HOME`/`USERPROFILE` 重定向到 `$BRAIN_HOME/state/plugins/<id>/home`，`TMPDIR`/`TEMP`/`TMP` 重定向到同级 `tmp`。不会继承父环境中的 token 或其他自定义变量，密钥要通过受授权的协议方法读取。环境收窄和独立进程不是操作系统级沙盒。完整协议见[进程外插件](process-plugins.md)。

## 发布前验收

对准备发布的目录执行以下流程。切换 main/config 到 dist 后应重新 check；check 会实际导入 main。

```sh
npm test
npm run build
brain plugin check .
npm pack --dry-run
```

在自己的测试宿主实装本地目录，确认工具、配置、停用撤销、迁移和目标平台行为：

```sh
brain plugin install . --yes
brain plugin enable weather
```

发布后再用一个尚未安装该 ID 的测试宿主验证确切 npm 版本：

```sh
npm publish --access public
brain plugin install @alice/brain-plugin-weather@0.1.0 --yes
brain plugin enable weather
```

已安装同 ID 时使用 upgrade。`check` 是独立合规检查，安装器不会自动执行它；进程外插件 check 只验清单，必须用自己的语言测试与真实协议/平台验收补足。

## 交给用户的安装模板

将以下天气插件名称、版本、ID 替换成你的实际值，并补充平台前置条件、申请权限的理由与配置字段。CLI 不弹交互式确认提示；使用 CLI 修改插件前须先停止正在运行的 `brain console` 或 `brain start`。

直接确认安装并启用：

```sh
brain plugin install @alice/brain-plugin-weather@0.1.0 --yes
brain plugin enable weather
```

先查看权限、稍后确认：

```sh
brain plugin install @alice/brain-plugin-weather@0.1.0
brain plugin confirm weather
brain plugin enable weather
```

不带 `--yes` 的 install 会准备包并留下待确认记录；不是纯演练。`confirm` 确认后处于停用状态，还需 `enable`。也可打开 `brain console`，在「印谱」中填写同一安装 spec，检查权限后确认并启用。

升级到指定版本：

```sh
brain plugin upgrade weather @alice/brain-plugin-weather@0.2.0 --yes
```

如果升级新增权限且不带 `--yes`，旧版保留，新版等待确认；查看新增权限后执行 `brain plugin confirm weather`。没有新增权限时，upgrade 直接完成升级。升级保留原启停状态，原先停用的插件仍需手动 enable；失败会尝试恢复原版本与备份的数据。
