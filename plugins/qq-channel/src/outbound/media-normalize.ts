// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
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
}

function pngInfo(bytes: Buffer): ImageInfo | undefined {
  if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  let animated = false
  let imageData = false
  for (let pos = 33; pos + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(pos)
    if (size > bytes.length - pos - 12) return
    switch (bytes.toString('ascii', pos + 4, pos + 8)) {
      case 'acTL': animated = true; break
      case 'IDAT': imageData ||= size > 0; break
      case 'IEND': return imageData && size === 0 ? { mediaType: 'image/png', width, height, animated } : undefined
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
    case 'VP8X': return size === 10 && bytes.length > 30
      ? { mediaType, width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3), animated: (bytes[20]! & 2) !== 0 }
      : undefined
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
        mediaType: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), animated: frames > 1, duration,
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

function atMost(value: number, maximum: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), maximum) : maximum
}

async function jpegWithFfmpeg(input: Buffer, info: ImageInfo, settings: QqMediaSettings, maxDimension: number, maxBytes: number): Promise<Buffer | undefined> {
  const executable = settings.ffmpegPath || 'ffmpeg'
  if (executable !== 'ffmpeg' && (!isAbsolute(executable) || !/^ffmpeg(?:\.exe)?$/i.test(basename(executable)))) return
  let directory: string | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), 'brain-qq-image-'))
    const source = join(directory, 'input')
    const destination = join(directory, 'image.jpg')
    await writeFile(source, input, { mode: 0o600 })
    const cell = Math.min(240, Math.floor(maxDimension / 3))
    const fit = (size: number): string => `scale=${size}:${size}:force_original_aspect_ratio=decrease`
    const filters = info.mediaType === 'image/gif' && info.animated
      ? `fps=fps=6/${Math.max(info.duration ?? 0.1, 0.1)}:start_time=0,${fit(cell)},pad=${cell}:${cell}:(ow-iw)/2:(oh-ih)/2,tpad=stop_mode=clone:stop=6,tile=3x2:nb_frames=6`
      : fit(maxDimension)
    await runFile(executable, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-threads', '1',
      ...(info.mediaType === 'image/gif' ? ['-ignore_loop', '1'] : []),
      '-f', demuxer[info.mediaType], '-i', source, '-map', '0:v:0', '-an',
      '-filter_threads', '1', '-vf', filters, '-frames:v', '1', '-map_metadata', '-1', '-q:v', '6', destination,
    ], { cwd: directory, timeout: atMost(settings.timeoutMs, 10_000), windowsHide: true, maxBuffer: 64 * 1024 })
    if ((await stat(destination)).size > maxBytes) return
    return await readFile(destination)
  } catch {
    return undefined
  } finally {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined)
  }
}

/** Oversized or animated images are decoded only by a local executable in the plugin's temporary directory. */
export async function normalizeImage(bytes: Uint8Array, settings: QqMediaSettings): Promise<ToolImage | undefined> {
  if (bytes.byteLength > atMost(settings.maxDownloadBytes, MAX_DOWNLOAD_BYTES)) return
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const info = imageInfo(input)
  if (info === undefined || info.width === 0 || info.height === 0 || info.width * info.height > 40_000_000) return
  const maxBytes = atMost(settings.maxImageBytes, MAX_IMAGE_BYTES)
  const maxDimension = atMost(settings.maxImageDimension, MAX_DIMENSION)
  if (!info.animated && input.length <= maxBytes && Math.max(info.width, info.height) <= maxDimension) {
    return { mediaType: info.mediaType, base64: input.toString('base64') }
  }
  if (info.animated && info.mediaType !== 'image/gif') return
  const jpeg = await jpegWithFfmpeg(input, info, settings, maxDimension, maxBytes)
  const result = jpeg === undefined ? undefined : jpegInfo(jpeg)
  if (jpeg === undefined || result === undefined || Math.max(result.width, result.height) > maxDimension) return
  return { mediaType: result.mediaType, base64: jpeg.toString('base64') }
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
): Promise<ToolImage | undefined> {
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
      const image = await normalizeImage(response.bytes(), options.media)
      if (image !== undefined) return image
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
  let total = 0
  const maxTotal = atMost(options.media.maxTotalImageBytes, MAX_TOTAL_BYTES)
  for (const location of locations.slice(0, LIMITS.toolImages)) {
    const image = await downloadImage(options, location, requireSource)
    if (image === undefined) continue
    const size = Buffer.byteLength(image.base64, 'base64')
    if (total + size > maxTotal) continue
    images.push(image)
    total += size
  }
  await requireSource()
  if (images.length > 0) {
    const output = {
      text: images.length === locations.length ? 'QQ 消息图片' : '部分 QQ 消息图片可用', images,
    }
    if (Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: '0', result: output })) <= MAX_RPC_LINE_BYTES) return output
  }
  return { text: '没有可显示的 QQ 图片。图片可能已失效、超出限制或需要本地 FFmpeg 转码。' }
}
