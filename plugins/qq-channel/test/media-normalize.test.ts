// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'
import type { PluginHttp } from '@dsh-brain-core/sdk'
import { DEFAULT_QQ_CONFIG, type QqMediaSettings } from '../src/config.ts'
import { normalizeImage, normalizeImageDetailed, planAnimation, readMessageImages, resolveFfmpegPath, resolveSharp, sampleFrameIndices, type SharpLoader } from '../src/outbound/media-normalize.ts'

import { COLORS, makeApng, makeGif, makeWebp, sharp } from './media-fixtures.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXxkAAAAASUVORK5CYII=', 'base64')
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEACgAALAAAAAABAAEAAAIBRAA7', 'base64')
const animatedGif = Buffer.concat([gif.subarray(0, -1), gif.subarray(19)])
const media = DEFAULT_QQ_CONFIG.media
const pngResponse = { status: 200, headers: {}, text: () => '', bytes: () => png }

function resolveTestFfmpeg(): string | undefined {
  const candidates = [process.env['BRAIN_QQ_TEST_FFMPEG'], process.env['FFMPEG_PATH'],
    ...(process.platform === 'darwin' ? ['/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg'] : []),
    ...(process.env['PATH'] ?? '').split(delimiter).map((dir) => join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))]
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue
    try {
      execFileSync(candidate, ['-version'], { stdio: 'ignore', windowsHide: true })
      return candidate
    } catch { /* Try the next installed executable. */ }
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
  const sof = Buffer.alloc(13)
  sof[0] = 0xff; sof[1] = 0xc0
  sof.writeUInt16BE(11, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 1
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])])
}

function makeAnimatedWebp(width: number, height: number, anmfCount = 0): Buffer {
  const vp8x = Buffer.alloc(10)
  vp8x[0] = 0x02 // ANIM bit
  vp8x.writeUIntLE(width - 1, 4, 3)
  vp8x.writeUIntLE(height - 1, 7, 3)
  const chunkHeader = Buffer.alloc(8)
  chunkHeader.write('VP8X', 0, 'ascii')
  chunkHeader.writeUInt32LE(10, 4)
  const anmfChunks: Buffer[] = []
  for (let i = 0; i < anmfCount; i++) {
    const anmfHeader = Buffer.alloc(8)
    anmfHeader.write('ANMF', 0, 'ascii')
    anmfHeader.writeUInt32LE(16, 4)
    anmfChunks.push(anmfHeader, Buffer.alloc(16))
  }
  const payload = Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    chunkHeader,
    vp8x,
    ...anmfChunks,
    ...(anmfCount === 0 ? [Buffer.from([0])] : []),
  ])
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

const noFfmpeg = { ...media, ffmpegPath: 'nonexistent' }
const noSharp = { sharp: null }

test('animation plans use adaptive row-major layouts without clone-padding', () => {
  for (const [frames, cols, rows] of [[1, 1, 1], [2, 2, 1], [3, 3, 1], [4, 2, 2], [5, 3, 2], [6, 3, 2], [7, 4, 2], [8, 4, 2], [9, 3, 3], [10, 5, 2], [11, 4, 3], [12, 4, 3]]) {
    const plan = planAnimation(frames!, { ...media, gifFrames: 12 })
    assert.equal(plan.sampleFrames, frames)
    assert.deepEqual([plan.cols, plan.rows], [cols, rows])
    assert.equal(plan.cellPx, 240)
    assert.equal(plan.width, cols! * 240 + (cols! + 1) * 4)
    assert.equal(plan.height, rows! * 240 + (rows! + 1) * 4)
  }
  assert.deepEqual(sampleFrameIndices(10, 1), [0])
  assert.deepEqual(sampleFrameIndices(2, 6), [0, 1])
  assert.deepEqual(sampleFrameIndices(9, 4), [0, 3, 5, 8])
  assert.deepEqual(sampleFrameIndices(20, 6), [0, 4, 8, 11, 15, 19])
  assert.equal(planAnimation(2, media).sampleFrames, 2)
  assert.equal(planAnimation(20, media).sampleFrames, 6)
  assert.equal(planAnimation(20, { ...media, gifFrames: 0 }).sampleFrames, 2)
  assert.equal(planAnimation(20, { ...media, gifFrames: 100 }).sampleFrames, 12)
  assert.equal(planAnimation(20, { ...media, gifFrames: NaN, gifCellPx: NaN }).sampleFrames, 6)
  assert.equal(planAnimation(2, { ...media, gifCellPx: 0 }).cellPx, 64)
  assert.equal(planAnimation(2, { ...media, gifCellPx: 1000 }).cellPx, 400)
  const capped = planAnimation(9, { ...media, gifFrames: 9, gifCellPx: 400, maxImageDimension: 300 })
  assert.equal(capped.cellPx, 94)
  assert.ok(capped.width <= 300 && capped.height <= 300)
})

async function assertGrid(input: Buffer, frames: number, ffmpegPath = 'nonexistent', disableSharp = false, patch: Partial<QqMediaSettings> = {}): Promise<void> {
  assert.ok(sharp, 'sharp required to inspect output pixels')
  const settings = { ...media, ffmpegPath, gifCellPx: 64, ...patch }
  const result = await normalizeImageDetailed(input, settings, disableSharp ? noSharp : { sharp })
  assert.equal(result?.image.mediaType, 'image/jpeg')
  const jpeg = Buffer.from(result!.image.base64, 'base64')
  const plan = planAnimation(frames, settings)
  const metadata = await sharp(jpeg).metadata()
  assert.deepEqual([metadata.width, metadata.height], [plan.width, plan.height])
  const pixels = await sharp(jpeg).removeAlpha().raw().toBuffer()
  for (let i = 0; i < plan.sampleFrames; i++) {
    const x = 4 + i % plan.cols * (plan.cellPx + 4) + Math.floor(plan.cellPx / 2)
    const y = 4 + Math.floor(i / plan.cols) * (plan.cellPx + 4) + Math.floor(plan.cellPx / 2)
    const offset = (y * plan.width + x) * 3
    const expected = COLORS[plan.indices[i]! % COLORS.length]!
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(pixels[offset + c]! - expected[c]!) < 25, `cell ${i}, channel ${c}: ${pixels[offset + c]} vs ${expected[c]}`)
  }
  assert.match(result!.note!, new RegExp(`已抽 ${plan.sampleFrames} 帧拼成 ${plan.cols}×${plan.rows} 网格，行优先 左上→右下`))
  assert.ok(!result!.note!.includes('（'))
}

test('sharp resolves through the SDK host and renders real 2/4-frame GIF grids with distinct colors without FFmpeg', async (t) => {
  if (!sharp) return t.skip('optional host sharp not installed')
  assert.equal(resolveSharp(), sharp)
  assert.equal(resolveSharp(), resolveSharp())
  for (const count of [2, 4]) {
    const input = makeGif(count)
    const metadata = await sharp(input, { page: 0, pages: 1, limitInputPixels: 40_000_000 }).metadata()
    assert.equal(metadata.pages, count)
    assert.deepEqual(metadata.delay, Array.from({ length: count }, () => 100))
    await assertGrid(input, count)
  }
  await assertGrid(makeGif(9), 9, 'nonexistent', false, { gifFrames: 5, gifCellPx: 100 })
  const note = (await normalizeImageDetailed(makeGif(4), noFfmpeg))?.note
  assert.equal(note, '动图 4 帧/0.4s，已抽 4 帧拼成 2×2 网格，行优先 左上→右下')
})

test('offline-installed plugin discovers sharp via the realpath of its SDK junction', async (t) => {
  if (!sharp) return t.skip('optional host sharp not installed')
  const directory = await mkdtemp(join(tmpdir(), 'brain-qq-sharp-resolution-'))
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }))
  const plugin = join(directory, '.installed', 'qq', 'version')
  const outbound = join(plugin, 'src', 'outbound')
  await mkdir(outbound, { recursive: true })
  await mkdir(join(plugin, 'node_modules', '@dsh-brain-core'), { recursive: true })
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ type: 'module', dependencies: { '@dsh-brain-core/sdk': 'workspace:*' } }))
  await symlink(fileURLToPath(new URL('../../../packages/sdk', import.meta.url)), join(plugin, 'node_modules', '@dsh-brain-core', 'sdk'), 'junction')
  const target = join(outbound, 'media-normalize.ts')
  await copyFile(new URL('../src/outbound/media-normalize.ts', import.meta.url), target)
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { resolveSharp } = await import(${JSON.stringify(pathToFileURL(target).href)}); console.log(typeof resolveSharp())`],
    { cwd: directory, windowsHide: true, encoding: 'utf8', timeout: 10_000 })
  assert.equal(output.trim(), 'function')
})

test('sharp coalesces delta GIF regions and disposal 2/3 when decoding individual pages', async (t) => {
  if (!sharp) return t.skip('optional host sharp not installed')
  const input = makeGif(4, true)
  const settings = { ...noFfmpeg, gifCellPx: 64 }
  const result = await normalizeImageDetailed(input, settings, { sharp })
  assert.equal(result?.image.mediaType, 'image/jpeg')
  const plan = planAnimation(4, settings)
  const grid = await sharp(Buffer.from(result!.image.base64, 'base64')).raw().toBuffer()
  const expected = [
    [0, 0, 0, 0], // Full red canvas.
    [1, 0, 0, 0], // Green top-left delta, then disposal 2 clears to red background.
    [0, 0, 0, 2], // Blue bottom-right delta, then disposal 3 restores red canvas.
    [0, 3, 0, 0], // Yellow top-right delta.
  ]
  for (let page = 0; page < 4; page++) {
    const pixels = await sharp(input, { page, pages: 1, limitInputPixels: 40_000_000 }).removeAlpha().raw().toBuffer()
    assert.equal(pixels.length, 32 * 32 * 3)
    for (let quadrant = 0; quadrant < 4; quadrant++) {
      const x = 8 + (quadrant % 2) * 16
      const y = 8 + Math.floor(quadrant / 2) * 16
      const offset = (y * 32 + x) * 3
      const color = COLORS[expected[page]![quadrant]!]!
      assert.deepEqual([...pixels.subarray(offset, offset + 3)], [...color], `page ${page}, quadrant ${quadrant}`)
      const gx = 4 + (page % 2) * 68 + x * 2
      const gy = 4 + Math.floor(page / 2) * 68 + y * 2
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(grid[(gy * plan.width + gx) * 3 + c]! - color[c]!) < 25)
    }
  }
})

test('sharp renders animated WebP pages with distinct colors and parses ANMF duration including zero fallback', async (t) => {
  if (!sharp) return t.skip('optional host sharp not installed')
  const input = await makeWebp()
  const metadata = await sharp(input, { page: 0, pages: 1, limitInputPixels: 40_000_000 }).metadata()
  assert.equal(metadata.pages, 4)
  assert.deepEqual(metadata.delay, [100, 200, 0, 300])
  await assertGrid(input, 4)
  assert.equal((await normalizeImageDetailed(input, noFfmpeg))?.note,
    '动图 4 帧/0.7s，已抽 4 帧拼成 2×2 网格，行优先 左上→右下')
})

test('sharp coalesces animated WebP subrectangles and background disposal per page', async (t) => {
  if (!sharp) return t.skip('optional host sharp not installed')
  const input = await makeWebp([100, 100, 100, 100], true)
  const white = [255, 255, 255]
  const expected = [
    [COLORS[0], COLORS[0], COLORS[0], COLORS[0]],
    [COLORS[1], COLORS[0], COLORS[0], COLORS[0]],
    [white, COLORS[0], COLORS[0], COLORS[2]],
    [white, COLORS[3], COLORS[0], COLORS[2]],
  ]
  for (let page = 0; page < 4; page++) {
    const pixels = await sharp(input, { page, pages: 1, limitInputPixels: 40_000_000 })
      .flatten({ background: '#ffffff' }).raw().toBuffer()
    assert.equal(pixels.length, 32 * 32 * 3)
    for (let quadrant = 0; quadrant < 4; quadrant++) {
      const offset = ((8 + Math.floor(quadrant / 2) * 16) * 32 + 8 + quadrant % 2 * 16) * 3
      assert.deepEqual([...pixels.subarray(offset, offset + 3)], [...expected[page]![quadrant]!], `page ${page}, quadrant ${quadrant}`)
    }
  }
  assert.equal((await normalizeImageDetailed(input, noFfmpeg))?.image.mediaType, 'image/jpeg')
})

test('sharp downscales real oversized static PNG without FFmpeg and enforces byte/dimension budgets', async (t) => {
  if (!sharp) return t.skip('optional host sharp not installed')
  const input = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#aabbcc' } }).png().toBuffer()
  const result = await normalizeImageDetailed(input, noFfmpeg)
  assert.equal(result?.image.mediaType, 'image/jpeg')
  const output = Buffer.from(result!.image.base64, 'base64')
  const metadata = await sharp(output).metadata()
  assert.deepEqual([metadata.width, metadata.height], [1280, 720])
  assert.ok(output.length <= media.maxImageBytes)
  const tinyBudget = await normalizeImageDetailed(input, { ...noFfmpeg, maxImageBytes: 1 })
  assert.equal(tinyBudget, undefined)
})

test('FFmpeg renders real 2/6-frame GIF grids without cloned cells and APNG with parsed fcTL delays', async (t) => {
  const ffmpegPath = resolveTestFfmpeg()
  if (!ffmpegPath) return t.skip('ffmpeg not installed')
  if (!sharp) return t.skip('optional host sharp required to inspect pixels')
  for (const count of [2, 6]) await assertGrid(makeGif(count), count, ffmpegPath, true)
  const apng = makeApng()
  await assertGrid(apng, 4, ffmpegPath, true)
  const result = await normalizeImageDetailed(apng, { ...media, ffmpegPath }, noSharp)
  assert.equal(result?.note, '动图 4 帧/0.7s，已抽 4 帧拼成 2×2 网格，行优先 左上→右下')
  // APNG must bypass sharp's frame-zero-only PNG loader.
  let sharpCalled = false
  const forbiddenSharp: SharpLoader = () => { sharpCalled = true; throw new Error('APNG should not invoke sharp') }
  assert.equal((await normalizeImageDetailed(apng, { ...media, ffmpegPath }, { sharp: forbiddenSharp }))?.image.mediaType, 'image/jpeg')
  assert.equal(sharpCalled, false)
})

test('FFmpeg animated WebP fallback uses the animation demuxer when supported', async (t) => {
  const ffmpegPath = resolveTestFfmpeg()
  if (!ffmpegPath) return t.skip('ffmpeg not installed')
  if (!sharp) return t.skip('optional host sharp required to encode and inspect WebP')
  const demuxers = execFileSync(ffmpegPath, ['-hide_banner', '-demuxers'], { encoding: 'utf8', windowsHide: true })
  if (!demuxers.includes('webp_anim')) return t.skip('host FFmpeg lacks animated WebP support')
  await assertGrid(await makeWebp(), 4, ffmpegPath, true)
})

test('FFmpeg resizes static PNG when sharp is disabled or throws', async (t) => {
  const ffmpegPath = resolveTestFfmpeg()
  if (!ffmpegPath) return t.skip('ffmpeg not installed')
  for (const options of [noSharp, { sharp: (() => { throw new Error('native failure') }) as SharpLoader }]) {
    const output = await normalizeImageDetailed(makePng(1600, 900), { ...media, ffmpegPath }, options)
    assert.equal(output?.image.mediaType, 'image/jpeg')
    const jpeg = Buffer.from(output!.image.base64, 'base64')
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]))
    assert.deepEqual([jpeg.readUInt16BE(sof + 7), jpeg.readUInt16BE(sof + 5)], [1280, 720])
  }
})

test('both decoders disabled: bounded GIF/WebP/APNG/static passthrough notes and strict byte rejection', async () => {
  for (const [input, note] of [
    [animatedGif, '动图 2 帧，未能抽帧拼图，当前仅显示首帧'],
    [makeAnimatedWebp(16, 16, 3), '动图 3 帧，未能抽帧拼图，当前仅显示首帧'],
    [makeAnimatedWebp(16, 16), '动图未能抽帧拼图，当前仅显示首帧'],
    [makeApng(), '动图 4 帧，未能抽帧拼图，当前仅显示首帧'],
    [makePng(1600, 900), '原图 1600×900，未能缩放，按原图提供'],
    [makeJpegHeader(1600, 900), '原图 1600×900，未能缩放，按原图提供'],
  ] as const) {
    const output = await normalizeImageDetailed(input, noFfmpeg, noSharp)
    assert.equal(output?.note, note)
    assert.equal(output?.image.base64, input.toString('base64'))
    assert.equal(await normalizeImageDetailed(input, { ...noFfmpeg, maxImageBytes: input.length - 1 }, noSharp), undefined)
  }
  const secretUrl = 'https://h.qpic.cn/sticker/path?token=super-secret-token'
  const output = await readMessageImages({
    media: noFfmpeg,
    fetch: async () => ({ ...pngResponse, bytes: () => makeAnimatedWebp(16, 16, 3) }),
    authorize: async () => ({ recordId: 'l0_gif', locations: [{ url: secretUrl }] }),
  })
  assert.equal(output.text, 'QQ 消息图片（动图 3 帧，未能抽帧拼图，当前仅显示首帧）')
  assert.ok(!output.text.includes('qpic.cn') && !output.text.includes('super-secret-token'))
})

test('pixel-bomb headers and zero dimensions are rejected before invoking sharp', async () => {
  let called = false
  const fakeSharp: SharpLoader = () => { called = true; throw new Error('must not decode') }
  for (const input of [makePng(7000, 7000, { idat: Buffer.from([0]) }), makePng(0, 1), makeJpegHeader(7000, 7000), makeAnimatedWebp(7000, 7000, 2)]) {
    assert.equal(await normalizeImageDetailed(input, media, { sharp: fakeSharp }), undefined)
    assert.equal(await normalizeImageDetailed(input, noFfmpeg, noSharp), undefined)
  }
  assert.equal(called, false)
  // The boundary is strictly greater than 40 MP, not greater than or equal.
  const boundary = makeJpegHeader(8000, 5000)
  assert.equal((await normalizeImageDetailed(boundary, noFfmpeg, noSharp))?.image.mediaType, 'image/jpeg')
})

test('FFMPEG_PATH precedence and explicit executable path validation', async (t) => {
  const previous = process.env['FFMPEG_PATH']
  t.after(() => {
    if (previous === undefined) delete process.env['FFMPEG_PATH']
    else process.env['FFMPEG_PATH'] = previous
  })
  process.env['FFMPEG_PATH'] = '  /configured/ffmpeg  '
  assert.equal(resolveFfmpegPath({ ...media, ffmpegPath: ' ' }), '/configured/ffmpeg')
  assert.equal(resolveFfmpegPath({ ...media, ffmpegPath: ' /preferred/ffmpeg.exe ' }), '/preferred/ffmpeg.exe')
  for (const unsafe of ['ffmpeg', 'nonexistent', './ffmpeg', '../ffmpeg', '/tmp/node', '/tmp/ffmpeg --version', 'C:ffmpeg.exe']) {
    assert.equal(resolveFfmpegPath({ ...media, ffmpegPath: unsafe }), undefined)
    process.env['FFMPEG_PATH'] = unsafe
    assert.equal(resolveFfmpegPath({ ...media, ffmpegPath: '' }), undefined)
  }
  process.env['FFMPEG_PATH'] = ''
  assert.equal(resolveFfmpegPath({ ...media, ffmpegPath: '' }), 'ffmpeg')
  if (process.platform === 'win32') assert.equal(resolveFfmpegPath({ ...media, ffmpegPath: 'C:\\tools\\ffmpeg.exe' }), 'C:\\tools\\ffmpeg.exe')
  const ffmpegPath = resolveTestFfmpeg()
  if (ffmpegPath) {
    process.env['FFMPEG_PATH'] = ` ${ffmpegPath} `
    assert.equal((await normalizeImageDetailed(makeGif(2), { ...media, ffmpegPath: ' ' }, noSharp))?.image.mediaType, 'image/jpeg')
  }
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
