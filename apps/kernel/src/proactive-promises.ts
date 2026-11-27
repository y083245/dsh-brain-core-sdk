import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { BrainError } from '@dsh-brain-core/sdk'
import type { MemoryRecord, Viewer } from '@dsh-brain-core/sdk'
import { writeFileAtomic } from '@dsh-brain-core/shared'
import { dayOf, zonedParts } from './agent-runtime/index.ts'
import type { AgentRuntime, ChannelRegistry, Clock, CrossChannelMode, RuntimeSettings } from './contracts/index.ts'
import type { Logger } from './log/index.ts'
import type { Memory } from './memory-api/index.ts'
import { createPolicy } from './memory-policy/index.ts'

const DEFAULT_CHANNELS = new Set(['qq', 'telegram', 'tg', 'feishu'])
const REMINDER_HOUR = 10
const MAX_PROMISES = 3
const MEMBERS_TIMEOUT_MS = 3_000
const MAX_RETRY_ATTEMPTS = 3

interface Delivery {
  readonly day: string
  readonly channel: string
  readonly evidence: readonly string[]
  readonly status: 'sending' | 'sent' | 'declined' | 'retry' | 'failed'
  readonly attempts?: number
  readonly messageId?: string
}

interface VisiblePromise {
  readonly record: MemoryRecord
  readonly label: string
}

function isDelivery(value: unknown): value is Delivery {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return typeof item.day === 'string' && typeof item.channel === 'string'
    && Array.isArray(item.evidence) && item.evidence.every((id) => typeof id === 'string')
    && (item.status === 'sending' || item.status === 'sent' || item.status === 'declined'
      || item.status === 'retry' || item.status === 'failed')
    && (item.attempts === undefined || (typeof item.attempts === 'number' && Number.isInteger(item.attempts) && item.attempts >= 0))
    && (item.messageId === undefined || typeof item.messageId === 'string')
}

function dueOn(record: MemoryRecord, day: string): boolean {
  const { due, promiseStatus, legacy, text } = record.content
  return record.layer === 'L1' && record.kind === 'l1.promise' && record.status === 'active' && due === day
    && (promiseStatus === 'pending' || (legacy === true && (promiseStatus === 'open' || promiseStatus === undefined)))
    && typeof text === 'string' && text.trim() !== ''
}

export function createProactivePromises(deps: {
  readonly memory: Pick<Memory, 'store' | 'channels' | 'audit'>
  readonly agent: AgentRuntime
  readonly providers: ChannelRegistry
  readonly ownerChannels: ReadonlySet<string>
  readonly settings: () => Promise<RuntimeSettings>
  readonly crossChannelMode: () => CrossChannelMode
  readonly clock: Clock
  readonly log: Logger
  readonly stateFile: string
}): () => Promise<void> {
  const policy = createPolicy()

  async function readState(): Promise<Delivery[]> {
    try {
      const state: unknown = JSON.parse(await readFile(deps.stateFile, 'utf8'))
      if (!Array.isArray(state) || !state.every(isDelivery)) throw new Error('invalid proactive delivery state')
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async function visiblePromises(channel: string, day: string, now: number, candidates: readonly MemoryRecord[]): Promise<VisiblePromise[]> {
    const base: Viewer = { caller: 'agent', channel, participants: [] }
    let facts = await deps.memory.channels.forViewer(base)
    let participants = [...(facts.members.get(channel) ?? [])].filter((person) => person !== 'self')
    if (participants.length === 0) {
      const provider = deps.providers.proactiveProviderOf(channel)
      if (provider !== undefined) {
        const pending = provider.members(channel)
        pending.catch(() => undefined)
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const members = await Promise.race([
            pending,
            new Promise<readonly string[]>((_, reject) => {
              timer = setTimeout(() => { reject(new Error('members timed out')) }, MEMBERS_TIMEOUT_MS)
              timer.unref?.()
            }),
          ])
          if (Array.isArray(members) && members.length > 0) {
            deps.memory.channels.setMembers(channel, members)
            facts = await deps.memory.channels.forViewer(base)
            participants = [...(facts.members.get(channel) ?? [])].filter((person) => person !== 'self')
          }
        } catch {
          deps.log.warn('proactive.members_failed', { channel })
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      }
    }
    if (participants.length === 0) return []
    const viewer: Viewer = { ...base, participants }
    const crossChannel = deps.crossChannelMode() === 'on'
    const visible: VisiblePromise[] = []
    for (const record of candidates) {
      if (!dueOn(record, day) || (record.validTo !== undefined && record.validTo <= now)) continue
      if (!record.subjects.some((person) => participants.includes(person))) continue
      if (record.channel !== channel && !crossChannel) continue
      const decision = policy.decide(record, viewer, facts)
      if (!decision.visible || decision.injection !== 'verbatim' || decision.disclosure.speakable !== 'yes') continue
      const evidence = await Promise.all(record.evidence.map(({ id }) => deps.memory.store.get(id)))
      if (evidence.length === 0 || evidence.some((source) => source?.status !== 'active')) continue
      visible.push({ record, label: decision.disclosure.label })
      if (visible.length === MAX_PROMISES) break
    }
    return visible
  }

  return async () => {
    const settings = await deps.settings()
    const now = deps.clock.now()
    const zone = settings.timezone
    if (zonedParts(now, zone).hour < REMINDER_HOUR) return
    const day = dayOf(now, zone)
    const channels = [...deps.ownerChannels]
      .filter((channel) => deps.providers.proactiveProviderOf(channel) !== undefined)
      .sort((a, b) => {
        const aDefault = DEFAULT_CHANNELS.has(a.split(':')[0] ?? '') ? 0 : 1
        const bDefault = DEFAULT_CHANNELS.has(b.split(':')[0] ?? '') ? 0 : 1
        return aDefault - bDefault
      })
    if (channels.length === 0) return
    const state = (await readState()).filter((item) => item.day >= day)
    const remaining = channels.filter((channel) => {
      const existing = state.find((item) => item.channel === channel && item.day === day)
      return existing === undefined || existing.status === 'retry'
    })
    if (remaining.length === 0) return

    const due: MemoryRecord[] = []
    for await (const record of deps.memory.store.scan(['L1'])) {
      if (dueOn(record, day)) due.push(record)
    }
    const store = async (delivery: Delivery): Promise<void> => {
      await mkdir(path.dirname(deps.stateFile), { recursive: true })
      const next = state.filter((item) => item.day !== delivery.day || item.channel !== delivery.channel)
      next.push(delivery)
      await writeFileAtomic(deps.stateFile, JSON.stringify(next))
      state.splice(0, state.length, ...next)
    }

    for (const channel of remaining) {
      const promises = await visiblePromises(channel, day, now, due)
      if (promises.length === 0) continue
      const evidence = promises.map(({ record }) => record.id)
      const delivery = { day, channel, evidence }
      let deliveryRequested = false
      const note = ['今天有到期的约定。想提就自然地提一句，别像闹钟一样念；不想打扰也可以保持安静。']
      for (const { record, label } of promises) {
        const text = String(record.content.text)
        note.push(record.channel !== channel && label.trim() !== '' ? `[${label}] ${text}` : text)
      }

      try {
        const result = await deps.agent.wakeProactiveMessage(channel, { reason: 'promise-due', evidence, note: note.join('\n') }, async (text) => {
          deliveryRequested = true
          const existing = state.find((item) => item.channel === channel && item.day === day)
          if (existing !== undefined && existing.status !== 'retry') {
            throw new BrainError('CONFLICT', '这条约定提醒已有投递记录。')
          }
          const provider = deps.providers.proactiveProviderOf(channel)
          const current = await deps.settings()
          const sendingAt = deps.clock.now()
          const records = await Promise.all(evidence.map((id) => deps.memory.store.get(id)))
          const active = records.filter((record): record is MemoryRecord => record !== null)
          if (provider === undefined || !deps.ownerChannels.has(channel) || dayOf(sendingAt, current.timezone) !== day
            || (await visiblePromises(channel, day, sendingAt, active)).length !== evidence.length
            || deps.providers.proactiveProviderOf(channel) !== provider) {
            throw new BrainError('UNAVAILABLE', '当前约定或投递通道不可用。')
          }
          const priorAttempts = existing?.status === 'retry' ? (existing.attempts ?? 0) : 0
          await store({ ...delivery, status: 'sending', ...(priorAttempts > 0 ? { attempts: priorAttempts } : {}) })
          if (deps.providers.proactiveProviderOf(channel) !== provider) {
            throw new BrainError('UNAVAILABLE', '投递通道已变更。')
          }
          let response: { readonly messageId?: string } | undefined
          try {
            response = await provider.send(channel, { text })
          } catch (error) {
            if (error instanceof BrainError && error.code === 'RATE_LIMITED') {
              const attempts = priorAttempts + 1
              await store({
                ...delivery,
                status: attempts >= MAX_RETRY_ATTEMPTS ? 'failed' : 'retry',
                attempts,
              })
            }
            throw error
          }
          if (typeof response?.messageId !== 'string' || response.messageId.trim() === '') {
            throw new BrainError('UNAVAILABLE', '通道未返回可确认的消息 ID。')
          }
          await store({ ...delivery, status: 'sent', messageId: response.messageId })
          return response.messageId
        })
        if (result.skipped === undefined) {
          for (const { record } of promises) {
            if (record.channel !== channel) {
              await deps.memory.audit.crossChannelUse({ recordId: record.id, viewerChannel: channel, mode: 'on', tAt: now })
            }
          }
        }
        if (result.blocked === true && result.sent === 0 && !deliveryRequested) {
          deps.log.info('proactive.promise_deferred', { channel })
        } else if (result.acked && !deliveryRequested && result.sent === 0 && result.blocked !== true) {
          await store({ ...delivery, status: 'declined' })
        }
        if (result.skipped !== undefined) deps.log.info('proactive.promise_skipped', { channel, code: result.skipped })
      } catch {
        deps.log.warn('proactive.promise_wake_failed', { channel })
      }
    }
  }
}
