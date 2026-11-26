// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { BrainError } from '@brain-core/sdk'

const runFile = promisify(execFile)
const MAX_AUDIO_BYTES = 4 * 1024 * 1024
const PROCESS_TIMEOUT = 10_000

function audioFormat(bytes: Uint8Array): string | undefined {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 12))
  if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE') return 'wav'
  if (header.toString('ascii', 0, 4) === 'OggS') return 'ogg'
  if (header.toString('ascii', 0, 3) === 'ID3' || (header[0] === 255 && header[1] !== undefined && (header[1] & 0xe0) === 0xe0)) return 'mp3'
  if (header.toString('ascii', 0, 5) === '#!AMR') return 'amr'
  if (header.toString('ascii', 4, 8) === 'ftyp') return 'mov'
}

function probeExecutable(ffmpegPath: string): string {
  if (!isAbsolute(ffmpegPath)) return 'ffprobe'
  return join(dirname(ffmpegPath), extname(ffmpegPath).toLowerCase() === '.exe' ? 'ffprobe.exe' : 'ffprobe')
}

async function withAudioInput<T>(
  bytes: Uint8Array,
  work: (directory: string, inputArgs: readonly string[]) => Promise<T>,
): Promise<T> {
  const format = audioFormat(bytes)
  if (format === undefined || bytes.byteLength > MAX_AUDIO_BYTES) throw new BrainError('INVALID_ARGUMENT', '语音格式或大小无效')
  let directory: string | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), 'brain-qq-voice-'))
    const input = join(directory, 'input')
    await writeFile(input, bytes, { mode: 0o600 })
    return await work(directory, ['-protocol_whitelist', 'file', '-f', format, '-i', input])
  } catch {
    throw new BrainError('UNAVAILABLE', '本地语音处理不可用')
  } finally {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined)
  }
}

/** Creates the local codec callbacks used by VoiceLibrary when voice is explicitly enabled. */
export function createVoiceCodec(ffmpegPath = '') {
  const executable = ffmpegPath || 'ffmpeg'
  const runOptions = { timeout: PROCESS_TIMEOUT, windowsHide: true, maxBuffer: 64 * 1024 }
  const requireExecutable = (): void => {
    if (executable !== 'ffmpeg' && (!isAbsolute(executable) || !/^ffmpeg(?:\.exe)?$/i.test(basename(executable)))) {
      throw new Error('invalid FFmpeg path')
    }
  }
  return {
    probeDuration: (bytes: Uint8Array): Promise<number> => withAudioInput(bytes, async (directory, input) => {
      requireExecutable()
      const { stdout } = await runFile(probeExecutable(executable), [
        '-v', 'error', ...input, '-select_streams', 'a:0', '-show_entries', 'stream=duration:format=duration', '-of', 'json',
      ], { ...runOptions, cwd: directory })
      const probe = JSON.parse(stdout) as { streams?: readonly { duration?: string }[]; format?: { duration?: string } }
      const audio = probe.streams?.[0]
      const durations = [Number(audio?.duration), Number(probe.format?.duration)].filter((value) => Number.isFinite(value) && value > 0)
      if (audio === undefined || durations.length === 0) throw new Error('missing duration')
      return Math.max(...durations)
    }),
    normalize: (bytes: Uint8Array): Promise<Uint8Array> => withAudioInput(bytes, async (directory, input) => {
      requireExecutable()
      const output = join(directory, 'voice.mp3')
      await runFile(executable, [
        '-nostdin', '-v', 'error', '-threads', '1', ...input, '-map', '0:a:0', '-map_metadata', '-1', '-vn',
        '-af', 'loudnorm=I=-16:LRA=11:TP=-1.5', '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '64k', output,
      ], { ...runOptions, cwd: directory })
      if ((await stat(output)).size > MAX_AUDIO_BYTES) throw new Error('voice too large')
      return readFile(output)
    }),
  }
}
