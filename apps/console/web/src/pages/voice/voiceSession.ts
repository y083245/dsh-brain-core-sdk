import { useSyncExternalStore } from 'react'
import { chatApi, DEFAULT_CHAT_CHANNEL } from '../../api/client.ts'
import type { WakeResult } from '../../api/types.ts'
import { inktideStore } from '../../data/store.ts'

export interface OutgoingMessage {
  readonly messageId: string
  readonly text: string
  readonly tEvent: number
  readonly status: 'sending' | 'sent' | 'failed'
  readonly error?: unknown
}

interface VoiceSession {
  readonly channel: string
  readonly drafts: ReadonlyMap<string, string>
  readonly outgoing: ReadonlyMap<string, readonly OutgoingMessage[]>
}

const emptySession: VoiceSession = {
  channel: DEFAULT_CHAT_CHANNEL,
  drafts: new Map(),
  outgoing: new Map(),
}
let session = emptySession
let generation = 0
const listeners = new Set<() => void>()

function publish(next: VoiceSession): void {
  session = next
  for (const listener of listeners) listener()
}

inktideStore.subscribe(() => {
  if (!inktideStore.getSnapshot().authenticated && session !== emptySession) {
    generation += 1
    publish(emptySession)
  }
})

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const getSnapshot = (): VoiceSession => session

export function useVoiceSession(): VoiceSession {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function selectVoiceChannel(channel: string): void {
  if (channel !== session.channel) publish({ ...session, channel })
}

export function saveVoiceDraft(channel: string, text: string): void {
  const drafts = new Map(session.drafts)
  if (text === '') drafts.delete(channel)
  else drafts.set(channel, text)
  publish({ ...session, drafts })
}

function putOutgoing(channel: string, message: OutgoingMessage): void {
  const outgoing = new Map(session.outgoing)
  const messages = outgoing.get(channel) ?? []
  if (messages.some((item) => item.messageId === message.messageId)) {
    outgoing.set(channel, messages.map((item) =>
      item.messageId === message.messageId ? message : item,
    ))
  } else {
    outgoing.set(channel, [...messages, message])
  }
  publish({ ...session, outgoing })
}

export function reconcileOutgoing(channel: string, confirmed: ReadonlySet<string>): void {
  const messages = session.outgoing.get(channel)
  if (!messages?.some((item) => item.status !== 'sending' && confirmed.has(item.messageId))) return
  const remaining = messages.filter((item) => item.status === 'sending' || !confirmed.has(item.messageId))
  const outgoing = new Map(session.outgoing)
  if (remaining.length === 0) outgoing.delete(channel)
  else outgoing.set(channel, remaining)
  publish({ ...session, outgoing })
}

export async function sendVoiceMessage(
  channel: string,
  message: OutgoingMessage,
  consumeDraft: boolean,
): Promise<WakeResult | undefined> {
  if (!inktideStore.getSnapshot().authenticated) return
  if (session.outgoing.get(channel)?.some((item) => item.status === 'sending')) return
  const currentGeneration = generation
  putOutgoing(channel, { messageId: message.messageId, text: message.text, tEvent: message.tEvent, status: 'sending' })
  if (consumeDraft) saveVoiceDraft(channel, '')
  try {
    const { wake } = await chatApi.sendMessage({
      channel,
      messageId: message.messageId,
      text: message.text,
      tEvent: message.tEvent,
    })
    if (currentGeneration !== generation) return
    putOutgoing(channel, { ...message, status: 'sent' })
    return wake
  } catch (error) {
    if (currentGeneration === generation) putOutgoing(channel, { ...message, status: 'failed', error })
    return undefined
  }
}
