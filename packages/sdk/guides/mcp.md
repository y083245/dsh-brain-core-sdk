# 插件自带 MCP server

插件可以在清单中携带 MCP server，由宿主连接，并把声明的工具经统一工具网关交给模型。插件的 MCP server 不能直接挂入底层 DSH，也不能绕过宿主工具权限、加载和发送规则。

## 两种连接方式

本地 stdio 命令与远程 Streamable HTTP 二选一：

```json
{
  "mcp": {
    "command": "node",
    "args": ["./server.js"],
    "env": { "SERVICE_TOKEN": "secret:service_token" }
  }
}
```

server.js 必须已包含在插件包内，并在安装目录作为工作目录可运行。命令和参数分别填写，不执行 shell 字符串。也可以使用目标机已具备的 MCP 命令；依赖和解释器要求由插件交付说明写清。

远程示例：

```json
{
  "mcp": {
    "url": "config:endpoint",
    "headers": { "Authorization": "secret:service_authorization" }
  }
}
```

url/env/headers 的每个值分别是完整字面字符串、config:key 或 secret:name，**没有内嵌插值**。`Bearer secret:token` 会被当作原样字符串，不会解析密钥。Authorization 若要 Bearer 格式，应把完整的 `Bearer ...` 值存为 service_authorization 密钥，并使用示例中的整个 secret 引用。

config 引用取顶层键，值必须是字符串；不存在或类型不对会失败。secret 引用需 `secrets:<name>` 权限，未设置或为空会使连接失败。mcp.args 是字面参数数组，不会解析 config/secret。

## 网络与进程边界

字面 http(s) URL 须由 network:host 或 lan:host 覆盖；config:endpoint 须有 network:config:endpoint 或 lan:config:endpoint。远程连接时宿主再次执行目标 URL 检查。私网/回环必须明确授权 lan，不能用公网权限替代。

stdio server 使用与进程外插件相同的环境白名单和独立 HOME/TMP，外加 mcp.env 显式解析的值。env 可覆盖同名值，开发者应保持必要的 HOME/TMP 重定向，不传宿主凭据。子进程自身的文件和网络访问不受 ctx 自动拦截；环境收窄不是操作系统安全沙盒。远程 MCP server 自身行为同样需要信任与审核，URL 校验不等于审计远端实现。

## 声明工具并映射名字

每个开放工具仍需写 name/effect/load/summary，context/onDemand 需 group；清单需要 tools.register 权限，send 还需要 channel.send。MCP 中工具名可能含大写或其他字符，使用 mcpName 映射到合法短名。

```json
{
  "id": "home-tools",
  "kinds": ["capability"],
  "api": "^1.0.0",
  "runtime": "node",
  "permissions": ["tools.register", "lan:config:endpoint", "secrets:service_authorization"],
  "config": "./dist/config.js",
  "mcp": {
    "url": "config:endpoint",
    "headers": { "Authorization": "secret:service_authorization" }
  },
  "tools": [{
    "name": "turn_on",
    "mcpName": "HassTurnOn",
    "effect": "write",
    "load": "onDemand",
    "group": "lights",
    "summary": "打开指定房间的灯",
    "audience": "owner"
  }],
  "groups": { "lights": { "summary": "家里的灯", "usage": "确认房间后再操作。" } }
}
```

配置模块需校验 endpoint 字符串，用户把实际内网 MCP 地址写入自己的 config.json。开灯属于修改外部世界的 write；只有对外发消息才是 send。

宿主连接后请求工具列表，按 mcpName 或 name 查找：清单声明而 server 未提供则启用失败；server 多余工具不会开放。description 优先使用 MCP description，否则使用清单 summary；参数取 inputSchema，模型工具名加 `<id>__` 前缀。

## 入口和撤销

Node 包仍须有 main 并导出 apply。MCP 在 apply 后由宿主连接注册，自己的 apply 不要重复注册这些工具：

```ts
import type { BrainContext } from '@dsh-brain-core/sdk'

export function apply(ctx: BrainContext): void {
  ctx.logger.info('mcp.entry.ready', { plugin: ctx.plugin.id })
}
```

宿主将 MCP 文本与图片内容转为 ToolOutput；其他内容块不作为工具输出开放，isError 结果视为失败。图片和文本仍遵守[工具输出预算](tools.md)。停用时撤销桥接工具并关闭连接，启用失败也清理已注册项。

testkit 契约对 MCP 的 tools-registered 项作跳过成功处理，因为假内核不连接真实 server；check 并不能验证 server 有工具、网络目标可达或远端鉴权正确。发布前还需真实连接测试，见[测试](testing.md)与[发布](publishing.md)。
