import type { Viewer } from '@dsh-brain-core/sdk'
import type { ChannelFacts, RecordStore } from '../contracts/index.ts'
import type { IdentityService } from '../identity-persona/index.ts'

/** The channel-membership facts the policy is a pure function over (RFC P4). */
export interface ChannelFactsSource {
  note(channel: string, actor: string): void
  /** Replaces the speakers fallback for this channel; null goes back to it. */
  setMembers(channel: string, personIds: readonly string[] | null): void
  forViewer(viewer: Viewer): Promise<ChannelFacts>
}

/** `<source>:<kind>:<id>`, so the second segment says whether this is a private chat, a group or something else. */
export function channelKind(channel: string): 'private' | 'group' | 'other' {
  const kind = channel.split(':')[1]
  if (kind === 'private') return 'private'
  if (kind === 'group') return 'group'
  return 'other'
}

/**
 * S2 has no channel plugin feeding membership, so it falls back to who has spoken in the channel (RFC P4).
 * Actor ids are expanded through the identity snapshot, so an alias merged into someone counts as them.
 */
export function createChannelFacts(options: {
  readonly ownerChannels: readonly string[]
  readonly identity: IdentityService
}): ChannelFactsSource & { load(store: RecordStore): Promise<void> } {
  const members = new Map<string, Set<string>>()
  /** A channel explicitly given a membership list, which wins over who has spoken there. */
  const declared = new Map<string, ReadonlySet<string>>()

  function add(channel: string, actor: string): void {
    const set = members.get(channel)
    if (set === undefined) members.set(channel, new Set([actor]))
    else set.add(actor)
  }

  return {
    note: (channel, actor) => { add(channel, actor) },

    setMembers(channel, personIds) {
      if (personIds === null) declared.delete(channel)
      else declared.set(channel, new Set(personIds))
    },

    async load(store) {
      for await (const record of store.scan(['L0'])) {
        if (record.status === 'tombstoned') continue
        add(record.channel, record.actor)
      }
    },

    async forViewer() {
      const snapshot = await options.identity.snapshot()
      const expanded = new Map<string, ReadonlySet<string>>()
      const channels = new Set([...members.keys(), ...declared.keys()])
      for (const channel of channels) {
        const actors = declared.get(channel) ?? members.get(channel) ?? new Set<string>()
        const people = new Set<string>()
        for (const actor of actors) {
          for (const id of snapshot.idsOf(actor)) people.add(id)
        }
        expanded.set(channel, people)
      }
      return {
        ownerChannels: new Set(options.ownerChannels),
        members: expanded,
        kindOf: channelKind,
      }
    },
  }
}
