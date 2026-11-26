import type {
  ContextBundle, ContextRequest, Disclosure, ErrorCode, EvidenceRef, ForgetReport, ForgetSelector, IngestEvent, Layer, MemoryRecord, RecordInput, RecordPatch,
  SearchHit, SearchRequest, Trust, Visibility,
} from './types.ts'
import { BrainError, LIMITS, TRUST_LEVELS, VISIBILITIES } from './types.ts'

export const PLUGIN_API_VERSION = '1.0.0'
export const PLUGIN_KINDS = ['channel', 'activity', 'capability', 'memory-provider'] as const
export type PluginKind = (typeof PLUGIN_KINDS)[number]
export const TOOL_EFFECTS = ['read', 'write', 'send'] as const
export type ToolEffect = (typeof TOOL_EFFECTS)[number]
export const TOOL_LOADS = ['core', 'context', 'onDemand'] as const
export type ToolLoad = (typeof TOOL_LOADS)[number]

export const PLAIN_PERMISSIONS = [
  'memory.ingest', 'memory.record', 'memory.search', 'memory.context', 'memory.forget',
  'memory.readL0', 'memory.writeDerived', 'agent.session', 'tools.register', 'channel.provide', 'channel.send',
  'identity.link', 'schedule.ownTime', 'llm.invoke',
] as const
export type PlainPermission = (typeof PLAIN_PERMISSIONS)[number]
export type ParsedPermission =
  | { readonly kind: 'plain'; readonly name: PlainPermission }
  | { readonly kind: 'network'; readonly host: string }         // public: exact host, or *.example.com for subdomains only
  | { readonly kind: 'network-config'; readonly key: string }   // public hosts taken from this config field
  | { readonly kind: 'lan'; readonly host: string }             // one private or loopback host, never a wildcard
  | { readonly kind: 'lan-config'; readonly key: string }       // private or loopback hosts taken from this config field
  | { readonly kind: 'secret'; readonly name: string }

const PLAIN_PERMISSION_SET: ReadonlySet<string> = new Set(PLAIN_PERMISSIONS)
const CONFIG_KEY = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/
const SECRET_NAME = /^[a-z][a-z0-9._-]{0,23}$/
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'
const DOMAIN = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})*$`)
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
const NUMERIC_HOST = /^[0-9.]+$/

/** Lower-case domain or IPv4. Leading zeroes or a bare number are neither. */
function isDomain(host: string): boolean {
  if (!DOMAIN.test(host)) return false
  if (NUMERIC_HOST.test(host) && !IPV4.test(host)) return false
  return true
}

function isBracketedIpv6(host: string): boolean {
  if (!host.startsWith('[') || !host.endsWith(']')) return false
  const inner = host.slice(1, -1)
  if (!/^[0-9a-f:]+$/.test(inner)) return false
  const halves = inner.split('::')
  if (halves.length > 2) return false
  if (halves.length === 2) {
    const left = halves[0] === '' ? [] : halves[0]!.split(':')
    const right = halves[1] === '' ? [] : halves[1]!.split(':')
    const hex = (group: string): boolean => /^[0-9a-f]{1,4}$/.test(group)
    return left.every(hex) && right.every(hex) && left.length + right.length <= 7
  }
  const groups = inner.split(':')
  return groups.length === 8 && groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))
}

function invalidPermission(text: string): BrainError {
  return new BrainError('INVALID_ARGUMENT', `unknown permission: ${text}`, { field: 'permissions' })
}

/** Throws BrainError INVALID_ARGUMENT on anything unknown. */
export function parsePermission(text: string): ParsedPermission {
  if (PLAIN_PERMISSION_SET.has(text)) {
    return { kind: 'plain', name: text as PlainPermission }
  }
  // `config` is reserved: a missing key must not turn into a host named "config".
  if (text === 'network:config' || text === 'lan:config') {
    throw invalidPermission(text)
  }
  if (text.startsWith('network:config:')) {
    const key = text.slice('network:config:'.length)
    if (CONFIG_KEY.test(key)) return { kind: 'network-config', key }
    throw invalidPermission(text)
  }
  if (text.startsWith('network:')) {
    const host = text.slice('network:'.length)
    if (host.startsWith('*.')) {
      // a wildcard needs a domain of at least two labels, so `*.com` and `*.1.2.3.4` are out
      const base = host.slice(2)
      if (isDomain(base) && base.includes('.') && !IPV4.test(base)) return { kind: 'network', host }
    } else if (isDomain(host)) {
      return { kind: 'network', host }
    }
    throw invalidPermission(text)
  }
  if (text.startsWith('lan:config:')) {
    const key = text.slice('lan:config:'.length)
    if (CONFIG_KEY.test(key)) return { kind: 'lan-config', key }
    throw invalidPermission(text)
  }
  if (text.startsWith('lan:')) {
    const host = text.slice('lan:'.length)
    if (isDomain(host) || isBracketedIpv6(host)) return { kind: 'lan', host }
    throw invalidPermission(text)
  }
  if (text.startsWith('secrets:')) {
    const name = text.slice('secrets:'.length)
    if (SECRET_NAME.test(name)) return { kind: 'secret', name }
    throw invalidPermission(text)
  }
  throw invalidPermission(text)
}

/** `host` must already be lower case. */
export function hostAllowed(pattern: string, host: string): boolean {
  if (pattern === host) return true
  if (!pattern.startsWith('*.')) return false
  return host.endsWith(pattern.slice(1))
}

export interface ManifestTool {
  readonly name: string
  readonly effect: ToolEffect
  readonly load: ToolLoad
  readonly group?: string
  readonly summary: string
  readonly keywords?: readonly string[]
  readonly when?: string
  /** `<source>:<kind>`, either part may be `*`. */
  readonly channels?: readonly string[]
  /** send tools only; may lower the kernel's limit, never raise it. */
  readonly sendPerMinute?: number
  /** send tools only: the argument holding the words she says, which turns on the outgoing check. */
  readonly textArg?: string
  /** Only owner channels can see or call this tool. */
  readonly audience?: 'owner'
  /** The tool's name inside the plugin's MCP server, when it differs from `name`. */
  readonly mcpName?: string
}
export interface ManifestGroup { readonly summary: string; readonly usage?: string }
export interface ManifestSource {
  /** `<plugin id>:<kind>:<id>`, the last part may be `*`. */
  readonly channels: readonly string[]
  readonly eventKinds: readonly string[]
  readonly defaultVisibility: Visibility
  readonly trust: Trust
  readonly retentionDays?: number
  readonly rateLimitPerHour?: number
  /** Allows kernel-initiated messages via this provider to eligible private channels. */
  readonly proactiveMessaging?: boolean
}
/** A value of url, headers or env is literal text, `config:<key>` or `secret:<name>`. */
export type ManifestMcp =
  | { readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }
  | { readonly url: string; readonly headers?: Readonly<Record<string, string>> }
export interface BrainManifest {
  readonly id: string
  readonly kinds: readonly PluginKind[]
  readonly api: string
  readonly runtime: 'node' | 'process'
  readonly process?: { readonly command: string; readonly args?: readonly string[] }
  readonly permissions: readonly string[]
  readonly source?: ManifestSource
  readonly tools?: readonly ManifestTool[]
  readonly groups?: Readonly<Record<string, ManifestGroup>>
  readonly config?: string
  readonly migrations?: string
  readonly mcp?: ManifestMcp
}
export interface ManifestError { readonly field: string; readonly message: string }
export type ManifestResult =
  | { readonly ok: true; readonly manifest: BrainManifest }
  | { readonly ok: false; readonly errors: readonly ManifestError[] }

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,30}$/
const TOOL_NAME = /^[a-z][a-z0-9_]{0,30}$/
const GROUP_NAME = /^[a-z][a-z0-9_-]{0,30}$/
const CHANNEL_KIND = /^[a-z][a-z0-9_-]*$/
const SOURCE_CHANNEL = /^([^:]+):([^:]+):(\S+)$/
const TOOL_CHANNEL = /^([a-z0-9][a-z0-9-]*|\*):([a-z][a-z0-9_-]*|\*)$/
const API_RANGE = /^\^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){0,2}$/
const KEYWORD_LIMIT = 16
const KEYWORD_CHARS = 32
const USAGE_CHARS = 2000

const RESERVED_PLUGIN_IDS: ReadonlySet<string> = new Set([
  'memory', 'tools', 'agent', 'brain', 'kernel', 'self', 'owner-console', 'notify',
])
const SOURCE_TRUSTS: readonly string[] = TRUST_LEVELS.filter((trust) => trust !== 'self')

const MANIFEST_FIELDS: readonly string[] = [
  'id', 'kinds', 'api', 'runtime', 'process', 'permissions', 'source', 'tools', 'groups', 'config', 'migrations', 'mcp',
]
const PROCESS_FIELDS: readonly string[] = ['command', 'args']
const SOURCE_FIELDS: readonly string[] = [
  'channels', 'eventKinds', 'defaultVisibility', 'trust', 'retentionDays', 'rateLimitPerHour', 'proactiveMessaging',
]
const TOOL_FIELDS: readonly string[] = [
  'name', 'effect', 'load', 'group', 'summary', 'keywords', 'when', 'channels', 'sendPerMinute', 'textArg',
  'audience', 'mcpName',
]
const GROUP_FIELDS: readonly string[] = ['summary', 'usage']
const MCP_COMMAND_FIELDS: readonly string[] = ['command', 'args', 'env']
const MCP_URL_FIELDS: readonly string[] = ['url', 'headers']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function codepointLength(value: string): number {
  return [...value].length
}

function memberOf(list: readonly unknown[], value: unknown): boolean {
  return list.includes(value)
}

/** Takes the `brain` object of package.json and reports every problem, not just the first. */
export function validateManifest(json: unknown): ManifestResult {
  const errors: ManifestError[] = []
  const add = (field: string, message: string): void => {
    errors.push({ field, message })
  }

  if (!isRecord(json)) {
    return { ok: false, errors: [{ field: '', message: 'the manifest must be an object' }] }
  }

  const rejectUnknown = (value: Record<string, unknown>, allowed: readonly string[], prefix: string): void => {
    for (const key of Object.keys(value)) {
      if (allowed.includes(key)) continue
      add(prefix === '' ? key : `${prefix}.${key}`, `unknown field "${key}"`)
    }
  }

  rejectUnknown(json, MANIFEST_FIELDS, '')

  let id: string | undefined
  if (typeof json.id !== 'string' || !PLUGIN_ID.test(json.id)) {
    add('id', 'id must match ^[a-z][a-z0-9-]{0,30}$')
  } else if (RESERVED_PLUGIN_IDS.has(json.id)) {
    add('id', `id "${json.id}" is reserved`)
  } else {
    id = json.id
  }

  if (!Array.isArray(json.kinds) || json.kinds.length === 0) {
    add('kinds', 'kinds must be a non-empty array')
  } else {
    const seen = new Set<unknown>()
    json.kinds.forEach((kind, index) => {
      if (!memberOf(PLUGIN_KINDS, kind)) {
        add(`kinds[${index}]`, `unknown plugin kind: ${String(kind)}`)
      } else if (seen.has(kind)) {
        add(`kinds[${index}]`, `duplicate plugin kind: ${String(kind)}`)
      }
      seen.add(kind)
    })
  }

  if (typeof json.api !== 'string') {
    add('api', 'api is required')
  } else if (apiMajor(json.api) === null) {
    add('api', 'api must be a caret range such as "^1", "^1.2" or "^1.2.3"')
  }

  const runtime = json.runtime
  if (runtime !== 'node' && runtime !== 'process') {
    add('runtime', 'runtime must be "node" or "process"')
  }

  const validateProcess = (value: unknown): void => {
    if (!isRecord(value)) {
      add('process', 'process must be an object')
      return
    }
    rejectUnknown(value, PROCESS_FIELDS, 'process')
    if (typeof value.command !== 'string' || value.command === '') {
      add('process.command', 'process.command must be a non-empty string')
    }
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string'))) {
      add('process.args', 'process.args must be an array of strings')
    }
  }

  if (json.process !== undefined) {
    validateProcess(json.process)
    if (runtime === 'node') add('process', 'process is only allowed when runtime is "process"')
  } else if (runtime === 'process') {
    add('process.command', 'runtime "process" requires process.command')
  }

  const permissions: ParsedPermission[] = []
  if (!Array.isArray(json.permissions)) {
    add('permissions', 'permissions is required')
  } else {
    const seen = new Set<string>()
    json.permissions.forEach((entry, index) => {
      const field = `permissions[${index}]`
      if (typeof entry !== 'string') {
        add(field, 'a permission must be a string')
        return
      }
      let parsed: ParsedPermission
      try {
        parsed = parsePermission(entry)
      } catch {
        add(field, `unknown permission: ${entry}`)
        return
      }
      if (seen.has(entry)) add(field, `duplicate permission: ${entry}`)
      seen.add(entry)
      permissions.push(parsed)
    })
  }
  const plain = new Set<string>()
  for (const permission of permissions) {
    if (permission.kind === 'plain') plain.add(permission.name)
  }

  const hasMemoryProviderKind = Array.isArray(json.kinds) && json.kinds.includes('memory-provider')
  if ((plain.has('memory.readL0') || plain.has('memory.writeDerived')) && !hasMemoryProviderKind) {
    add('permissions', 'memory.readL0 and memory.writeDerived require plugin kind "memory-provider"')
  }

  const validateSource = (value: unknown, pluginId: string | undefined): void => {
    if (!isRecord(value)) {
      add('source', 'source must be an object')
      return
    }
    rejectUnknown(value, SOURCE_FIELDS, 'source')

    if (!Array.isArray(value.channels) || value.channels.length === 0) {
      add('source.channels', 'source.channels must be a non-empty array')
    } else {
      value.channels.forEach((channel, index) => {
        const field = `source.channels[${index}]`
        if (typeof channel !== 'string') {
          add(field, 'a channel must be a string')
          return
        }
        const match = SOURCE_CHANNEL.exec(channel)
        if (!match) {
          add(field, 'channel must look like <plugin id>:<kind>:<id>')
          return
        }
        const head = match[1]!
        const kind = match[2]!
        if (pluginId !== undefined && head !== pluginId) {
          add(field, `channel must start with the plugin id "${pluginId}"`)
        }
        if (!CHANNEL_KIND.test(kind)) {
          add(field, 'channel kind must match ^[a-z][a-z0-9_-]*$')
        }
      })
    }

    if (!Array.isArray(value.eventKinds)) {
      add('source.eventKinds', 'source.eventKinds must be an array')
    } else {
      value.eventKinds.forEach((eventKind, index) => {
        const field = `source.eventKinds[${index}]`
        if (typeof eventKind !== 'string' || (pluginId !== undefined && !eventKind.startsWith(`${pluginId}.`))) {
          add(field, `event kind must start with "${pluginId ?? '<plugin id>'}."`)
        }
      })
    }

    if (!memberOf(VISIBILITIES, value.defaultVisibility)) {
      add('source.defaultVisibility', `defaultVisibility must be one of ${VISIBILITIES.join(', ')}`)
    }
    if (!memberOf(SOURCE_TRUSTS, value.trust)) {
      add('source.trust', 'trust must be "owner", "member" or "external"')
    }
    if (value.retentionDays !== undefined && !isPositiveInteger(value.retentionDays)) {
      add('source.retentionDays', 'retentionDays must be a positive integer')
    }
    if (value.rateLimitPerHour !== undefined && !isPositiveInteger(value.rateLimitPerHour)) {
      add('source.rateLimitPerHour', 'rateLimitPerHour must be a positive integer')
    }
    if (value.proactiveMessaging !== undefined && typeof value.proactiveMessaging !== 'boolean') {
      add('source.proactiveMessaging', 'proactiveMessaging must be a boolean')
    }
    if (value.proactiveMessaging === true) {
      if (!Array.isArray(json.kinds) || !json.kinds.includes('channel')) {
        add('source.proactiveMessaging', 'proactiveMessaging requires plugin kind "channel"')
      }
      if (!plain.has('channel.provide') || !plain.has('channel.send')) {
        add('source.proactiveMessaging', 'proactiveMessaging requires channel.provide and channel.send')
      }
      if (!Array.isArray(value.channels) || !value.channels.some((channel) =>
        typeof channel === 'string' && SOURCE_CHANNEL.exec(channel)?.[2] === 'private',
      )) {
        add('source.proactiveMessaging', 'proactiveMessaging requires a private source channel')
      }
    }
  }

  const writesMemory = plain.has('memory.ingest') || plain.has('memory.record')
  if (json.source === undefined) {
    if (writesMemory) add('source', 'source is required when memory.ingest or memory.record is granted')
  } else {
    validateSource(json.source, id)
  }

  const validateTool = (value: unknown, field: string, names: Set<string>): void => {
    if (!isRecord(value)) {
      add(field, 'a tool must be an object')
      return
    }
    rejectUnknown(value, TOOL_FIELDS, field)

    if (typeof value.name !== 'string' || !TOOL_NAME.test(value.name) || value.name.includes('__')) {
      add(`${field}.name`, 'tool name must match ^[a-z][a-z0-9_]{0,30}$ and must not contain "__"')
    } else {
      if (names.has(value.name)) add(`${field}.name`, `duplicate tool name: ${value.name}`)
      names.add(value.name)
    }

    const effect = memberOf(TOOL_EFFECTS, value.effect) ? value.effect as ToolEffect : undefined
    if (effect === undefined) add(`${field}.effect`, 'effect must be read, write or send')

    const load = memberOf(TOOL_LOADS, value.load) ? value.load as ToolLoad : undefined
    if (load === undefined) add(`${field}.load`, 'load must be core, context or onDemand')

    if ((load === 'context' || load === 'onDemand') && value.group === undefined) {
      add(`${field}.group`, `${load} tools need a group`)
    }
    if (value.group !== undefined && (typeof value.group !== 'string' || !GROUP_NAME.test(value.group))) {
      add(`${field}.group`, 'group must match ^[a-z][a-z0-9_-]{0,30}$')
    }

    if (typeof value.summary !== 'string' || codepointLength(value.summary) < 1
      || codepointLength(value.summary) > LIMITS.toolSummaryChars) {
      add(`${field}.summary`, `summary must be 1 to ${LIMITS.toolSummaryChars} characters`)
    }

    if (value.keywords !== undefined) {
      if (!Array.isArray(value.keywords) || value.keywords.length > KEYWORD_LIMIT) {
        add(`${field}.keywords`, `keywords must be an array of at most ${KEYWORD_LIMIT} strings`)
      } else {
        value.keywords.forEach((keyword, index) => {
          if (typeof keyword !== 'string' || codepointLength(keyword) < 1 || codepointLength(keyword) > KEYWORD_CHARS) {
            add(`${field}.keywords[${index}]`, `a keyword must be 1 to ${KEYWORD_CHARS} characters`)
          }
        })
      }
    }

    if (value.when !== undefined) {
      if (load !== 'context') {
        add(`${field}.when`, 'when is only allowed on context tools')
      } else if (typeof value.when !== 'string') {
        add(`${field}.when`, 'when must be a string')
      } else {
        try {
          parseWhen(value.when)
        } catch {
          add(`${field}.when`, `when is not a valid feature expression: ${value.when}`)
        }
      }
    } else if (load === 'context') {
      add(`${field}.when`, 'context tools need a when expression')
    }

    if (value.channels !== undefined) {
      if (!Array.isArray(value.channels)) {
        add(`${field}.channels`, 'channels must be an array')
      } else {
        value.channels.forEach((channel, index) => {
          if (typeof channel !== 'string' || !TOOL_CHANNEL.test(channel)) {
            add(`${field}.channels[${index}]`, 'channel must match <source>:<kind> with optional "*"')
          }
        })
      }
    }

    const hasChannelPermission = plain.has('channel.send')
    if (effect === 'send') {
      if (value.sendPerMinute !== undefined && !isPositiveInteger(value.sendPerMinute)) {
        add(`${field}.sendPerMinute`, 'sendPerMinute must be a positive integer')
      }
      if (value.textArg !== undefined && (typeof value.textArg !== 'string' || value.textArg === '')) {
        add(`${field}.textArg`, 'textArg must be a non-empty string')
      }
      if (!hasChannelPermission) add(`${field}.effect`, 'send tools require the channel.send permission')
    } else if (effect !== undefined) {
      if (value.sendPerMinute !== undefined) {
        add(`${field}.sendPerMinute`, 'sendPerMinute is only allowed on send tools')
      }
      if (value.textArg !== undefined) {
        add(`${field}.textArg`, 'textArg is only allowed on send tools')
      }
    }

    if (value.audience !== undefined && value.audience !== 'owner') {
      add(`${field}.audience`, 'audience may only be "owner"')
    }

    if (value.mcpName !== undefined) {
      if (typeof value.mcpName !== 'string' || value.mcpName === '') {
        add(`${field}.mcpName`, 'mcpName must be a non-empty string')
      } else if (json.mcp === undefined) {
        add(`${field}.mcpName`, 'mcpName is only allowed when the manifest has mcp')
      }
    }
  }

  if (json.tools !== undefined) {
    if (!Array.isArray(json.tools)) {
      add('tools', 'tools must be an array')
    } else {
      if (json.tools.length > 0 && !plain.has('tools.register')) {
        add('tools', 'tools requires the tools.register permission')
      }
      const names = new Set<string>()
      json.tools.forEach((tool, index) => {
        validateTool(tool, `tools[${index}]`, names)
      })
    }
  }

  if (json.groups !== undefined) {
    if (!isRecord(json.groups)) {
      add('groups', 'groups must be an object')
    } else {
      for (const [name, group] of Object.entries(json.groups)) {
        const field = `groups.${name}`
        if (!GROUP_NAME.test(name)) {
          add(field, 'group name must match ^[a-z][a-z0-9_-]{0,30}$')
        }
        if (!isRecord(group)) {
          add(field, 'a group must be an object')
          continue
        }
        rejectUnknown(group, GROUP_FIELDS, field)
        if (typeof group.summary !== 'string' || codepointLength(group.summary) < 1
          || codepointLength(group.summary) > LIMITS.toolSummaryChars) {
          add(`${field}.summary`, `summary must be 1 to ${LIMITS.toolSummaryChars} characters`)
        }
        if (group.usage !== undefined
          && (typeof group.usage !== 'string' || codepointLength(group.usage) > USAGE_CHARS)) {
          add(`${field}.usage`, `usage must be at most ${USAGE_CHARS} characters`)
        }
      }
    }
  }

  for (const key of ['config', 'migrations'] as const) {
    const value = json[key]
    if (value !== undefined && (typeof value !== 'string' || !value.startsWith('./') || value.includes('..'))) {
      add(key, `${key} must be a relative path starting with "./" and without ".."`)
    }
  }

  const hasSecret = (name: string): boolean =>
    permissions.some((permission) => permission.kind === 'secret' && permission.name === name)

  const validateValues = (value: unknown, field: string): void => {
    if (!isRecord(value)) {
      add(field, 'must be an object of strings')
      return
    }
    for (const [key, entry] of Object.entries(value)) {
      const path = `${field}.${key}`
      if (typeof entry !== 'string') {
        add(path, 'value must be a string')
        continue
      }
      if (entry.startsWith('secret:')) {
        const name = entry.slice('secret:'.length)
        if (!SECRET_NAME.test(name)) {
          add(path, 'secret name must match ^[a-z][a-z0-9._-]{0,23}$')
        } else if (!hasSecret(name)) {
          add(path, `secret:${name} requires the secrets:${name} permission`)
        }
      } else if (entry.startsWith('config:')) {
        const keyName = entry.slice('config:'.length)
        if (!CONFIG_KEY.test(keyName)) add(path, 'config key must match ^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$')
      }
    }
  }

  const urlAllowed = (url: string): boolean => {
    if (url.startsWith('config:')) {
      const key = url.slice('config:'.length)
      if (!CONFIG_KEY.test(key)) return false
      return permissions.some((permission) =>
        (permission.kind === 'network-config' || permission.kind === 'lan-config') && permission.key === key)
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return permissions.some((permission) => {
      if (permission.kind === 'network') return hostAllowed(permission.host, parsed.hostname)
      if (permission.kind === 'lan') return permission.host === parsed.hostname
      return false
    })
  }

  const validateMcp = (value: unknown): void => {
    if (!isRecord(value)) {
      add('mcp', 'mcp must be an object')
      return
    }
    const hasCommand = value.command !== undefined
    const hasUrl = value.url !== undefined
    if (hasCommand === hasUrl) {
      add('mcp', 'mcp must have exactly one of command and url')
      return
    }
    if (hasCommand) {
      rejectUnknown(value, MCP_COMMAND_FIELDS, 'mcp')
      if (typeof value.command !== 'string' || value.command === '') {
        add('mcp.command', 'mcp.command must be a non-empty string')
      }
      if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string'))) {
        add('mcp.args', 'mcp.args must be an array of strings')
      }
      if (value.env !== undefined) validateValues(value.env, 'mcp.env')
    }
    if (hasUrl) {
      rejectUnknown(value, MCP_URL_FIELDS, 'mcp')
      if (typeof value.url !== 'string') {
        add('mcp.url', 'mcp.url must be a string')
      } else if (!urlAllowed(value.url)) {
        add('mcp.url', 'mcp.url must be http(s) covered by a network or lan permission, or config:<key> with its permission')
      }
      if (value.headers !== undefined) validateValues(value.headers, 'mcp.headers')
    }
  }

  if (json.mcp !== undefined) validateMcp(json.mcp)

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, manifest: json as unknown as BrainManifest }
}

/** The major version of a range such as `^1`, `^1.2` or `^1.2.3`; null when it is not that shape. */
export function apiMajor(range: string): number | null {
  const match = API_RANGE.exec(range)
  return match ? Number(match[1]) : null
}

/** Only these names may appear in a manifest's `when`. */
export interface WakeFeatures {
  readonly message: { readonly hasMedia: boolean; readonly hasForward: boolean }
  readonly event: { readonly poke: boolean }
  readonly channel: { readonly kind: string }
}
export type WhenAtom =
  | { readonly feature: 'message.hasMedia' | 'message.hasForward' | 'event.poke' }
  | { readonly feature: 'channel.kind'; readonly equals: string }
/** Any group matches when all of its atoms do: `a && b || c` is [[a, b], [c]]. */
export interface WhenExpr { readonly anyOf: readonly (readonly WhenAtom[])[] }

type WhenToken =
  | { readonly kind: 'and' }
  | { readonly kind: 'or' }
  | { readonly kind: 'eq' }
  | { readonly kind: 'word'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }

const SIMPLE_FEATURES: ReadonlySet<string> = new Set(['message.hasMedia', 'message.hasForward', 'event.poke'])
const WHEN_VALUE = /^[a-z0-9_-]+$/
const WHEN_WORD_START = /[A-Za-z_]/
const WHEN_WORD_PART = /[A-Za-z0-9_.-]/
const WHEN_SPACE = /[ \t\n\r]/

function invalidWhen(text: string): BrainError {
  return new BrainError('INVALID_ARGUMENT', `invalid when expression: ${text}`, { field: 'when' })
}

function tokenizeWhen(text: string): WhenToken[] {
  const tokens: WhenToken[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    if (WHEN_SPACE.test(char)) {
      index += 1
      continue
    }
    if (text.startsWith('&&', index)) {
      tokens.push({ kind: 'and' })
      index += 2
      continue
    }
    if (text.startsWith('||', index)) {
      tokens.push({ kind: 'or' })
      index += 2
      continue
    }
    if (text.startsWith('==', index)) {
      tokens.push({ kind: 'eq' })
      index += 2
      continue
    }
    if (char === '"') {
      const end = text.indexOf('"', index + 1)
      if (end === -1) throw invalidWhen(text)
      const value = text.slice(index + 1, end)
      if (!WHEN_VALUE.test(value)) throw invalidWhen(text)
      tokens.push({ kind: 'string', value })
      index = end + 1
      continue
    }
    if (WHEN_WORD_START.test(char)) {
      let end = index + 1
      while (end < text.length && WHEN_WORD_PART.test(text[end]!)) end += 1
      tokens.push({ kind: 'word', value: text.slice(index, end) })
      index = end
      continue
    }
    throw invalidWhen(text)
  }
  return tokens
}

interface WhenCursor {
  readonly tokens: readonly WhenToken[]
  index: number
}

function parseWhenAtom(cursor: WhenCursor, text: string): WhenAtom {
  const token = cursor.tokens[cursor.index]
  if (!token || token.kind !== 'word') throw invalidWhen(text)
  if (SIMPLE_FEATURES.has(token.value)) {
    cursor.index += 1
    return { feature: token.value as 'message.hasMedia' | 'message.hasForward' | 'event.poke' }
  }
  if (token.value === 'channel.kind') {
    const operator = cursor.tokens[cursor.index + 1]
    const value = cursor.tokens[cursor.index + 2]
    if (!operator || operator.kind !== 'eq' || !value || value.kind !== 'string') throw invalidWhen(text)
    cursor.index += 3
    return { feature: 'channel.kind', equals: value.value }
  }
  throw invalidWhen(text)
}

/** Grammar: atoms joined by `&&` and `||`, no parentheses. Throws INVALID_ARGUMENT otherwise. */
export function parseWhen(text: string): WhenExpr {
  const tokens = tokenizeWhen(text)
  if (tokens.length === 0) throw invalidWhen(text)
  const cursor: WhenCursor = { tokens, index: 0 }
  const anyOf: WhenAtom[][] = []
  for (;;) {
    const group: WhenAtom[] = [parseWhenAtom(cursor, text)]
    while (cursor.tokens[cursor.index]?.kind === 'and') {
      cursor.index += 1
      group.push(parseWhenAtom(cursor, text))
    }
    anyOf.push(group)
    const next = cursor.tokens[cursor.index]
    if (!next) break
    if (next.kind !== 'or') throw invalidWhen(text)
    cursor.index += 1
  }
  return { anyOf }
}

function atomMatches(atom: WhenAtom, features: WakeFeatures): boolean {
  switch (atom.feature) {
    case 'message.hasMedia':
      return features.message.hasMedia
    case 'message.hasForward':
      return features.message.hasForward
    case 'event.poke':
      return features.event.poke
    case 'channel.kind':
      return features.channel.kind === atom.equals
  }
  return false
}

export function evalWhen(expr: WhenExpr, features: WakeFeatures): boolean {
  return expr.anyOf.some((group) => group.every((atom) => atomMatches(atom, features)))
}

/** JSON Schema with an object root. Keywords DSH cannot take are dropped by the kernel. */
export interface ToolParameters {
  readonly type: 'object'
  readonly properties?: Readonly<Record<string, unknown>>
  readonly required?: readonly string[]
  readonly [key: string]: unknown
}
export interface ToolImage { readonly mediaType: string; readonly base64: string }
export type ToolOutput = string | { readonly text: string; readonly images?: readonly ToolImage[] }
/** Filled by the kernel from the session; a tool never learns the channel from the model. */
export interface ToolCallContext {
  readonly channel: string
  readonly wakeId: string
  /** Opaque host-issued credential bound to this active tool call; pass `call` unchanged to `ctx.memory.readChannelEvent`. */
  readonly callToken?: string
}
export interface ToolDefinition {
  /** The action name from the manifest, without the `<plugin id>__` prefix. */
  readonly name: string
  readonly description: string
  readonly parameters: ToolParameters
  handler(args: Readonly<Record<string, unknown>>, call: ToolCallContext): Promise<ToolOutput>
}

export type Disposable = () => void

export interface ReadL0Request {
  readonly afterId?: string
  readonly from?: number
  readonly to?: number
  readonly limit?: number
}

export interface ReadL0Result {
  readonly items: readonly MemoryRecord[]
  readonly nextCursor?: string
}

export interface DerivedRecordInput {
  readonly channel: string
  readonly subjects: readonly string[]
  readonly content: Readonly<Record<string, unknown>>
  readonly evidence: readonly EvidenceRef[]
  readonly visibility?: Visibility
  readonly confidence?: number
  readonly importance?: number
  readonly tEvent?: number
  readonly idempotencyKey?: string
}

export interface MemoryProviderQuery {
  readonly query: string
  readonly layers?: readonly Layer[]
  readonly channels?: readonly string[]
  readonly subjects?: readonly string[]
  readonly from?: number
  readonly to?: number
  readonly limit: number
}

export interface MemoryProviderHit {
  readonly id: string
  readonly score: number
}

export interface MemoryProviderHealth {
  readonly status: 'ok' | 'degraded' | 'down'
  readonly model?: string
  readonly dimension?: number
}

export interface MemoryProvider {
  search(query: MemoryProviderQuery): Promise<readonly MemoryProviderHit[]>
  onRecord?(record: MemoryRecord): Promise<void>
  onForgotten(ids: readonly string[]): Promise<void>
  health?(): Promise<MemoryProviderHealth>
}

/** `channel` must be one of the plugin's own; participants always come from the kernel. */
export interface ViewOptions { readonly channel?: string }
export interface ChannelEventResult {
  readonly record: MemoryRecord
  readonly disclosure: Disclosure
}
export interface PluginMemory {
  ingest(event: IngestEvent): Promise<{ readonly id: string }>                                      // memory.ingest
  record(input: RecordInput): Promise<MemoryRecord>                                                 // memory.record
  update(id: string, patch: RecordPatch, expectedVersion: number, view?: ViewOptions): Promise<MemoryRecord>   // memory.record
  remove(id: string, view?: ViewOptions): Promise<void>                                             // memory.record
  search(request: SearchRequest, view?: ViewOptions): Promise<{ readonly items: readonly SearchHit[]; readonly nextCursor?: string; readonly degraded: boolean }>   // memory.search
  /** Active tool call only: reads one visible same-channel, same-source L0 record with its disclosure. */
  readChannelEvent?(recordId: string, call: ToolCallContext): Promise<ChannelEventResult>            // memory.search
  context(request: ContextRequest): Promise<ContextBundle>                                          // memory.context
  /** record: own source only; channel, and time with a channel: own channels only; person: never. */
  forget(selector: ForgetSelector): Promise<ForgetReport>                                           // memory.forget
  readL0(request?: ReadL0Request): Promise<ReadL0Result>                                            // memory.readL0
  writeDerived(input: DerivedRecordInput): Promise<MemoryRecord>                                    // memory.writeDerived
  provide(provider: MemoryProvider): Disposable                                                     // memory.readL0
}

export interface WakeMessage {
  /** The L0 record id returned by ingest; memory__remember cites it as evidence. */
  readonly id: string
  readonly actor: string           // person id
  readonly name: string            // what she calls them, at most 64 characters
  readonly text: string
  readonly tEvent: number
  readonly images?: readonly ToolImage[]
  /** True when the message carries media that may be fetched on demand without pre-attaching images. */
  readonly hasMedia?: boolean
  readonly forwarded?: boolean
}
export interface WakeInput {
  /** `^[a-z0-9_-]{1,32}$`, for instance message, poke, own-time. */
  readonly reason: string
  readonly messages?: readonly WakeMessage[]
  /** Trigger text with no sender. Treated as data, like a message. */
  readonly note?: string
  /** Extra L0 ids memory__remember may cite. */
  readonly evidence?: readonly string[]
  readonly event?: 'poke'
  /** Waits this long for more input before queueing; default 0. */
  readonly debounceMs?: number
  /** The turn may think and remember, but send tools are refused. */
  readonly silent?: boolean
  /** She is starting this herself: checked against quiet hours, an active chat, an unanswered message and the cooldown. */
  readonly proactive?: boolean
}
export type WakeSkip = 'quiet' | 'foreground' | 'unanswered' | 'cooldown'
export interface WakeResult {
  readonly wakeId: string
  readonly acked: boolean
  readonly profileVersion: number
  readonly sent: number
  readonly steps: number
  /** Set when a proactive wake was not run. */
  readonly skipped?: WakeSkip
}
export interface AgentSessionHandle {
  readonly channel: string
  wake(input: WakeInput): Promise<WakeResult>
  rotate(): Promise<void>
}
export interface PluginAgent {
  session(channel: string): AgentSessionHandle                                                      // agent.session
  /** Resolves when the turn that took this input ends. UNAVAILABLE when no model or role card is set. */
  wake(channel: string, input: WakeInput): Promise<WakeResult>                                      // agent.session
}

export interface PluginTools {
  /** The name must be listed in the manifest, otherwise PERMISSION_DENIED. */
  register(tool: ToolDefinition): Disposable                                                        // tools.register
}

export interface OutboundMessage {
  readonly text?: string
  readonly images?: readonly ToolImage[]
  readonly replyTo?: string
}
export interface ChannelProvider {
  send(channel: string, message: OutboundMessage): Promise<{ readonly messageId?: string }>
  /** Person ids; use ctx.identity.resolve first. */
  members(channel: string): Promise<readonly string[]>
  resolveIdentity(account: string): Promise<{ readonly displayName?: string } | null>
}
export interface PluginChannel {
  provide(provider: ChannelProvider): Disposable                                                    // channel.provide
  /** Own channels only; audited and rate limited like a send tool. */
  send(channel: string, message: OutboundMessage): Promise<{ readonly messageId?: string }>         // channel.send
}

/** Accounts must start with `<plugin id>:`. */
export interface PluginIdentity {
  resolve(account: string): Promise<string>                                                         // identity.link
  link(account: string, personId: string): Promise<void>                                            // identity.link
}

export interface OwnTimeRequest {
  readonly name: string
  readonly everyMs: number
  run(): Promise<void> | void
}
export interface PluginScheduler {
  every(ms: number, run: () => Promise<void> | void): Disposable
  at(timeMs: number, run: () => Promise<void> | void): Disposable
  ownTime(request: OwnTimeRequest): Disposable                                                      // schedule.ownTime
}

/** Payloads carry ids and numbers only, never chat text (R8). */
export interface BrainEvents {
  'message.in': { readonly channel: string; readonly count: number; readonly recordIds: readonly string[] }
  'agent.turn': { readonly channel: string; readonly wakeId: string; readonly ok: boolean; readonly sent: number; readonly steps: number; readonly profileVersion: number }
  'memory.recorded': { readonly id: string; readonly layer: 'L1' | 'L2'; readonly kind: string; readonly source: string }
  'memory.forgotten': { readonly ids: readonly string[] }
}
export interface PluginEvents {
  on<K extends keyof BrainEvents>(name: K, handler: (payload: BrainEvents[K]) => void | Promise<void>): Disposable
  on(name: string, handler: (payload: unknown) => void | Promise<void>): Disposable
  /** Only names starting with `<plugin id>.`. */
  emit(name: string, payload: Readonly<Record<string, unknown>>): void
}

export interface PluginRequest {
  readonly method: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly body: unknown
}
export interface FetchOptions {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Uint8Array
  readonly timeoutMs?: number
  readonly maxBytes?: number
  /** Redirect handling: default `'follow'`; `'error'` refuses any 3xx redirect. */
  readonly redirect?: 'follow' | 'error'
}
export interface FetchResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  text(): string
  bytes(): Uint8Array
}
export interface WebSocketAuthOptions {
  /** Secret names tried in order; every listed name must be granted via `secrets:<name>`. */
  readonly secretNames: readonly string[]
  /** How the resolved secret is sent during the handshake; default `'header'`. */
  readonly transport?: 'header' | 'query'
  /** Header name (default `'Authorization'` with `Bearer <secret>`) or query param name (default `'access_token'`). */
  readonly paramName?: string
}
export interface WebSocketSubscribeOptions {
  /** Top-level config key holding the `ws://` or `wss://` URL, authorized by `lan:config:<configKey>` or `network:config:<configKey>`. */
  readonly configKey: string
  /** Optional expected URL checked against the host-validated config value; never overrides host config. */
  readonly url?: string
  /** Optional kernel-resolved handshake secret configuration. */
  readonly auth?: WebSocketAuthOptions
  /** Handshake timeout in ms (capped by the kernel). */
  readonly timeoutMs?: number
  /** Max inbound UTF-8 text message size in bytes (capped at 1 MiB). */
  readonly maxMessageBytes?: number
  /** Max pending undelivered events before closing with queue overflow (capped by the kernel). */
  readonly maxQueueLength?: number
}
export type WebSocketEvent =
  | { readonly type: 'open' }
  | { readonly type: 'message'; readonly data: string }
  | { readonly type: 'close'; readonly code: number; readonly reason: string }
  | { readonly type: 'error'; readonly code: ErrorCode; readonly reason: string }
export interface PluginHttp {
  /** Mounted at `/api/v1/plugins/<id><path>`, behind the kernel's token and envelope. Returns `data`. */
  route(method: string, path: string, handler: (request: PluginRequest) => Promise<unknown>): Disposable
  fetch(url: string, options?: FetchOptions): Promise<FetchResponse>                                // network:<host>
  /** Kernel-managed text WebSocket subscription bound to a top-level URL config key. */
  subscribeWebSocket?(options: WebSocketSubscribeOptions, listener: (event: WebSocketEvent) => void | Promise<void>): Promise<Disposable>  // lan:config:<key>
}

export interface PluginConsole {
  page(descriptor: { readonly id: string; readonly title: string; readonly entry: string }): Disposable
}
export interface PluginSecrets {
  get(name: string): Promise<string | undefined>                                                    // secrets:<name>
}
/** Paths are relative to state/plugins/<id>/; `..`, absolute paths and links leading outside are refused. */
export interface PluginStorage {
  read(path: string): Promise<Uint8Array | undefined>
  write(path: string, data: string | Uint8Array): Promise<void>
  remove(path: string): Promise<void>
  list(prefix?: string): Promise<readonly string[]>
}
export interface BrainLogger {
  /** Only strings, numbers and booleans; keys like content, text and message are dropped. */
  info(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void
  warn(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void
  error(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void
}
export interface PluginLlm {
  /** FR-P10 is P1: rejects with UNAVAILABLE until model-accounting lands. */
  complete(request: { readonly system: string; readonly user: string; readonly maxOutputTokens: number }): Promise<{ readonly text: string; readonly tokens: number }>   // llm.invoke
}

export interface BrainContext<C = Readonly<Record<string, unknown>>> {
  readonly plugin: { readonly id: string; readonly version: string }
  readonly memory: PluginMemory
  readonly agent: PluginAgent
  readonly tools: PluginTools
  readonly channel: PluginChannel
  readonly identity: PluginIdentity
  readonly scheduler: PluginScheduler
  readonly events: PluginEvents
  readonly http: PluginHttp
  readonly console: PluginConsole
  readonly config: C
  readonly secrets: PluginSecrets
  readonly storage: PluginStorage
  readonly logger: BrainLogger
  readonly llm: PluginLlm
}
/** A plugin's main module exports `apply` under this name. */
export type PluginApply<C = Readonly<Record<string, unknown>>> = (ctx: BrainContext<C>, config: C) => void | Promise<void>
