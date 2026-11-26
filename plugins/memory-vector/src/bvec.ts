import { BrainError, type Layer, type MemoryProviderHit } from '@brain-core/sdk'

const MAGIC = new Uint8Array([0x42, 0x56, 0x45, 0x43]) // "BVEC"
const FORMAT_VERSION = 1
const FLAG_NORMALIZED = 1
const HEADER_FIXED_BYTES = 18 // magic(4) + version(2) + flags(2) + dimension(4) + modelNameLen(2) + count(4)

export interface BvecHeader {
  readonly version: 1
  readonly normalized: boolean
  readonly dimension: number
  readonly modelName: string
  readonly count: number
}

export interface BvecMeta {
  readonly layer: Layer
  readonly channel: string
  readonly tEvent: number
  readonly subjects: readonly string[]
}

export interface BvecRowMeta extends BvecMeta {
  readonly row: number
}

export interface BvecQueryFilter {
  readonly layers?: readonly Layer[]
  readonly channels?: readonly string[]
  readonly subjects?: readonly string[]
  readonly from?: number
  readonly to?: number
  readonly limit: number
}

export interface BvecExpected {
  readonly modelName: string
  readonly dimension: number
  readonly normalized?: boolean
}

interface SerializedMeta {
  readonly version: 1
  readonly modelName: string
  readonly dimension: number
  readonly normalized: boolean
  readonly entries: Record<string, BvecRowMeta>
}

export interface QuantizedVector {
  readonly scale: number
  readonly quantized: Int8Array
}

/** Quantizes a floating-point vector into signed Int8 [-127, 127] with a single f32 scale. */
export function quantizeVector(vector: readonly number[] | Float32Array): QuantizedVector {
  const dim = vector.length
  let maxAbs = 0
  for (let i = 0; i < dim; i += 1) {
    const abs = Math.abs(vector[i]!)
    if (abs > maxAbs) maxAbs = abs
  }
  const quantized = new Int8Array(dim)
  if (maxAbs === 0) {
    return { scale: 0, quantized }
  }
  const scale = maxAbs / 127
  for (let i = 0; i < dim; i += 1) {
    const scaled = Math.round(vector[i]! / scale)
    quantized[i] = scaled > 127 ? 127 : scaled < -127 ? -127 : scaled
  }
  return { scale, quantized }
}

/** Computes exact integer dot product between two equal-length Int8Array vectors. */
function int8Dot(left: Int8Array, right: Int8Array, offsetRight: number, dim: number): number {
  let sum = 0
  for (let i = 0; i < dim; i += 1) {
    sum += left[i]! * right[offsetRight + i]!
  }
  return sum
}

function int8NormSq(vec: Int8Array, offset: number, dim: number): number {
  let sum = 0
  for (let i = 0; i < dim; i += 1) {
    const v = vec[offset + i]!
    sum += v * v
  }
  return sum
}

/**
 * Clean-Room BVEC v1 quantized binary vector store.
 * Stores Int8 quantized vectors + f32 scale in `vectors.bvec` and filter metadata only (never raw text).
 */
export class BvecStore {
  readonly #modelName: string
  readonly #dimension: number
  readonly #normalized: boolean
  readonly #rowStride: number
  #buffer: Uint8Array
  #view: DataView
  #capacity: number
  #count: number
  readonly #meta = new Map<string, BvecRowMeta>()
  readonly #freeRows: number[] = []

  private constructor(
    modelName: string,
    dimension: number,
    normalized: boolean,
    initialCapacity: number,
    initialCount: number,
    buffer?: Uint8Array,
  ) {
    this.#modelName = modelName
    this.#dimension = dimension
    this.#normalized = normalized
    this.#rowStride = 1 + 4 + dimension
    this.#capacity = Math.max(16, initialCapacity)
    this.#count = initialCount
    this.#buffer = new Uint8Array(this.#capacity * this.#rowStride)
    if (buffer !== undefined) {
      this.#buffer.set(buffer.subarray(0, initialCount * this.#rowStride))
    }
    this.#view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, this.#buffer.byteLength)
  }

  static create(options: BvecExpected): BvecStore {
    if (typeof options.modelName !== 'string' || options.modelName === '') {
      throw new BrainError('INVALID_ARGUMENT', 'modelName must be a non-empty string')
    }
    if (!Number.isInteger(options.dimension) || options.dimension <= 0) {
      throw new BrainError('INVALID_ARGUMENT', 'dimension must be a positive integer')
    }
    return new BvecStore(options.modelName, options.dimension, options.normalized ?? true, 16, 0)
  }

  static load(bytes: Uint8Array, metaJson: string | undefined, expected: BvecExpected): BvecStore {
    if (bytes.byteLength < HEADER_FIXED_BYTES) {
      throw new BrainError('INTERNAL', 'corrupt bvec header: truncated')
    }
    for (let i = 0; i < MAGIC.length; i += 1) {
      if (bytes[i] !== MAGIC[i]) {
        throw new BrainError('INTERNAL', 'corrupt bvec header: invalid magic')
      }
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const version = view.getUint16(4, true)
    if (version !== FORMAT_VERSION) {
      throw new BrainError('INTERNAL', `unsupported bvec version: ${version}`)
    }
    const flags = view.getUint16(6, true)
    const normalized = (flags & FLAG_NORMALIZED) !== 0
    const dimension = view.getUint32(8, true)
    const modelNameLen = view.getUint16(12, true)
    const headerSize = HEADER_FIXED_BYTES + modelNameLen
    if (bytes.byteLength < headerSize) {
      throw new BrainError('INTERNAL', 'corrupt bvec header: model name truncated')
    }
    const modelName = new TextDecoder().decode(bytes.subarray(14, 14 + modelNameLen))
    const count = view.getUint32(14 + modelNameLen, true)

    const expectedNormalized = expected.normalized ?? true
    if (
      modelName !== expected.modelName
      || dimension !== expected.dimension
      || normalized !== expectedNormalized
    ) {
      throw new BrainError(
        'EMBEDDING_MISMATCH',
        `embedding index mismatch: expected (${expected.modelName}, dim=${expected.dimension}, norm=${expectedNormalized}) `
        + `but found (${modelName}, dim=${dimension}, norm=${normalized})`,
      )
    }

    const rowStride = 1 + 4 + dimension
    const expectedBytes = headerSize + count * rowStride
    if (bytes.byteLength < expectedBytes) {
      throw new BrainError('INTERNAL', 'corrupt bvec payload: truncated rows')
    }

    const store = new BvecStore(
      modelName,
      dimension,
      normalized,
      Math.max(16, count),
      count,
      bytes.subarray(headerSize, expectedBytes),
    )

    if (metaJson !== undefined && metaJson.trim() !== '') {
      let parsed: SerializedMeta
      try {
        parsed = JSON.parse(metaJson) as SerializedMeta
      } catch {
        throw new BrainError('INTERNAL', 'corrupt bvec metadata json')
      }
      if (
        parsed.modelName !== expected.modelName
        || parsed.dimension !== expected.dimension
        || parsed.normalized !== expectedNormalized
      ) {
        throw new BrainError('EMBEDDING_MISMATCH', 'embedding metadata does not match expected model')
      }
      const referencedRows = new Set<number>()
      if (parsed.entries !== null && typeof parsed.entries === 'object') {
        for (const [id, entry] of Object.entries(parsed.entries)) {
          if (
            entry === null || typeof entry !== 'object'
            || !Number.isInteger(entry.row) || entry.row < 0 || entry.row >= count
          ) {
            continue
          }
          if (store.#buffer[entry.row * rowStride] !== 1) continue
          store.#meta.set(id, {
            row: entry.row,
            layer: entry.layer,
            channel: entry.channel,
            tEvent: entry.tEvent,
            subjects: Array.isArray(entry.subjects) ? [...entry.subjects] : [],
          })
          referencedRows.add(entry.row)
        }
      }
      for (let row = 0; row < count; row += 1) {
        if (!referencedRows.has(row)) {
          store.#buffer.fill(0, row * rowStride, (row + 1) * rowStride)
          store.#freeRows.push(row)
        }
      }
    } else {
      for (let row = 0; row < count; row += 1) {
        if (store.#buffer[row * rowStride] !== 1) {
          store.#buffer.fill(0, row * rowStride, (row + 1) * rowStride)
          store.#freeRows.push(row)
        }
      }
    }

    return store
  }

  get header(): BvecHeader {
    return {
      version: FORMAT_VERSION,
      normalized: this.#normalized,
      dimension: this.#dimension,
      modelName: this.#modelName,
      count: this.#count,
    }
  }

  has(id: string): boolean {
    return this.#meta.has(id)
  }

  size(): number {
    return this.#meta.size
  }

  rowCount(): number {
    return this.#count
  }

  #ensureCapacity(neededRows: number): void {
    if (neededRows <= this.#capacity) return
    let nextCapacity = this.#capacity
    while (nextCapacity < neededRows) nextCapacity *= 2
    const nextBuffer = new Uint8Array(nextCapacity * this.#rowStride)
    nextBuffer.set(this.#buffer.subarray(0, this.#count * this.#rowStride))
    this.#buffer = nextBuffer
    this.#view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, this.#buffer.byteLength)
    this.#capacity = nextCapacity
  }

  upsert(id: string, vector: readonly number[] | Float32Array, meta: BvecMeta): void {
    if (vector.length !== this.#dimension) {
      throw new BrainError(
        'EMBEDDING_MISMATCH',
        `vector dimension mismatch: expected ${this.#dimension}, got ${vector.length}`,
      )
    }
    const existing = this.#meta.get(id)
    let row: number
    if (existing !== undefined) {
      row = existing.row
    } else if (this.#freeRows.length > 0) {
      row = this.#freeRows.pop()!
    } else {
      row = this.#count
      this.#ensureCapacity(row + 1)
      this.#count += 1
    }

    const { scale, quantized } = quantizeVector(vector)
    const offset = row * this.#rowStride
    this.#buffer[offset] = 1
    this.#view.setFloat32(offset + 1, scale, true)
    const rowView = new Int8Array(this.#buffer.buffer, this.#buffer.byteOffset + offset + 5, this.#dimension)
    rowView.set(quantized)

    this.#meta.set(id, {
      row,
      layer: meta.layer,
      channel: meta.channel,
      tEvent: meta.tEvent,
      subjects: [...meta.subjects],
    })
  }

  forget(ids: readonly string[]): number {
    let erased = 0
    for (const id of ids) {
      const existing = this.#meta.get(id)
      if (existing === undefined) continue
      const offset = existing.row * this.#rowStride
      // Zero active byte, scale f32, and every quantized Int8 byte in the slot.
      this.#buffer.fill(0, offset, offset + this.#rowStride)
      this.#meta.delete(id)
      this.#freeRows.push(existing.row)
      erased += 1
    }
    return erased
  }

  search(queryVector: readonly number[] | Float32Array, filter: BvecQueryFilter): readonly MemoryProviderHit[] {
    if (queryVector.length !== this.#dimension) {
      throw new BrainError(
        'EMBEDDING_MISMATCH',
        `query vector dimension mismatch: expected ${this.#dimension}, got ${queryVector.length}`,
      )
    }
    if (filter.limit <= 0 || this.#meta.size === 0) return []

    const { scale: queryScale, quantized: queryQuant } = quantizeVector(queryVector)
    if (queryScale === 0) return []
    const queryNormSq = this.#normalized ? 1 : int8NormSq(queryQuant, 0, this.#dimension)
    if (queryNormSq === 0) return []

    const rowsInt8 = new Int8Array(this.#buffer.buffer, this.#buffer.byteOffset, this.#count * this.#rowStride)
    const hits: MemoryProviderHit[] = []

    for (const [id, meta] of this.#meta) {
      if (filter.layers !== undefined && !filter.layers.includes(meta.layer)) continue
      if (filter.channels !== undefined && !filter.channels.includes(meta.channel)) continue
      if (filter.subjects !== undefined && filter.subjects.length > 0
        && !meta.subjects.some((subject) => filter.subjects!.includes(subject))) continue
      if (filter.from !== undefined && meta.tEvent < filter.from) continue
      if (filter.to !== undefined && meta.tEvent > filter.to) continue

      const offset = meta.row * this.#rowStride
      if (this.#buffer[offset] !== 1) continue
      const rowScale = this.#view.getFloat32(offset + 1, true)
      if (rowScale === 0) continue

      const dot = int8Dot(queryQuant, rowsInt8, offset + 5, this.#dimension)
      let score: number
      if (this.#normalized) {
        score = dot * queryScale * rowScale
      } else {
        const rowNormSq = int8NormSq(rowsInt8, offset + 5, this.#dimension)
        if (rowNormSq === 0) continue
        score = dot / Math.sqrt(queryNormSq * rowNormSq)
      }
      if (score > 0) {
        hits.push({ id, score })
      }
    }

    hits.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    })

    return hits.slice(0, filter.limit)
  }

  encode(): { readonly vectors: Uint8Array; readonly metaJson: string } {
    const modelBytes = new TextEncoder().encode(this.#modelName)
    const headerSize = HEADER_FIXED_BYTES + modelBytes.byteLength
    const payloadSize = this.#count * this.#rowStride
    const vectors = new Uint8Array(headerSize + payloadSize)
    vectors.set(MAGIC, 0)
    const view = new DataView(vectors.buffer, vectors.byteOffset, vectors.byteLength)
    view.setUint16(4, FORMAT_VERSION, true)
    view.setUint16(6, this.#normalized ? FLAG_NORMALIZED : 0, true)
    view.setUint32(8, this.#dimension, true)
    view.setUint16(12, modelBytes.byteLength, true)
    vectors.set(modelBytes, 14)
    view.setUint32(14 + modelBytes.byteLength, this.#count, true)
    vectors.set(this.#buffer.subarray(0, payloadSize), headerSize)

    const metaPayload: SerializedMeta = {
      version: FORMAT_VERSION,
      modelName: this.#modelName,
      dimension: this.#dimension,
      normalized: this.#normalized,
      entries: Object.fromEntries(this.#meta),
    }
    return { vectors, metaJson: JSON.stringify(metaPayload) }
  }
}
