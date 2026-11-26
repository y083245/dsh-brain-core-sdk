import assert from 'node:assert/strict'
import test from 'node:test'
import { memoryApi } from '../../web/src/api/client.ts'
import type { PersonSummary } from '../../web/src/api/types.ts'
import {
  buildConsoleSearchRequest,
  collectAvailableChannels,
  collectKnownChannels,
  formatPersonLabel,
  formatScopeSummary,
  INITIAL_SEARCH_OPTIONS,
  resolveEffectiveChannel,
  resolveEffectivePerson,
  resolveSearchContext,
  type SearchOptions,
} from '../../web/src/pages/memory/searchContext.ts'

const ALICE: PersonSummary = {
  personId: 'p_alice',
  accounts: ['qq:1001'],
  aliases: ['小鲸鱼'],
}

const BOB: PersonSummary = {
  personId: 'p_bob',
  accounts: ['wx:2002'],
  aliases: [],
}

function withOptions(patch: Partial<SearchOptions>): SearchOptions {
  return { ...INITIAL_SEARCH_OPTIONS, ...patch }
}

test('collectKnownChannels and collectAvailableChannels deduplicate, trim, and sort candidates', () => {
  assert.deepEqual(
    collectKnownChannels({
      discoveredChannels: [' qq:group:2 ', '', 'qq:group:1'],
      sessionChannels: ['qq:group:1', 'console-chat:private:owner', '   '],
    }),
    ['console-chat:private:owner', 'qq:group:1', 'qq:group:2'],
  )

  assert.deepEqual(
    collectAvailableChannels({
      discoveredChannels: ['qq:group:1'],
      sessionChannels: ['qq:group:2'],
      voiceChannel: 'console-chat:private:owner',
      filterChannel: 'qq:group:3',
      selectedChannel: 'qq:group:1',
    }),
    ['console-chat:private:owner', 'qq:group:1', 'qq:group:2', 'qq:group:3'],
  )
})

test('resolveEffectiveChannel applies option > filter > known voice > sole known > empty-known voice > none', () => {
  // 1. Explicit option channel wins over filter and voice
  assert.deepEqual(
    resolveEffectiveChannel({
      optionChannel: 'qq:group:opt',
      filterChannel: 'qq:group:flt',
      knownChannels: ['console-chat:private:owner', 'qq:group:flt'],
      voiceChannel: 'console-chat:private:owner',
    }),
    { channel: 'qq:group:opt', source: 'option' },
  )

  // 2. Strata filter channel wins over voice channel
  assert.deepEqual(
    resolveEffectiveChannel({
      optionChannel: '',
      filterChannel: 'qq:group:flt',
      knownChannels: ['console-chat:private:owner', 'qq:group:flt'],
      voiceChannel: 'console-chat:private:owner',
    }),
    { channel: 'qq:group:flt', source: 'filter' },
  )

  // 3. Voice channel is used when it exists in knownChannels
  assert.deepEqual(
    resolveEffectiveChannel({
      optionChannel: '',
      filterChannel: '',
      knownChannels: ['console-chat:private:owner', 'qq:group:1'],
      voiceChannel: 'console-chat:private:owner',
    }),
    { channel: 'console-chat:private:owner', source: 'voice' },
  )

  // 4. Imported single external channel does NOT get shadowed by unused voice default channel
  assert.deepEqual(
    resolveEffectiveChannel({
      optionChannel: '',
      filterChannel: '',
      knownChannels: ['qq:group:imported'],
      voiceChannel: 'console-chat:private:owner',
    }),
    { channel: 'qq:group:imported', source: 'sole' },
  )

  // 5. Multiple external channels with unused voice default -> require explicit user selection
  assert.deepEqual(
    resolveEffectiveChannel({
      optionChannel: '',
      filterChannel: '',
      knownChannels: ['qq:group:1', 'qq:group:2'],
      voiceChannel: 'console-chat:private:owner',
    }),
    { channel: null, source: 'none' },
  )

  // 6. No known channels discovered yet -> fall back to active voice channel
  assert.deepEqual(
    resolveEffectiveChannel({
      optionChannel: '',
      filterChannel: '',
      knownChannels: [],
      voiceChannel: 'console-chat:private:owner',
    }),
    { channel: 'console-chat:private:owner', source: 'voice' },
  )

  // 7. Nothing available -> none
  assert.deepEqual(
    resolveEffectiveChannel({
      optionChannel: '',
      filterChannel: '',
      knownChannels: [],
      voiceChannel: '',
    }),
    { channel: null, source: 'none' },
  )
})

test('resolveEffectivePerson applies option > filter > sole person > none', () => {
  assert.deepEqual(
    resolveEffectivePerson({
      optionSubject: ALICE.personId,
      filterPersonId: BOB.personId,
      persons: [ALICE, BOB],
    }),
    { personId: ALICE.personId, source: 'option' },
  )

  assert.deepEqual(
    resolveEffectivePerson({
      optionSubject: '',
      filterPersonId: BOB.personId,
      persons: [ALICE, BOB],
    }),
    { personId: BOB.personId, source: 'filter' },
  )

  assert.deepEqual(
    resolveEffectivePerson({
      optionSubject: '',
      filterPersonId: '',
      persons: [ALICE],
    }),
    { personId: ALICE.personId, source: 'sole' },
  )

  assert.deepEqual(
    resolveEffectivePerson({
      optionSubject: '',
      filterPersonId: '',
      persons: [ALICE, BOB],
    }),
    { personId: null, source: 'none' },
  )

  assert.deepEqual(
    resolveEffectivePerson({
      optionSubject: '',
      filterPersonId: '',
      persons: [],
    }),
    { personId: null, source: 'none' },
  )
})

test('resolveSearchContext and buildConsoleSearchRequest handle here, person, all, and missing context', () => {
  // Missing channel under 'here' returns missingReason='channel' and null request
  const missingHere = resolveSearchContext({
    options: withOptions({ scope: 'here' }),
    filterChannel: '',
    filterPersonId: '',
    discoveredChannels: ['qq:group:1', 'qq:group:2'],
    sessionChannels: [],
    voiceChannel: 'console-chat:private:owner',
    persons: [ALICE, BOB],
  })
  assert.equal(missingHere.missingReason, 'channel')
  assert.equal(formatScopeSummary(missingHere), '当前通道（未选择）')
  assert.equal(buildConsoleSearchRequest('龙井', withOptions({ scope: 'here' }), missingHere), null)

  // Resolved 'here' passes channel (and optional subject filter)
  const hereOptions = withOptions({
    scope: 'here',
    layers: ['L1', 'L0'],
    subject: ALICE.personId,
    neighbors: 2,
    history: true,
  })
  const resolvedHere = resolveSearchContext({
    options: hereOptions,
    filterChannel: 'qq:group:1',
    filterPersonId: '',
    discoveredChannels: ['qq:group:1', 'qq:group:2'],
    sessionChannels: [],
    voiceChannel: 'console-chat:private:owner',
    persons: [ALICE, BOB],
  })
  assert.equal(resolvedHere.missingReason, null)
  assert.equal(formatScopeSummary(resolvedHere), '当前通道 (qq:group:1) · 主体 小鲸鱼')
  assert.deepEqual(
    buildConsoleSearchRequest('龙井', hereOptions, resolvedHere, 'cur_1'),
    {
      query: '龙井',
      scope: 'here',
      channel: 'qq:group:1',
      layers: ['L1', 'L0'],
      subjects: [ALICE.personId],
      neighbors: 2,
      history: true,
      cursor: 'cur_1',
      limit: 50,
    },
  )

  // Missing person under 'person' returns missingReason='person' and null request
  const missingPerson = resolveSearchContext({
    options: withOptions({ scope: 'person' }),
    filterChannel: '',
    filterPersonId: '',
    discoveredChannels: ['qq:group:1'],
    sessionChannels: [],
    voiceChannel: 'console-chat:private:owner',
    persons: [ALICE, BOB],
  })
  assert.equal(missingPerson.missingReason, 'person')
  assert.equal(formatScopeSummary(missingPerson), '当前人物（未选择）')
  assert.equal(buildConsoleSearchRequest('龙井', withOptions({ scope: 'person' }), missingPerson), null)

  // Resolved 'person' passes participants=[effectivePersonId] and omits subjects/channel
  const personOptions = withOptions({ scope: 'person' })
  const resolvedPerson = resolveSearchContext({
    options: personOptions,
    filterChannel: 'qq:group:1',
    filterPersonId: ALICE.personId,
    discoveredChannels: ['qq:group:1'],
    sessionChannels: [],
    voiceChannel: 'console-chat:private:owner',
    persons: [ALICE, BOB],
  })
  assert.equal(resolvedPerson.missingReason, null)
  assert.equal(resolvedPerson.effectivePersonLabel, '小鲸鱼')
  assert.equal(formatScopeSummary(resolvedPerson), '当前人物 (小鲸鱼)')
  assert.equal(formatPersonLabel(BOB.personId, [ALICE, BOB]), 'p_bob')
  const personReq = buildConsoleSearchRequest('龙井', personOptions, resolvedPerson)
  assert.deepEqual(personReq, {
    query: '龙井',
    scope: 'person',
    participants: [ALICE.personId],
    limit: 50,
  })
  assert.equal('subjects' in (personReq ?? {}), false)
  assert.equal('channel' in (personReq ?? {}), false)

  // 'all' scope never triggers missingReason, surfaces active subject filter in summary, and keeps optional subject filter
  const allPlain = resolveSearchContext({
    options: withOptions({ scope: 'all' }),
    filterChannel: '',
    filterPersonId: '',
    discoveredChannels: [],
    sessionChannels: [],
    voiceChannel: '',
    persons: [ALICE, BOB],
  })
  assert.equal(allPlain.missingReason, null)
  assert.equal(formatScopeSummary(allPlain), '全部')

  const allWithAliasSubject = resolveSearchContext({
    options: withOptions({ scope: 'all', subject: ALICE.personId }),
    filterChannel: '',
    filterPersonId: '',
    discoveredChannels: [],
    sessionChannels: [],
    voiceChannel: '',
    persons: [ALICE, BOB],
  })
  assert.equal(allWithAliasSubject.missingReason, null)
  assert.equal(formatScopeSummary(allWithAliasSubject), '全部 · 主体 小鲸鱼')

  const allOptions = withOptions({ scope: 'all', subject: BOB.personId })
  const resolvedAll = resolveSearchContext({
    options: allOptions,
    filterChannel: '',
    filterPersonId: '',
    discoveredChannels: [],
    sessionChannels: [],
    voiceChannel: '',
    persons: [],
  })
  assert.equal(resolvedAll.missingReason, null)
  assert.equal(formatScopeSummary(resolvedAll), '全部 · 主体 p_bob')
  assert.deepEqual(
    buildConsoleSearchRequest('龙井', allOptions, resolvedAll),
    {
      query: '龙井',
      scope: 'all',
      subjects: [BOB.personId],
      limit: 50,
    },
  )
})

test('memoryApi.search routes contextual searches to /api/v1/console/memory/search and plain all searches to /api/v1/memory/search', async () => {
  const calls: { readonly url: string; readonly body: unknown }[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const parsedBody = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    calls.push({ url, body: parsedBody })
    return new Response(JSON.stringify({
      ok: true,
      data: { items: [] },
      meta: { requestId: 'req_1', apiVersion: '1.0', degraded: false },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  try {
    await memoryApi.search({ query: '龙井', scope: 'all', limit: 6 })
    await memoryApi.search({ query: '龙井', scope: 'here', channel: 'qq:group:1', limit: 50 })
    await memoryApi.search({ query: '龙井', scope: 'person', participants: ['p_alice'], limit: 50 })

    assert.equal(calls.length, 3)
    assert.equal(calls[0]?.url, '/api/v1/memory/search')
    assert.equal(calls[1]?.url, '/api/v1/console/memory/search')
    assert.deepEqual(calls[1]?.body, { query: '龙井', scope: 'here', channel: 'qq:group:1', limit: 50 })
    assert.equal(calls[2]?.url, '/api/v1/console/memory/search')
    assert.deepEqual(calls[2]?.body, { query: '龙井', scope: 'person', participants: ['p_alice'], limit: 50 })
  } finally {
    globalThis.fetch = originalFetch
  }
})
