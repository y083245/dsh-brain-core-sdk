import type { MemoryRecord, Viewer } from '@dsh-brain-core/sdk'
import type { ChannelFacts, Policy, PolicyDecision } from '../contracts/index.ts'

/** The only words a label may use (RFC P2): no account, group or channel id ever appears. */
export const LABELS = {
  here: '就在这里说过',
  private: '私下聊过',
  group: '在群里听说的',
  elsewhere: '在别处看到的',
  raiseOnly: '，不要当众提，对方自己提起再接话',
  internal: '只作判断依据，不要说出来',
  owner: '主人可见',
} as const

/** A channel id is `<source>:<kind>:<id>`, so two or more colons mark one. */
const CHANNEL_ID = /^[^:]+:[^:]+:.+$/

function hidden(): PolicyDecision {
  return { visible: false, injection: 'none', disclosure: { speakable: 'never', label: '' } }
}

function show(speakable: 'yes' | 'if-subject-raises', label: string): PolicyDecision {
  return { visible: true, injection: 'verbatim', disclosure: { speakable, label } }
}

/** Subjects minus 'self' minus channel ids: the people this record is about. */
function subjectsOf(record: MemoryRecord): readonly string[] {
  return record.subjects.filter((subject) => subject !== 'self' && !CHANNEL_ID.test(subject))
}

/** Participants minus 'self': the people actually present. */
function othersOf(viewer: Viewer): readonly string[] {
  return viewer.participants.filter((participant) => participant !== 'self')
}

function place(record: MemoryRecord, viewer: Viewer, facts: ChannelFacts): string {
  if (viewer.channel !== null && viewer.channel === record.channel) return LABELS.here
  const kind = facts.kindOf(record.channel)
  if (kind === 'private') return LABELS.private
  if (kind === 'group') return LABELS.group
  return LABELS.elsewhere
}

function labelFor(
  record: MemoryRecord,
  viewer: Viewer,
  facts: ChannelFacts,
  speakable: 'yes' | 'if-subject-raises',
): string {
  const where = place(record, viewer, facts)
  return speakable === 'if-subject-raises' ? where + LABELS.raiseOnly : where
}

/**
 * The disclosure policy (RFC 6.4, P1–P2). Pure: same arguments give the same decision, nothing is changed,
 * and the viewer is trusted because the kernel fills it in from the caller's identity.
 */
export function createPolicy(): Policy {
  return {
    decide(record, viewer, facts): PolicyDecision {
      if (record.status === 'tombstoned') return hidden()
      if (viewer.caller === 'owner-console') {
        return { visible: true, injection: 'verbatim', disclosure: { speakable: 'yes', label: LABELS.owner } }
      }
      if (record.visibility === 'internal') {
        return {
          visible: true,
          injection: 'conclusion-only',
          disclosure: { speakable: 'never', label: LABELS.internal },
        }
      }

      const here = viewer.channel
      if (here === null) {
        return record.visibility === 'open' ? show('yes', labelFor(record, viewer, facts, 'yes')) : hidden()
      }

      switch (record.visibility) {
        case 'owner':
          return facts.ownerChannels.has(here) ? show('yes', labelFor(record, viewer, facts, 'yes')) : hidden()
        case 'origin':
          return here === record.channel ? show('yes', labelFor(record, viewer, facts, 'yes')) : hidden()
        case 'subject': {
          const subjects = new Set(subjectsOf(record))
          if (!othersOf(viewer).some((person) => subjects.has(person))) return hidden()
          const speakable = facts.kindOf(here) === 'private' ? 'yes' : 'if-subject-raises'
          return show(speakable, labelFor(record, viewer, facts, speakable))
        }
        case 'open': {
          const origin = record.channel
          const crossChannelGroup = facts.kindOf(origin) === 'group' && facts.kindOf(here) === 'private' && here !== origin
          if (crossChannelGroup) {
            const present = othersOf(viewer)
            const members = facts.members.get(origin) ?? new Set<string>()
            if (present.length === 0 || !present.every((person) => members.has(person))) return hidden()
          }
          return show('yes', labelFor(record, viewer, facts, 'yes'))
        }
      }
    },
  }
}
