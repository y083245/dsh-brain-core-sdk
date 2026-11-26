import test from 'node:test'
import {
  BrainManifestSchema,
  ContextBlockSchema,
  ContextBundleSchema,
  ContextItemSchema,
  ContextRequestSchema,
  DisclosureSchema,
  EnvelopeErrorSchema,
  EnvelopeOkSchema,
  EnvelopeSchema,
  EvidenceRefSchema,
  ForgetByChannelSchema,
  ForgetByPersonSchema,
  ForgetByRecordSchema,
  ForgetByTimeSchema,
  ForgetReportSchema,
  ForgetSelectorSchema,
  IngestEventSchema,
  ManifestGroupSchema,
  ManifestMcpCommandSchema,
  ManifestMcpSchema,
  ManifestMcpUrlSchema,
  ManifestProcessSchema,
  ManifestSourceSchema,
  ManifestToolSchema,
  MemoryRecordSchema,
  RecordInputSchema,
  RecordPatchSchema,
  SearchHistoryItemSchema,
  SearchHitSchema,
  SearchNeighborSchema,
  SearchRequestSchema,
} from '../src/schema.ts'
import type {
  BrainManifest,
  ManifestGroup,
  ManifestMcp,
  ManifestSource,
  ManifestTool,
} from '../src/plugin.ts'
import type {
  ContextBlock,
  ContextBundle,
  ContextItem,
  ContextRequest,
  Disclosure,
  Envelope,
  EvidenceRef,
  ForgetReport,
  ForgetSelector,
  IngestEvent,
  MemoryRecord,
  RecordInput,
  RecordPatch,
  SearchHistoryItem,
  SearchHit,
  SearchNeighbor,
  SearchRequest,
} from '../src/types.ts'

type KnownKeys<T> = keyof { [K in keyof T as string extends K ? never : K]: T[K] }
type SameKeys<A, B> = [KnownKeys<A>] extends [KnownKeys<B>] ? ([KnownKeys<B>] extends [KnownKeys<A>] ? true : false) : false
type Fits<Out, I> = [Out] extends [I] ? true : false
type NotAny<T> = 0 extends 1 & T ? false : true
type Assert<T extends true> = T

export type EvidenceRefKeys = Assert<SameKeys<Schemastery.TypeT<typeof EvidenceRefSchema>, EvidenceRef>>
export type EvidenceRefFits = Assert<Fits<Schemastery.TypeT<typeof EvidenceRefSchema>, EvidenceRef>>
export type EvidenceRefNotAny = Assert<NotAny<Schemastery.TypeT<typeof EvidenceRefSchema>>>

export type MemoryRecordKeys = Assert<SameKeys<Schemastery.TypeT<typeof MemoryRecordSchema>, MemoryRecord>>
export type MemoryRecordFits = Assert<Fits<Schemastery.TypeT<typeof MemoryRecordSchema>, MemoryRecord>>
export type MemoryRecordNotAny = Assert<NotAny<Schemastery.TypeT<typeof MemoryRecordSchema>>>

export type IngestEventKeys = Assert<SameKeys<Schemastery.TypeT<typeof IngestEventSchema>, IngestEvent>>
export type IngestEventFits = Assert<Fits<Schemastery.TypeT<typeof IngestEventSchema>, IngestEvent>>
export type IngestEventNotAny = Assert<NotAny<Schemastery.TypeT<typeof IngestEventSchema>>>

export type RecordInputKeys = Assert<SameKeys<Schemastery.TypeT<typeof RecordInputSchema>, RecordInput>>
export type RecordInputFits = Assert<Fits<Schemastery.TypeT<typeof RecordInputSchema>, RecordInput>>
export type RecordInputNotAny = Assert<NotAny<Schemastery.TypeT<typeof RecordInputSchema>>>

export type RecordPatchKeys = Assert<SameKeys<Schemastery.TypeT<typeof RecordPatchSchema>, RecordPatch>>
export type RecordPatchFits = Assert<Fits<Schemastery.TypeT<typeof RecordPatchSchema>, RecordPatch>>
export type RecordPatchNotAny = Assert<NotAny<Schemastery.TypeT<typeof RecordPatchSchema>>>

export type SearchRequestKeys = Assert<SameKeys<Schemastery.TypeT<typeof SearchRequestSchema>, SearchRequest>>
export type SearchRequestFits = Assert<Fits<Schemastery.TypeT<typeof SearchRequestSchema>, SearchRequest>>
export type SearchRequestNotAny = Assert<NotAny<Schemastery.TypeT<typeof SearchRequestSchema>>>

export type ContextRequestKeys = Assert<SameKeys<Schemastery.TypeT<typeof ContextRequestSchema>, ContextRequest>>
export type ContextRequestFits = Assert<Fits<Schemastery.TypeT<typeof ContextRequestSchema>, ContextRequest>>
export type ContextRequestNotAny = Assert<NotAny<Schemastery.TypeT<typeof ContextRequestSchema>>>

export type ContextItemKeys = Assert<SameKeys<Schemastery.TypeT<typeof ContextItemSchema>, ContextItem>>
export type ContextItemFits = Assert<Fits<Schemastery.TypeT<typeof ContextItemSchema>, ContextItem>>
export type ContextItemNotAny = Assert<NotAny<Schemastery.TypeT<typeof ContextItemSchema>>>

export type ContextBlockKeys = Assert<SameKeys<Schemastery.TypeT<typeof ContextBlockSchema>, ContextBlock>>
export type ContextBlockFits = Assert<Fits<Schemastery.TypeT<typeof ContextBlockSchema>, ContextBlock>>
export type ContextBlockNotAny = Assert<NotAny<Schemastery.TypeT<typeof ContextBlockSchema>>>

export type ContextBundleKeys = Assert<SameKeys<Schemastery.TypeT<typeof ContextBundleSchema>, ContextBundle>>
export type ContextBundleFits = Assert<Fits<Schemastery.TypeT<typeof ContextBundleSchema>, ContextBundle>>
export type ContextBundleNotAny = Assert<NotAny<Schemastery.TypeT<typeof ContextBundleSchema>>>

export type DisclosureKeys = Assert<SameKeys<Schemastery.TypeT<typeof DisclosureSchema>, Disclosure>>
export type DisclosureFits = Assert<Fits<Schemastery.TypeT<typeof DisclosureSchema>, Disclosure>>
export type DisclosureNotAny = Assert<NotAny<Schemastery.TypeT<typeof DisclosureSchema>>>

export type SearchHitKeys = Assert<SameKeys<Schemastery.TypeT<typeof SearchHitSchema>, SearchHit>>
export type SearchHitFits = Assert<Fits<Schemastery.TypeT<typeof SearchHitSchema>, SearchHit>>
export type SearchHitNotAny = Assert<NotAny<Schemastery.TypeT<typeof SearchHitSchema>>>

export type SearchNeighborKeys = Assert<SameKeys<Schemastery.TypeT<typeof SearchNeighborSchema>, SearchNeighbor>>
export type SearchNeighborFits = Assert<Fits<Schemastery.TypeT<typeof SearchNeighborSchema>, SearchNeighbor>>
export type SearchNeighborNotAny = Assert<NotAny<Schemastery.TypeT<typeof SearchNeighborSchema>>>

export type SearchHistoryItemKeys = Assert<SameKeys<Schemastery.TypeT<typeof SearchHistoryItemSchema>, SearchHistoryItem>>
export type SearchHistoryItemFits = Assert<Fits<Schemastery.TypeT<typeof SearchHistoryItemSchema>, SearchHistoryItem>>
export type SearchHistoryItemNotAny = Assert<NotAny<Schemastery.TypeT<typeof SearchHistoryItemSchema>>>

export type ForgetReportKeys = Assert<SameKeys<Schemastery.TypeT<typeof ForgetReportSchema>, ForgetReport>>
export type ForgetReportFits = Assert<Fits<Schemastery.TypeT<typeof ForgetReportSchema>, ForgetReport>>
export type ForgetReportNotAny = Assert<NotAny<Schemastery.TypeT<typeof ForgetReportSchema>>>

export type ForgetSelectorFits = Assert<Fits<Schemastery.TypeT<typeof ForgetSelectorSchema>, ForgetSelector>>
export type ForgetSelectorNotAny = Assert<NotAny<Schemastery.TypeT<typeof ForgetSelectorSchema>>>

export type ForgetByRecordKeys = Assert<SameKeys<Schemastery.TypeT<typeof ForgetByRecordSchema>, Extract<ForgetSelector, { by: 'record' }>>>
export type ForgetByChannelKeys = Assert<SameKeys<Schemastery.TypeT<typeof ForgetByChannelSchema>, Extract<ForgetSelector, { by: 'channel' }>>>
export type ForgetByPersonKeys = Assert<SameKeys<Schemastery.TypeT<typeof ForgetByPersonSchema>, Extract<ForgetSelector, { by: 'person' }>>>
export type ForgetByTimeKeys = Assert<SameKeys<Schemastery.TypeT<typeof ForgetByTimeSchema>, Extract<ForgetSelector, { by: 'time' }>>>

export type EnvelopeFits = Assert<Fits<Schemastery.TypeT<typeof EnvelopeSchema>, Envelope<unknown>>>
export type EnvelopeNotAny = Assert<NotAny<Schemastery.TypeT<typeof EnvelopeSchema>>>

export type EnvelopeOkKeys = Assert<SameKeys<Schemastery.TypeT<typeof EnvelopeOkSchema>, Extract<Envelope<unknown>, { ok: true }>>>
export type EnvelopeErrorKeys = Assert<SameKeys<Schemastery.TypeT<typeof EnvelopeErrorSchema>, Extract<Envelope<unknown>, { ok: false }>>>

export type ManifestToolKeys = Assert<SameKeys<Schemastery.TypeT<typeof ManifestToolSchema>, ManifestTool>>
export type ManifestToolFits = Assert<Fits<Schemastery.TypeT<typeof ManifestToolSchema>, ManifestTool>>
export type ManifestToolNotAny = Assert<NotAny<Schemastery.TypeT<typeof ManifestToolSchema>>>

export type ManifestGroupKeys = Assert<SameKeys<Schemastery.TypeT<typeof ManifestGroupSchema>, ManifestGroup>>
export type ManifestGroupFits = Assert<Fits<Schemastery.TypeT<typeof ManifestGroupSchema>, ManifestGroup>>

export type ManifestSourceKeys = Assert<SameKeys<Schemastery.TypeT<typeof ManifestSourceSchema>, ManifestSource>>
export type ManifestSourceFits = Assert<Fits<Schemastery.TypeT<typeof ManifestSourceSchema>, ManifestSource>>

export type ManifestProcessKeys = Assert<SameKeys<Schemastery.TypeT<typeof ManifestProcessSchema>, NonNullable<BrainManifest['process']>>>
export type ManifestProcessFits = Assert<Fits<Schemastery.TypeT<typeof ManifestProcessSchema>, NonNullable<BrainManifest['process']>>>

export type ManifestMcpCommandKeys = Assert<SameKeys<Schemastery.TypeT<typeof ManifestMcpCommandSchema>, Extract<ManifestMcp, { readonly command: string }>>>
export type ManifestMcpUrlKeys = Assert<SameKeys<Schemastery.TypeT<typeof ManifestMcpUrlSchema>, Extract<ManifestMcp, { readonly url: string }>>>
export type ManifestMcpFits = Assert<Fits<Schemastery.TypeT<typeof ManifestMcpSchema>, ManifestMcp>>
export type ManifestMcpNotAny = Assert<NotAny<Schemastery.TypeT<typeof ManifestMcpSchema>>>

export type BrainManifestKeys = Assert<SameKeys<Schemastery.TypeT<typeof BrainManifestSchema>, BrainManifest>>
export type BrainManifestFits = Assert<Fits<Schemastery.TypeT<typeof BrainManifestSchema>, BrainManifest>>
export type BrainManifestNotAny = Assert<NotAny<Schemastery.TypeT<typeof BrainManifestSchema>>>

test('schema types compile', () => {})
