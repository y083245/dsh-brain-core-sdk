import type { ConsoleSearchRequest, Layer, PersonSummary, SearchScope } from '../../api/types.ts'

export interface SearchOptions {
  readonly scope: SearchScope
  readonly channel: string
  readonly layers: readonly Layer[]
  readonly from: string
  readonly to: string
  readonly subject: string
  readonly neighbors: number
  readonly history: boolean
}

export const INITIAL_SEARCH_OPTIONS: SearchOptions = {
  scope: 'all',
  channel: '',
  layers: [],
  from: '',
  to: '',
  subject: '',
  neighbors: 0,
  history: false,
}

export type ChannelContextSource = 'option' | 'filter' | 'voice' | 'sole' | 'none'
export type PersonContextSource = 'option' | 'filter' | 'sole' | 'none'

export interface ChannelCandidateSources {
  readonly discoveredChannels?: readonly string[]
  readonly sessionChannels?: readonly string[]
  readonly voiceChannel?: string | null
  readonly selectedChannel?: string | null
  readonly filterChannel?: string | null
}

export interface SearchContextInput {
  readonly options: SearchOptions
  readonly filterChannel: string
  readonly filterPersonId: string
  readonly discoveredChannels: readonly string[]
  readonly sessionChannels: readonly string[]
  readonly voiceChannel?: string | null
  readonly persons: readonly PersonSummary[]
}

export interface ResolvedChannelContext {
  readonly channel: string | null
  readonly source: ChannelContextSource
}

export interface ResolvedPersonContext {
  readonly personId: string | null
  readonly source: PersonContextSource
}

export interface ResolvedSearchContext {
  readonly scope: SearchScope
  readonly knownChannels: readonly string[]
  readonly availableChannels: readonly string[]
  readonly effectiveChannel: string | null
  readonly channelSource: ChannelContextSource
  readonly effectivePersonId: string | null
  readonly effectivePersonLabel: string | null
  readonly personSource: PersonContextSource
  readonly subjectFilterId: string | null
  readonly subjectFilterLabel: string | null
  readonly missingReason: 'channel' | 'person' | null
}

function normalizeId(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function uniqueSortedNonEmpty(values: Iterable<string | null | undefined>): readonly string[] {
  const result = new Set<string>()
  for (const raw of values) {
    const clean = normalizeId(raw)
    if (clean !== '') result.add(clean)
  }
  return [...result].sort()
}

export function collectKnownChannels(sources: Pick<ChannelCandidateSources, 'discoveredChannels' | 'sessionChannels'>): readonly string[] {
  return uniqueSortedNonEmpty([
    ...(sources.discoveredChannels ?? []),
    ...(sources.sessionChannels ?? []),
  ])
}

export function collectAvailableChannels(sources: ChannelCandidateSources): readonly string[] {
  return uniqueSortedNonEmpty([
    ...(sources.discoveredChannels ?? []),
    ...(sources.sessionChannels ?? []),
    sources.voiceChannel,
    sources.filterChannel,
    sources.selectedChannel,
  ])
}

export function formatPersonLabel(personId: string, persons: readonly PersonSummary[]): string {
  const clean = normalizeId(personId)
  if (clean === '') return ''
  const matched = persons.find((person) => person.personId === clean)
  if (matched === undefined) return clean
  return matched.aliases.find((alias) => alias.trim() !== '')?.trim() ?? matched.personId
}

export function resolveEffectiveChannel(input: {
  readonly optionChannel: string
  readonly filterChannel: string
  readonly knownChannels: readonly string[]
  readonly voiceChannel?: string | null
}): ResolvedChannelContext {
  const optionChannel = normalizeId(input.optionChannel)
  if (optionChannel !== '') {
    return { channel: optionChannel, source: 'option' }
  }
  const filterChannel = normalizeId(input.filterChannel)
  if (filterChannel !== '') {
    return { channel: filterChannel, source: 'filter' }
  }
  const voiceChannel = normalizeId(input.voiceChannel)
  if (voiceChannel !== '' && input.knownChannels.includes(voiceChannel)) {
    return { channel: voiceChannel, source: 'voice' }
  }
  if (input.knownChannels.length === 1) {
    return { channel: input.knownChannels[0]!, source: 'sole' }
  }
  if (input.knownChannels.length === 0 && voiceChannel !== '') {
    return { channel: voiceChannel, source: 'voice' }
  }
  return { channel: null, source: 'none' }
}

export function resolveEffectivePerson(input: {
  readonly optionSubject: string
  readonly filterPersonId: string
  readonly persons: readonly PersonSummary[]
}): ResolvedPersonContext {
  const optionSubject = normalizeId(input.optionSubject)
  if (optionSubject !== '') {
    return { personId: optionSubject, source: 'option' }
  }
  const filterPersonId = normalizeId(input.filterPersonId)
  if (filterPersonId !== '') {
    return { personId: filterPersonId, source: 'filter' }
  }
  if (input.persons.length === 1) {
    const soleId = normalizeId(input.persons[0]?.personId)
    if (soleId !== '') {
      return { personId: soleId, source: 'sole' }
    }
  }
  return { personId: null, source: 'none' }
}

export function resolveSearchContext(input: SearchContextInput): ResolvedSearchContext {
  const knownChannels = collectKnownChannels({
    discoveredChannels: input.discoveredChannels,
    sessionChannels: input.sessionChannels,
  })
  const availableChannels = collectAvailableChannels({
    discoveredChannels: input.discoveredChannels,
    sessionChannels: input.sessionChannels,
    voiceChannel: input.voiceChannel,
    filterChannel: input.filterChannel,
    selectedChannel: input.options.channel,
  })
  const channel = resolveEffectiveChannel({
    optionChannel: input.options.channel,
    filterChannel: input.filterChannel,
    knownChannels,
    voiceChannel: input.voiceChannel,
  })
  const person = resolveEffectivePerson({
    optionSubject: input.options.subject,
    filterPersonId: input.filterPersonId,
    persons: input.persons,
  })

  const subjectFilterId = normalizeId(input.options.subject) || null
  const subjectFilterLabel = subjectFilterId === null ? null : formatPersonLabel(subjectFilterId, input.persons)

  let missingReason: 'channel' | 'person' | null = null
  if (input.options.scope === 'here' && channel.channel === null) {
    missingReason = 'channel'
  } else if (input.options.scope === 'person' && person.personId === null) {
    missingReason = 'person'
  }

  return {
    scope: input.options.scope,
    knownChannels,
    availableChannels,
    effectiveChannel: channel.channel,
    channelSource: channel.source,
    effectivePersonId: person.personId,
    effectivePersonLabel: person.personId === null ? null : formatPersonLabel(person.personId, input.persons),
    personSource: person.source,
    subjectFilterId,
    subjectFilterLabel,
    missingReason,
  }
}

export function buildConsoleSearchRequest(
  query: string,
  options: SearchOptions,
  context: ResolvedSearchContext,
  cursor?: string,
): ConsoleSearchRequest | null {
  if (context.missingReason !== null) return null

  const fromMs = options.from ? new Date(`${options.from}T00:00:00`).getTime() : undefined
  const toMs = options.to ? new Date(`${options.to}T23:59:59.999`).getTime() : undefined
  const optionSubject = normalizeId(options.subject)
  const cleanCursor = normalizeId(cursor)

  const base: ConsoleSearchRequest = {
    query,
    scope: options.scope,
    ...(options.layers.length > 0 ? { layers: options.layers } : {}),
    ...(fromMs !== undefined && Number.isFinite(fromMs) ? { from: fromMs } : {}),
    ...(toMs !== undefined && Number.isFinite(toMs) ? { to: toMs } : {}),
    ...(options.neighbors > 0 ? { neighbors: options.neighbors } : {}),
    ...(options.history ? { history: true } : {}),
    ...(cleanCursor !== '' ? { cursor: cleanCursor } : {}),
    limit: 50,
  }

  if (options.scope === 'here') {
    if (context.effectiveChannel === null) return null
    return {
      ...base,
      channel: context.effectiveChannel,
      ...(optionSubject !== '' ? { subjects: [optionSubject] } : {}),
    }
  }

  if (options.scope === 'person') {
    if (context.effectivePersonId === null) return null
    return {
      ...base,
      participants: [context.effectivePersonId],
    }
  }

  return {
    ...base,
    ...(optionSubject !== '' ? { subjects: [optionSubject] } : {}),
  }
}

export function formatScopeSummary(context: ResolvedSearchContext): string {
  const subjectSuffix = context.subjectFilterLabel !== null
    ? ` · 主体 ${context.subjectFilterLabel}`
    : context.subjectFilterId !== null
      ? ` · 主体 ${context.subjectFilterId}`
      : ''

  if (context.scope === 'here') {
    return context.effectiveChannel !== null
      ? `当前通道 (${context.effectiveChannel})${subjectSuffix}`
      : '当前通道（未选择）'
  }
  if (context.scope === 'person') {
    const label = context.effectivePersonLabel ?? context.effectivePersonId
    return label !== null ? `当前人物 (${label})` : '当前人物（未选择）'
  }
  return `全部${subjectSuffix}`
}
