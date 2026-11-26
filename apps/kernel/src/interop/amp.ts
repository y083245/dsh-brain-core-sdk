import { BrainError, LIMITS } from '@brain-core/sdk'
import type {
  ManifestGroup,
  ManifestTool,
  MemoryRecord,
  RecordPatch,
  SearchRequest,
  SearchScope,
  ToolLoad,
  ToolParameters,
  Viewer,
} from '@brain-core/sdk'
import { scanInjection } from '@brain-core/shared'
import type {
  ConsolidationEngine,
  GatewayTool,
  MemoryService,
  RecordStore,
  WriteIdentity,
} from '../contracts/index.ts'

export interface AmpHost {
  readonly memory: MemoryService
  readonly consolidation?: ConsolidationEngine
  readonly store?: RecordStore
}

/** Structural match for tool-gateway's BuiltinCall without cross-module deep imports. */
export interface AmpBuiltinCall {
  readonly sessionId: string
  readonly channel: string
  readonly wake: {
    readonly participants: readonly string[]
    readonly evidence: readonly string[]
  }
  readonly viewer: Viewer
  readonly identity: WriteIdentity
}

/** Structural match for tool-gateway's ToolEntry without cross-module deep imports. */
export interface AmpBuiltinEntry {
  readonly name: string
  readonly description: string
  readonly parameters: ToolParameters
  readonly load: ToolLoad
  readonly group?: string
  readonly groupInfo?: ManifestGroup
  readonly summary: string
  readonly keywords: readonly string[]
  readonly channels: readonly string[]
  readonly ownerOnly: boolean
  readonly run: (call: AmpBuiltinCall, args: Readonly<Record<string, unknown>>) => Promise<string>
}

interface AmpExecContext {
  readonly channel: string
  readonly participants: readonly string[]
  readonly evidence: readonly string[]
  readonly viewer: Viewer
  readonly identity: WriteIdentity
}

type Args = Readonly<Record<string, unknown>>

const AMP_GROUP: ManifestGroup = { summary: 'AMP 标准记忆动词别名（编码、遗忘、固定、巩固与统计）' }
const AMP_KEYWORDS = ['amp', 'recall', 'encode', 'forget', 'pin', 'consolidate', 'stats', '记忆', '固定', '巩固', '统计'] as const
const SEARCH_SCOPES: readonly SearchScope[] = ['here', 'person', 'all']
const ENCODE_KINDS = ['fact', 'event', 'promise', 'self'] as const
const INFERRED_BELOW = 0.8

function invalid(message: string): BrainError {
  return new BrainError('INVALID_ARGUMENT', message)
}

function readString(args: Args, key: string): string {
  const value = args[key]
  if (typeof value !== 'string') throw invalid(`参数 ${key} 必填，要是字符串。`)
  return value
}

function readNonEmptyText(args: Args, key: string): string {
  const value = readString(args, key)
  if (value.trim() === '') throw invalid(`参数 ${key} 不能是空的。`)
  return value
}

function readOptionalImportance(args: Args): number | undefined {
  const value = args.importance
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalid('参数 importance 要在 0 到 1 之间。')
  }
  return value
}

function guardInjection(value: string): void {
  const reason = scanInjection(value)
  if (reason !== null) throw invalid(`这段话不能记：${reason}。`)
}

function isInferred(record: MemoryRecord): boolean {
  return record.layer === 'L2' || (record.layer === 'L1' && (record.confidence < INFERRED_BELOW || record.kind === 'l1.candidate'))
}

function textOf(record: MemoryRecord): string {
  const { text: plain, conclusion } = record.content
  if (typeof plain === 'string') return plain
  if (typeof conclusion === 'string') return conclusion
  return JSON.stringify(record.content)
}

function channelKindOf(channel: string): 'private' | 'group' | 'other' {
  const parts = channel.split(':')
  if (parts.length < 3) return 'other'
  if (parts[1] === 'private') return 'private'
  if (parts[1] === 'group') return 'group'
  return 'other'
}

interface AmpVerbSpec {
  readonly verb: 'recall' | 'encode' | 'forget' | 'pin' | 'consolidate' | 'stats'
  readonly effect: ManifestTool['effect']
  readonly load: ToolLoad
  readonly group?: string
  readonly summary: string
  readonly description: string
  readonly ownerOnly: boolean
  readonly parameters: ToolParameters
  readonly run: (ctx: AmpExecContext, args: Args) => Promise<string>
}

function buildAmpSpecs(host: AmpHost): readonly AmpVerbSpec[] {
  async function runRecall(ctx: AmpExecContext, args: Args): Promise<string> {
    const query = readString(args, 'query')
    if (query === '') throw invalid('参数 query 不能是空的。')
    const scope = args.scope === undefined ? 'here' : args.scope
    if (!SEARCH_SCOPES.includes(scope as SearchScope)) {
      throw invalid('参数 scope 只能是 here、person 或 all。')
    }
    if (
      args.limit !== undefined
      && (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > LIMITS.searchLimit)
    ) {
      throw invalid(`参数 limit 要是 1 到 ${String(LIMITS.searchLimit)} 的整数。`)
    }
    const neighbors = args.neighbors === undefined ? 2 : args.neighbors
    if (typeof neighbors !== 'number' || !Number.isInteger(neighbors) || neighbors < 0 || neighbors > 10) {
      throw invalid('参数 neighbors 要是 0 到 10 的整数。')
    }
    if (args.history !== undefined && typeof args.history !== 'boolean') {
      throw invalid('参数 history 要是布尔值。')
    }
    const request: SearchRequest = {
      query,
      scope: scope as SearchScope,
      ...(args.limit === undefined ? {} : { limit: args.limit as number }),
      neighbors,
      ...(args.history === undefined ? {} : { history: args.history }),
    }
    const result = await host.memory.search(request, ctx.viewer)
    const lines = result.items.map((item) => JSON.stringify({
      id: item.record.id,
      version: item.record.version,
      text: textOf(item.record),
      label: item.disclosure.label,
      speakable: item.disclosure.speakable,
      ...(isInferred(item.record) ? { inferred: true } : {}),
      ...(item.neighbors !== undefined && item.neighbors.length > 0
        ? {
            neighbors: item.neighbors.map((neighbor) => ({
              position: neighbor.position,
              id: neighbor.record.id,
              text: textOf(neighbor.record),
              label: neighbor.disclosure.label,
              speakable: neighbor.disclosure.speakable,
            })),
          }
        : {}),
      ...(item.history !== undefined && item.history.length > 0
        ? {
            history: item.history.map((hist) => ({
              key: hist.key,
              text: hist.text,
              status: hist.label,
              changedAt: hist.changedAt,
            })),
          }
        : {}),
    }))
    const notice = result.degraded ? ['记忆检索现在不完整，结果可能漏掉一些。'] : []
    return [...notice, ...(lines.length === 0 ? ['没有找到相关的记忆。'] : lines)].join('\n')
  }

  async function runEncode(ctx: AmpExecContext, args: Args): Promise<string> {
    let words: string
    if (args.content !== undefined) {
      words = readNonEmptyText(args, 'content')
    } else if (args.text !== undefined) {
      words = readNonEmptyText(args, 'text')
    } else {
      throw invalid('参数 content 或 text 必填且不能为空。')
    }
    const kind = args.kind === undefined ? 'fact' : args.kind
    if (!ENCODE_KINDS.includes(kind as (typeof ENCODE_KINDS)[number])) {
      throw invalid('参数 kind 只能是 fact、event、promise 或 self。')
    }
    const about = args.about
    if (about !== undefined && (!Array.isArray(about) || about.some((item) => typeof item !== 'string' || item === ''))) {
      throw invalid('参数 about 要是 id 的数组。')
    }
    const importance = readOptionalImportance(args)
    guardInjection(words)
    if (ctx.evidence.length === 0) throw new Error('这次唤醒没有可以引用的原始记录，不能记。')
    const others = ctx.participants.filter((person) => person !== 'self')
    const subjects = about !== undefined && about.length > 0 ? (about as string[]) : others.length > 0 ? others : ['self']
    const record = await host.memory.record({
      layer: 'L1',
      kind: `l1.${kind as string}`,
      channel: ctx.channel,
      subjects,
      actor: 'self',
      content: { text: words },
      evidence: ctx.evidence.slice(0, LIMITS.evidence).map((id) => ({ id })),
      ...(importance === undefined ? {} : { importance }),
    }, ctx.identity)
    return `已记下：${record.id}`
  }

  async function runForget(ctx: AmpExecContext, args: Args): Promise<string> {
    const id = readNonEmptyText(args, 'id')
    await host.memory.remove(id, ctx.identity, ctx.viewer)
    return `已忘掉：${id}`
  }

  async function runPin(ctx: AmpExecContext, args: Args): Promise<string> {
    const id = readNonEmptyText(args, 'id')
    if (!Number.isInteger(args.version)) throw invalid('参数 version 必填，要是整数。')
    if (host.store === undefined) {
      throw new BrainError('UNAVAILABLE', '未挂载记录存储，无法安全执行 pin')
    }
    const existing = await host.store.get(id)
    if (existing === null) {
      throw new BrainError('NOT_FOUND', '没有找到这条记忆。')
    }
    const patch: RecordPatch = {
      content: { ...existing.content, pinned: true },
      importance: 1,
    }
    await host.memory.update(id, patch, args.version as number, ctx.identity, ctx.viewer)
    return `已固定：${id}`
  }

  async function runConsolidate(): Promise<string> {
    if (host.consolidation === undefined) {
      return '巩固引擎未启用，暂不可用。'
    }
    const proposal = await host.consolidation.runShadow({ force: false })
    const budget = await host.consolidation.budgetStatus()
    return JSON.stringify({
      proposalId: proposal.id,
      status: proposal.status,
      l2Candidates: proposal.l2Candidates.length,
      corrections: proposal.corrections.length,
      selfConflicts: proposal.selfConflicts.length,
      budget,
    })
  }

  async function runStats(): Promise<string> {
    const health = await host.memory.health()
    let counts: Record<'L0' | 'L1' | 'L2' | 'L3', number> | undefined
    if (host.store !== undefined) {
      counts = { L0: 0, L1: 0, L2: 0, L3: 0 }
      for await (const rec of host.store.scan()) {
        if (rec.status === 'active') counts[rec.layer] += 1
      }
    }
    return JSON.stringify({
      health,
      ...(counts === undefined ? {} : { counts }),
    })
  }

  return [
    {
      verb: 'recall',
      effect: 'read',
      load: 'core',
      summary: 'AMP 别名：在记忆中检索信息',
      description: 'AMP recall 别名：在记忆里检索信息。scope：here 当前对话，person 对话成员，all 全部可见记忆。',
      ownerOnly: false,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要找什么' },
          scope: { type: 'string', enum: ['here', 'person', 'all'], default: 'here' },
          limit: { type: 'integer', description: '最多返回条数' },
          neighbors: { type: 'integer', description: 'L0 命中带前后几条同通道原文，默认 2，0 为不带' },
          history: { type: 'boolean', description: '是否附带历史变更值，默认 false' },
        },
        required: ['query'],
      },
      run: runRecall,
    },
    {
      verb: 'encode',
      effect: 'write',
      load: 'onDemand',
      group: 'amp',
      summary: 'AMP 别名：编码并记住一条事实或事件',
      description: 'AMP encode 别名：记住一条记忆（兼容 content 或 text 参数）。',
      ownerOnly: false,
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要记的内容' },
          text: { type: 'string', description: '要记的内容（与 content 等价）' },
          kind: { type: 'string', enum: ['fact', 'event', 'promise', 'self'], default: 'fact' },
          about: { type: 'array', items: { type: 'string' }, description: '相关人物 id 列表' },
          importance: { type: 'number', description: '0 到 1，越大越重要' },
        },
      },
      run: runEncode,
    },
    {
      verb: 'forget',
      effect: 'write',
      load: 'onDemand',
      group: 'amp',
      summary: 'AMP 别名：忘掉指定记忆',
      description: 'AMP forget 别名：忘掉一条记忆。',
      ownerOnly: false,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '记忆的 id' },
        },
        required: ['id'],
      },
      run: runForget,
    },
    {
      verb: 'pin',
      effect: 'write',
      load: 'onDemand',
      group: 'amp',
      summary: 'AMP 别名：将重要记忆设为永久置顶',
      description: 'AMP pin 别名：将记录 importance 设为 1 并标记 pinned: true，防止代谢低权。',
      ownerOnly: false,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '记忆的 id' },
          version: { type: 'integer', description: '记录当前 version（乐观锁）' },
        },
        required: ['id', 'version'],
      },
      run: runPin,
    },
    {
      verb: 'consolidate',
      effect: 'write',
      load: 'onDemand',
      group: 'amp',
      summary: 'AMP 别名：触发一次影子记忆巩固（仅主人）',
      description: 'AMP consolidate 别名：触发影子记忆巩固并返回提案与预算摘要（仅主人通道可用）。',
      ownerOnly: true,
      parameters: {
        type: 'object',
        properties: {},
      },
      run: runConsolidate,
    },
    {
      verb: 'stats',
      effect: 'read',
      load: 'onDemand',
      group: 'amp',
      summary: 'AMP 别名：查看记忆健康与分层统计',
      description: 'AMP stats 别名：返回记忆健康状态与各层活跃记录计数（不含聊天原文）。',
      ownerOnly: false,
      parameters: {
        type: 'object',
        properties: {},
      },
      run: runStats,
    },
  ]
}

/**
 * Produces builtin ToolEntry items (`amp__recall`, `amp__encode`, `amp__forget`, `amp__pin`,
 * `amp__consolidate`, `amp__stats`) for ToolGateway so AMP aliases reuse exact session
 * viewer, WriteIdentity, wake evidence, and ownerOnly enforcement.
 */
export function createAmpBuiltinEntries(host: AmpHost): readonly AmpBuiltinEntry[] {
  return buildAmpSpecs(host).map((spec) => ({
    name: `amp__${spec.verb}`,
    description: spec.description,
    parameters: spec.parameters,
    load: spec.load,
    ...(spec.group === undefined ? {} : { group: spec.group }),
    ...(spec.group === 'amp' ? { groupInfo: AMP_GROUP } : {}),
    summary: spec.summary,
    keywords: spec.group === 'amp' ? AMP_KEYWORDS : [],
    channels: ['*:*'],
    ownerOnly: spec.ownerOnly,
    run: (call: AmpBuiltinCall, args: Readonly<Record<string, unknown>>) => spec.run({
      channel: call.channel,
      participants: call.wake.participants,
      evidence: call.wake.evidence,
      viewer: call.viewer,
      identity: call.identity,
    }, args),
  }))
}

/**
 * Produces GatewayTool wrappers (`pluginId: 'amp'`) for callers registering AMP aliases
 * through `ToolGateway.register`. Prefer `createAmpBuiltinEntries` inside `ToolGateway`
 * when session wake evidence and participants are required.
 */
export function createAmpAliasTools(host: AmpHost): readonly GatewayTool[] {
  return buildAmpSpecs(host).map((spec) => {
    const manifest: ManifestTool = {
      name: spec.verb,
      effect: spec.effect,
      load: spec.load,
      ...(spec.group === undefined ? {} : { group: spec.group }),
      summary: spec.summary,
      ...(spec.group === 'amp' ? { keywords: AMP_KEYWORDS } : {}),
      ...(spec.ownerOnly ? { audience: 'owner' as const } : {}),
    }
    return {
      pluginId: 'amp',
      manifest,
      ...(spec.group === 'amp' ? { group: AMP_GROUP } : {}),
      description: spec.description,
      parameters: spec.parameters,
      channels: ['*:*'],
      async invoke(args, call) {
        const evidenceRaw = Array.isArray(args.evidence)
          ? args.evidence.filter((item): item is string => typeof item === 'string' && item !== '')
          : []
        const viewer: Viewer = { caller: 'agent', channel: call.channel, participants: [] }
        const identity: WriteIdentity = {
          kind: 'kernel',
          source: 'agent',
          trust: 'self',
          defaultVisibility: channelKindOf(call.channel) === 'private' ? 'subject' : 'open',
        }
        return spec.run({
          channel: call.channel,
          participants: [],
          evidence: evidenceRaw,
          viewer,
          identity,
        }, args)
      },
    }
  })
}
