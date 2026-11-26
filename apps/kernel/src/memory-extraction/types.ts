/** What one `runOnce` did. */
export interface ExtractionReport {
  readonly processed: number         // L0 records marked processed this run
  readonly batches: number           // model calls made
  readonly candidates: number        // l1.candidate records written
  readonly promoted: number          // records written straight as l1.fact, l1.event or l1.promise
  readonly discardedBatches: number  // complete JSON that broke a rule; dropped and marked processed
  readonly incompleteBatches: number // empty or unparsable replies; the batch stays unprocessed
  readonly parkedBatches: number     // incomplete too many times; skipped until the extractor is recreated
  readonly droppedFacts: number      // facts about others whose only evidence is the agent's own words
  readonly injectedFacts: number     // facts dropped because they look like prompt injection
  readonly tokens: number            // tokens spent this run
  readonly capped: boolean           // stopped because the daily cap was reached
}

/** Which L0 records have been sent to the model already, so none is extracted twice. */
export interface ProcessedLog {
  has(id: string): boolean
  add(ids: readonly string[]): Promise<void>
}

/** One fact the model proposed; already validated against the batch it came from. */
export interface ExtractedFact {
  readonly kind: 'l1.fact' | 'l1.event' | 'l1.promise'
  readonly text: string
  readonly subjects: readonly string[]
  readonly evidence: readonly string[]
  readonly confidence: number
  readonly key?: string
  readonly value?: string
  readonly due?: string
}
