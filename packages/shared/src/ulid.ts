import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LENGTH = 10
const RANDOM_LENGTH = 16
const ID_LENGTH = TIME_LENGTH + RANDOM_LENGTH

export interface UlidOptions {
  readonly now?: () => number                          // default Date.now
  readonly random?: (bytes: number) => Uint8Array      // default crypto.randomBytes
}

function encodeTime(time: number): string {
  if (!Number.isSafeInteger(time) || time < 0) throw new Error(`invalid ULID time: ${time}`)
  let rest = time
  const chars: string[] = new Array<string>(TIME_LENGTH)
  for (let index = TIME_LENGTH - 1; index >= 0; index -= 1) {
    chars[index] = ALPHABET[rest % 32] as string
    rest = Math.floor(rest / 32)
  }
  if (rest !== 0) throw new Error(`ULID time out of range: ${time}`)
  return chars.join('')
}

export function ulidTime(id: string): number {
  if (id.length !== ID_LENGTH) throw new Error(`invalid ULID: ${id}`)
  let time = 0
  for (let index = 0; index < TIME_LENGTH; index += 1) {
    const digit = ALPHABET.indexOf(id[index] as string)
    if (digit < 0) throw new Error(`invalid ULID: ${id}`)
    time = time * 32 + digit
  }
  return time
}

/** Returns a generator of monotonic ULIDs: 26 Crockford base32 characters, 10 for the time and 16 random. */
export function createUlid(options: UlidOptions = {}): () => string {
  const now = options.now ?? Date.now
  const random = options.random ?? ((bytes: number) => new Uint8Array(randomBytes(bytes)))
  let lastTime = -1
  let lastDigits: number[] = []

  function freshDigits(): number[] {
    const bytes = random(10)
    const digits: number[] = new Array<number>(RANDOM_LENGTH)
    // 80 bits split into sixteen 5-bit groups: every group maps to one base32 digit.
    for (let index = 0; index < RANDOM_LENGTH; index += 1) {
      const bit = index * 5
      const byte = bytes[Math.floor(bit / 8)] ?? 0
      const next = bytes[Math.floor(bit / 8) + 1] ?? 0
      digits[index] = (((byte << 8) | next) >> (11 - (bit % 8))) & 31
    }
    return digits
  }

  function increment(digits: number[]): void {
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      const digit = (digits[index] as number) + 1
      if (digit < 32) {
        digits[index] = digit
        return
      }
      digits[index] = 0
    }
    throw new Error('ULID random space exhausted')
  }

  return () => {
    const at = now()
    if (at > lastTime) {
      lastTime = at
      lastDigits = freshDigits()
    } else {
      // 同一毫秒或时钟倒退：沿用时间部分与随机部分，只把随机部分加 1。
      increment(lastDigits)
    }
    return encodeTime(lastTime) + lastDigits.map((digit) => ALPHABET[digit] as string).join('')
  }
}
