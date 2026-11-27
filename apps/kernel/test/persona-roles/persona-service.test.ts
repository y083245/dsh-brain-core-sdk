import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { EvidenceRef } from '@dsh-brain-core/sdk'
import {
  DEFAULT_SETTINGS, computeMoodSnapshot, createPersonaService, createRoleStore,
  decayEmotion, expressedPad, mergeSettings, modulation, moodWord, newCore, renderNow, renderStable, traitValues,
  type Emotion, type PersonaService, type ProfileWriter, type RoleCard,
} from '../../src/persona-roles/index.ts'
import { FakeClock, FakeRecordStore } from '../fakes/index.ts'

interface CommitCall {
  readonly stable: string
  readonly data: Readonly<Record<string, unknown>>
  readonly evidence: readonly EvidenceRef[]
}

class FakeProfileWriter implements ProfileWriter {
  readonly calls: CommitCall[] = []
  readonly version: number

  constructor(version = 1) {
    this.version = version
  }

  async commit(next: CommitCall): Promise<number> {
    this.calls.push(next)
    return this.version
  }
}

interface Setup {
  readonly root: string
  readonly dir: string
  readonly clock: FakeClock
  readonly store: FakeRecordStore
  readonly roles: ReturnType<typeof createRoleStore>
  readonly profiles: FakeProfileWriter
  readonly service: PersonaService
}

async function setup(): Promise<Setup> {
  const root = await mkdtemp(path.join(tmpdir(), 'brain-persona-roles-'))
  const stateDir = path.join(root, 'state')
  const dir = path.join(stateDir, 'persona')
  const clock = new FakeClock()
  const store = new FakeRecordStore(clock)
  const roles = createRoleStore({ root, stateDir })
  const profiles = new FakeProfileWriter()
  const service = createPersonaService({ roles, dir, store, profiles, clock })
  return { root, dir, clock, store, roles, profiles, service }
}

async function roleCardRecords(store: FakeRecordStore): Promise<readonly { id: string }[]> {
  const page = await store.list({ layers: ['L0'], kinds: ['kernel.role_card'] }, { limit: 10 })
  return page.items
}

test('DEFAULT_SETTINGS.appraisal carries no model or baseUrl default', () => {
  assert.equal('model' in DEFAULT_SETTINGS.appraisal, false)
  assert.equal('baseUrl' in DEFAULT_SETTINGS.appraisal, false)
})

test('saveRoleCard writes the card, reads it back, inserts one L0 and commits it', async () => {
  const s = await setup()
  try {
    const card: RoleCard = { name: '小鲸鱼', text: '# 小鲸鱼\r\n你温柔。\r\n' }
    const version = await s.service.saveRoleCard(card)
    assert.equal(version, 1, 'returns the value from ProfileWriter.commit')
    assert.equal(s.roles.origin(card.name), 'user')

    const readBack = await s.service.roleCard()
    assert.deepEqual(readBack, card)

    const records = await roleCardRecords(s.store)
    assert.equal(records.length, 1)
    const l0 = (await s.store.get((records[0] as { id: string }).id))!
    assert.deepEqual(l0.content, { name: card.name, text: card.text })
    assert.equal(l0.layer, 'L0')
    assert.equal(l0.kind, 'kernel.role_card')
    assert.equal(l0.source, 'kernel')
    assert.equal(l0.channel, 'kernel:owner:console')
    assert.deepEqual(l0.subjects, ['self'])
    assert.equal(l0.actor, 'owner')
    assert.equal(l0.visibility, 'owner')
    assert.equal(l0.trust, 'owner')
    assert.equal(l0.confidence, 1)
    assert.equal(l0.importance, 1)
    assert.equal(l0.tEvent, s.clock.now())

    assert.equal(s.profiles.calls.length, 1)
    const call = s.profiles.calls[0]!
    assert.equal(call.stable, renderStable(card))
    assert.equal(call.stable, '# 小鲸鱼\n你温柔。\n')
    assert.deepEqual(call.data, { roleCard: card.name })
    assert.deepEqual(call.evidence, [{ id: l0.id }])
  } finally {
    await rm(s.root, { recursive: true, force: true })
  }
})

test('roleCard is null before a card is saved and after the card is removed', async () => {
  const s = await setup()
  try {
    assert.equal(await s.service.roleCard(), null)
    await s.service.saveRoleCard({ name: '小鲸鱼', text: '鲸\n' })
    assert.deepEqual(await s.service.roleCard(), { name: '小鲸鱼', text: '鲸\n' })
    s.roles.remove('小鲸鱼')
    assert.equal(await s.service.roleCard(), null)
  } finally {
    await rm(s.root, { recursive: true, force: true })
  }
})

test('saveRoleCard rejects an invalid name and writes no L0', async () => {
  const s = await setup()
  try {
    for (const bad of ['a/b', '..', 'a\\b', '']) {
      await assert.rejects(s.service.saveRoleCard({ name: bad, text: 'x' }), undefined as never, bad)
      assert.equal((await roleCardRecords(s.store)).length, 0, bad)
    }
  } finally {
    await rm(s.root, { recursive: true, force: true })
  }
})

test('renderStable normalizes CRLF and is byte-stable', () => {
  assert.equal(renderStable({ name: 'a', text: 'a\r\nb\r\n' }), 'a\nb\n')
  assert.equal(renderStable({ name: 'a', text: 'a\nb\n' }), 'a\nb\n')
  const card: RoleCard = { name: 'a', text: 'a\r\nb\r\n' }
  assert.ok(Buffer.from(renderStable(card)).equals(Buffer.from(renderStable(card))))
})

test('mood is neutral without emotion.json or core.json', async () => {
  const s = await setup()
  try {
    assert.deepEqual(await s.service.mood(), {
      p: 0, a: 0, d: 0, word: '心情平平', line: '【你此刻】整体心情平平', at: s.clock.now(),
    })
  } finally {
    await rm(s.root, { recursive: true, force: true })
  }
})

test('mood reflects a positive emotion.json and decays with the clock', async () => {
  const s = await setup()
  try {
    const now = s.clock.now()
    await mkdir(s.dir, { recursive: true })
    const emotion = {
      version: 1,
      core: { p: 1, a: 0, d: 0, at: now },
      scenes: {},
      labels: [],
      budget: { hour: Math.floor(now / 3600000), used: 0 },
      history: [],
    }
    await writeFile(path.join(s.dir, 'emotion.json'), JSON.stringify(emotion))

    const before = await s.service.mood()
    assert.equal(before.word, '心情不错')
    assert.ok(Math.abs(before.p - 0.4) < 1e-9, `p ${before.p}`)

    s.clock.advance(360 * 60 * 1000)
    const after = await s.service.mood()
    assert.ok(after.p < before.p)
    assert.ok(Math.abs(after.p - 0.2) < 1e-9, `p ${after.p}`)
    assert.equal(after.word, '心情还行')
  } finally {
    await rm(s.root, { recursive: true, force: true })
  }
})

test('mood reads core.json and the trait baseline changes the snapshot', async () => {
  const s = await setup()
  try {
    const neutral = await s.service.mood()
    assert.equal(neutral.p, 0)

    await mkdir(s.dir, { recursive: true })
    await writeFile(path.join(s.dir, 'core.json'), JSON.stringify(newCore({ E: 100, A: 100 })))
    const shaped = await s.service.mood()
    assert.ok(Math.abs(shaped.p - 0.4) < 1e-9, `p ${shaped.p}`)
    assert.notEqual(shaped.p, neutral.p)
    assert.notEqual(shaped.line, neutral.line)
  } finally {
    await rm(s.root, { recursive: true, force: true })
  }
})

test('mood treats unreadable emotion.json and core.json as absent', async () => {
  const s = await setup()
  try {
    await mkdir(s.dir, { recursive: true })
    await writeFile(path.join(s.dir, 'emotion.json'), '{坏')
    await writeFile(path.join(s.dir, 'core.json'), '{坏')
    const snapshot = await s.service.mood()
    assert.equal(snapshot.word, '心情平平')
    assert.equal(snapshot.p, 0)
    assert.match(snapshot.line, /^【你此刻】/)
  } finally {
    await rm(s.root, { recursive: true, force: true })
  }
})

test('roleCard treats a malformed active.json as absent', async () => {
  const s = await setup()
  try {
    await mkdir(s.dir, { recursive: true })
    const file = path.join(s.dir, 'active.json')
    const malformed = [
      '{坏',
      JSON.stringify({ version: 2, name: '小鲸鱼' }),
      JSON.stringify({ version: '1', name: '小鲸鱼' }),
      JSON.stringify({ version: 1, name: '' }),
    ]
    for (const raw of malformed) {
      await writeFile(file, raw)
      assert.equal(await s.service.roleCard(), null, raw)
    }
  } finally {
    await rm(s.root, { recursive: true, force: true })
  }
})

test('active.json is private on non-Windows', async () => {
  const s = await setup()
  try {
    await s.service.saveRoleCard({ name: '小鲸鱼', text: '鲸\n' })
    if (process.platform !== 'win32') {
      assert.equal((await stat(path.join(s.dir, 'active.json'))).mode & 0o777, 0o600)
    }
  } finally {
    await rm(s.root, { recursive: true, force: true })
  }
})

test('mood matches computeMoodSnapshot and two-step decayEmotion+renderNow equivalence on labels and scenes', async () => {
  const s = await setup()
  try {
    const t0 = s.clock.now()
    await mkdir(s.dir, { recursive: true })
    const core = newCore({ O: 65, E: 70, A: 60 }, { grudge: 80 })
    const emotion: Emotion = {
      version: 1,
      core: { p: 0.4, a: 0.2, d: 0.1, at: t0 },
      scenes: { '': { p: -0.3, a: 0.5, d: 0, at: t0 }, 'group:1': { p: 0.9, a: 0, d: 0, at: t0 } },
      labels: [
        { name: '生气', v: 0.55, key: '', cause: '被怼', since: t0, at: t0 },
        { name: '开心', v: 0.7, key: 'group:1', cause: '隐私原因', since: t0, at: t0 },
      ],
      budget: { hour: Math.floor(t0 / 3600000), used: 0 },
      history: [],
    }
    await writeFile(path.join(s.dir, 'core.json'), JSON.stringify(core))
    await writeFile(path.join(s.dir, 'emotion.json'), JSON.stringify(emotion))

    s.clock.advance(20 * 60 * 1000)
    const now = s.clock.now()
    const fromService = await s.service.mood()
    const direct = computeMoodSnapshot(emotion, core, now)
    assert.deepEqual(fromService, direct)

    const settings = mergeSettings({})
    const values = traitValues(core)
    const decayed = decayEmotion(structuredClone(emotion), now, settings, modulation(values))
    const pad = expressedPad(decayed, '', values, settings)
    assert.deepEqual(fromService, {
      p: pad.p,
      a: pad.a,
      d: pad.d,
      word: moodWord(pad.p),
      line: renderNow(emotion, '', values, settings, now),
      at: now,
    })
    assert.doesNotMatch(fromService.line, /隐私原因/)
  } finally {
    await rm(s.root, { recursive: true, force: true })
  }
})
