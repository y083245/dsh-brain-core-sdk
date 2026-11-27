// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { deflateSync } from 'node:zlib'
import { resolveSharp, type SharpLoader, type SharpPipeline } from '../src/outbound/media-normalize.ts'

interface TestPipeline extends SharpPipeline {
  metadata(): Promise<{ width: number; height: number; pages?: number; delay?: number[] }>
  flatten(options: { background: string }): TestPipeline
  raw(): TestPipeline
  removeAlpha(): TestPipeline
  webp(options: { lossless: boolean }): TestPipeline
}
export const sharp = resolveSharp() as ((...args: Parameters<SharpLoader>) => TestPipeline) | null
export const COLORS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255]] as const

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let value = n
  for (let k = 0; k < 8; k++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
export function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write(type, 4, 'ascii')
  data.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, -4)) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8)
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return chunk
}

export function makeApng(delays: readonly (readonly [number, number])[] = [[1, 10], [2, 10], [0, 0], [3, 10]]): Buffer {
  const size = 32
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2
  const actl = Buffer.alloc(8); actl.writeUInt32BE(delays.length)
  const chunks = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('acTL', actl)]
  let sequence = 0
  for (const [i, [numerator, denominator]] of delays.entries()) {
    const control = Buffer.alloc(26)
    control.writeUInt32BE(sequence++); control.writeUInt32BE(size, 4); control.writeUInt32BE(size, 8)
    control.writeUInt16BE(numerator, 20); control.writeUInt16BE(denominator, 22)
    chunks.push(pngChunk('fcTL', control))
    const pixels = Buffer.alloc((size * 3 + 1) * size)
    const color = COLORS[i % COLORS.length]!
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      for (let c = 0; c < 3; c++) pixels[y * (size * 3 + 1) + 1 + x * 3 + c] = color[c]!
    }
    const compressed = deflateSync(pixels)
    if (i === 0) chunks.push(pngChunk('IDAT', compressed))
    else {
      const seq = Buffer.alloc(4); seq.writeUInt32BE(sequence++)
      chunks.push(pngChunk('fdAT', Buffer.concat([seq, compressed])))
    }
  }
  chunks.push(pngChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

/** Deliberately simple LZW: clear before every literal keeps all codes at four bits. */
export function makeGif(count = 4, delta = false): Buffer {
  const size = 32
  const screen = Buffer.from([size, 0, size, 0, 0x82, 0, 0]) // 8-entry global color table
  const palette = Buffer.alloc(24)
  for (const [i, color] of COLORS.entries()) Buffer.from(color).copy(palette, i * 3)
  const chunks = [Buffer.from('GIF89a'), screen, palette]
  for (let i = 0; i < count; i++) {
    const side = delta && i > 0 ? 16 : size
    const left = delta && (i === 2 || i === 3) ? 16 : 0
    const top = delta && i === 2 ? 16 : 0
    const disposal = delta && i === 1 ? 2 : delta && i === 2 ? 3 : 1
    chunks.push(Buffer.from([0x21, 0xf9, 4, disposal << 2, 10, 0, 0, 0]))
    chunks.push(Buffer.from([0x2c, left, 0, top, 0, side, 0, side, 0, 0, 3]))
    // Minimum LZW code size 3: clear=8, end=9. Low nibble precedes high nibble.
    const codes = Buffer.alloc(side * side + 1, 8 | ((i % COLORS.length) << 4))
    codes[codes.length - 1] = 9
    for (let offset = 0; offset < codes.length; offset += 255) {
      const block = codes.subarray(offset, offset + 255)
      chunks.push(Buffer.from([block.length]), block)
    }
    chunks.push(Buffer.from([0]))
  }
  return Buffer.concat([...chunks, Buffer.from([0x3b])])
}

function riffChunk(tag: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8); header.write(tag); header.writeUInt32LE(payload.length, 4)
  return Buffer.concat([header, payload, ...(payload.length & 1 ? [Buffer.alloc(1)] : [])])
}

export async function makeWebp(delays = [100, 200, 0, 300], delta = false): Promise<Buffer> {
  if (sharp === null) throw new Error('sharp required to encode WebP fixture')
  const size = 32
  const extended = Buffer.alloc(10); extended[0] = 2
  extended.writeUIntLE(size - 1, 4, 3); extended.writeUIntLE(size - 1, 7, 3)
  const chunks = [riffChunk('VP8X', extended), riffChunk('ANIM', Buffer.alloc(6))]
  for (const [i, delay] of delays.entries()) {
    const color = COLORS[i % COLORS.length]!
    const side = delta && i > 0 ? 16 : size
    const frame = await sharp({ create: { width: side, height: side, channels: 3, background: `rgb(${color.join(',')})` } }).webp({ lossless: true }).toBuffer()
    const header = Buffer.alloc(16)
    if (delta && (i === 2 || i === 3)) header.writeUIntLE(8, 0, 3)
    if (delta && i === 2) header.writeUIntLE(8, 3, 3)
    header.writeUIntLE(side - 1, 6, 3); header.writeUIntLE(side - 1, 9, 3); header.writeUIntLE(delay, 12, 3)
    header[15] = delta && i === 1 ? 3 : 2 // Replace canvas rather than blend.
    chunks.push(riffChunk('ANMF', Buffer.concat([header, frame.subarray(12)])))
  }
  const payload = Buffer.concat([Buffer.from('WEBP'), ...chunks])
  const riff = Buffer.alloc(8); riff.write('RIFF'); riff.writeUInt32LE(payload.length, 4)
  return Buffer.concat([riff, payload])
}
