# @dsh-brain-core/testkit

Brain Core 插件开发测试工具：假内核、假通道、FakeDeepSeek、契约测试、一致性用例及插件静态检查。
当前预览版 `1.0.1-rc.1`，需要 Node.js ≥ 24.12。

```bash
npm install --save-dev @dsh-brain-core/testkit@next
```

下面的测试在插件项目中运行，`apply` 路径应匹配项目源码或编译产物：

```js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createTestKernel, runPluginContractTests } from '@dsh-brain-core/testkit'
import { apply } from './src/index.ts'

const { brain } = JSON.parse(await readFile('./package.json', 'utf8'))
const results = await runPluginContractTests({ apply }, brain)
for (const result of results) assert.equal(result.ok, true, result.message)

const kernel = createTestKernel()
await kernel.loadPlugin({ apply }, brain)
// 按需调用 kernel.callTool、kernel.http、kernel.advance，并查看 kernel.records()。
await kernel.unload()
```

`loadPlugin` 可传入 `{ config, granted }` 模拟配置和授权；默认授权清单请求的权限。
假内核支持 `setResponse`、`setSecret`、`useAgent`、`useLlm` 等注入，适合可重复的本地测试。
`checkPlugin(dir)` 返回结构化报告；安装内核后也可用 `brain plugin check .`。
Node 插件运行清单、契约与静态规则检查；process 插件仅验证清单，需另做协议与真实安装测试。
静态扫描与假内核不能替代实际宿主验收。此包应作为开发依赖，宿主不会向已安装插件注入它。

[测试指南](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/guides/testing.md) ·
[静态规则](https://github.com/y083245/dsh-brain-core-sdk/blob/main/packages/sdk/guides/rules.md)

许可协议：PolyForm Noncommercial License 1.0.0，商业用途需另行授权。
