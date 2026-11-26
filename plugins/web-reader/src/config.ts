import { Schema } from '@brain-core/sdk'

export interface WebReaderConfig {
  readonly feeds?: readonly string[]
  readonly maxBytes?: number
  readonly maxChars?: number
  readonly timeoutMs?: number
  readonly everyMs?: number
}

export default Schema.object({
  feeds: Schema.array(Schema.string()).default([]),
  maxBytes: Schema.number().default(262_144),
  maxChars: Schema.number().default(4_000),
  timeoutMs: Schema.number().default(15_000),
  everyMs: Schema.number().default(3_600_000),
})
