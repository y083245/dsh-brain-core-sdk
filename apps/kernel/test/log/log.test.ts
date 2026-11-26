import assert from 'node:assert/strict'
import test from 'node:test'
import { createLogger, redact } from '../../src/log/index.ts'

function capture(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = []
  const logger = createLogger({ write: (line) => lines.push(line), now: () => 1234 })
  return { lines, logger }
}

test('a log line is one JSON object with a stable field order', () => {
  const { lines, logger } = capture()
  logger.info('memory.ingest', {
    requestId: 'r1', plugin: 'plugin.test', channel: 'ch1', layer: 'L1', code: 'OK', durationMs: 5, count: 2,
  })
  assert.equal(lines.length, 1)
  const line = lines[0] as string
  assert.equal(line.includes('\n'), false)
  const parsed = JSON.parse(line) as Record<string, unknown>
  assert.deepEqual(Object.keys(parsed), ['t', 'level', 'event', 'requestId', 'plugin', 'channel', 'layer', 'code', 'durationMs', 'count'])
  assert.deepEqual(parsed, {
    t: 1234, level: 'info', event: 'memory.ingest',
    requestId: 'r1', plugin: 'plugin.test', channel: 'ch1', layer: 'L1', code: 'OK', durationMs: 5, count: 2,
  })
})

test('unknown fields are dropped even when forced in', () => {
  const { lines, logger } = capture()
  logger.warn('memory.ingest', { content: 'raw chat text' } as never)
  const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>
  assert.equal('content' in parsed, false)
  assert.equal(JSON.stringify(parsed).includes('raw chat text'), false)
})

test('known fields with the wrong type are dropped', () => {
  const { lines, logger } = capture()
  logger.error('memory.ingest', { count: 'not a number' as never })
  const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>
  assert.equal('count' in parsed, false)
})

test('the compiler rejects a content field', () => {
  const { logger } = capture()
  // @ts-expect-error content is not part of LogFields
  logger.info('memory.ingest', { content: 'raw chat text' })
})

test('secret values, sk- keys and bearer tokens are redacted', () => {
  const lines: string[] = []
  const logger = createLogger({
    write: (line) => lines.push(line),
    now: () => 0,
    secrets: () => ['super-secret-value'],
  })
  logger.warn('auth.failed', { code: 'super-secret-value', plugin: 'sk-abcdefghijklmnopqrstuvwx' })
  logger.info('request Bearer abcdefghijklmnop', { channel: 'Bearer abcdefghijklmnop' })
  const output = lines.join('\n')
  assert.equal(output.includes('super-secret-value'), false)
  assert.equal(output.includes('sk-abcdefghijklmnopqrstuvwx'), false)
  assert.equal(output.includes('Bearer abcdefghijklmnop'), false)
  assert.equal(output.includes('[redacted]'), true)
})

test('redact leaves short secrets alone and handles every pattern', () => {
  assert.equal(redact('value is abcdefg', ['abcdefg']), 'value is abcdefg')
  assert.equal(redact('value is abcdefgh', ['abcdefgh']), 'value is [redacted]')
  assert.equal(redact('sk-0123456789abcdef', []), '[redacted]')
  assert.equal(redact('sk-0123456789abcde', []), 'sk-0123456789abcde')
  assert.equal(redact('token Bearer abc.def-ghi_jkl', []), 'token [redacted]')
  assert.equal(redact('nothing to see', []), 'nothing to see')
})
