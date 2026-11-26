/** Shared runtime validation helpers for chat-kit modules. */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RangeError(`${field} must be a non-empty string`)
  }
  return value
}

export function assertNonNegativeFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative finite number`)
  }
  return value
}

export function assertFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${field} must be a finite number`)
  }
  return value
}

export function assertPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive integer`)
  }
  return value
}
