import { BrainError, type BrainContext } from '@brain-core/sdk'

export interface EmbedResult {
  readonly modelName: string
  readonly vector: Float32Array
}

export interface Embedder {
  readonly modelName: string
  readonly dimension: number
  readonly normalized: boolean
  embed(text: string): Promise<EmbedResult>
}

export interface HashEmbedderOptions {
  readonly modelName?: string
  readonly dimension?: number
}

export interface HttpEmbedderOptions {
  readonly endpoint: string
  readonly modelName: string
  readonly dimension?: number
  readonly normalized?: boolean
  readonly apiKey?: string
  readonly fetch: BrainContext['http']['fetch']
  readonly timeoutMs?: number
}

function fnv1a(input: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

function addFeature(vec: Float32Array, feature: string, weight: number): void {
  const h1 = fnv1a(feature, 0x811c9dc5)
  const h2 = fnv1a(feature, 0x9e3779b9)
  const bucket = h1 % vec.length
  const sign = (h2 & 1) === 0 ? 1 : -1
  vec[bucket] = vec[bucket]! + sign * weight
}

/**
 * Deterministic local character n-gram + word feature-hashing embedder (L2 normalized).
 * Used for offline unit tests and Int8 vs Float32 quantization accuracy verification.
 */
export function createHashEmbedder(options: HashEmbedderOptions = {}): Embedder {
  const modelName = options.modelName ?? 'hash-ngram-v1'
  const dimension = options.dimension ?? 256
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new BrainError('INVALID_ARGUMENT', 'dimension must be a positive integer')
  }

  return {
    modelName,
    dimension,
    normalized: true,
    async embed(text: string): Promise<EmbedResult> {
      const vec = new Float32Array(dimension)
      const cleaned = text.toLowerCase().trim().replace(/\s+/g, ' ')
      if (cleaned === '') {
        return { modelName, vector: vec }
      }

      const words = cleaned.match(/[a-z0-9_]+/g)
      if (words !== null) {
        for (const word of words) {
          addFeature(vec, `w:${word}`, 2.0)
        }
      }

      const chars = [...cleaned]
      for (const ch of chars) {
        if (ch !== ' ') addFeature(vec, `c1:${ch}`, 0.5)
      }
      for (let i = 0; i < chars.length - 1; i += 1) {
        addFeature(vec, `c2:${chars[i]!}${chars[i + 1]!}`, 1.5)
      }
      for (let i = 0; i < chars.length - 2; i += 1) {
        addFeature(vec, `c3:${chars[i]!}${chars[i + 1]!}${chars[i + 2]!}`, 1.2)
      }

      let normSq = 0
      for (let i = 0; i < dimension; i += 1) {
        const val = vec[i]!
        normSq += val * val
      }
      if (normSq > 0) {
        const invNorm = 1 / Math.sqrt(normSq)
        for (let i = 0; i < dimension; i += 1) {
          vec[i] = vec[i]! * invNorm
        }
      }
      return { modelName, vector: vec }
    },
  }
}

function buildEmbeddingsUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/embeddings') ? trimmed : `${trimmed}/embeddings`
}

/**
 * OpenAI-compatible HTTP `/embeddings` client wired strictly through `ctx.http.fetch`.
 * Enforces returned modelName and vector dimension calibration.
 */
export function createHttpEmbedder(options: HttpEmbedderOptions): Embedder {
  const {
    endpoint,
    modelName,
    dimension = 1024,
    normalized = true,
    apiKey,
    fetch: httpFetch,
    timeoutMs = 15_000,
  } = options

  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    throw new BrainError('INVALID_ARGUMENT', 'embedding endpoint must be a non-empty string')
  }
  if (typeof modelName !== 'string' || modelName === '') {
    throw new BrainError('INVALID_ARGUMENT', 'modelName must be a non-empty string')
  }
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new BrainError('INVALID_ARGUMENT', 'dimension must be a positive integer')
  }

  const targetUrl = buildEmbeddingsUrl(endpoint)

  return {
    modelName,
    dimension,
    normalized,
    async embed(text: string): Promise<EmbedResult> {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (typeof apiKey === 'string' && apiKey !== '') {
        headers.authorization = `Bearer ${apiKey}`
      }
      const response = await httpFetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: modelName, input: text }),
        timeoutMs,
      })
      if (response.status < 200 || response.status >= 300) {
        throw new BrainError('UNAVAILABLE', `embedding endpoint returned status ${response.status}`)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(response.text())
      } catch {
        throw new BrainError('UNAVAILABLE', 'embedding endpoint returned invalid JSON')
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new BrainError('UNAVAILABLE', 'embedding response must be an object')
      }
      const body = parsed as { readonly model?: unknown; readonly data?: unknown }
      const returnedModel = typeof body.model === 'string' && body.model !== '' ? body.model : modelName
      if (returnedModel !== modelName) {
        throw new BrainError(
          'EMBEDDING_MISMATCH',
          `embedding model mismatch: expected "${modelName}", got "${returnedModel}"`,
        )
      }
      if (!Array.isArray(body.data) || body.data.length === 0) {
        throw new BrainError('UNAVAILABLE', 'embedding response has no data entries')
      }
      const first = body.data[0] as { readonly embedding?: unknown } | undefined
      if (first === undefined || !Array.isArray(first.embedding)) {
        throw new BrainError('UNAVAILABLE', 'embedding response is missing vector')
      }
      if (first.embedding.length !== dimension) {
        throw new BrainError(
          'EMBEDDING_MISMATCH',
          `embedding dimension mismatch: expected ${dimension}, got ${first.embedding.length}`,
        )
      }
      const vector = new Float32Array(first.embedding.length)
      for (let i = 0; i < first.embedding.length; i += 1) {
        const value = first.embedding[i]
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new BrainError('UNAVAILABLE', 'embedding vector contains non-finite value')
        }
        vector[i] = value
      }
      return { modelName: returnedModel, vector }
    },
  }
}
