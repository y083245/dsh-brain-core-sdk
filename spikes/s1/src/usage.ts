/** Reads per-step token usage out of a run's session events. */

export interface StepUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** The share of this step's whole input that was served from the prompt cache. */
export function hitRatio(usage: StepUsage): number {
  const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  return input === 0 ? 0 : usage.cacheReadTokens / input
}

export function stepUsages(events: readonly unknown[]): StepUsage[] {
  const usages: StepUsage[] = []
  for (const event of events as { type?: string; data?: { usage?: Partial<StepUsage> } }[]) {
    if (event.type !== 'assistant/message' || event.data?.usage === undefined) continue
    const { inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0 } = event.data.usage
    usages.push({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })
  }
  return usages
}

/** Adds up tokens as steps finish. `add` returns true once the ceiling is passed. */
export class TokenMeter {
  spent = 0
  readonly max: number

  constructor(max: number) {
    this.max = max
  }

  add(events: readonly unknown[]): boolean {
    for (const usage of stepUsages(events)) {
      this.spent += usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    }
    return this.spent > this.max
  }
}
