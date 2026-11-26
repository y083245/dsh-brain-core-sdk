import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { MemoryRecord, Viewer, Visibility } from '@brain-core/sdk'
import type { ChannelFacts, PolicyDecision } from '../../src/contracts/index.ts'
import { LABELS, createPolicy } from '../../src/memory-policy/index.ts'

const OWNER = 'qq:private:10001' // the owner's private chat
const G = 'qq:group:20001' // a group whose members are alice and bob
const PA = 'qq:private:30001' // a private chat with alice
const PC = 'qq:private:40001' // a private chat with carol, who is not in G

const facts: ChannelFacts = {
  ownerChannels: new Set([OWNER]),
  members: new Map([[G, new Set(['p_alice', 'p_bob'])]]),
  kindOf: (channel) =>
    channel.split(':')[1] === 'private' ? 'private' : channel.split(':')[1] === 'group' ? 'group' : 'other',
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'l1_01JTEST000000000000000000',
    layer: 'L1',
    kind: 'l1.fact',
    source: 'plugin.test',
    channel: G,
    subjects: ['p_alice'],
    actor: 'owner',
    content: { text: 'hello' },
    evidence: [{ id: 'l0_01JTEST000000000000000000' }],
    visibility: 'open',
    trust: 'owner',
    confidence: 0.5,
    importance: 0.5,
    tEvent: 1_760_000_000_000,
    tIngest: 1_760_000_001_000,
    status: 'active',
    version: 1,
    ...overrides,
  }
}

function viewer(channel: string | null, participants: readonly string[], caller = 'agent'): Viewer {
  return { caller, channel, participants }
}

const A = viewer(G, ['p_alice', 'p_bob'])
const B = viewer(G, ['p_bob'])
const C = viewer(PA, ['p_alice'])
const D = viewer(PC, ['p_carol'])
const E = viewer(OWNER, ['self'])
const F = viewer(null, [])

const HIDDEN: PolicyDecision = { visible: false, injection: 'none', disclosure: { speakable: 'never', label: '' } }
const conclude: PolicyDecision = {
  visible: true,
  injection: 'conclusion-only',
  disclosure: { speakable: 'never', label: LABELS.internal },
}

function verbatim(speakable: 'yes' | 'if-subject-raises', label: string): PolicyDecision {
  return { visible: true, injection: 'verbatim', disclosure: { speakable, label } }
}

interface Case {
  readonly name: string
  readonly record: MemoryRecord
  readonly viewer: Viewer
  readonly expected: PolicyDecision
}

const observed: { readonly caller: string; readonly visibility: Visibility; readonly decision: PolicyDecision }[] = []

/** Every table cell is exactly one assertion over the whole PolicyDecision. */
function check(testCase: Case): void {
  const decision = createPolicy().decide(testCase.record, testCase.viewer, facts)
  assert.deepEqual(decision, testCase.expected, testCase.name)
  observed.push({ caller: testCase.viewer.caller, visibility: testCase.record.visibility, decision })
}

function inGroup(visibility: Visibility): MemoryRecord {
  return record({ channel: G, subjects: ['p_alice'], visibility })
}

function inPrivateWithAlice(visibility: Visibility): MemoryRecord {
  return record({ channel: PA, subjects: ['p_alice'], visibility })
}

test('LABELS carry the exact wording from the work order', () => {
  assert.deepEqual(LABELS, {
    here: '就在这里说过',
    private: '私下聊过',
    group: '在群里听说的',
    elsewhere: '在别处看到的',
    raiseOnly: '，不要当众提，对方自己提起再接话',
    internal: '只作判断依据，不要说出来',
    owner: '主人可见',
  })
})

const TABLE_1: readonly Case[] = [
    { name: 'T1 open A', record: inGroup('open'), viewer: A, expected: verbatim('yes', LABELS.here) },
    { name: 'T1 open B', record: inGroup('open'), viewer: B, expected: verbatim('yes', LABELS.here) },
    { name: 'T1 open C', record: inGroup('open'), viewer: C, expected: verbatim('yes', LABELS.group) },
    { name: 'T1 open D', record: inGroup('open'), viewer: D, expected: HIDDEN },
    { name: 'T1 open E', record: inGroup('open'), viewer: E, expected: HIDDEN },
    { name: 'T1 open F', record: inGroup('open'), viewer: F, expected: verbatim('yes', LABELS.group) },
    {
      name: 'T1 subject A', record: inGroup('subject'), viewer: A,
      expected: verbatim('if-subject-raises', LABELS.here + LABELS.raiseOnly),
    },
    { name: 'T1 subject B', record: inGroup('subject'), viewer: B, expected: HIDDEN },
    { name: 'T1 subject C', record: inGroup('subject'), viewer: C, expected: verbatim('yes', LABELS.group) },
    { name: 'T1 subject D', record: inGroup('subject'), viewer: D, expected: HIDDEN },
    { name: 'T1 subject E', record: inGroup('subject'), viewer: E, expected: HIDDEN },
    { name: 'T1 subject F', record: inGroup('subject'), viewer: F, expected: HIDDEN },
    { name: 'T1 origin A', record: inGroup('origin'), viewer: A, expected: verbatim('yes', LABELS.here) },
    { name: 'T1 origin B', record: inGroup('origin'), viewer: B, expected: verbatim('yes', LABELS.here) },
    { name: 'T1 origin C', record: inGroup('origin'), viewer: C, expected: HIDDEN },
    { name: 'T1 origin D', record: inGroup('origin'), viewer: D, expected: HIDDEN },
    { name: 'T1 origin E', record: inGroup('origin'), viewer: E, expected: HIDDEN },
    { name: 'T1 origin F', record: inGroup('origin'), viewer: F, expected: HIDDEN },
    { name: 'T1 owner A', record: inGroup('owner'), viewer: A, expected: HIDDEN },
    { name: 'T1 owner B', record: inGroup('owner'), viewer: B, expected: HIDDEN },
    { name: 'T1 owner C', record: inGroup('owner'), viewer: C, expected: HIDDEN },
    { name: 'T1 owner D', record: inGroup('owner'), viewer: D, expected: HIDDEN },
    { name: 'T1 owner E', record: inGroup('owner'), viewer: E, expected: verbatim('yes', LABELS.group) },
    { name: 'T1 owner F', record: inGroup('owner'), viewer: F, expected: HIDDEN },
    { name: 'T1 internal A', record: inGroup('internal'), viewer: A, expected: conclude },
    { name: 'T1 internal B', record: inGroup('internal'), viewer: B, expected: conclude },
    { name: 'T1 internal C', record: inGroup('internal'), viewer: C, expected: conclude },
    { name: 'T1 internal D', record: inGroup('internal'), viewer: D, expected: conclude },
    { name: 'T1 internal E', record: inGroup('internal'), viewer: E, expected: conclude },
    { name: 'T1 internal F', record: inGroup('internal'), viewer: F, expected: conclude },
]


const TABLE_2: readonly Case[] = [
    { name: 'T2 open A', record: inPrivateWithAlice('open'), viewer: A, expected: verbatim('yes', LABELS.private) },
    { name: 'T2 open B', record: inPrivateWithAlice('open'), viewer: B, expected: verbatim('yes', LABELS.private) },
    { name: 'T2 open C', record: inPrivateWithAlice('open'), viewer: C, expected: verbatim('yes', LABELS.here) },
    { name: 'T2 open D', record: inPrivateWithAlice('open'), viewer: D, expected: verbatim('yes', LABELS.private) },
    { name: 'T2 open E', record: inPrivateWithAlice('open'), viewer: E, expected: verbatim('yes', LABELS.private) },
    {
      name: 'T2 subject A', record: inPrivateWithAlice('subject'), viewer: A,
      expected: verbatim('if-subject-raises', LABELS.private + LABELS.raiseOnly),
    },
    { name: 'T2 subject B', record: inPrivateWithAlice('subject'), viewer: B, expected: HIDDEN },
    { name: 'T2 subject C', record: inPrivateWithAlice('subject'), viewer: C, expected: verbatim('yes', LABELS.here) },
    { name: 'T2 subject D', record: inPrivateWithAlice('subject'), viewer: D, expected: HIDDEN },
    { name: 'T2 subject E', record: inPrivateWithAlice('subject'), viewer: E, expected: HIDDEN },
    { name: 'T2 origin A', record: inPrivateWithAlice('origin'), viewer: A, expected: HIDDEN },
    { name: 'T2 origin B', record: inPrivateWithAlice('origin'), viewer: B, expected: HIDDEN },
    { name: 'T2 origin C', record: inPrivateWithAlice('origin'), viewer: C, expected: verbatim('yes', LABELS.here) },
    { name: 'T2 origin D', record: inPrivateWithAlice('origin'), viewer: D, expected: HIDDEN },
    { name: 'T2 origin E', record: inPrivateWithAlice('origin'), viewer: E, expected: HIDDEN },
    { name: 'T2 owner A', record: inPrivateWithAlice('owner'), viewer: A, expected: HIDDEN },
    { name: 'T2 owner B', record: inPrivateWithAlice('owner'), viewer: B, expected: HIDDEN },
    { name: 'T2 owner C', record: inPrivateWithAlice('owner'), viewer: C, expected: HIDDEN },
    { name: 'T2 owner D', record: inPrivateWithAlice('owner'), viewer: D, expected: HIDDEN },
    { name: 'T2 owner E', record: inPrivateWithAlice('owner'), viewer: E, expected: verbatim('yes', LABELS.private) },
    { name: 'T2 internal A', record: inPrivateWithAlice('internal'), viewer: A, expected: conclude },
    { name: 'T2 internal B', record: inPrivateWithAlice('internal'), viewer: B, expected: conclude },
    { name: 'T2 internal C', record: inPrivateWithAlice('internal'), viewer: C, expected: conclude },
    { name: 'T2 internal D', record: inPrivateWithAlice('internal'), viewer: D, expected: conclude },
    { name: 'T2 internal E', record: inPrivateWithAlice('internal'), viewer: E, expected: conclude },
]


test('table 1: a record about alice heard in group G', () => {
  for (const testCase of TABLE_1) check(testCase)
})

test('table 2: a record about alice from her private chat', () => {
  for (const testCase of TABLE_2) check(testCase)
})

test('table 3: every cell of tables 1 and 2 stays hidden once tombstoned', () => {
  for (const testCase of [...TABLE_1, ...TABLE_2]) {
    check({
      ...testCase,
      name: `${testCase.name} tombstoned`,
      record: { ...testCase.record, status: 'tombstoned' },
      expected: HIDDEN,
    })
  }
})

test('table 3: the owner console sees every visibility verbatim', () => {
  const consoleViewer = viewer(null, [], 'owner-console')
  const table: readonly Case[] = [
    { name: 'T3 console open', record: inGroup('open'), viewer: consoleViewer, expected: verbatim('yes', LABELS.owner) },
    {
      name: 'T3 console subject', record: inGroup('subject'), viewer: consoleViewer,
      expected: verbatim('yes', LABELS.owner),
    },
    { name: 'T3 console origin', record: inGroup('origin'), viewer: consoleViewer, expected: verbatim('yes', LABELS.owner) },
    { name: 'T3 console owner', record: inGroup('owner'), viewer: consoleViewer, expected: verbatim('yes', LABELS.owner) },
    {
      name: 'T3 console internal', record: inGroup('internal'), viewer: consoleViewer,
      expected: verbatim('yes', LABELS.owner),
    },
    {
      name: 'T3 console tombstoned', record: { ...inGroup('open'), status: 'tombstoned' }, viewer: consoleViewer,
      expected: HIDDEN,
    },
  ]
  for (const testCase of table) check(testCase)
})

test('table 3: the remaining cases', () => {
  const table: readonly Case[] = [
    {
      name: 'T3 owner record in the owner channel',
      record: record({ channel: OWNER, subjects: [], visibility: 'owner' }),
      viewer: E,
      expected: verbatim('yes', LABELS.here),
    },
    {
      name: 'T3 elsewhere: an open record from the douyin feed',
      record: record({ channel: 'douyin:feed:self', subjects: [], visibility: 'open' }),
      viewer: C,
      expected: verbatim('yes', LABELS.elsewhere),
    },
    {
      name: 'T3 open group record: self does not count, alice is a member',
      record: inGroup('open'),
      viewer: viewer(PA, ['p_alice', 'self']),
      expected: verbatim('yes', LABELS.group),
    },
    {
      name: 'T3 open group record: carol is not a member',
      record: inGroup('open'),
      viewer: viewer(PA, ['p_alice', 'p_carol']),
      expected: HIDDEN,
    },
    {
      name: 'T3 open record from a group with no member table',
      record: record({ channel: 'qq:group:99999', subjects: [], visibility: 'open' }),
      viewer: viewer(PA, ['p_alice']),
      expected: HIDDEN,
    },
    {
      name: 'T3 subject record whose subjects are only self and a channel',
      record: record({ channel: G, subjects: ['self', G], visibility: 'subject' }),
      viewer: viewer(G, ['p_alice']),
      expected: HIDDEN,
    },
    {
      name: 'T3 subject record with self alongside alice',
      record: record({ channel: G, subjects: ['p_alice', 'self'], visibility: 'subject' }),
      viewer: viewer(PA, ['p_alice']),
      expected: verbatim('yes', LABELS.group),
    },
  ]
  for (const testCase of table) check(testCase)
})

test('no label ever carries an account, group or channel id', () => {
  assert.ok(observed.length > 0)
  for (const entry of observed) {
    assert.equal(/[0-9:]|qq/.test(entry.decision.disclosure.label), false, entry.decision.disclosure.label)
  }
})

test('internal is never injected verbatim except to the owner console', () => {
  for (const entry of observed) {
    if (entry.visibility !== 'internal' || entry.caller === 'owner-console') continue
    assert.notEqual(entry.decision.injection, 'verbatim', entry.caller)
  }
})

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze((value as unknown as Record<string, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

test('the policy is deterministic and never changes its arguments', () => {
  const frozenRecord = deepFreeze(record({ channel: G, subjects: ['p_alice'], visibility: 'subject' }))
  const frozenViewer = deepFreeze(viewer(G, ['p_alice', 'p_bob']))
  const frozenFacts = deepFreeze({
    ownerChannels: new Set([OWNER]),
    members: new Map([[G, new Set(['p_alice', 'p_bob'])]]),
    kindOf: facts.kindOf,
  })
  const recordBefore = JSON.stringify(frozenRecord)
  const viewerBefore = JSON.stringify(frozenViewer)
  const first = createPolicy().decide(frozenRecord, frozenViewer, frozenFacts)
  for (let i = 0; i < 100; i += 1) {
    assert.deepEqual(createPolicy().decide(frozenRecord, frozenViewer, frozenFacts), first)
  }
  assert.equal(JSON.stringify(frozenRecord), recordBefore)
  assert.equal(JSON.stringify(frozenViewer), viewerBefore)
})

test('the source reads no clock, no randomness and no io', () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/memory-policy')
  const files = readdirSync(dir).filter((file) => file.endsWith('.ts'))
  assert.ok(files.length > 0)
  for (const file of files) {
    const source = readFileSync(path.join(dir, file), 'utf8')
    for (const banned of ['Date', 'Math.random', 'node:fs', 'process']) {
      assert.equal(source.includes(banned), false, `${file} must not mention ${banned}`)
    }
    for (const line of source.split(/\r?\n/u).filter((text) => text.startsWith('import '))) {
      assert.match(line, /^import type .* from '(\.\.\/contracts\/index\.ts|@brain-core\/sdk)'$/u, `${file}: ${line}`)
    }
  }
})
