import { BrainError } from '@dsh-brain-core/sdk'
import type { IngestEvent, Layer, RecordInput } from '@dsh-brain-core/sdk'
import { KINDS, type NewRecord, type WriteIdentity } from '../contracts/index.ts'

/** `<source>:<kind>:<id>`. */
export const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9-]*:[a-z][a-z0-9_-]*:\S+$/

export function isValidChannel(channel: string): boolean {
  return CHANNEL_PATTERN.test(channel)
}

function invalidArgument(message: string): BrainError {
  return new BrainError('INVALID_ARGUMENT', message)
}

function permissionDenied(message: string): BrainError {
  return new BrainError('PERMISSION_DENIED', message)
}

/**
 * Turns caller input into a NewRecord from trusted identity alone (RFC M5): source and trust always come from
 * identity, extra input fields are never read, and a plugin may only write what its manifest registered.
 */
export function applyWriteGuard(input: RecordInput | IngestEvent, identity: WriteIdentity, now: number): NewRecord {
  if (!isValidChannel(input.channel)) {
    throw invalidArgument(`channel ${JSON.stringify(input.channel)} is not <source>:<kind>:<id>`)
  }
  if (identity.kind === 'plugin' && !(identity.channels ?? []).includes(input.channel)) {
    throw permissionDenied(`channel ${input.channel} is not registered for ${identity.source}`)
  }

  if ('layer' in input) {
    const layer = input.layer as Layer
    if (layer !== 'L1' && layer !== 'L2') {
      throw identity.kind === 'plugin'
        ? permissionDenied(`a plugin cannot write ${layer} records`)
        : invalidArgument(`${layer} records are written by the kernel directly, not through the write guard`)
    }
    if (!(KINDS[layer] as readonly string[]).includes(input.kind)) {
      throw invalidArgument(`kind ${input.kind} is not a ${layer} kind`)
    }
    const record: NewRecord = {
      layer,
      kind: input.kind,
      source: identity.source,
      channel: input.channel,
      subjects: [...input.subjects],
      actor: input.actor,
      content: input.content,
      evidence: input.evidence.map((reference) => ({ id: reference.id })),
      visibility: input.visibility ?? identity.defaultVisibility,
      trust: identity.trust,
      confidence: input.confidence ?? 1,
      importance: input.importance ?? 0.5,
      tEvent: input.tEvent ?? now,
    }
    return input.validFrom === undefined ? record : { ...record, validFrom: input.validFrom }
  }

  if (identity.kind === 'plugin' && !(identity.eventKinds ?? []).includes(input.kind)) {
    throw permissionDenied(`event kind ${input.kind} is not registered for ${identity.source}`)
  }
  return {
    layer: 'L0',
    kind: input.kind,
    source: identity.source,
    channel: input.channel,
    subjects: [...input.subjects],
    actor: input.actor,
    content: input.content,
    evidence: [],
    visibility: input.visibility ?? identity.defaultVisibility,
    trust: identity.trust,
    confidence: 1,
    importance: 0.5,
    tEvent: input.tEvent,
  }
}
