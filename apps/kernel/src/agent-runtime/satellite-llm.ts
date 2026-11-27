import { RunnerFailedError, SelectionMissingError, encodeSessionId } from '@dsh-brain-core/satellite-host'
import type { TurnRunner } from '@dsh-brain-core/satellite-host'
import { BrainError } from '@dsh-brain-core/sdk'
import type { LlmClient, TokenUsage } from '../contracts/index.ts'
import type { DetailedLlmClient, DetailedLlmResult } from '../model-accounting/index.ts'

export type { DetailedLlmClient, DetailedLlmResult }

export interface SatelliteLlmDeps {
  readonly runner: TurnRunner
  readonly newId: () => string
  readonly selection?: () =>
    | Promise<{ readonly provider?: string; readonly model?: string } | undefined>
    | { readonly provider?: string; readonly model?: string }
    | undefined
  readonly onUsage?: (info: DetailedLlmResult) => Promise<void> | void
}

/**
 * Lets the kernel's own jobs (memory extraction and the like) call the model through the activity process.
 * Every call gets a session of its own with no tools, and the session is deleted when the call ends.
 */
export function createSatelliteLlm(deps: SatelliteLlmDeps): LlmClient & DetailedLlmClient {
  async function completeDetailed(request: {
    readonly system: string
    readonly user: string
    readonly maxOutputTokens: number
  }): Promise<DetailedLlmResult> {
    const sessionId = encodeSessionId({ agentClass: 'activity', channel: `kernel:job:${deps.newId()}`, generation: 0 })
    try {
      const selected = deps.selection === undefined ? undefined : await deps.selection()
      const provider = typeof selected?.provider === 'string' && selected.provider.trim() !== ''
        ? selected.provider.trim()
        : 'unknown'
      const model = typeof selected?.model === 'string' && selected.model.trim() !== ''
        ? selected.model.trim()
        : 'unknown'
      const result = await deps.runner.run('activity', sessionId, `${request.system}\n\n${request.user}`)
      let inputTokens = 0
      let outputTokens = 0
      let cacheReadTokens = 0
      let cacheWriteTokens = 0
      for (const step of result.steps) {
        inputTokens += step.inputTokens
        outputTokens += step.outputTokens
        cacheReadTokens += step.cacheReadTokens
        cacheWriteTokens += step.cacheWriteTokens
      }
      const usage: TokenUsage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
      const tokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
      const detailed: DetailedLlmResult = {
        text: result.finalResponse,
        tokens,
        usage,
        provider,
        model,
      }
      if (deps.onUsage !== undefined) {
        try {
          await deps.onUsage(detailed)
        } catch {
          // Usage observation failures must never fail a completed LLM call.
        }
      }
      return detailed
    } catch (error) {
      if (error instanceof SelectionMissingError) throw new BrainError('UNAVAILABLE', '还没选模型')
      if (error instanceof RunnerFailedError) throw new BrainError('UNAVAILABLE', '模型现在用不了')
      throw error
    } finally {
      try {
        await deps.runner.purge([sessionId])
      } catch {
        // The sessions still waiting to be deleted are retried by the runner; the caller's result matters more.
      }
    }
  }

  return {
    completeDetailed,
    async complete(request) {
      const result = await completeDetailed(request)
      return { text: result.text, tokens: result.tokens }
    },
  }
}
