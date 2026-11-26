import Schema from 'schemastery'
import {
  PLUGIN_KINDS,
  TOOL_EFFECTS,
  TOOL_LOADS,
  type ManifestGroup,
  type ManifestMcp,
  type ManifestTool,
} from './plugin.ts'
import {
  BrainError, CONTEXT_BLOCK_NAMES, ERROR_CODES, LAYERS, LIMITS, RECORD_STATUSES, TRUST_LEVELS, VISIBILITIES,
  type ContextBlock,
  type ContextItem,
  type ErrorCode,
  type EvidenceRef,
  type SearchHistoryItem,
  type SearchNeighbor,
} from './types.ts'

type JsonObject = Record<string, unknown>
type UnionOf<L extends readonly Schema[]> = Schema<Schemastery.TypeS<L[number]>, Schemastery.TypeT<L[number]>>

/**
 * `Schema.object` infers `{...} & Dict`, and `Dict` comes from cosmokit, which
 * this package does not depend on. Spell the type out so declaration emit does
 * not need to name an unimportable type.
 */
function objectOf<X extends Record<string, Schema>>(
  dict: X,
): Schema<Schemastery.ObjectS<X>, Schemastery.ObjectT<X>> {
  return Schema.object(dict)
}

/** A free-form JSON object field (`content`, error `details`). */
function contentOf(): Schema<JsonObject, JsonObject> {
  return Schema.dict(Schema.any()) as unknown as Schema<JsonObject, JsonObject>
}

export const EvidenceRefSchema = objectOf({
  id: Schema.string().required(),
})

/** Object arrays are cast to their plain interfaces so declaration emit stays portable. */
export const EvidenceRefsSchema = Schema.array(EvidenceRefSchema) as unknown as Schema<EvidenceRef[], EvidenceRef[]>

export const MemoryRecordSchema = objectOf({
  id: Schema.string().required(),
  layer: Schema.union(LAYERS).required(),
  kind: Schema.string().required(),
  source: Schema.string().required(),
  channel: Schema.string().required(),
  subjects: Schema.array(Schema.string()).max(LIMITS.subjects).required(),
  actor: Schema.string().required(),
  content: contentOf().required(),
  evidence: EvidenceRefsSchema.max(LIMITS.evidence).required(),
  visibility: Schema.union(VISIBILITIES).required(),
  trust: Schema.union(TRUST_LEVELS).required(),
  confidence: Schema.number().min(0).max(1).required(),
  importance: Schema.number().min(0).max(1).required(),
  tEvent: Schema.number().required(),
  tIngest: Schema.number().required(),
  status: Schema.union(RECORD_STATUSES).required(),
  validFrom: Schema.number(),
  validTo: Schema.number(),
  version: Schema.number().required(),
})

export const IngestEventSchema = objectOf({
  kind: Schema.string().required(),
  channel: Schema.string().required(),
  subjects: Schema.array(Schema.string()).max(LIMITS.subjects).required(),
  actor: Schema.string().required(),
  content: contentOf().required(),
  tEvent: Schema.number().required(),
  idempotencyKey: Schema.string().required(),
  visibility: Schema.union(VISIBILITIES),
})

export const RecordInputSchema = objectOf({
  layer: Schema.union([Schema.const('L1'), Schema.const('L2')]).required(),
  kind: Schema.string().required(),
  channel: Schema.string().required(),
  subjects: Schema.array(Schema.string()).max(LIMITS.subjects).required(),
  actor: Schema.string().required(),
  content: contentOf().required(),
  evidence: EvidenceRefsSchema.max(LIMITS.evidence).required(),
  visibility: Schema.union(VISIBILITIES),
  confidence: Schema.number().min(0).max(1),
  importance: Schema.number().min(0).max(1),
  tEvent: Schema.number(),
  validFrom: Schema.number(),
  idempotencyKey: Schema.string(),
})

export const RecordPatchSchema = objectOf({
  content: contentOf(),
  subjects: Schema.array(Schema.string()).max(LIMITS.subjects),
  visibility: Schema.union(VISIBILITIES),
  confidence: Schema.number().min(0).max(1),
  importance: Schema.number().min(0).max(1),
  status: Schema.union(RECORD_STATUSES),
  validTo: Schema.number(),
})

export const SearchRequestSchema = objectOf({
  query: Schema.string().required(),
  scope: Schema.union(['here', 'person', 'all']).required(),
  layers: Schema.array(Schema.union(LAYERS)),
  from: Schema.number(),
  to: Schema.number(),
  subjects: Schema.array(Schema.string()).max(LIMITS.subjects),
  limit: Schema.number().max(LIMITS.searchLimit),
  cursor: Schema.string(),
  neighbors: Schema.number().min(0).max(10),
  history: Schema.boolean(),
})

export const DisclosureSchema = objectOf({
  speakable: Schema.union(['yes', 'if-subject-raises', 'never']).required(),
  label: Schema.string().required(),
})

export const SearchNeighborSchema = objectOf({
  record: MemoryRecordSchema.required(),
  disclosure: DisclosureSchema.required(),
  position: Schema.union(['before', 'after']).required(),
})

const SearchNeighborsSchema = Schema.array(SearchNeighborSchema) as unknown as Schema<SearchNeighbor[], SearchNeighbor[]>

export const SearchHistoryItemSchema = objectOf({
  id: Schema.string(),
  key: Schema.string().required(),
  value: Schema.any().required(),
  text: Schema.string().required(),
  changedAt: Schema.number().required(),
  status: Schema.union(['outdated', 'archived']).required(),
  label: Schema.string().required(),
})

const SearchHistoryItemsSchema = Schema.array(SearchHistoryItemSchema) as unknown as Schema<SearchHistoryItem[], SearchHistoryItem[]>

export const SearchHitSchema = objectOf({
  record: MemoryRecordSchema.required(),
  disclosure: DisclosureSchema.required(),
  score: Schema.number().required(),
  neighbors: SearchNeighborsSchema,
  history: SearchHistoryItemsSchema,
})

export const ContextRequestSchema = objectOf({
  channel: Schema.string().required(),
  query: Schema.string(),
  budgetChars: Schema.number(),
})

export const ContextItemSchema = objectOf({
  id: Schema.string().required(),
  text: Schema.string().required(),
  disclosure: DisclosureSchema.required(),
  inferred: Schema.boolean(),
})

const ContextItemsSchema = Schema.array(ContextItemSchema) as unknown as Schema<ContextItem[], ContextItem[]>

export const ContextBlockSchema = objectOf({
  name: Schema.union(CONTEXT_BLOCK_NAMES).required(),
  items: ContextItemsSchema.required(),
})

const ContextBlocksSchema = Schema.array(ContextBlockSchema) as unknown as Schema<ContextBlock[], ContextBlock[]>

export const ContextBundleSchema = objectOf({
  profileVersion: Schema.number().required(),
  stable: Schema.string().required(),
  blocks: ContextBlocksSchema.required(),
  truncated: Schema.boolean().required(),
})

export const ForgetByRecordSchema = objectOf({
  by: Schema.const('record').required(),
  id: Schema.string().required(),
})

export const ForgetByChannelSchema = objectOf({
  by: Schema.const('channel').required(),
  channel: Schema.string().required(),
})

export const ForgetByPersonSchema = objectOf({
  by: Schema.const('person').required(),
  personId: Schema.string().required(),
})

export const ForgetByTimeSchema = objectOf({
  by: Schema.const('time').required(),
  from: Schema.number().required(),
  to: Schema.number().required(),
  channel: Schema.string(),
})

const forgetSelectorMembers = [
  ForgetByRecordSchema,
  ForgetByChannelSchema,
  ForgetByPersonSchema,
  ForgetByTimeSchema,
] as const

export const ForgetSelectorSchema: UnionOf<typeof forgetSelectorMembers> = Schema.union(forgetSelectorMembers)

export const ForgetReportSchema = objectOf({
  tombstoned: Schema.number().required(),
  invalidated: Schema.number().required(),
  l3Flagged: Schema.number().required(),
})

const MetaSchema = objectOf({
  requestId: Schema.string().required(),
  apiVersion: Schema.string(),
  degraded: Schema.boolean(),
  nextCursor: Schema.string(),
})

const ErrorBodySchema = objectOf({
  code: Schema.union(Object.keys(ERROR_CODES) as ErrorCode[]).required(),
  message: Schema.string().required(),
  details: contentOf().required(),
})

export const EnvelopeOkSchema = objectOf({
  ok: Schema.const(true).required(),
  data: Schema.any().required(),
  meta: MetaSchema.required(),
})

export const EnvelopeErrorSchema = objectOf({
  ok: Schema.const(false).required(),
  error: ErrorBodySchema.required(),
  meta: MetaSchema.required(),
})

const envelopeMembers = [EnvelopeOkSchema, EnvelopeErrorSchema] as const

export const EnvelopeSchema: UnionOf<typeof envelopeMembers> = Schema.union(envelopeMembers)

type StringDict = Readonly<Record<string, string>>
type GroupDict = Readonly<Record<string, ManifestGroup>>

/** Dict cast to a plain record so declaration emit does not need cosmokit's `Dict`. */
function stringDict(): Schema<StringDict, StringDict> {
  return Schema.dict(Schema.string()) as unknown as Schema<StringDict, StringDict>
}

function groupDict(): Schema<GroupDict, GroupDict> {
  return Schema.dict(ManifestGroupSchema) as unknown as Schema<GroupDict, GroupDict>
}

export const ManifestProcessSchema = objectOf({
  command: Schema.string().required(),
  args: Schema.array(Schema.string()),
})

export const ManifestToolSchema = objectOf({
  name: Schema.string().required(),
  effect: Schema.union(TOOL_EFFECTS).required(),
  load: Schema.union(TOOL_LOADS).required(),
  group: Schema.string(),
  summary: Schema.string().required(),
  keywords: Schema.array(Schema.string()),
  when: Schema.string(),
  channels: Schema.array(Schema.string()),
  sendPerMinute: Schema.number(),
  textArg: Schema.string(),
  audience: Schema.const('owner'),
  mcpName: Schema.string(),
})

export const ManifestGroupSchema = objectOf({
  summary: Schema.string().required(),
  usage: Schema.string(),
})

export const ManifestSourceSchema = objectOf({
  channels: Schema.array(Schema.string()).required(),
  eventKinds: Schema.array(Schema.string()).required(),
  defaultVisibility: Schema.union(VISIBILITIES).required(),
  trust: Schema.union(TRUST_LEVELS).required(),
  retentionDays: Schema.number(),
  rateLimitPerHour: Schema.number(),
  proactiveMessaging: Schema.boolean(),
})

export const ManifestMcpCommandSchema = objectOf({
  command: Schema.string().required(),
  args: Schema.array(Schema.string()),
  env: stringDict(),
})

export const ManifestMcpUrlSchema = objectOf({
  url: Schema.string().required(),
  headers: stringDict(),
})

const mcpMembers = [ManifestMcpCommandSchema, ManifestMcpUrlSchema] as const

/** Cast so declaration emit does not expand the union's `& Dict` into an unimportable name. */
export const ManifestMcpSchema = Schema.union(mcpMembers) as unknown as Schema<ManifestMcp, ManifestMcp>

/** Object arrays are cast to their plain interfaces so declaration emit stays portable. */
const ManifestToolsSchema = Schema.array(ManifestToolSchema) as unknown as Schema<ManifestTool[], ManifestTool[]>

/**
 * Schemastery fills an absent object field with `{}` and then fails its required
 * children, so optional object fields need an explicit undefined default.
 */
function optionalObject<S extends Schema>(schema: S): S {
  return schema.default(undefined) as S
}

export const BrainManifestSchema = objectOf({
  id: Schema.string().required(),
  kinds: Schema.array(Schema.union(PLUGIN_KINDS)).required(),
  api: Schema.string().required(),
  runtime: Schema.union(['node', 'process']).required(),
  process: optionalObject(ManifestProcessSchema),
  permissions: Schema.array(Schema.string()).required(),
  source: optionalObject(ManifestSourceSchema),
  tools: ManifestToolsSchema,
  groups: groupDict(),
  config: Schema.string(),
  migrations: Schema.string(),
  mcp: optionalObject(ManifestMcpSchema),
})

/** Every schema that crosses a boundary, keyed by its public name. */
export const SCHEMAS = {
  MemoryRecord: MemoryRecordSchema,
  IngestEvent: IngestEventSchema,
  RecordInput: RecordInputSchema,
  RecordPatch: RecordPatchSchema,
  SearchRequest: SearchRequestSchema,
  ContextRequest: ContextRequestSchema,
  ContextBundle: ContextBundleSchema,
  ForgetSelector: ForgetSelectorSchema,
  Envelope: EnvelopeSchema,
  SearchHit: SearchHitSchema,
  SearchNeighbor: SearchNeighborSchema,
  SearchHistoryItem: SearchHistoryItemSchema,
  Disclosure: DisclosureSchema,
  ForgetReport: ForgetReportSchema,
  BrainManifest: BrainManifestSchema,
} as const

export type SchemaName = keyof typeof SCHEMAS

/**
 * Validate a value against one of the boundary schemas.
 * Throws `BrainError('INVALID_ARGUMENT')` carrying the dotted field path.
 */
export function validate(name: SchemaName, value: unknown): unknown {
  const schema = SCHEMAS[name] as Schema | undefined
  if (!schema) throw new BrainError('INVALID_ARGUMENT', `unknown schema: ${name}`, { field: '' })
  try {
    return Schema.resolve(value, schema, {})[0]
  } catch (error) {
    if (Schema.ValidationError.is(error)) {
      const path = error.options.path ?? []
      throw new BrainError('INVALID_ARGUMENT', error.message, { field: path.join('.') })
    }
    throw error
  }
}
