// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'
import type { PluginHttp } from '@brain-core/sdk'
import { DEFAULT_QQ_CONFIG } from '../src/config.ts'
import { normalizeImage, readMessageImages } from '../src/outbound/media-normalize.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXxkAAAAASUVORK5CYII=', 'base64')
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEACgAALAAAAAABAAEAAAIBRAA7', 'base64')
const animatedGif = Buffer.concat([gif.subarray(0, -1), gif.subarray(19)])
const media = DEFAULT_QQ_CONFIG.media
const pngResponse = { status: 200, headers: {}, text: () => '', bytes: () => png }

function resolveTestFfmpeg(): string | undefined {
  const configured = process.env['BRAIN_QQ_TEST_FFMPEG']
  const candidate = configured && configured.length > 0 ? configured : 'ffmpeg'
  try {
    execFileSync(candidate, ['-version'], { stdio: 'ignore' })
    return candidate
  } catch {
    return undefined
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function makePng(width: number, height: number, options: { readonly animated?: boolean; readonly idat?: Buffer } = {}): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  const idat = options.idat ?? deflateSync(Buffer.alloc((width + 1) * Math.min(height, 1000)))
  const chunks: Buffer[] = [
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
  ]
  if (options.animated) {
    const actl = Buffer.alloc(8)
    actl.writeUInt32BE(2, 0)
    chunks.push(pngChunk('acTL', actl))
  }
  chunks.push(pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

function makeJpegHeader(width: number, height: number): Buffer {
  const sof = Buffer.alloc(11)
  sof[0] = 0xff; sof[1] = 0xc0
  sof.writeUInt16BE(11, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 1
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])])
}

function makeAnimatedWebp(width: number, height: number): Buffer {
  const vp8x = Buffer.alloc(10)
  vp8x[0] = 0x02 // ANIM bit
  vp8x.writeUIntLE(width - 1, 4, 3)
  vp8x.writeUIntLE(height - 1, 7, 3)
  const chunkHeader = Buffer.alloc(8)
  chunkHeader.write('VP8X', 0, 'ascii')
  chunkHeader.writeUInt32LE(10, 4)
  const payload = Buffer.concat([Buffer.from('WEBP', 'ascii'), chunkHeader, vp8x, Buffer.from([0])])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(payload.length, 4)
  return Buffer.concat([riff, payload])
}

test('QQ image normalization passes through small static images and rejects invalid headers', async () => {
  assert.deepEqual(await normalizeImage(png, media), { mediaType: 'image/png', base64: png.toString('base64') })
  assert.deepEqual(await normalizeImage(gif, media), { mediaType: 'image/gif', base64: gif.toString('base64') })
  assert.equal(await normalizeImage(png.subarray(0, -1), media), undefined)
  assert.equal(await normalizeImage(Buffer.from('not an image'), media), undefined)
  assert.equal(await normalizeImage(png, { ...media, maxDownloadBytes: png.length - 1 }), undefined)
})

test('animated GIFs degrade cleanly without FFmpeg', async () => {
  assert.equal(await normalizeImage(animatedGif, { ...media, ffmpegPath: 'brain-test-ffmpeg-does-not-exist' }), undefined)
})

test('animated GIFs render a 3-by-2 grid when FFmpeg is available', async (t) => {
  const ffmpegPath = resolveTestFfmpeg()
  if (ffmpegPath === undefined) {
    t.skip('ffmpeg not installed')
    return
  }
  const grid = await normalizeImage(animatedGif, { ...media, ffmpegPath })
  assert.equal(grid?.mediaType, 'image/jpeg')
  const jpeg = Buffer.from(grid!.base64, 'base64')
  const frame = jpeg.indexOf(Buffer.from([0xff, 0xc0]))
  assert.ok(frame > 0)
  assert.equal(jpeg.readUInt16BE(frame + 5), 480)
  assert.equal(jpeg.readUInt16BE(frame + 7), 720)
})

test('oversized >1280px static PNG/JPEG never pass raw without FFmpeg', async () => {
  const bigPng = makePng(1600, 900)
  const bigJpeg = makeJpegHeader(1600, 900)

  // Kills OUT-15 even without FFmpeg: >1280px static PNG and JPEG must degrade rather than return raw.
  assert.equal(await normalizeImage(bigPng, { ...media, ffmpegPath: 'brain-test-ffmpeg-does-not-exist' }), undefined)
  assert.equal(await normalizeImage(bigJpeg, { ...media, ffmpegPath: 'brain-test-ffmpeg-does-not-exist' }), undefined)
  const degraded = await readMessageImages({
    media: { ...media, ffmpegPath: 'brain-test-ffmpeg-does-not-exist' },
    fetch: async () => ({ status: 200, headers: {}, text: () => '', bytes: () => bigPng }),
    authorize: async () => ({ recordId: 'l0_big', locations: [{ url: 'https://h.qpic.cn/big.png' }] }),
  })
  assert.equal(degraded.images, undefined)
  assert.match(degraded.text, /没有可显示的 QQ 图片/)
})

test('oversized >1280px static PNG/JPEG downscale to <=1280px JPEG when FFmpeg is available', async (t) => {
  const ffmpegPath = resolveTestFfmpeg()
  if (ffmpegPath === undefined) {
    t.skip('ffmpeg not installed')
    return
  }
  const bigPng = makePng(1600, 900)
  const downscaled = await normalizeImage(bigPng, { ...media, ffmpegPath })
  assert.equal(downscaled?.mediaType, 'image/jpeg')
  const jpeg = Buffer.from(downscaled!.base64, 'base64')
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]))
  assert.ok(sof > 0)
  assert.equal(jpeg.readUInt16BE(sof + 5), 720)
  assert.equal(jpeg.readUInt16BE(sof + 7), 1280)
})

test('rejects >40 MP pixel bombs, APNG, and animated WebP even when FFmpeg is present', async () => {
  const ffmpegPath = resolveTestFfmpeg() ?? 'ffmpeg'
  const bombPng = makePng(7000, 7000, { idat: deflateSync(Buffer.from([0, 0])) })
  const apng = makePng(16, 16, { animated: true })
  const animatedWebp = makeAnimatedWebp(16, 16)

  assert.equal(await normalizeImage(bombPng, { ...media, ffmpegPath }), undefined)
  assert.equal(await normalizeImage(apng, { ...media, ffmpegPath }), undefined)
  assert.equal(await normalizeImage(animatedWebp, { ...media, ffmpegPath }), undefined)

  const degraded = await readMessageImages({
    media: { ...media, ffmpegPath },
    fetch: async (url) => ({
      status: 200,
      headers: {},
      text: () => '',
      bytes: () => url.endsWith('apng') ? apng : url.endsWith('webp') ? animatedWebp : bombPng,
    }),
    authorize: async () => ({
      recordId: 'l0_bad',
      locations: [
        { url: 'https://h.qpic.cn/bomb' },
        { url: 'https://h.qpic.cn/apng' },
        { url: 'https://h.qpic.cn/webp' },
      ],
    }),
  })
  assert.equal(degraded.images, undefined)
  assert.match(degraded.text, /没有可显示的 QQ 图片/)
})

test('readMessageImages trims multi-image payloads under budget and enforces the 8 MiB JSON-RPC line cap', async (t) => {
  const bigChunkPng = makePng(16, 16, { idat: Buffer.alloc(900_000, 0x41) })
  const trimmed = await readMessageImages({
    media,
    fetch: async () => ({ status: 200, headers: {}, text: () => '', bytes: () => bigChunkPng }),
    authorize: async () => ({
      recordId: 'l0_trim',
      locations: [
        { url: 'https://h.qpic.cn/1' },
        { url: 'https://h.qpic.cn/2' },
        { url: 'https://h.qpic.cn/3' },
        { url: 'https://h.qpic.cn/4' },
      ],
    }),
  })
  assert.equal(trimmed.images?.length, 2)
  assert.equal(trimmed.text, '部分 QQ 消息图片可用')
  assert.ok(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: '0', result: trimmed })) < 8 * 1024 * 1024)

  // Kills OUT-17: if serialized JSON-RPC payload exceeds 8 MiB, readMessageImages degrades safely.
  const originalByteLength = Buffer.byteLength.bind(Buffer)
  t.mock.method(Buffer, 'byteLength', (value: Parameters<typeof Buffer.byteLength>[0], encoding?: BufferEncoding) => {
    if (typeof value === 'string' && value.startsWith('{"jsonrpc":')) {
      return 8 * 1024 * 1024 + 1
    }
    return encoding !== undefined ? originalByteLength(value, encoding) : originalByteLength(value)
  })
  const overflowed = await readMessageImages({
    media,
    fetch: async () => pngResponse,
    authorize: async () => ({ recordId: 'l0_rpc', locations: [{ url: 'https://h.qpic.cn/1' }] }),
  })
  assert.equal(overflowed.images, undefined)
  assert.match(overflowed.text, /没有可显示的 QQ 图片/)
})

test('QQ media reading keeps tokens out of transport options and prefers market sticker CDN URLs', async () => {
  const calls: string[] = []
  const fetch: PluginHttp['fetch'] = async (url, options) => {
    assert.deepEqual(options, { maxBytes: 5 * 1024 * 1024, redirect: 'error' })
    calls.push(url)
    return pngResponse
  }
  const output = await readMessageImages({
    media, fetch,
    authorize: async () => ({ recordId: 'l0_test', locations: [
      { file: 'market.jpg', isMarketSticker: true, url: 'https://h.qpic.cn/emoji' },
      { file: 'normal.jpg', url: 'https://h.qpic.cn/fallback' },
      { file: 'C:\\private\\image.jpg', url: 'http://127.0.0.1:3000/private' },
      { url: 'https://h.qpic.cn.evil.test/image' },
      { url: 'https://h.qpic.cn/overflow' },
    ] }),
    resolveImageUrl: async (file) => { calls.push(file); return 'https://h.qpic.cn/resolved' },
  })
  assert.deepEqual(calls, ['https://h.qpic.cn/emoji', 'normal.jpg', 'https://h.qpic.cn/resolved'])
  assert.equal(output.images?.length, 2)
})

test('QQ media reading re-checks the source after download and enforces aggregate size', async () => {
  let active = true
  let calls = 0
  const location = { url: 'https://h.qpic.cn/image' }
  const fetch: PluginHttp['fetch'] = async () => {
    calls++
    active = false
    return pngResponse
  }
  const read = () => readMessageImages({
    media, fetch, authorize: async () => active ? { recordId: 'l0_test', locations: [location, location] } : undefined,
  })
  await assert.rejects(read(), { code: 'NOT_FOUND' })
  await assert.rejects(read(), { code: 'NOT_FOUND' })
  assert.equal(calls, 1)
  const capped = await readMessageImages({
    media: { ...media, maxTotalImageBytes: png.length },
    fetch: async () => pngResponse,
    authorize: async () => ({ recordId: 'l0_test', locations: [location, location] }),
  })
  assert.equal(capped.images?.length, 1)
})
