import { inktideStore } from '../data/store.ts'

interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: typeof AudioContext
}

let sharedContext: AudioContext | null = null
let cachedNoiseBuffer: AudioBuffer | null = null

function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

function getAudioContext(): AudioContext | null {
  if (!inktideStore.getSnapshot().soundEnabled) {
    return null
  }
  if (typeof window === 'undefined') {
    return null
  }
  const AudioCtx =
    typeof window.AudioContext === 'function'
      ? window.AudioContext
      : (window as WindowWithWebkitAudio).webkitAudioContext
  if (typeof AudioCtx !== 'function') {
    return null
  }

  try {
    if (!sharedContext || sharedContext.state === 'closed') {
      sharedContext = new AudioCtx()
      cachedNoiseBuffer = null
    }
    if (sharedContext.state === 'suspended') {
      void sharedContext.resume().catch(() => {
        // Ignore browser autoplay policy rejection until next user gesture
      })
    }
    return sharedContext
  } catch {
    return null
  }
}

function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (cachedNoiseBuffer && cachedNoiseBuffer.sampleRate === ctx.sampleRate) {
    return cachedNoiseBuffer
  }
  const length = Math.max(1, Math.floor(ctx.sampleRate * 1.2))
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const channel = buffer.getChannelData(0)
  for (let i = 0; i < length; i += 1) {
    channel[i] = Math.random() * 2 - 1
  }
  cachedNoiseBuffer = buffer
  return buffer
}

/**
 * 落印：80ms 低频敲击（110Hz 正弦 + 噪声包络）
 */
export function playStamp(): void {
  const ctx = getAudioContext()
  if (!ctx) return

  try {
    const now = ctx.currentTime
    const duration = 0.08

    // 110Hz sine thump
    const osc = ctx.createOscillator()
    const oscGain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(110, now)
    oscGain.gain.setValueAtTime(0.0001, now)
    oscGain.gain.linearRampToValueAtTime(dbToGain(-14), now + 0.004)
    oscGain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
    osc.connect(oscGain)
    oscGain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + duration + 0.01)

    // Short filtered noise envelope for physical seal contact
    const noise = ctx.createBufferSource()
    noise.buffer = getNoiseBuffer(ctx)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(650, now)
    filter.frequency.exponentialRampToValueAtTime(180, now + duration)

    const noiseGain = ctx.createGain()
    noiseGain.gain.setValueAtTime(0.0001, now)
    noiseGain.gain.linearRampToValueAtTime(dbToGain(-18), now + 0.003)
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + duration)

    noise.connect(filter)
    filter.connect(noiseGain)
    noiseGain.connect(ctx.destination)
    noise.start(now)
    noise.stop(now + duration + 0.01)
  } catch {
    // Gracefully ignore audio errors in restricted environments
  }
}

/**
 * 泼墨转场：400ms 带通滤波白噪声，频率 400Hz -> 1200Hz，-28dB
 */
export function playFlood(): void {
  const ctx = getAudioContext()
  if (!ctx) return

  try {
    const now = ctx.currentTime
    const duration = 0.4
    const peakGain = dbToGain(-28)

    const noise = ctx.createBufferSource()
    noise.buffer = getNoiseBuffer(ctx)

    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.Q.setValueAtTime(1.4, now)
    filter.frequency.setValueAtTime(400, now)
    filter.frequency.exponentialRampToValueAtTime(1200, now + duration)

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.06)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)

    noise.connect(filter)
    filter.connect(gain)
    gain.connect(ctx.destination)
    noise.start(now)
    noise.stop(now + duration + 0.02)
  } catch {
    // Gracefully ignore audio errors in restricted environments
  }
}

/**
 * 回复分段轻点：1ms 极轻点击，-34dB
 */
export function playReplyTick(): void {
  const ctx = getAudioContext()
  if (!ctx) return

  try {
    const now = ctx.currentTime
    const duration = 0.001
    const peakGain = dbToGain(-34)

    const noise = ctx.createBufferSource()
    noise.buffer = getNoiseBuffer(ctx)

    const filter = ctx.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.setValueAtTime(1800, now)

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(peakGain, now)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)

    noise.connect(filter)
    filter.connect(gain)
    gain.connect(ctx.destination)
    noise.start(now)
    noise.stop(now + duration + 0.005)
  } catch {
    // Gracefully ignore audio errors in restricted environments
  }
}

/**
 * 遗忘：900ms 低通噪声，频率 2000Hz -> 200Hz（如水退去）
 */
export function playForget(): void {
  const ctx = getAudioContext()
  if (!ctx) return

  try {
    const now = ctx.currentTime
    const duration = 0.9
    const peakGain = dbToGain(-24)

    const noise = ctx.createBufferSource()
    noise.buffer = getNoiseBuffer(ctx)

    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.Q.setValueAtTime(0.8, now)
    filter.frequency.setValueAtTime(2000, now)
    filter.frequency.exponentialRampToValueAtTime(200, now + duration)

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.08)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)

    noise.connect(filter)
    filter.connect(gain)
    gain.connect(ctx.destination)
    noise.start(now)
    noise.stop(now + duration + 0.02)
  } catch {
    // Gracefully ignore audio errors in restricted environments
  }
}
