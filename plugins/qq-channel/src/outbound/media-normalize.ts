// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, win32 } from 'node:path'
import { promisify } from 'node:util'
import { BrainError, LIMITS, hostAllowed, type PluginHttp, type ToolImage, type ToolOutput } from '@brain-core/sdk'
import type { QqMediaSettings } from '../config.ts'

const runFile = promisify(execFile)
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 2_516_582
const MAX_DIMENSION = 1280
const MAX_RPC_LINE_BYTES = 8 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const JPEG_END = Buffer.from([0xff, 0xd9])
const JPEG_SIZE_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
const MEDIA_HOSTS = ['*.qpic.cn', '*.qq.com', '*.qq.com.cn', '*.gtimg.cn', '*.qlogo.cn']

type MediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
interface ImageInfo {
  readonly mediaType: MediaType
  readonly width: number
  readonly height: number
  readonly animated?: boolean
  readonly duration?: number
  readonly frames?: number
}

export interface NormalizedImageResult {
  readonly image: ToolImage
  readonly note?: string
}

function pngInfo(bytes: Buffer): ImageInfo | undefined {
  if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  let animated = false
  let frames: number | undefined
  let duration = 0
  let imageData = false
  for (let pos = 33; pos + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(pos)
    if (size > bytes.length - pos - 12) return
    switch (bytes.toString('ascii', pos + 4, pos + 8)) {
      case 'acTL':
        animated = true
        if (size >= 4) frames = bytes.readUInt32BE(pos + 8)
        break
      case 'IDAT': imageData ||= size > 0; break
      case 'fcTL': {
        if (size < 26) return
        const seconds = bytes.readUInt16BE(pos + 28) / (bytes.readUInt16BE(pos + 30) || 100)
        duration += seconds || 0.1
        break
      }
      case 'IEND': return imageData && size === 0
        ? { mediaType: 'image/png', width, height, animated, duration, ...(frames !== undefined ? { frames } : {}) }
        : undefined
    }
    pos += size + 12
  }
}

function jpegInfo(bytes: Buffer): ImageInfo | undefined {
  if (bytes.length < 12 || bytes.lastIndexOf(JPEG_END) <= 2) return
  for (let pos = 2; pos + 3 < bytes.length;) {
    if (bytes[pos++] !== 0xff) return
    while (bytes[pos] === 0xff) pos++
    const marker = bytes[pos++]
    if (marker === undefined || pos + 2 > bytes.length || marker === 0xda || marker === 0xd9) return
    const size = bytes.readUInt16BE(pos)
    if (size < 2 || pos + size > bytes.length) return
    if (JPEG_SIZE_MARKERS.has(marker) && size >= 8 && bytes.lastIndexOf(JPEG_END) > pos + size) {
      return { mediaType: 'image/jpeg', width: bytes.readUInt16BE(pos + 5), height: bytes.readUInt16BE(pos + 3) }
    }
    pos += size
  }
}

function webpInfo(bytes: Buffer): ImageInfo | undefined {
  if (bytes.length < 25 || bytes.readUInt32LE(4) + 8 !== bytes.length || bytes.toString('ascii', 8, 12) !== 'WEBP') return
  const size = bytes.readUInt32LE(16)
  if (size + (size & 1) > bytes.length - 20) return
  const mediaType = 'image/webp'
  switch (bytes.toString('ascii', 12, 16)) {
    case 'VP8X': {
      if (size !== 10 || bytes.length <= 30) return
      const animated = (bytes[20]! & 2) !== 0
      let frames = 0
      let duration = 0
      if (animated) {
        for (let pos = 20 + size + (size & 1); pos + 8 <= bytes.length;) {
          const chunkTag = bytes.toString('ascii', pos, pos + 4)
          const chunkSize = bytes.readUInt32LE(pos + 4)
          const padded = chunkSize + (chunkSize & 1)
          if (padded > bytes.length - pos - 8) break
          if (chunkTag === 'ANMF') {
            frames++
            if (chunkSize >= 16) duration += (bytes.readUIntLE(pos + 20, 3) || 100) / 1000
          }
          pos += 8 + padded
        }
      }
      return {
        mediaType,
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
        animated,
        duration,
        ...(frames > 0 ? { frames } : {}),
      }
    }
    case 'VP8L': {
      if (size < 5 || bytes[20] !== 0x2f) return
      const bits = bytes.readUInt32LE(21)
      return { mediaType, width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
    }
    case 'VP8 ': return size >= 10 && (bytes[20]! & 1) === 0 && bytes.readUIntBE(23, 3) === 0x9d012a
      ? { mediaType, width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
      : undefined
  }
}

function skipGifBlocks(bytes: Buffer, current: number): number {
  while (current < bytes.length) {
    const size = bytes[current++]!
    if (size === 0) return current
    current += size
  }
  return bytes.length
}

function gifInfo(bytes: Buffer): ImageInfo | undefined {
  if (bytes.length < 14) return
  const tableSize = (flags: number): number => (flags & 0x80) !== 0 ? 3 * (2 << (flags & 7)) : 0
  let frames = 0
  let duration = 0
  let delay = 0.1
  for (let pos = 13 + tableSize(bytes[10]!); pos < bytes.length;) {
    const tag = bytes[pos++]
    if (tag === 0x3b) {
      return frames > 0 ? {
        mediaType: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), animated: frames > 1, duration, frames,
      } : undefined
    }
    if (tag === 0x21) {
      const label = bytes[pos++]
      if (label === 0xf9 && bytes[pos] === 4 && pos + 5 < bytes.length) {
        const centiseconds = bytes.readUInt16LE(pos + 2)
        delay = centiseconds < 2 ? 0.1 : centiseconds / 100
      }
      pos = skipGifBlocks(bytes, pos)
      continue
    }
    if (tag !== 0x2c || pos + 9 > bytes.length) return
    pos += 10 + tableSize(bytes[pos + 8]!)
    pos = skipGifBlocks(bytes, pos)
    frames++
    duration += delay
    delay = 0.1
  }
}

function imageInfo(bytes: Buffer): ImageInfo | undefined {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return pngInfo(bytes)
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegInfo(bytes)
  if (bytes.toString('ascii', 0, 4) === 'RIFF') return webpInfo(bytes)
  const gif = bytes.toString('ascii', 0, 6)
  if (gif === 'GIF87a' || gif === 'GIF89a') return gifInfo(bytes)
}

const demuxer: Readonly<Record<MediaType, string>> = {
  'image/png': 'png_pipe', 'image/jpeg': 'jpeg_pipe', 'image/webp': 'webp_pipe', 'image/gif': 'gif',
}
const animatedDemuxer: Readonly<Record<MediaType, string>> = {
  ...demuxer, 'image/png': 'apng', 'image/webp': 'webp_anim',
}

function atMost(value: number, maximum: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), maximum) : maximum
}

const PADDING = 4
const MAX_PIXELS = 40_000_000

// A narrow structural API keeps sharp optional at runtime AND at TypeScript build time.
export interface SharpPipeline {
  metadata(): Promise<{ readonly pages?: number; readonly delay?: readonly number[] }>
  flatten(options: { background: string }): SharpPipeline
  resize(options: { width: number; height: number; fit: 'inside' | 'contain'; withoutEnlargement: boolean; background?: string }): SharpPipeline
  composite(images: readonly { input: Buffer; left: number; top: number }[]): SharpPipeline
  png(): SharpPipeline
  jpeg(options: { quality: number }): SharpPipeline
  toBuffer(): Promise<Buffer>
}

export type SharpLoader = (
  input: Buffer | { create: { width: number; height: number; channels: 3; background: string } },
  options?: { page: number; pages: number; limitInputPixels: number },
) => SharpPipeline

export interface NormalizeImageOptions {
  /** undefined discovers the installed sharp; null explicitly disables it. */
  readonly sharp?: SharpLoader | null
}

let cachedSharp: SharpLoader | null | undefined

/** Reuse the host's sharp without adding an online-install-triggering plugin dependency. */
export function resolveSharp(): SharpLoader | null {
  if (cachedSharp !== undefined) return cachedSharp
  const localRequire = createRequire(import.meta.url)
  const load = (require: NodeJS.Require): SharpLoader | undefined => {
    try {
      const value: unknown = require('sharp')
      return typeof value === 'function' ? value as SharpLoader : undefined
    } catch {
      return undefined
    }
  }
  const direct = load(localRequire)
  if (direct !== undefined) return (cachedSharp = direct)
  try {
    let sdkPackage: string
    try {
      sdkPackage = localRequire.resolve('@brain-core/sdk/package.json')
    } catch {
      // SDK exports only its entry point. Locate its package.json before resolving junctions.
      let directory = dirname(localRequire.resolve('@brain-core/sdk'))
      while (!existsSync(join(directory, 'package.json'))) {
        const parent = dirname(directory)
        if (parent === directory) return (cachedSharp = null)
        directory = parent
      }
      sdkPackage = join(directory, 'package.json')
    }
    let directory = dirname(realpathSync(sdkPackage))
    for (;;) {
      for (const anchor of [join(directory, 'index.js'), join(directory, 'node_modules', '.pnpm', 'node_modules', 'index.js')]) {
        const loader = load(createRequire(anchor))
        if (loader !== undefined) return (cachedSharp = loader)
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  } catch {
    // Optional host dependency may be missing or its native binary may be unavailable.
  }
  return (cachedSharp = null)
}

function clampSetting(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : fallback
}

export function sampleFrameIndices(totalFrames: number, sampleFrames: number): number[] {
  if (sampleFrames <= 1) return [0]
  if (sampleFrames >= totalFrames) return Array.from({ length: totalFrames }, (_, i) => i)
  return [...new Set(Array.from({ length: sampleFrames }, (_, i) => Math.round(i * (totalFrames - 1) / (sampleFrames - 1))))]
}

export interface AnimationPlan {
  readonly sampleFrames: number
  readonly indices: readonly number[]
  readonly cols: number
  readonly rows: number
  readonly cellPx: number
  readonly width: number
  readonly height: number
}

export function planAnimation(frames: number | undefined, settings: QqMediaSettings, maxDimension = atMost(settings.maxImageDimension, MAX_DIMENSION)): AnimationPlan {
  const wanted = clampSetting(settings.gifFrames, 2, 12, 6)
  const totalFrames = frames === undefined ? wanted : Math.max(1, Math.floor(frames))
  const sampleFrames = Math.min(wanted, totalFrames)
  const layouts: readonly (readonly [number, number])[] = [[1, 1], [2, 1], [3, 1], [2, 2], [3, 2], [3, 2], [4, 2], [4, 2], [3, 3], [5, 2], [4, 3], [4, 3]]
  const fallbackCols = Math.ceil(Math.sqrt(sampleFrames))
  const [cols, rows] = layouts[sampleFrames - 1] ?? [fallbackCols, Math.ceil(sampleFrames / fallbackCols)]
  const cellPx = Math.max(0, Math.min(
    clampSetting(settings.gifCellPx, 64, 400, 240),
    Math.floor((maxDimension - (cols + 1) * PADDING) / cols),
    Math.floor((maxDimension - (rows + 1) * PADDING) / rows),
  ))
  return {
    sampleFrames, indices: sampleFrameIndices(totalFrames, sampleFrames), cols, rows, cellPx,
    width: cols * cellPx + (cols + 1) * PADDING,
    height: rows * cellPx + (rows + 1) * PADDING,
  }
}

function storyboardNote(info: ImageInfo, plan: AnimationPlan): string {
  const count = info.frames ? ` ${info.frames} 帧` : ''
  const duration = info.duration && info.duration > 0 ? `/${info.duration.toFixed(1)}s` : ''
  return `动图${count}${duration}，已抽 ${plan.sampleFrames} 帧拼成 ${plan.cols}×${plan.rows} 网格，行优先 左上→右下`
}

async function jpegWithSharp(input: Buffer, info: ImageInfo, settings: QqMediaSettings, maxDimension: number, maxBytes: number, sharp: SharpLoader): Promise<{ jpeg: Buffer; info: ImageInfo; plan?: AnimationPlan } | undefined> {
  try {
    if (info.animated && info.mediaType === 'image/png') return // libpng only exposes APNG frame zero.
    if (info.animated && info.frames === undefined) {
      const metadata = await sharp(input, { page: 0, pages: 1, limitInputPixels: MAX_PIXELS }).metadata()
      if (metadata.pages === undefined || metadata.pages < 2) return
      info = { ...info, frames: metadata.pages, duration: metadata.delay?.reduce((sum, delay) => sum + (delay || 100) / 1000, 0) }
    }
    for (const [attempt, quality] of [82, 68, 55].entries()) {
      const dimension = Math.max(1, Math.floor(maxDimension * 0.8 ** attempt))
      const plan = info.animated ? planAnimation(info.frames, settings, dimension) : undefined
      let pipeline: SharpPipeline
      if (plan !== undefined) {
        if (plan.cellPx < 1) return
        const tiles: { input: Buffer; left: number; top: number }[] = []
        // Decode one coalesced page at a time, never an unbounded all-frame pixel strip.
        for (const [i, page] of plan.indices.entries()) {
          const tile = await sharp(input, { page, pages: 1, limitInputPixels: MAX_PIXELS })
            .flatten({ background: '#ffffff' })
            .resize({ width: plan.cellPx, height: plan.cellPx, fit: 'contain', withoutEnlargement: false, background: '#ffffff' })
            .png().toBuffer()
          tiles.push({ input: tile, left: PADDING + (i % plan.cols) * (plan.cellPx + PADDING), top: PADDING + Math.floor(i / plan.cols) * (plan.cellPx + PADDING) })
        }
        pipeline = sharp({ create: { width: plan.width, height: plan.height, channels: 3, background: '#ffffff' } }).composite(tiles)
      } else {
        pipeline = sharp(input, { page: 0, pages: 1, limitInputPixels: MAX_PIXELS })
          .flatten({ background: '#ffffff' })
          .resize({ width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true })
      }
      const jpeg = await pipeline.jpeg({ quality }).toBuffer()
      if (jpeg.length <= maxBytes) return { jpeg, info, ...(plan !== undefined ? { plan } : {}) }
    }
  } catch {
    // Native decoding is optional. Try FFmpeg, then bounded passthrough.
  }
}

/** Explicit paths must name an absolute ffmpeg executable, even when supplied via the environment. */
export function resolveFfmpegPath(settings: QqMediaSettings): string | undefined {
  const explicit = settings.ffmpegPath.trim() || process.env['FFMPEG_PATH']?.trim()
  if (!explicit) return 'ffmpeg'
  const windowsPath = process.platform === 'win32' && win32.isAbsolute(explicit)
  if (!(isAbsolute(explicit) || windowsPath)) return
  if (!/^ffmpeg(?:\.exe)?$/i.test(windowsPath ? win32.basename(explicit) : basename(explicit))) return
  return explicit
}

async function jpegWithFfmpeg(input: Buffer, info: ImageInfo, settings: QqMediaSettings, maxDimension: number, maxBytes: number): Promise<{ jpeg: Buffer; info: ImageInfo; plan?: AnimationPlan } | undefined> {
  const executable = resolveFfmpegPath(settings)
  if (executable === undefined) return
  let directory: string | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), 'brain-qq-image-'))
    const source = join(directory, 'input')
    const destination = join(directory, 'image.jpg')
    await writeFile(source, input, { mode: 0o600 })
    for (const [attempt, quality] of [6, 9, 12].entries()) {
      const dimension = Math.max(1, Math.floor(maxDimension * 0.8 ** attempt))
      const plan = info.animated ? planAnimation(info.frames, settings, dimension) : undefined
      if (plan !== undefined && plan.cellPx < 1) return
      const size = plan?.cellPx ?? dimension
      const fit = `scale=${size}:${size}:force_original_aspect_ratio=decrease`
      // Selecting frame indices includes both endpoints, handles uneven delays, and never clone-pads.
      const sampling = plan === undefined ? '' : info.frames !== undefined
        ? `select='${plan.indices.map((index) => `eq(n,${index})`).join('+')}',`
        : `fps=fps=${plan.sampleFrames}/${Math.max(info.duration ?? plan.sampleFrames * 0.1, 0.1)}:start_time=0,`
      const filters = plan === undefined ? `${fit},format=rgba,geq=r='r(X,Y)*alpha(X,Y)/255+255-alpha(X,Y)':g='g(X,Y)*alpha(X,Y)/255+255-alpha(X,Y)':b='b(X,Y)*alpha(X,Y)/255+255-alpha(X,Y)'`
        : `${sampling}${fit},pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=white,tile=${plan.cols}x${plan.rows}:nb_frames=${plan.sampleFrames}:padding=4:margin=4:color=white`
      await runFile(executable, [
        '-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-threads', '1',
        ...(info.animated ? ['-ignore_loop', '1'] : []),
        '-f', (info.animated ? animatedDemuxer : demuxer)[info.mediaType], '-i', source, '-map', '0:v:0', '-an',
        '-filter_threads', '1', '-vf', filters, '-frames:v', '1', '-map_metadata', '-1', '-q:v', String(quality), destination,
      ], { cwd: directory, timeout: atMost(settings.timeoutMs, 10_000), windowsHide: true, maxBuffer: 64 * 1024 })
      if ((await stat(destination)).size <= maxBytes) return { jpeg: await readFile(destination), info, ...(plan !== undefined ? { plan } : {}) }
    }
  } catch {
    return undefined
  } finally {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
  }
}

/** Validate headers and pixel budgets before optional local decoding; never expose decoder details. */
export async function normalizeImageDetailed(bytes: Uint8Array, settings: QqMediaSettings, options: NormalizeImageOptions = {}): Promise<NormalizedImageResult | undefined> {
  if (bytes.byteLength > atMost(settings.maxDownloadBytes, MAX_DOWNLOAD_BYTES)) return
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const info = imageInfo(input)
  if (info === undefined || info.width === 0 || info.height === 0 || info.width * info.height > 40_000_000) return
  const maxBytes = atMost(settings.maxImageBytes, MAX_IMAGE_BYTES)
  const maxDimension = atMost(settings.maxImageDimension, MAX_DIMENSION)
  if (!info.animated && input.length <= maxBytes && Math.max(info.width, info.height) <= maxDimension) {
    return { image: { mediaType: info.mediaType, base64: input.toString('base64') } }
  }
  const sharp = options.sharp === undefined ? resolveSharp() : options.sharp
  const rendered = (sharp === null ? undefined : await jpegWithSharp(input, info, settings, maxDimension, maxBytes, sharp))
    ?? await jpegWithFfmpeg(input, info, settings, maxDimension, maxBytes)
  if (rendered !== undefined) {
    const result = jpegInfo(rendered.jpeg)
    if (result !== undefined && rendered.jpeg.length <= maxBytes && Math.max(result.width, result.height) <= maxDimension) {
      return {
        image: { mediaType: 'image/jpeg', base64: rendered.jpeg.toString('base64') },
        ...(rendered.plan !== undefined ? { note: storyboardNote(rendered.info, rendered.plan) } : {}),
      }
    }
  }
  if (input.length <= maxBytes) {
    return {
      image: { mediaType: info.mediaType, base64: input.toString('base64') },
      note: info.animated
        ? `动图${info.frames && info.frames > 1 ? ` ${info.frames} 帧，` : ''}未能抽帧拼图，当前仅显示首帧`
        : `原图 ${info.width}×${info.height}，未能缩放，按原图提供`,
    }
  }
  return undefined
}

export async function normalizeImage(bytes: Uint8Array, settings: QqMediaSettings, options: NormalizeImageOptions = {}): Promise<ToolImage | undefined> {
  return (await normalizeImageDetailed(bytes, settings, options))?.image
}

export interface ImageLocation {
  readonly file?: unknown
  readonly url?: unknown
  readonly isMarketSticker?: unknown
}

export interface MessageImagesOptions {
  readonly media: QqMediaSettings
  readonly fetch: PluginHttp['fetch']
  /** Returns locations only after checking the current tool's L0 source and disclosure. */
  readonly authorize: () => Promise<{ readonly recordId: string; readonly locations: readonly ImageLocation[] } | undefined>
  /** Calls OneBot get_image for a validated file id and returns its download URL, never a local file path. */
  readonly resolveImageUrl?: (file: string) => Promise<unknown>
}

function cdnUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 16_384) return
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.port !== '') return
    if (!MEDIA_HOSTS.some((pattern) => hostAllowed(pattern, url.hostname))) return
    url.hash = ''
    return url.href
  } catch {
    return undefined
  }
}

async function downloadImage(
  options: MessageImagesOptions,
  location: ImageLocation,
  requireSource: () => Promise<void>,
): Promise<NormalizedImageResult | undefined> {
  const urls: string[] = []
  const file = location.file
  if (location.isMarketSticker !== true && options.resolveImageUrl !== undefined && typeof file === 'string'
    && /^[a-z0-9_-][a-z0-9_.-]{0,199}$/i.test(file)) {
    await requireSource()
    const resolved = cdnUrl(await options.resolveImageUrl(file).catch(() => undefined))
    if (resolved !== undefined) urls.push(resolved)
  }
  const messageUrl = cdnUrl(location.url)
  if (messageUrl !== undefined && !urls.includes(messageUrl)) urls.push(messageUrl)
  for (const url of urls) {
    await requireSource()
    try {
      const response = await options.fetch(url, { redirect: 'error', maxBytes: atMost(options.media.maxDownloadBytes, MAX_DOWNLOAD_BYTES) })
      if (response.status < 200 || response.status >= 300) continue
      const result = await normalizeImageDetailed(response.bytes(), options.media)
      if (result !== undefined) return result
    } catch {
      // The protocol may return a stale URL. Never echo a URL, token or decoder output.
    }
  }
}

/** Reads at most four locations. Re-checks source access after all network and decoder work. */
export async function readMessageImages(options: MessageImagesOptions): Promise<Exclude<ToolOutput, string>> {
  const source = await options.authorize()
  if (source === undefined) throw new BrainError('NOT_FOUND', '找不到当前通道中的这条消息')
  const { recordId, locations } = source
  const requireSource = async (): Promise<void> => {
    if ((await options.authorize())?.recordId !== recordId) throw new BrainError('NOT_FOUND', '找不到当前通道中的这条消息')
  }
  const images: ToolImage[] = []
  const notes: string[] = []
  let total = 0
  const maxTotal = atMost(options.media.maxTotalImageBytes, MAX_TOTAL_BYTES)
  for (const location of locations.slice(0, LIMITS.toolImages)) {
    const result = await downloadImage(options, location, requireSource)
    if (result === undefined) continue
    const size = Buffer.byteLength(result.image.base64, 'base64')
    if (total + size > maxTotal) continue
    images.push(result.image)
    if (result.note) notes.push(result.note)
    total += size
  }
  await requireSource()
  if (images.length > 0) {
    const baseText = images.length === locations.length ? 'QQ 消息图片' : '部分 QQ 消息图片可用'
    const output = {
      text: notes.length > 0 ? `${baseText}（${notes.join('；')}）` : baseText,
      images,
    }
    if (Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: '0', result: output })) <= MAX_RPC_LINE_BYTES) return output
  }
  return { text: '没有可显示的 QQ 图片。图片可能已失效、超出限制或需要本地 FFmpeg 转码。' }
}
