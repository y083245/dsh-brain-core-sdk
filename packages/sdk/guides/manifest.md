# 插件清单

清单是 `package.json` 的 `brain` 对象，由 SDK `validateManifest` 校验。package.json 本身还要有包名、版本、运行入口等信息；`name` 与 `brain.id` 彼此独立。安装器另行检查版本字符串、API 兼容性和入口是否存在。

```json
{
  "name": "@alice/brain-plugin-weather",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "brain": {
    "id": "weather",
    "kinds": ["capability"],
    "api": "^1.0.0",
    "runtime": "node",
    "permissions": ["tools.register", "network:api.example.com"],
    "config": "./dist/config.js",
    "tools": [{ "name": "forecast", "effect": "read", "load": "onDemand", "group": "weather", "summary": "查询天气" }],
    "groups": { "weather": { "summary": "天气预报", "usage": "确认城市后查询。" } }
  }
}
```

## 全部顶层字段

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | 是 | `^[a-z][a-z0-9-]{0,30}$`，最多 31 字符；升级时必须保持一致 |
| `kinds` | 是 | 非空、不重复的 `channel`、`activity`、`capability`、`memory-provider` 数组 |
| `api` | 是 | caret 形式：`^1`、`^1.0`、`^1.0.0`；不是 npm 包版本或任意 SemVer range |
| `runtime` | 是 | `node` 或 `process` |
| `process` | process 时必填 | `{ command: string, args?: string[] }`；node 禁止此字段；command 非空 |
| `permissions` | 是 | 可以为空数组；未知或重复权限报错，完整表见[权限](permissions.md) |
| `source` | 写普通记忆时必填 | 申请 `memory.ingest` 或 `memory.record` 必须提供；也可单独声明 |
| `tools` | 否 | 工具数组，非空时需 `tools.register` |
| `groups` | 否 | 组名到 `{ summary, usage? }` 的映射 |
| `config` | 否 | `./` 开头且不含 `..` 的配置模块路径 |
| `migrations` | 否 | `./` 开头且不含 `..` 的迁移目录路径 |
| `mcp` | 否 | 本地命令或远程 HTTP MCP，二选一 |

保留 ID：`memory`、`tools`、`agent`、`brain`、`kernel`、`self`、`owner-console`、`notify`。清单及 process/source/tools/groups/mcp 子对象中的未知字段会报错，不能随意加自定义键。`validateManifest` 汇总字段错误，不只报告第一项。

安装阶段清单 API 主版本允许内核当前主版本或前一个主版本；进程外插件 initialize 握手另要求**相同主版本**。不要用安装兼容判断替代进程协议测试。

## source：来源与信任

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `channels` | 是 | 非空数组，每项 `<plugin id>:<kind>:<id>`；kind 匹配 `^[a-z][a-z0-9_-]*$`，尾段可用 `*` 表示模式 |
| `eventKinds` | 是 | 数组，每项必须以 `<plugin id>.` 开头；推荐 `<id>.<名词>.<动词>` |
| `defaultVisibility` | 是 | `open`、`subject`、`origin`、`owner`、`internal` |
| `trust` | 是 | `owner`、`member`、`external`；不能设为 `self`，外部采集应为 `external` |
| `retentionDays` | 否 | 正整数，来源的保留期设置 |
| `rateLimitPerHour` | 否 | 正整数，来源的写入速率上限 |
| `proactiveMessaging` | 否 | boolean，缺省关闭；true 要求 channel 类型、channel.provide/channel.send 权限和至少一条 private 模式 |

source 声明不是给插件任意伪造信任的许可。入库、主体、披露和来源范围仍由运行时检查。`memory-provider` 的衍生写入走专用接口和证据校验，不应借此声明自己可以写任意内部层。

## tools 与 groups

| tools 字段 | 规则 |
| --- | --- |
| `name` | 必填且唯一，`^[a-z][a-z0-9_]{0,30}$`，不能含 `__`；注册时使用这个短名 |
| `effect` | 必填：`read`、`write`、`send`；send 需 `channel.send` |
| `load` | 必填：`core`、`context`、`onDemand` |
| `summary` | 必填，1–60 个 Unicode 码点 |
| `group` | context/onDemand 必填；匹配 `^[a-z][a-z0-9_-]{0,30}$` |
| `keywords` | 可选，最多 16 项，每项 1–32 个码点 |
| `when` | 仅 context 可用且必填；受限特征表达式，见[工具](tools.md) |
| `channels` | 可选数组，每项 `<source>:<kind>`，任一段可为 `*` |
| `sendPerMinute` | 仅 send 可用，正整数，只能收紧宿主发送频率 |
| `textArg` | 仅 send 可用，非空字符串，指出待发送文本参数 |
| `audience` | 可选，只接受 `owner`，限制为主人通道 |
| `mcpName` | 可选、非空，只能在存在 mcp 时使用，映射 MCP 工具原名 |

`groups` 的键使用同一组名规则；每组 `summary` 为 1–60 码点，`usage` 可选且最多 2,000 码点。应为工具引用的每个组提供说明；组说明用于发现和加载。清单校验不代替工具注册契约检查。

## config：配置模块与配置值

`brain.config` 指向一个默认导出 Schemastery schema 的可导入模块。SDK 公开导出 `Schema`。例如 `src/config.ts`：

```ts
import { Schema } from '@dsh-brain-core/sdk'

export interface Config { greeting: string }
const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('hello'),
}) as unknown as Schema<Config>
export default Config
```

当前宿主读取 `$BRAIN_HOME/state/plugins/<id>/config.json`，缺失时使用 `{}`，再交给配置 schema 校验并补默认值，然后传入 `apply(ctx, config)` 和 `ctx.config`。没有 config 模块时配置结果为 `{}`。**控制台配置表单待后续版本接入**；不要把 schema 误写成已上线的表单界面。按插件说明在自己的运行目录准备配置，密钥使用 secrets 服务，不能打进 npm 包。

配置模块仍是 Node 可导入的模块；即使业务运行在 process，也不能把 Python 文件当作此 schema。发布 JS 时必须同步改写 main 与 brain.config，见[发布指南](publishing.md)。

## migrations：私有数据迁移

目录中的迁移文件名须匹配 `NNN-名称.mjs`，如 `001-cache-format.mjs`；编号为三位数字且不得重复。文件导出 `up({ storage, logger })`。宿主按编号执行高于已记录 schema-version 的迁移，每次成功记录版本。目录里的其他普通文件也会因命名不合法报错。

迁移操作插件私有 storage，不直写记忆数据库。升级会备份私有数据并在失败时尝试恢复旧版和数据；迁移应保持可重试，外部系统副作用无法靠本地备份撤销。独立 check 只验证 migrations 路径的清单格式，不执行迁移、不验证实际目录或迁移函数。

## mcp 与网络权限

`mcp` 只能是 `{ command, args?, env? }` 或 `{ url, headers? }`，不能混用。env/headers 的值支持完整的字面字符串、`config:<key>`、`secret:<name>`；不是字符串插值语言。secret 引用必须有同名 `secrets:<name>` 权限。

远程 mcp.url 为 http(s) 字面地址时需对应 `network:<host>` 或 `lan:<host>`；为 `config:<key>` 时需 `network:config:<key>` 或 `lan:config:<key>`。公网、内网和回环网络的运行时检查见[权限](permissions.md)，完整 MCP 约束见[MCP 桥接](mcp.md)。

## 本地校验

```ts
import { validateManifest } from '@dsh-brain-core/sdk'

const result = validateManifest({
  id: 'weather', kinds: ['capability'], api: '^1.0.0', runtime: 'node', permissions: [],
})
if (!result.ok) {
  for (const error of result.errors) console.error(error.field, error.message)
}
```

编辑器可使用 SDK 包内的[清单 JSON Schema](../generated/json-schema/BrainManifest.json)补全；实际语义以 validateManifest 和宿主运行时为准。
