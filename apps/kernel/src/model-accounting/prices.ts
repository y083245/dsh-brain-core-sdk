import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { BrainError } from '@dsh-brain-core/sdk'
import { ensurePrivateDir, writeFileAtomic } from '@dsh-brain-core/shared'
import type { ModelPriceBook, ModelPriceEntry, TokenUsage } from '../contracts/index.ts'

export const DEFAULT_PRICE_BOOK: ModelPriceBook = {
  version: 1,
  currency: 'CNY',
  models: {
    'deepseek-official/deepseek-flash': {
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheReadPerMillion: 0.1,
      cacheWritePerMillion: 1,
    },
    'deepseek-official/deepseek-v4-pro': {
      inputPerMillion: 4,
      outputPerMillion: 12,
      cacheReadPerMillion: 0.4,
      cacheWritePerMillion: 4,
    },
  },
}

const PRICE_FIELDS = [
  'inputPerMillion',
  'outputPerMillion',
  'cacheReadPerMillion',
  'cacheWritePerMillion',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function assertNonNegativeFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BrainError('INVALID_ARGUMENT', `${field} must be a finite non-negative number`)
  }
  return value
}

export function clonePriceBook(book: ModelPriceBook): ModelPriceBook {
  const models: Record<string, ModelPriceEntry> = {}
  for (const [key, entry] of Object.entries(book.models)) {
    models[key] = {
      inputPerMillion: entry.inputPerMillion,
      outputPerMillion: entry.outputPerMillion,
      cacheReadPerMillion: entry.cacheReadPerMillion,
      cacheWritePerMillion: entry.cacheWritePerMillion,
    }
  }
  return {
    version: 1,
    currency: book.currency,
    models,
  }
}

export function validatePriceBook(value: unknown): ModelPriceBook {
  if (!isRecord(value)) {
    throw new BrainError('INVALID_ARGUMENT', 'price book must be an object')
  }
  if (value.version !== 1) {
    throw new BrainError('INVALID_ARGUMENT', 'price book version must be 1')
  }
  if (typeof value.currency !== 'string' || value.currency.trim() === '') {
    throw new BrainError('INVALID_ARGUMENT', 'price book currency must be a non-empty string')
  }
  if (!isRecord(value.models)) {
    throw new BrainError('INVALID_ARGUMENT', 'price book models must be an object')
  }

  const models: Record<string, ModelPriceEntry> = {}
  for (const [key, rawEntry] of Object.entries(value.models)) {
    if (key.trim() === '' || key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new BrainError('INVALID_ARGUMENT', 'invalid model price key')
    }
    if (!isRecord(rawEntry)) {
      throw new BrainError('INVALID_ARGUMENT', `price entry for ${key} must be an object`)
    }
    for (const field of PRICE_FIELDS) {
      assertNonNegativeFinite(rawEntry[field], `models[${key}].${field}`)
    }
    models[key] = {
      inputPerMillion: rawEntry.inputPerMillion as number,
      outputPerMillion: rawEntry.outputPerMillion as number,
      cacheReadPerMillion: rawEntry.cacheReadPerMillion as number,
      cacheWritePerMillion: rawEntry.cacheWritePerMillion as number,
    }
  }

  return {
    version: 1,
    currency: value.currency.trim(),
    models,
  }
}

export async function loadPriceBook(filePath: string): Promise<ModelPriceBook> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return clonePriceBook(DEFAULT_PRICE_BOOK)
    }
    throw new BrainError('UNAVAILABLE', 'model price book is unreadable')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new BrainError('UNAVAILABLE', 'model price book is corrupted')
  }

  try {
    return validatePriceBook(parsed)
  } catch {
    throw new BrainError('UNAVAILABLE', 'model price book schema is invalid')
  }
}

export async function savePriceBook(filePath: string, book: ModelPriceBook): Promise<ModelPriceBook> {
  const validated = validatePriceBook(book)
  await ensurePrivateDir(path.dirname(filePath))
  await writeFileAtomic(filePath, `${JSON.stringify(validated, null, 2)}\n`)
  return clonePriceBook(validated)
}

export function lookupPrice(book: ModelPriceBook, provider: string, model: string): ModelPriceEntry | undefined {
  const qualified = provider !== '' ? `${provider}/${model}` : model
  if (Object.hasOwn(book.models, qualified)) {
    return book.models[qualified]
  }
  if (Object.hasOwn(book.models, model)) {
    return book.models[model]
  }
  return undefined
}

export function computeCostMicros(
  usage: TokenUsage,
  entry: ModelPriceEntry | undefined,
  currency: string,
): { readonly costMicros: number; readonly currency: string; readonly priced: boolean } {
  if (entry === undefined) {
    return { costMicros: 0, currency, priced: false }
  }
  const rawMicros =
    usage.inputTokens * entry.inputPerMillion
    + usage.outputTokens * entry.outputPerMillion
    + usage.cacheReadTokens * entry.cacheReadPerMillion
    + usage.cacheWriteTokens * entry.cacheWritePerMillion
  const rounded = Math.round(rawMicros)
  return {
    costMicros: rounded === 0 ? 0 : rounded,
    currency,
    priced: true,
  }
}
