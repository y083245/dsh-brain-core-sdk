/** Internal runtime-guard helpers shared across persona-roles submodules. */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function finiteOr(value: unknown, fallback: number): number {
  if (value === null || value === '' || typeof value === 'boolean') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
