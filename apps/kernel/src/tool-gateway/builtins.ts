import { BrainError, LIMITS } from '@dsh-brain-core/sdk'
import type { MemoryRecord, RecordPatch, SearchRequest, SearchScope, ToolParameters } from '@dsh-brain-core/sdk'
import { scanInjection } from '@dsh-brain-core/shared'
import type { MemoryService } from '../contracts/index.ts'
import { dice } from './similarity.ts'
import type { BuiltinCall, ToolEntry, ToolGroup } from './types.ts'

export interface BuiltinHost {
  readonly memory: MemoryService
  /** Groups that apply to this channel, onDemand or not. */
  groupsFor(channel: string): readonly ToolGroup[]
}

type Args = Readonly<Record<string, unknown>>

const MEMORY_KEYWORDS = ['记住', '记一下', '忘掉', 'remember', 'forget'] as const
const MEMORY_GROUP = { summary: '记下、修改或忘掉一件事' } as const
const SEARCH_SCOPES: readonly SearchScope[] = ['here', 'person', 'all']
const REMEMBER_KINDS = ['fact', 'event', 'promise', 'self'] as const
const SEARCH_RESULT_LIMIT = 8
const KEYWORD_SCORE = 2
const SUMMARY_SCORE = 1
const SUMMARY_SIMILARITY = 0.3
const INFERRED_BELOW = 0.8

function invalid(message: string): BrainError {
  return new BrainError('INVALID_ARGUMENT', message)
}

function string(args: Args, key: string): string {
  const value = args[key]
  if (typeof value !== 'string') throw invalid(`参数 ${key} 必填，要是字符串。`)
  return value
}

function text(args: Args, key: string): string {
  const value = string(args, key)
  if (value.trim() === '') throw invalid(`参数 ${key} 不能是空的。`)
  return value
}

function optionalText(args: Args, key: string): string | undefined {
  return args[key] === undefined ? undefined : text(args, key)
}

function optionalImportance(args: Args): number | undefined {
  const value = args.importance
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw invalid('参数 importance 要在 0 到 1 之间。')
  return value
}

function inferred(record: MemoryRecord): boolean {
  return record.layer === 'L2' || (record.layer === 'L1' && (record.confidence < INFERRED_BELOW || record.kind === 'l1.candidate'))
}

function textOf(record: MemoryRecord): string {
  const { text: plain, conclusion } = record.content
  if (typeof plain === 'string') return plain
  if (typeof conclusion === 'string') return conclusion
  return JSON.stringify(record.content)
}

function guard(value: string): void {
  const reason = scanInjection(value)
  if (reason !== null) throw invalid(`这段话不能记：${reason}。`)
}

function scoreOf(group: ToolGroup, query: string): number {
  const matches = group.keywords.some((keyword) => {
    const word = keyword.toLowerCase()
    return word !== '' && (query.includes(word) || word.includes(query))
  })
  return (matches ? KEYWORD_SCORE : 0) + (dice(query, group.summary) >= SUMMARY_SIMILARITY ? SUMMARY_SCORE : 0)
}

function entry(spec: {
  readonly name: string
  readonly description: string
  readonly parameters: ToolParameters
  readonly load: ToolEntry['load']
  readonly group?: string
  readonly run: NonNullable<ToolEntry['run']>
}): ToolEntry {
  const memory = spec.group === 'memory'
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    load: spec.load,
    ...(spec.group === undefined ? {} : { group: spec.group }),
    ...(memory ? { groupInfo: MEMORY_GROUP } : {}),
    summary: spec.description,
    keywords: memory ? MEMORY_KEYWORDS : [],
    channels: ['*:*'],
    ownerOnly: false,
    run: spec.run,
  }
}

export function createBuiltins(host: BuiltinHost): readonly ToolEntry[] {
  async function search(call: BuiltinCall, args: Args): Promise<string> {
    const query = string(args, 'query').trim().toLowerCase()
    if (query === '') return '没找到相关工具'
    const scored = host.groupsFor(call.channel)
      .filter((group) => group.onDemand)
      .map((group) => ({ group, score: scoreOf(group, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || (a.group.name < b.group.name ? -1 : a.group.name > b.group.name ? 1 : 0))
      .slice(0, SEARCH_RESULT_LIMIT)
    if (scored.length === 0) return '没找到相关工具'
    return scored
      .map(({ group }) => {
        const loaded = call.state.activated.has(group.name) ? '（已加载）' : ''
        return `${group.name}${loaded}：${group.summary}（工具：${group.tools.map((tool) => tool.name).join('、')}）`
      })
      .join('\n')
  }

  async function load(call: BuiltinCall, args: Args): Promise<string> {
    const name = text(args, 'group')
    const group = host.groupsFor(call.channel).find((item) => item.name === name && item.onDemand)
    if (group === undefined) throw new Error(`没有叫「${name}」的工具组。先用 tools__search 查找。`)
    const { state } = call
    if (call.wake.mode === 'fixed') {
      // A group already in `activated` (put back by restoreSession) is on the surface; the model can use it now.
      if (state.activated.has(name)) return '已加载，下一步可用。'
      state.pending.add(name)
      return '这个工具组要换会话后才能用。'
    }
    const first = !state.activated.has(name)
    state.activated.add(name)
    state.pending.delete(name)
    for (const tool of group.tools) state.surface.add(tool.name)
    return first && group.usage !== undefined ? `已加载，下一步可用。\n${group.usage}` : '已加载，下一步可用。'
  }

  async function memorySearch(call: BuiltinCall, args: Args): Promise<string> {
    const query = string(args, 'query')
    if (query === '') throw invalid('参数 query 不能是空的。')
    const scope = args.scope === undefined ? 'here' : args.scope
    if (!SEARCH_SCOPES.includes(scope as SearchScope)) throw invalid('参数 scope 只能是 here、person 或 all。')
    if (args.limit !== undefined && !Number.isInteger(args.limit)) throw invalid('参数 limit 要是整数。')
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
    const result = await host.memory.search(request, call.viewer)
    const lines = result.items.map((item) => JSON.stringify({
      id: item.record.id,
      version: item.record.version,
      text: textOf(item.record),
      label: item.disclosure.label,
      speakable: item.disclosure.speakable,
      ...(inferred(item.record) ? { inferred: true } : {}),
      ...(item.neighbors !== undefined && item.neighbors.length > 0
        ? {
            neighbors: item.neighbors.map((n) => ({
              position: n.position,
              id: n.record.id,
              text: textOf(n.record),
              label: n.disclosure.label,
              speakable: n.disclosure.speakable,
            })),
          }
        : {}),
      ...(item.history !== undefined && item.history.length > 0
        ? {
            history: item.history.map((h) => ({
              key: h.key,
              text: h.text,
              status: h.label,
              changedAt: h.changedAt,
            })),
          }
        : {}),
    }))
    const notice = result.degraded ? ['记忆检索现在不完整，结果可能漏掉一些。'] : []
    return [...notice, ...(lines.length === 0 ? ['没有找到相关的记忆。'] : lines)].join('\n')
  }

  async function remember(call: BuiltinCall, args: Args): Promise<string> {
    const words = text(args, 'text')
    const kind = args.kind === undefined ? 'fact' : args.kind
    if (!REMEMBER_KINDS.includes(kind as (typeof REMEMBER_KINDS)[number])) throw invalid('参数 kind 只能是 fact、event、promise 或 self。')
    const about = args.about
    if (about !== undefined && (!Array.isArray(about) || about.some((item) => typeof item !== 'string' || item === ''))) {
      throw invalid('参数 about 要是 id 的数组。')
    }
    const importance = optionalImportance(args)
    guard(words)
    if (call.wake.evidence.length === 0) throw new Error('这次唤醒没有可以引用的原始记录，不能记。')
    const others = call.wake.participants.filter((person) => person !== 'self')
    const subjects = about !== undefined && about.length > 0 ? (about as string[]) : others.length > 0 ? others : ['self']
    const record = await host.memory.record({
      layer: 'L1',
      kind: `l1.${kind as string}`,
      channel: call.channel,
      subjects,
      actor: 'self',
      content: { text: words },
      evidence: call.wake.evidence.slice(0, LIMITS.evidence).map((id) => ({ id })),
      ...(importance === undefined ? {} : { importance }),
    }, call.identity)
    return `已记下：${record.id}`
  }

  async function update(call: BuiltinCall, args: Args): Promise<string> {
    const id = text(args, 'id')
    if (!Number.isInteger(args.version)) throw invalid('参数 version 必填，要是整数。')
    const words = optionalText(args, 'text')
    const importance = optionalImportance(args)
    if (words !== undefined) guard(words)
    const patch: RecordPatch = {
      ...(words === undefined ? {} : { content: { text: words } }),
      ...(importance === undefined ? {} : { importance }),
    }
    await host.memory.update(id, patch, args.version as number, call.identity, call.viewer)
    return `已修改：${id}`
  }

  async function forget(call: BuiltinCall, args: Args): Promise<string> {
    const id = text(args, 'id')
    await host.memory.remove(id, call.identity, call.viewer)
    return `已忘掉：${id}`
  }

  return [
    entry({
      name: 'tools__search',
      description: '按一句话找工具组。找到后用 tools__load 加载，加载后下一步就能用。',
      parameters: { type: 'object', properties: { query: { type: 'string', description: '想做的事，比如「发表情」' } }, required: ['query'] },
      load: 'core',
      run: search,
    }),
    entry({
      name: 'tools__load',
      description: '加载 tools__search 找到的一个工具组。',
      parameters: { type: 'object', properties: { group: { type: 'string', description: '工具组的名字' } }, required: ['group'] },
      load: 'core',
      run: load,
    }),
    entry({
      name: 'memory__search',
      description: '在记忆里找东西。scope：here 这个对话，person 对话里的人，all 全部你能看到的。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要找什么' },
          scope: { type: 'string', enum: ['here', 'person', 'all'], default: 'here' },
          limit: { type: 'integer', description: '最多几条' },
          neighbors: { type: 'integer', description: 'L0 命中带前后几条同通道原文，默认 2，0 为不带' },
          history: { type: 'boolean', description: '是否一并返回该属性的已变更历史值，默认 false' },
        },
        required: ['query'],
      },
      load: 'core',
      run: memorySearch,
    }),
    entry({
      name: 'memory__remember',
      description: '记下一件事。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要记的内容' },
          kind: { type: 'string', enum: ['fact', 'event', 'promise', 'self'], default: 'fact' },
          about: { type: 'array', items: { type: 'string' }, description: '这件事和谁有关（人的 id）' },
          importance: { type: 'number', description: '0 到 1，越大越重要' },
        },
        required: ['text'],
      },
      load: 'onDemand',
      group: 'memory',
      run: remember,
    }),
    entry({
      name: 'memory__update',
      description: '修改一条记忆。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '记忆的 id' },
          version: { type: 'integer', description: '搜索结果里的 version' },
          text: { type: 'string', description: '新的内容' },
          importance: { type: 'number', description: '0 到 1' },
        },
        required: ['id', 'version'],
      },
      load: 'onDemand',
      group: 'memory',
      run: update,
    }),
    entry({
      name: 'memory__forget',
      description: '忘掉一条记忆。',
      parameters: { type: 'object', properties: { id: { type: 'string', description: '记忆的 id' } }, required: ['id'] },
      load: 'onDemand',
      group: 'memory',
      run: forget,
    }),
  ]
}
