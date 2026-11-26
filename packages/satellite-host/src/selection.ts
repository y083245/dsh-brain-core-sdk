/** The owner's choice of model and thinking effort. The code holds no default on purpose. */

export const THINKING_EFFORTS = ['off', 'low', 'high', 'max', 'model-default'] as const
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number]
export type AgentClass = 'chat' | 'activity'

export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly effort: ThinkingEffort
}

/** Raised when the owner has not finished choosing; callers map it to UNAVAILABLE. */
export class SelectionMissingError extends Error {
  readonly agentClass: AgentClass
  constructor(agentClass: AgentClass, field: string) {
    super(`agent class "${agentClass}" has no ${field}: choose one in settings`)
    this.name = 'SelectionMissingError'
    this.agentClass = agentClass
  }
}

/** Validate a stored selection at the config boundary. */
export function requireSelection(value: Partial<Record<keyof ModelSelection, unknown>> | undefined, agentClass: AgentClass): ModelSelection {
  for (const field of ['provider', 'model', 'effort'] as const) {
    const given = value?.[field]
    if (typeof given !== 'string' || given.trim() === '') throw new SelectionMissingError(agentClass, field)
  }
  const { provider, model, effort } = value as Record<keyof ModelSelection, string>
  if (!(THINKING_EFFORTS as readonly string[]).includes(effort)) {
    throw new RangeError(`unknown thinking effort "${effort}"; expected one of ${THINKING_EFFORTS.join(', ')}`)
  }
  return { provider, model, effort: effort as ThinkingEffort }
}
