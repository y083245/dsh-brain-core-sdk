import { Buffer } from 'node:buffer'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const SIZE = 256
const MAX_COMBINED_BYTES = 120 * 1024
const PAPER_FIBER_SEED = 0x1a2b3c
const PAPER_FIBER_COUNT = 900

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const texturesDir = path.resolve(scriptsDir, '..', 'public', 'textures')

/**
 * Deterministic 32-bit integer hash mapped to [0, 1).
 */
function hash2(ix, iy, seed = 0) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h = (h ^ (h >>> 16)) >>> 0
  return h / 4294967296
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function wrapInt(n, period) {
  const m = n % period
  return m < 0 ? m + period : m
}

/**
 * Seamless toroidally wrapping value noise at integer frequency `period`.
 */
function noiseTileable(nx, ny, period, seed) {
  const px = nx * period
  const py = ny * period
  const ix = Math.floor(px)
  const iy = Math.floor(py)
  const fx = px - ix
  const fy = py - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)

  const x0 = wrapInt(ix, period)
  const x1 = wrapInt(ix + 1, period)
  const y0 = wrapInt(iy, period)
  const y1 = wrapInt(iy + 1, period)

  const n00 = hash2(x0, y0, seed)
  const n10 = hash2(x1, y0, seed)
  const n01 = hash2(x0, y1, seed)
  const n11 = hash2(x1, y1, seed)

  const nx0 = n00 + (n10 - n00) * ux
  const nx1 = n01 + (n11 - n01) * ux
  return nx0 + (nx1 - nx0) * uy
}

/**
 * 5-octave tileable FBM with integer octave periods so toroidal wrap is exact.
 */
function fbmTileable(nx, ny, basePeriod, seed, octaves = 5) {
  let value = 0
  let amp = 0.5
  let ampSum = 0
  let period = basePeriod
  for (let i = 0; i < octaves; i++) {
    value += amp * noiseTileable(nx, ny, period, seed + i * 97)
    ampSum += amp
    period *= 2
    amp *= 0.5
  }
  return value / ampSum
}

function clamp01(v) {
  if (v <= 0) return 0
  if (v >= 1) return 1
  return v
}

/**
 * Appendix C.5: inkstone.png
 * v = 0.6 * fbm(p * 4) + 0.4 * fbm(p * 32)
 * sparse bright speckles: hash(p) > 0.997 -> +0.3
 * contrast mapped to 0.35-0.65.
 */
function generateInkstonePixels() {
  const raw = new Float64Array(SIZE * SIZE)
  let minBase = Infinity
  let maxBase = -Infinity

  for (let y = 0; y < SIZE; y++) {
    const ny = y / SIZE
    for (let x = 0; x < SIZE; x++) {
      const nx = x / SIZE
      const v = 0.6 * fbmTileable(nx, ny, 4, 0x101) + 0.4 * fbmTileable(nx, ny, 32, 0x202)
      raw[y * SIZE + x] = v
      if (v < minBase) minBase = v
      if (v > maxBase) maxBase = v
    }
  }

  const baseSpan = maxBase > minBase ? maxBase - minBase : 1
  let minVal = Infinity
  let maxVal = -Infinity
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const idx = y * SIZE + x
      let v = (raw[idx] - minBase) / baseSpan
      if (hash2(x, y, 0x997) > 0.997) {
        v += 0.3
      }
      raw[idx] = v
      if (v < minVal) minVal = v
      if (v > maxVal) maxVal = v
    }
  }

  const span = maxVal > minVal ? maxVal - minVal : 1
  const bytes = new Uint8Array(SIZE * SIZE)
  for (let i = 0; i < raw.length; i++) {
    const norm = (raw[i] - minVal) / span
    const mapped = 0.35 + norm * 0.3
    bytes[i] = Math.round(clamp01(mapped) * 255)
  }
  return bytes
}

/**
 * Separable toroidally wrapped Gaussian blur.
 */
function gaussianBlurTileable(src, radius) {
  const half = Math.ceil(radius * 3)
  const kernel = new Float64Array(half * 2 + 1)
  const twoSigmaSq = 2 * radius * radius
  let sum = 0
  for (let k = -half; k <= half; k++) {
    const w = Math.exp(-(k * k) / twoSigmaSq)
    kernel[k + half] = w
    sum += w
  }
  for (let i = 0; i < kernel.length; i++) {
    kernel[i] /= sum
  }

  const tmp = new Float64Array(SIZE * SIZE)
  for (let y = 0; y < SIZE; y++) {
    const row = y * SIZE
    for (let x = 0; x < SIZE; x++) {
      let acc = 0
      for (let k = -half; k <= half; k++) {
        const sx = wrapInt(x + k, SIZE)
        acc += src[row + sx] * kernel[k + half]
      }
      tmp[row + x] = acc
    }
  }

  const dst = new Float64Array(SIZE * SIZE)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let acc = 0
      for (let k = -half; k <= half; k++) {
        const sy = wrapInt(y + k, SIZE)
        acc += tmp[sy * SIZE + x] * kernel[k + half]
      }
      dst[y * SIZE + x] = acc
    }
  }

  return dst
}

/**
 * Appendix C.5: paper-fiber.png
 * fbm(p * 6) base + 900 short fibers (length 6-28 px, width 1 px, random direction,
 * brightness +/-0.15, deterministic seed 0x1A2B3C, additive blend) + Gaussian blur radius 0.6 px.
 */
function generatePaperFiberPixels() {
  const buf = new Float64Array(SIZE * SIZE)
  for (let y = 0; y < SIZE; y++) {
    const ny = y / SIZE
    for (let x = 0; x < SIZE; x++) {
      const nx = x / SIZE
      buf[y * SIZE + x] = fbmTileable(nx, ny, 6, 0x303)
    }
  }

  const rand = mulberry32(PAPER_FIBER_SEED)
  for (let i = 0; i < PAPER_FIBER_COUNT; i++) {
    const x0 = rand() * SIZE
    const y0 = rand() * SIZE
    const len = 6 + rand() * 22
    const angle = rand() * Math.PI * 2
    const brightness = (rand() * 2 - 1) * 0.15
    const dx = Math.cos(angle)
    const dy = Math.sin(angle)

    const steps = Math.max(1, Math.ceil(len))
    const stepLen = len / steps
    for (let s = 0; s <= steps; s++) {
      const px = x0 + dx * (s * stepLen)
      const py = y0 + dy * (s * stepLen)
      const ix = Math.floor(px)
      const iy = Math.floor(py)
      const fx = px - ix
      const fy = py - iy

      const wx0 = wrapInt(ix, SIZE)
      const wx1 = wrapInt(ix + 1, SIZE)
      const wy0 = wrapInt(iy, SIZE)
      const wy1 = wrapInt(iy + 1, SIZE)

      buf[wy0 * SIZE + wx0] += brightness * (1 - fx) * (1 - fy)
      buf[wy0 * SIZE + wx1] += brightness * fx * (1 - fy)
      buf[wy1 * SIZE + wx0] += brightness * (1 - fx) * fy
      buf[wy1 * SIZE + wx1] += brightness * fx * fy
    }
  }

  const blurred = gaussianBlurTileable(buf, 0.6)
  const bytes = new Uint8Array(SIZE * SIZE)
  for (let i = 0; i < blurred.length; i++) {
    bytes[i] = Math.round(clamp01(blurred[i]) * 255)
  }
  return bytes
}

// --- Minimal zero-dependency grayscale PNG encoder ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcInput = Buffer.concat([typeBuf, data])
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(crcInput), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

function paethPredictor(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function encodeGrayscalePng(width, height, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // color type: grayscale
  ihdr[10] = 0 // compression: deflate
  ihdr[11] = 0 // filter: adaptive
  ihdr[12] = 0 // interlace: none

  const stride = width + 1
  const raw = Buffer.alloc(stride * height)
  const candidates = [
    new Uint8Array(width),
    new Uint8Array(width),
    new Uint8Array(width),
    new Uint8Array(width),
    new Uint8Array(width),
  ]

  for (let y = 0; y < height; y++) {
    const rowOff = y * width
    const prevOff = (y - 1) * width
    for (let x = 0; x < width; x++) {
      const cur = pixels[rowOff + x]
      const a = x > 0 ? pixels[rowOff + x - 1] : 0
      const b = y > 0 ? pixels[prevOff + x] : 0
      const c = x > 0 && y > 0 ? pixels[prevOff + x - 1] : 0

      candidates[0][x] = cur
      candidates[1][x] = (cur - a) & 0xff
      candidates[2][x] = (cur - b) & 0xff
      candidates[3][x] = (cur - ((a + b) >> 1)) & 0xff
      candidates[4][x] = (cur - paethPredictor(a, b, c)) & 0xff
    }

    let bestFilter = 0
    let bestScore = Infinity
    for (let f = 0; f < 5; f++) {
      let score = 0
      const row = candidates[f]
      for (let x = 0; x < width; x++) {
        const v = row[x]
        score += v < 128 ? v : 256 - v
      }
      if (score < bestScore) {
        bestScore = score
        bestFilter = f
      }
    }

    const dstOff = y * stride
    raw[dstOff] = bestFilter
    raw.set(candidates[bestFilter], dstOff + 1)
  }

  const compressed = deflateSync(raw, { level: 9 })
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ])
}

async function main() {
  const checkOnly = process.argv.includes('--check')

  const inkstonePng = encodeGrayscalePng(SIZE, SIZE, generateInkstonePixels())
  const paperFiberPng = encodeGrayscalePng(SIZE, SIZE, generatePaperFiberPixels())
  const combinedBytes = inkstonePng.byteLength + paperFiberPng.byteLength

  if (combinedBytes > MAX_COMBINED_BYTES) {
    process.stderr.write(
      `Texture size budget exceeded: ${String(combinedBytes)} bytes > ${String(MAX_COMBINED_BYTES)} bytes\n`,
    )
    process.exit(1)
  }

  const targets = [
    { name: 'inkstone.png', data: inkstonePng },
    { name: 'paper-fiber.png', data: paperFiberPng },
  ]

  if (checkOnly) {
    for (const target of targets) {
      const filePath = path.join(texturesDir, target.name)
      let existing
      try {
        existing = await readFile(filePath)
      } catch {
        process.stderr.write(`Missing texture file: ${filePath}\n`)
        process.exit(1)
      }
      if (!existing.equals(target.data)) {
        process.stderr.write(
          `Texture mismatch for ${target.name} (expected ${String(target.data.byteLength)} B, found ${String(existing.byteLength)} B). Run node apps/console/web/scripts/gen-textures.mjs to regenerate.\n`,
        )
        process.exit(1)
      }
    }
    process.stdout.write(
      `Textures OK: inkstone.png (${String(inkstonePng.byteLength)} B) + paper-fiber.png (${String(paperFiberPng.byteLength)} B) = ${String(combinedBytes)} B (<= ${String(MAX_COMBINED_BYTES)} B)\n`,
    )
    return
  }

  await mkdir(texturesDir, { recursive: true })
  for (const target of targets) {
    await writeFile(path.join(texturesDir, target.name), target.data)
  }
  process.stdout.write(
    `Generated textures: inkstone.png (${String(inkstonePng.byteLength)} B) + paper-fiber.png (${String(paperFiberPng.byteLength)} B) = ${String(combinedBytes)} B\n`,
  )
}

await main()
