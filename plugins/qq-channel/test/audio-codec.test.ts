// Copyright (c) 2026 xiaoyuan
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { createVoiceCodec } from '../src/outbound/audio-codec.ts'

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

function wavSample(): Buffer {
  const rate = 8000
  const samples = rate / 2
  const value = Buffer.alloc(44 + samples * 2)
  value.write('RIFF', 0)
  value.writeUInt32LE(value.length - 8, 4)
  value.write('WAVEfmt ', 8)
  value.writeUInt32LE(16, 16)
  value.writeUInt16LE(1, 20)
  value.writeUInt16LE(1, 22)
  value.writeUInt32LE(rate, 24)
  value.writeUInt32LE(rate * 2, 28)
  value.writeUInt16LE(2, 32)
  value.writeUInt16LE(16, 34)
  value.write('data', 36)
  value.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) value.writeInt16LE(Math.round(Math.sin(i / 10) * 1000), 44 + i * 2)
  return value
}

test('the QQ voice codec rejects unsupported input before invoking FFmpeg', async () => {
  const codec = createVoiceCodec('brain-test-ffmpeg-does-not-exist')
  await assert.rejects(codec.probeDuration(Buffer.from('https://not-an-audio-file.example')), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(codec.normalize(Buffer.alloc(4 * 1024 * 1024 + 1)), { code: 'INVALID_ARGUMENT' })
})

test('the QQ voice codec probes and normalizes PCM from the isolated directory', async (t) => {
  const ffmpegPath = resolveTestFfmpeg()
  if (ffmpegPath === undefined) {
    t.skip('ffmpeg not installed')
    return
  }
  const codec = createVoiceCodec(ffmpegPath)
  const audio = wavSample()
  assert.equal(await codec.probeDuration(audio), 0.5)
  const normalized = await codec.normalize(audio)
  assert.ok(normalized.length > 0)
  const duration = await codec.probeDuration(normalized)
  assert.ok(duration >= 0.5 && duration < 0.65)
})
