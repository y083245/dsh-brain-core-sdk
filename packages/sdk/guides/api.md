# 插件 API 参考

> 本文件由 `packages/create-brain-plugin/scripts/gen-api-docs.ts` 从 `packages/sdk/src/plugin.ts` 生成，请不要手改。
> 重新生成：`pnpm --filter create-brain-plugin gen:api`。

`apply(ctx, config)` 的第一个参数是 `BrainContext`。下面按 `ctx` 的成员列出接口和方法；
签名末尾的注释是调用它需要的权限，没有注释的方法不需要权限。

## `ctx.plugin`

```text
readonly plugin: { readonly id: string; readonly version: string }
```

## `ctx.memory` — `PluginMemory`

```text
ingest(event: IngestEvent): Promise<{ readonly id: string }>  // memory.ingest
record(input: RecordInput): Promise<MemoryRecord>  // memory.record
update(id: string, patch: RecordPatch, expectedVersion: number, view?: ViewOptions): Promise<MemoryRecord>  // memory.record
remove(id: string, view?: ViewOptions): Promise<void>  // memory.record
search(request: SearchRequest, view?: ViewOptions): Promise<{ readonly items: readonly SearchHit[]; readonly nextCursor?: string; readonly degraded: boolean }>  // memory.search
readChannelEvent?(recordId: string, call: ToolCallContext): Promise<ChannelEventResult>  // memory.search
context(request: ContextRequest): Promise<ContextBundle>  // memory.context
forget(selector: ForgetSelector): Promise<ForgetReport>  // memory.forget
readL0(request?: ReadL0Request): Promise<ReadL0Result>  // memory.readL0
writeDerived(input: DerivedRecordInput): Promise<MemoryRecord>  // memory.writeDerived
provide(provider: MemoryProvider): Disposable  // memory.readL0
```

- `readChannelEvent`：Active tool call only: reads one visible same-channel, same-source L0 record with its disclosure.
- `forget`：record: own source only; channel, and time with a channel: own channels only; person: never.

接口：`PluginMemory`。类型来自 `@dsh-brain-core/sdk`。

## `ctx.agent` — `PluginAgent`

```text
session(channel: string): AgentSessionHandle  // agent.session
wake(channel: string, input: WakeInput): Promise<WakeResult>  // agent.session
```

- `wake`：Resolves when the turn that took this input ends. UNAVAILABLE when no model or role card is set.

接口：`PluginAgent`。类型来自 `@dsh-brain-core/sdk`。

## `ctx.tools` — `PluginTools`

```text
register(tool: ToolDefinition): Disposable  // tools.register
```

- `register`：The name must be listed in the manifest, otherwise PERMISSION_DENIED.

接口：`PluginTools`。类型来自 `@dsh-brain-core/sdk`。

## `ctx.channel` — `PluginChannel`

```text
provide(provider: ChannelProvider): Disposable  // channel.provide
send(channel: string, message: OutboundMessage): Promise<{ readonly messageId?: string }>  // channel.send
```

- `send`：Own channels only; audited and rate limited like a send tool.

接口：`PluginChannel`。类型来自 `@dsh-brain-core/sdk`。

## `ctx.identity` — `PluginIdentity`

Accounts must start with `<plugin id>:`.

```text
resolve(account: string): Promise<string>  // identity.link
link(account: string, personId: string): Promise<void>  // identity.link
```

接口：`PluginIdentity`。类型来自 `@dsh-brain-core/sdk`。

## `ctx.scheduler` — `PluginScheduler`

```text
every(ms: number, run: () => Promise<void> | void): Disposable
at(timeMs: number, run: () => Promise<void> | void): Disposable
ownTime(request: OwnTimeRequest): Disposable  // schedule.ownTime
```

接口：`PluginScheduler`。类型来自 `@dsh-brain-core/sdk`。

## `ctx.events` — `PluginEvents`

```text
on<K extends keyof BrainEvents>(name: K, handler: (payload: BrainEvents[K]) => void | Promise<void>): Disposable
on(name: string, handler: (payload: unknown) => void | Promise<void>): Disposable
emit(name: string, payload: Readonly<Record<string, unknown>>): void
```

- `emit`：Only names starting with `<plugin id>.`.

接口：`PluginEvents`。类型来自 `@dsh-brain-core/sdk`。

## `ctx.http` — `PluginHttp`

```text
route(method: string, path: string, handler: (request: PluginRequest) => Promise<unknown>): Disposable
fetch(url: string, options?: FetchOptions): Promise<FetchResponse>  // network:<host>
subscribeWebSocket?(options: WebSocketSubscribeOptions, listener: (event: WebSocketEvent) => void | Promise<void>): Promise<Disposable>  // lan:config:<key>
```

- `route`：Mounted at `/api/v1/plugins/<id><path>`, behind the kernel's token and envelope. Returns `data`.
- `subscribeWebSocket`：Kernel-managed text WebSocket subscription bound to a top-level URL config key.

接口：`PluginHttp`。类型来自 `@dsh-brain-core/sdk`。

## `ctx.console` — `PluginConsole`

```text
page(descriptor: { readonly id: string; readonly title: string; readonly entry: string }): Disposable
```

接口：`PluginConsole`。类型来自 `@dsh-brain-core/sdk`。

## `ctx.config`

```text
readonly config: C
```

`C` 是 `BrainContext` 的配置类型，由内核按清单的 `config` 校验后传入。

## `ctx.secrets` — `PluginSecrets`

```text
get(name: string): Promise<string | undefined>  // secrets:<name>
```

接口：`PluginSecrets`。类型来自 `@dsh-brain-core/sdk`。

## `ctx.storage` — `PluginStorage`

Paths are relative to state/plugins/<id>/; `..`, absolute paths and links leading outside are refused.

```text
read(path: string): Promise<Uint8Array | undefined>
write(path: string, data: string | Uint8Array): Promise<void>
remove(path: string): Promise<void>
list(prefix?: string): Promise<readonly string[]>
```

接口：`PluginStorage`。类型来自 `@dsh-brain-core/sdk`。

## `ctx.logger` — `BrainLogger`

```text
info(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void
warn(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void
error(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void
```

- `info`：Only strings, numbers and booleans; keys like content, text and message are dropped.

接口：`BrainLogger`。类型来自 `@dsh-brain-core/sdk`。

## `ctx.llm` — `PluginLlm`

```text
complete(request: { readonly system: string; readonly user: string; readonly maxOutputTokens: number }): Promise<{ readonly text: string; readonly tokens: number }>  // llm.invoke
```

- `complete`：Calls the host model service with accounting and limits; UNAVAILABLE when the service or model is not configured.

接口：`PluginLlm`。类型来自 `@dsh-brain-core/sdk`。
