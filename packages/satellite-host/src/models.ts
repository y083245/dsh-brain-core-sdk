/** What the provider allows for a tool surface that is already in a conversation. */
import type { ModelSelection } from './selection.ts'

export type ToolUpdateMode = 'addition-only' | 'fixed'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** GET <base>/models. Anything but an official model listed as addition-only is 'fixed', including any failure. */
export async function fetchToolUpdateMode(selection: ModelSelection, apiKey: string, baseUrl?: string): Promise<ToolUpdateMode> {
  if (selection.provider !== 'deepseek-official') return 'fixed'
  try {
    const response = await fetch(`${baseUrl ?? 'https://api.deepseek.com'}/models`, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return 'fixed'
    const body = await response.json() as unknown
    if (!isRecord(body) || !Array.isArray(body.data)) return 'fixed'
    for (const value of body.data as readonly unknown[]) {
      if (!isRecord(value) || value.id !== selection.model) continue
      const capabilities = value.api_capabilities
      const messages = isRecord(capabilities) ? capabilities.anthropic_messages : undefined
      const update = isRecord(messages) ? messages.tool_update : undefined
      return update === 'addition-only' ? 'addition-only' : 'fixed'
    }
    return 'fixed'
  } catch {
    return 'fixed'
  }
}
