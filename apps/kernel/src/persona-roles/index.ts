import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { EvidenceRef } from '@dsh-brain-core/sdk'
import { ensurePrivateDir, writeFileAtomic } from '@dsh-brain-core/shared'
import type { Clock, NewRecord, RecordStore } from '../contracts/index.ts'
import { isPlainObject } from './helpers.ts'
import {
  computeMoodSnapshot, newEmotion,
  type Emotion, type MoodSnapshot,
} from './persona-state.ts'
import { createRoleStore } from './role-store.ts'

export * from './persona-state.ts'
export * from './role-store.ts'

export interface RoleCard {
  readonly name: string
  readonly text: string
}

/** What the service needs from identity-persona's profile store; memory-api wires the real one in. */
export interface ProfileWriter {
  commit(next: {
    readonly stable: string
    readonly data: Readonly<Record<string, unknown>>
    readonly evidence: readonly EvidenceRef[]
  }): Promise<number>
}

export interface PersonaService {
  /** The active role card, or null before one is saved. */
  roleCard(): Promise<RoleCard | null>
  /** Saves the card, makes it active and commits a new L3.1 version. Returns that version. */
  saveRoleCard(card: RoleCard): Promise<number>
  /** Activates an existing card (factory or user) without copying it, and commits a new L3.1 version. */
  selectRoleCard(name: string): Promise<number>
  mood(): Promise<MoodSnapshot>
}

/** Normalizes CRLF to LF so a card produces identical stable bytes across platforms (RFC 9.9). */
export function renderStable(card: RoleCard): string {
  return card.text.replace(/\r\n/g, '\n').trim() + '\n'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** A missing, unreadable or malformed file counts as absent. */
async function readJson(file: string): Promise<unknown> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return undefined
  }
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

interface ActiveCard {
  readonly version: 1
  readonly name: string
}

function asActiveCard(value: unknown): ActiveCard | null {
  if (!isPlainObject(value)) return null
  if (value.version !== 1 || typeof value.name !== 'string' || value.name === '') return null
  return { version: 1, name: value.name }
}

/** Only an emotion document matching the expected structure is usable; anything else falls back to neutral. */
function asEmotion(value: unknown): Emotion | null {
  if (!isPlainObject(value) || !isPlainObject(value.core)) return null
  const core = value.core
  if (!isFiniteNumber(core.p) || !isFiniteNumber(core.a) || !isFiniteNumber(core.d) || !isFiniteNumber(core.at)) {
    return null
  }
  if (!isPlainObject(value.scenes) || !Array.isArray(value.labels) || !Array.isArray(value.history)) {
    return null
  }
  const budget = value.budget
  if (!isPlainObject(budget) || !isFiniteNumber(budget.hour) || !isFiniteNumber(budget.used)) {
    return null
  }
  for (const label of value.labels) {
    if (!isPlainObject(label) || typeof label.name !== 'string' || !isFiniteNumber(label.v) || !isFiniteNumber(label.at)) {
      return null
    }
  }
  return value as unknown as Emotion
}

export function createPersonaService(deps: {
  readonly roles: ReturnType<typeof createRoleStore>
  readonly dir: string
  readonly store: RecordStore
  readonly profiles: ProfileWriter
  readonly clock: Clock
}): PersonaService {
  const { roles, dir, store, profiles, clock } = deps

  async function commitRoleCard(card: RoleCard): Promise<number> {
    const l0: NewRecord = {
      layer: 'L0',
      kind: 'kernel.role_card',
      source: 'kernel',
      channel: 'kernel:owner:console',
      subjects: ['self'],
      actor: 'owner',
      content: { name: card.name, text: card.text },
      evidence: [],
      visibility: 'owner',
      trust: 'owner',
      confidence: 1,
      importance: 1,
      tEvent: clock.now(),
    }
    const record = await store.insert(l0)

    const version = await profiles.commit({
      stable: renderStable(card),
      data: { roleCard: card.name },
      evidence: [{ id: record.id }],
    })

    await ensurePrivateDir(dir)
    await writeFileAtomic(path.join(dir, 'active.json'), JSON.stringify({ version: 1, name: card.name }))
    return version
  }

  return {
    roleCard: async (): Promise<RoleCard | null> => {
      const active = asActiveCard(await readJson(path.join(dir, 'active.json')))
      if (active === null) return null
      if (!roles.exists(active.name)) return null
      return { name: active.name, text: roles.read(active.name) }
    },

    saveRoleCard: async (card: RoleCard): Promise<number> => {
      // Invalid names throw before mutating active.json or inserting L0 records.
      roles.write(card.name, card.text)
      return await commitRoleCard(card)
    },

    selectRoleCard: async (name: string): Promise<number> => {
      if (!roles.exists(name)) {
        throw new Error(`人格「${name}」不存在`)
      }
      const text = roles.read(name)
      return await commitRoleCard({ name, text })
    },

    mood: async (): Promise<MoodSnapshot> => {
      const now = clock.now()
      const emotion = asEmotion(await readJson(path.join(dir, 'emotion.json'))) ?? newEmotion(now)
      const core = await readJson(path.join(dir, 'core.json'))
      return computeMoodSnapshot(emotion, core, now)
    },
  }
}
